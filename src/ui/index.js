// UI layer: HUD, menus, input, sound.  See CONTRACTS.md ("UI").
//
//   const ui = createUI({ bus, canvas });
//   ui.resize(layout); ui.update(dt, view); ui.draw(ctx, view);
//
// Extras beyond the contract: ui.dispose() removes listeners / closes audio.

import { clamp, ease } from '../core/util.js';
import { K, begin } from './kit.js';
import { createAudio } from './audio.js';
import { createInput } from './input.js';
import { drawHud } from './hud.js';
import { drawTitle, menuKey, resetTitle } from './menu.js';
import { drawPromotion, drawGameOver, promoKey, promoClosed, rematch } from './modal.js';

function historyOf(view) {
  try {
    const h = view.game && view.game.history && view.game.history();
    return Array.isArray(h) ? h : [];
  } catch (_) { return []; }
}

export function createUI({ bus, canvas }) {
  const audio = createAudio(bus);
  K.bus = bus; K.audio = audio;

  let layout = null, prevPhase = null, phaseT0 = 0;

  function track(view) {
    K.view = view;
    if (view.phase !== prevPhase) {
      prevPhase = view.phase;
      phaseT0 = view.t || 0;
      if (view.phase === 'title') resetTitle();
    }
    K.phaseT = Math.max(0, (view.t || 0) - phaseT0);
    K.alpha = view.reducedMotion ? 1 : ease.outCubic(clamp(K.phaseT / 0.6));
    if (!view.promotion) promoClosed();
    K.modal = view.phase === 'title' || view.phase === 'gameover' || !!view.promotion;
  }

  function onKey(e) {
    const view = K.view;
    if (!view) return false;
    audio.resume();
    const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k;
    if (lk === 'm') { if (!e.repeat) bus.emit('ui:mute'); return true; }
    if (e.repeat && lk !== 'ArrowUp' && lk !== 'ArrowDown' && lk !== 'ArrowLeft' && lk !== 'ArrowRight') return true;
    if (view.promotion) return promoKey(k);
    if (view.phase === 'title') return menuKey(k);
    if (lk === 'Escape') { bus.emit('ui:menu'); return true; }
    if (lk === 'u') { bus.emit('ui:undo'); return true; }
    if (lk === 'f') { bus.emit('ui:flip'); return true; }
    if (view.phase === 'gameover' && (lk === 'Enter' || lk === 'r')) { rematch(); return true; }
    return false;
  }

  const input = createInput({ canvas, bus, audio, onKey });

  return {
    resize(l) { layout = l; K.layout = l; },

    update(dt, view) {
      if (!view) return;
      K.dt = Math.min(dt || 0.016, 0.1);
      track(view);
      audio.setMuted(view.muted);
      audio.setAmbient(view.phase === 'title' ? 0.5 : view.phase === 'gameover' ? 0.6 : 1);
    },

    draw(ctx, view) {
      const L = (view && view.layout) || layout;
      if (!view || !L) return;
      track(view);
      begin(ctx, view, L);
      ctx.save();
      ctx.globalAlpha = 1;
      if (view.phase === 'title') {
        drawTitle(view);
      } else {
        ctx.globalAlpha = K.alpha;
        drawHud(view, historyOf(view));
        ctx.globalAlpha = 1;
        if (view.phase === 'gameover') drawGameOver(view);
        if (view.promotion) drawPromotion(view);
      }
      ctx.restore();
      input.refresh();
    },

    dispose() { input.dispose(); audio.dispose(); },
  };
}
