// Pointer + keyboard input.  Widgets (registered each frame in kit.js) are
// hit-tested first; anything else on the board becomes sq:down / sq:move / sq:up.

import { K, hitTest } from './kit.js';

export function createInput({ canvas, bus, audio, onKey }) {
  const st = { x: 0, y: 0, inside: false, touch: false, press: null, boardPress: false, pid: null, cursor: '' };

  const cs = canvas.style;
  cs.touchAction = 'none';
  cs.userSelect = 'none';
  cs.webkitUserSelect = 'none';
  cs.webkitTouchCallout = 'none';
  cs.webkitTapHighlightColor = 'transparent';

  function local(e) {
    const r = canvas.getBoundingClientRect(), L = K.layout;
    const sx = L && r.width ? L.W / r.width : 1, sy = L && r.height ? L.H / r.height : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }
  const squareAt = (x, y) => (K.layout ? K.layout.squareAt(x, y) : null);

  function down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (st.pid !== null && e.pointerId !== st.pid) return;
    e.preventDefault();
    audio.resume();
    const p = local(e);
    st.x = p.x; st.y = p.y; st.inside = true; st.touch = e.pointerType !== 'mouse'; st.pid = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const w = hitTest(p.x, p.y);
    if (w) {
      K.hover = w.id;
      if (w.action && w.enabled) { st.press = w.id; K.press = w.id; }
      return;
    }
    if (K.modal || !K.layout) return;
    const sq = squareAt(p.x, p.y);
    if (sq) { st.boardPress = true; bus.emit('sq:down', { sq, x: p.x, y: p.y }); }
  }

  function move(e) {
    if (st.pid !== null && e.pointerId !== st.pid) return;
    const p = local(e);
    st.x = p.x; st.y = p.y; st.inside = true; st.touch = e.pointerType !== 'mouse';
    if (st.boardPress) { bus.emit('sq:move', { sq: squareAt(p.x, p.y), x: p.x, y: p.y }); return; }
    const w = hitTest(p.x, p.y);
    K.hover = w ? w.id : null;
    setCursor(w);
    if (st.press || K.modal) return;
    bus.emit('sq:move', { sq: w ? null : squareAt(p.x, p.y), x: p.x, y: p.y });
  }

  function up(e) {
    if (st.pid !== null && e.pointerId !== st.pid) return;
    const p = local(e);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    st.pid = null;
    if (st.press) {
      const w = hitTest(p.x, p.y), id = st.press;
      st.press = null; K.press = null;
      if (w && w.id === id && w.enabled && w.action) { audio.play('ui'); w.action(); }
    } else if (st.boardPress) {
      st.boardPress = false;
      bus.emit('sq:up', { sq: squareAt(p.x, p.y), x: p.x, y: p.y });
    }
    if (st.touch) { st.inside = false; K.hover = null; }
  }

  function cancel(e) {
    if (st.pid !== null && e.pointerId !== st.pid) return;
    st.pid = null; st.press = null; K.press = null;
    if (st.boardPress) { st.boardPress = false; bus.emit('sq:up', { sq: null, x: st.x, y: st.y }); }
    st.inside = false; K.hover = null;
  }

  function leave(e) {
    if (st.pid !== null) return;
    st.inside = false; K.hover = null; setCursor(null);
    if (!K.modal && e.pointerType === 'mouse') bus.emit('sq:move', { sq: null, x: st.x, y: st.y });
  }

  function setCursor(w) {
    const want = w && w.action && w.enabled ? 'pointer' : '';
    if (want !== st.cursor) { cs.cursor = want; st.cursor = want; }
  }

  const stop = (e) => { e.preventDefault(); };
  const keydown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    try { if (onKey(e)) e.preventDefault(); } catch (err) { console.error('[ui:key]', err); }
  };
  const wake = () => audio.resume();

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('contextmenu', stop);
  canvas.addEventListener('wheel', stop, { passive: false });
  canvas.addEventListener('touchstart', stop, { passive: false });
  canvas.addEventListener('touchmove', stop, { passive: false });
  canvas.addEventListener('gesturestart', stop);
  canvas.addEventListener('gesturechange', stop);
  window.addEventListener('keydown', keydown);
  window.addEventListener('keydown', wake, true);

  return {
    /** Called at the end of each draw: keeps hover + cursor right when widgets move. */
    refresh() {
      const w = st.inside ? hitTest(st.x, st.y) : null;
      K.hover = w ? w.id : null;
      setCursor(w);
    },
    dispose() {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('contextmenu', stop);
      canvas.removeEventListener('wheel', stop);
      canvas.removeEventListener('touchstart', stop);
      canvas.removeEventListener('touchmove', stop);
      canvas.removeEventListener('gesturestart', stop);
      canvas.removeEventListener('gesturechange', stop);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keydown', wake, true);
    },
  };
}
