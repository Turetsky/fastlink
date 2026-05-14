export const log = (msg) => {
  process.stderr.write(`[fastlink] ${new Date().toISOString()} ${msg}\n`);
};
