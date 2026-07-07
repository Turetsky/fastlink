import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Load a KEY=VALUE secrets file into process.env (without overriding existing
// env). Lets the scout pick up GEMINI_API_KEY / OPENROUTER_API_KEY from a file
// outside the repo. Default path is ~/fastlink-secrets.txt (portable across
// macOS/Windows/Linux/WSL via os.homedir()); override with FASTLINK_SECRETS_FILE.
// Missing file is a silent no-op, so most installs (which set GEMINI_API_KEY in
// the MCP env directly) never need this file.
(function loadSecrets() {
  const path = process.env.FASTLINK_SECRETS_FILE
    || join(homedir(), 'fastlink-secrets.txt');
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
})();

const httpPortArg = process.argv.find(a => a.startsWith('--http-port='));

export const BROKER_PORT = parseInt(process.env.FASTLINK_BROKER_PORT, 10) || 9870;

export const HTTP_ENABLED = process.argv.includes('--http') || process.env.FASTLINK_HTTP === '1';
export const HTTP_PORT = httpPortArg
  ? parseInt(httpPortArg.split('=')[1], 10)
  : (parseInt(process.env.FASTLINK_HTTP_PORT, 10) || 9879);

export const TOKEN = process.env.FASTLINK_TOKEN || null;
export const REQUEST_TIMEOUT_MS = 30_000;

// Scout: fast model that pre-reads pages and turns intent into an action plan.
// Direct Gemini (Generative Language API) only. fast_scout returns
// {disabled:true} until GEMINI_API_KEY is set.
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
// Benchmarked winner for both planning and the vision/screenshot rung: fastest
// (TTFT ~440ms) AND fully accurate. 3.5-flash ~5× slower, 3.1-lite ~1.6×. See
// docs/scout-BENCHMARKS.md. Fallback for hard pages: gemini-2.5-flash.
export const GEMINI_MODEL = process.env.FASTLINK_GEMINI_MODEL || 'gemini-2.5-flash-lite';
export const SCOUT_ENABLED = !!GEMINI_API_KEY;

// ── Vision/scout fallback provider (OpenRouter) ──
// Gemini 503 "high demand"/UNAVAILABLE (and 429) are transient: the scout first
// retries the direct Google API with backoff (see scout.js), then — if a
// fallback is configured — re-issues the SAME request against OpenRouter, whose
// OpenAI-compatible /chat/completions endpoint can serve the Gemini family and
// is unaffected by the direct Google key's prepayment-credit issues.
//
// Gated by env so a default install (no OPENROUTER_API_KEY) behaves EXACTLY as
// before — no fallback attempted. When a key is present the fallback is ON by
// default (matches the user's global OpenRouter-for-Gemini preference); set
// FASTLINK_VISION_FALLBACK=0 to force it off even with a key present.
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
export const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
// google/gemini-2.5-pro is confirmed routed on OpenRouter; google/gemini-3-pro-preview is NOT.
export const OPENROUTER_MODEL = process.env.FASTLINK_OPENROUTER_MODEL || 'google/gemini-2.5-pro';
const _fbFlag = (process.env.FASTLINK_VISION_FALLBACK || '').toLowerCase();
export const VISION_FALLBACK_ENABLED = !!OPENROUTER_API_KEY
  && _fbFlag !== '0' && _fbFlag !== 'false' && _fbFlag !== 'off';

// ── Tier-3 fallback: a NON-Gemini provider (Claude), for provider diversity ──
// Tier 1 (direct Gemini) and tier 2 (OpenRouter google/gemini-2.5-pro) are the
// SAME model family, so a Google-wide capacity/demand event can take out BOTH at
// once (the 503s we keep hitting). Tier 3 adds a Claude vision model — routed
// through the SAME OpenRouter endpoint (OpenAI-compatible /chat/completions), so
// it reuses OPENROUTER_API_KEY and the existing request/response mapping — only
// fired after tiers 1 AND 2 are exhausted on transient failures. Claude is
// multimodal and does the screenshot coordinate-grounding/JSON-locate task fine.
// Gated on the OpenRouter key (reused) so a default install is unchanged; set
// FASTLINK_VISION_FALLBACK2=0 to disable tier 3 even when a key is present.
// Default model: fast/cheap Haiku 4.5; override with FASTLINK_CLAUDE_MODEL
// (e.g. anthropic/claude-sonnet-4-6 if Haiku's grounding proves weak).
export const OPENROUTER_CLAUDE_MODEL = process.env.FASTLINK_CLAUDE_MODEL || 'anthropic/claude-haiku-4-5';
const _fb2Flag = (process.env.FASTLINK_VISION_FALLBACK2 || '').toLowerCase();
export const VISION_FALLBACK2_ENABLED = !!OPENROUTER_API_KEY
  && _fb2Flag !== '0' && _fb2Flag !== 'false' && _fb2Flag !== 'off';
