import { readBuffer, consoleBuffers } from '../buffers.js';

export function readConsole(args = {}) {
  const filter = args.level && args.level !== 'all' ? (e => e.level === args.level) : null;
  return readBuffer(consoleBuffers, args, filter);
}
