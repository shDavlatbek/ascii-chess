// Module worker: runs searchBestMove off the main thread.
// Message in:  { id, fen, level, extra? }   (extra: { timeMs?, startFen?, moves? })
// Message out: { id, move } | { id, error }
import { searchBestMove } from './ai.js';

self.onmessage = (e) => {
  const { id, fen, level, extra } = e.data || {};
  try {
    const move = searchBestMove(fen, { ...(extra || {}), level });
    self.postMessage({ id, move });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
