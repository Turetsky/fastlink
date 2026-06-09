// src/index.js — FastLink Relay Worker entry (relay-core)
//
// The default export is the @cloudflare/workers-oauth-provider OAuthProvider.
// It splits traffic two ways:
//   • apiRoute '/mcp'  → OAuth-protected. The provider validates the Bearer
//     access token, attaches the grant's props (set at completeAuthorization)
//     to the api handler, and calls FastlinkApiHandler below.
//   • everything else  → the defaultHandler from auth.js (owns /authorize,
//     /oauth/*, /pair/*, and the /ext WebSocket upgrade).
//
// Identity → routing: the OAuth grant carries `props.userId`. That userId names
// the Durable Object (`idFromName(userId)`), and there is exactly ONE DO per
// user. The same userId is what the extension's device token resolves to on the
// /ext upgrade (see auth.js), so the MCP side and the browser side meet at the
// same DO. Strict per-tenant isolation is structural: an MCP grant can only ever
// address its own DO.
//
// See SPEC.md §3a.

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { makeDefaultHandler, registerRateLimit } from './auth.js'; // oauth owns this: /authorize,/oauth/*,/pair/*,/ext

// The Durable Object class MUST be exported from the Worker's main module so the
// runtime can construct it for the USER_RELAY binding.
export { UserRelay } from './userRelay.js';

// API handler for '/mcp'. By the time this runs, the OAuthProvider has already
// validated the Bearer token and exposed the grant's encrypted props. We trust
// `ctx.props.userId` (set by auth.js at completeAuthorization). All this handler
// does is resolve the caller's DO and forward the raw MCP POST to it, tagging the
// path as '/__mcp' so the DO routes it to its MCP handler.
export class FastlinkApiHandler extends WorkerEntrypoint {
  async fetch(request) {
    const { env } = this;

    // CORS for the browser MCP client (claude.ai web). ALLOWED_ORIGINS is a
    // comma-separated allowlist (infra-docs sets it, default "https://claude.ai").
    const cors = corsHeaders(request.headers.get('Origin'), env.ALLOWED_ORIGINS);
    // Preflight: answer here if it reaches us. NOTE: a CORS preflight carries no
    // Authorization header, so if the OAuthProvider rejects unauthenticated
    // requests to the '/mcp' apiRoute BEFORE this handler runs, the preflight must
    // instead be answered by oauth's defaultHandler — flagged to oauth/integrator.
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // Library convention: props land on ctx.props for a WorkerEntrypoint api
    // handler. Fall back to this.props defensively across library versions.
    const userId = this.ctx?.props?.userId ?? this.props?.userId;
    if (!userId) return withCors(new Response('no userId in OAuth grant', { status: 401 }), cors);

    const stub = env.USER_RELAY.get(env.USER_RELAY.idFromName(String(userId)));

    // Rewrite the path to the DO's internal MCP route, preserving method + body.
    const url = new URL(request.url);
    url.pathname = '/__mcp';
    const fwd = new Request(url, request);
    // Pass the resolved identity through so the DO can label status/audit. The DO
    // never trusts this for isolation (that's the idFromName keying above) — it's
    // purely informational.
    try { fwd.headers.set('X-Fastlink-User-Id', String(userId)); } catch { /* immutable headers — non-fatal */ }
    const res = await stub.fetch(fwd);
    return withCors(res, cors);
  }
}

// Build CORS headers, echoing the request Origin only if it's in the allowlist.
function corsHeaders(origin, allowed) {
  const list = (allowed || 'https://claude.ai').split(',').map((s) => s.trim()).filter(Boolean);
  const allow = origin && (list.includes('*') || list.includes(origin)) ? origin : (list[0] || '');
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
    'Access-Control-Max-Age': '86400',
  };
  if (allow) { h['Access-Control-Allow-Origin'] = allow; h.Vary = 'Origin'; }
  return h;
}

// Return a copy of `res` with the CORS headers merged in (Response from a DO stub
// has immutable headers, so we rebuild it).
function withCors(res, cors) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

const oauthProvider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: FastlinkApiHandler,
  defaultHandler: makeDefaultHandler(), // { fetch(request, env, ctx) }
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register', // claude.ai dynamic-registers here
  scopesSupported: ['browser.drive'],
  accessTokenTTL: 3600,
  // OAuth 2.1: reject the `plain` PKCE method, require S256. The library defaults
  // this true (accepts plain) for backwards-compat; plain offers no cryptographic
  // protection, so we pin S256-only before any stranger connects (audit M1).
  allowPlainPKCE: false,
});

// CORS-preflight shim (security audit S2 / task #11). claude.ai web is a browser
// MCP client, so it sends an UNAUTHENTICATED OPTIONS preflight to /mcp before the
// real POST. The OAuthProvider treats /mcp as a token-protected apiRoute and would
// 401 that preflight before FastlinkApiHandler runs (the library only auto-answers
// CORS for its OWN endpoints — token/register/metadata — not the app's apiRoute),
// breaking the browser connector. So we answer the /mcp preflight HERE, before the
// provider sees it — no auth required, just the CORS headers the browser needs.
// Everything else passes straight through to the OAuthProvider unchanged.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS' && url.pathname === '/mcp') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers.get('Origin'), env.ALLOWED_ORIGINS),
      });
    }
    // M2: the library's /oauth/register (open Dynamic Client Registration, required
    // for claude.ai) is an unauthenticated write surface — rate-limit it by IP
    // BEFORE the OAuthProvider handles it. Fails open if the limiter DB errors.
    if (request.method === 'POST' && url.pathname === '/oauth/register') {
      const rl = await registerRateLimit(env, request);
      if (!rl.allowed) {
        return new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSec) },
        });
      }
    }
    return oauthProvider.fetch(request, env, ctx);
  },
};
