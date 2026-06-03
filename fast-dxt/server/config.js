import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Load a KEY=VALUE secrets file into process.env (without overriding existing
// env). Lets the scout pick up GEMINI_API_KEY / OPENROUTER_API_KEY from a file
// outside the repo. Default path is fastlink-secrets.txt in the user's home dir
// (portable across Linux/macOS/Windows); override with FASTLINK_SECRETS_FILE.
// Missing file is a silent no-op.
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
// fastlink-scout-BENCHMARKS.md. Fallback for hard pages: gemini-2.5-flash.
export const GEMINI_MODEL = process.env.FASTLINK_GEMINI_MODEL || 'gemini-2.5-flash-lite';
export const SCOUT_ENABLED = !!GEMINI_API_KEY;
