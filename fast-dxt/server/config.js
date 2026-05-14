const httpPortArg = process.argv.find(a => a.startsWith('--http-port='));

export const BROKER_PORT = parseInt(process.env.FASTLINK_BROKER_PORT, 10) || 9870;

export const HTTP_ENABLED = process.argv.includes('--http') || process.env.FAST_BROWSER_HTTP === '1';
export const HTTP_PORT = httpPortArg
  ? parseInt(httpPortArg.split('=')[1], 10)
  : (parseInt(process.env.FAST_BROWSER_HTTP_PORT, 10) || 9879);

export const TOKEN = process.env.FAST_BROWSER_TOKEN || null;
export const REQUEST_TIMEOUT_MS = 30_000;
