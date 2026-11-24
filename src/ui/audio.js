// Tiny WebAudio synth.  No files.  Pentatonic palette (A minor pentatonic-ish)
// so every cue sits in the same key.  Never throws: if audio is unavailable
// every call is a no-op.

const N = {
  A2: 110, E3: 164.81, A3: 220, C4: 261.63, D4: 293.66, E4: 329.63, G4: 392,
  A4: 440, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5, E6: 1318.5,
};

export function createAudio(bus) {
  let ac = null, out = null, master = null, noiseBuf = null;
  let muted = false, gesture = false, failed = false, active = 0;
  let amb = null, ambLevel = 0;
  const lastPlayed = {};

  function ensure() {
    if (ac || failed) return ac;
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) { failed = true; return null; }
      ac = new C();
      master = ac.createGain();
      master.gain.value = muted ? 0 : 0.5;
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
      master.connect(comp); comp.connect(ac.destination);
      out = ac.createGain(); out.gain.value = 1; out.connect(master);
      // soft echo send
      const send = ac.createGain(); send.gain.value = 0.2;
      const dl = ac.createDelay(1); dl.delayTime.value = 0.17;
      const fb = ac.createGain(); fb.gain.value = 0.3;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
      out.connect(send); send.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(master);
      noiseBuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 1.5), ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      if (ambLevel > 0) startAmbient();
    } catch (e) { failed = true; ac = null; }
    return ac;
  }

  function resume() {
    gesture = true;
    try { ensure(); if (ac && ac.state === 'suspended') ac.resume().catch(() => {}); } catch (e) { /* ignore */ }
  }

  // ---- primitives ----------------------------------------------------------
  function tone({ type = 'sine', f = 440, f2 = 0, t = 0, d = 0.2, v = 0.3, a = 0.004, lp = 0 }) {
    if (active > 48) return;
    const t0 = ac.currentTime + t;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + d);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(v, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    let node = o;
    if (lp) { const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; o.connect(fl); node = fl; }
    node.connect(g); g.connect(out);
    active++; o.onended = () => { active--; };
    o.start(t0); o.stop(t0 + d + 0.05);
  }

  function nz({ t = 0, d = 0.2, v = 0.3, ft = 'bandpass', f = 1000, f2 = 0, q = 1, a = 0.004 }) {
    if (active > 48) return;
    const t0 = ac.currentTime + t;
    const s = ac.createBufferSource(); s.buffer = noiseBuf;
    const fl = ac.createBiquadFilter(); fl.type = ft; fl.Q.value = q;
    fl.frequency.setValueAtTime(f, t0);
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t0 + d);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(v, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    s.connect(fl); fl.connect(g); g.connect(out);
    active++; s.onended = () => { active--; };
    s.start(t0, Math.random() * 0.8); s.stop(t0 + d + 0.05);
  }

  const pluck = (f, t, v, d = 0.3) => {
    tone({ type: 'triangle', f, t, v, d, lp: f * 5 });
    tone({ type: 'sine', f: f * 2, t, v: v * 0.3, d: d * 0.5 });
  };
  const knock = (f, t, v, d = 0.1) => {
    tone({ f, f2: f * 0.55, t, v, d, a: 0.002 });
    nz({ t, d: 0.03, v: v * 0.4, f: f * 4, q: 2, a: 0.001 });
  };

  // ---- the cue table -------------------------------------------------------
  const SFX = {
    select: (v) => { tone({ f: N.E5, v: 0.16 * v, d: 0.09 }); tone({ type: 'triangle', f: N.A5, t: 0.035, v: 0.09 * v, d: 0.08 }); },
    deselect: (v) => { tone({ f: N.A4, f2: N.E4, v: 0.15 * v, d: 0.11 }); },
    illegal: (v) => {
      tone({ type: 'square', f: 150, f2: 110, v: 0.1 * v, d: 0.09, lp: 500 });
      tone({ type: 'square', f: 150, f2: 105, t: 0.11, v: 0.1 * v, d: 0.1, lp: 500 });
    },
    move: (v) => { knock(520, 0, 0.3 * v, 0.09); },
    slide: (v) => { nz({ f: 400, f2: 1800, q: 1.2, d: 0.3, a: 0.1, v: 0.16 * v }); tone({ f: N.A3, f2: N.C4, d: 0.25, a: 0.08, v: 0.04 * v }); },
    leap: (v) => { nz({ f: 700, f2: 3200, q: 1.4, d: 0.22, a: 0.05, v: 0.14 * v }); tone({ f: N.C5, f2: N.C6, d: 0.2, a: 0.04, v: 0.05 * v }); },
    land: (v) => { knock(200, 0, 0.34 * v, 0.14); nz({ ft: 'lowpass', f: 600, d: 0.07, v: 0.14 * v }); },
    slash: (v) => { nz({ ft: 'highpass', f: 3500, f2: 8000, d: 0.13, v: 0.2 * v, a: 0.005 }); tone({ f: 2637, f2: 1900, d: 0.16, v: 0.035 * v }); },
    impact: (v) => { nz({ ft: 'lowpass', f: 1400, f2: 180, d: 0.28, v: 0.34 * v }); tone({ f: 110, f2: 42, d: 0.35, v: 0.45 * v, a: 0.003 }); },
    shatter: (v) => {
      SFX.impact(v * 0.7);
      const pent = [N.E5, N.G5, N.A5, N.C6, N.E6];
      for (let i = 0; i < 9; i++) {
        const t = i * 0.032 + Math.random() * 0.025;
        nz({ ft: 'highpass', f: 4000 + Math.random() * 3000, d: 0.06, v: 0.1 * v, t });
        if (i % 2 === 0) tone({ f: pent[(Math.random() * pent.length) | 0], t, d: 0.35, v: 0.04 * v });
      }
    },
    capture: (v) => { SFX.impact(v * 0.8); knock(300, 0.02, 0.2 * v, 0.1); pluck(N.D5, 0.06, 0.1 * v, 0.25); },
    castle: (v) => { knock(440, 0, 0.26 * v, 0.09); knock(330, 0.11, 0.28 * v, 0.1); nz({ f: 500, f2: 1400, q: 1, d: 0.2, a: 0.06, v: 0.06 * v, t: 0.02 }); },
    promote: (v) => {
      [N.C5, N.E5, N.G5, N.C6, N.E6].forEach((f, i) => { pluck(f, i * 0.065, 0.15 * v, 0.4); });
      tone({ f: N.C6, t: 0.3, d: 0.6, v: 0.05 * v, a: 0.05 });
    },
    check: (v) => {
      tone({ type: 'triangle', f: N.A5, v: 0.2 * v, d: 0.18 });
      tone({ f: N.E6, t: 0.07, v: 0.13 * v, d: 0.22 });
      nz({ ft: 'highpass', f: 5000, d: 0.05, v: 0.07 * v });
    },
    mate: (v) => {
      [[N.A4, 0], [N.G4, 0.22], [N.E4, 0.44], [N.A3, 0.7]].forEach(([f, t]) => {
        tone({ type: 'triangle', f, t, d: 0.75, v: 0.24 * v, lp: 2200 });
        tone({ f: f / 2, t, d: 0.85, v: 0.12 * v });
      });
      tone({ f: 82, f2: 55, t: 0.7, d: 0.9, v: 0.3 * v });
    },
    draw: (v) => {
      pluck(N.E4, 0, 0.2 * v, 0.7); pluck(N.A4, 0.02, 0.14 * v, 0.7); pluck(N.D4, 0.3, 0.2 * v, 0.9);
    },
    start: (v) => {
      pluck(N.E4, 0, 0.16 * v); pluck(N.A4, 0.08, 0.16 * v); pluck(N.E5, 0.16, 0.16 * v, 0.5);
      nz({ f: 500, f2: 2500, q: 1, d: 0.35, a: 0.12, v: 0.06 * v });
    },
    ui: (v) => { tone({ f: 1200, v: 0.09 * v, d: 0.04 }); },
    tick: (v) => { tone({ f: 1800, v: 0.05 * v, d: 0.025 }); },
  };

  function play(name, intensity = 1) {
    if (muted || !gesture) return;
    try {
      if (!ensure() || ac.state !== 'running') return;
      const fn = SFX[name];
      if (!fn) return;
      const now = ac.currentTime;
      if (lastPlayed[name] && now - lastPlayed[name] < 0.02) return;   // de-dupe bursts
      lastPlayed[name] = now;
      fn(Math.min(1.6, Math.max(0.2, Number(intensity) || 1)));
    } catch (e) { /* never throw */ }
  }

  // ---- ambient drone -----------------------------------------------------------
  function startAmbient() {
    if (amb || !ac) return;
    try {
      const g = ac.createGain(); g.gain.value = 0;
      const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 520; fl.Q.value = 0.7;
      fl.connect(g); g.connect(master);
      const lfoF = ac.createOscillator(), lfoG = ac.createGain();
      lfoF.frequency.value = 0.05; lfoG.gain.value = 220; lfoF.connect(lfoG); lfoG.connect(fl.frequency); lfoF.start();
      const oscs = [lfoF];
      [[N.A2, 'sine', 0.5], [N.E3, 'sine', 0.35], [N.A3 * 1.004, 'triangle', 0.18], [N.E4 * 0.997, 'sine', 0.1]].forEach(([f, type, v], i) => {
        const o = ac.createOscillator(), og = ac.createGain();
        o.type = type; o.frequency.value = f; og.gain.value = v;
        const l = ac.createOscillator(), lg = ac.createGain();
        l.frequency.value = 0.07 + i * 0.031; lg.gain.value = v * 0.5;
        l.connect(lg); lg.connect(og.gain); l.start();
        o.connect(og); og.connect(fl); o.start();
        oscs.push(o, l);
      });
      amb = { g, oscs };
      setAmbient(ambLevel);
    } catch (e) { amb = null; }
  }
  function setAmbient(level) {
    ambLevel = level;
    if (!ac) return;
    try {
      if (level > 0 && !amb) startAmbient();
      if (amb) amb.g.gain.setTargetAtTime(level * 0.07, ac.currentTime, 1.5);
    } catch (e) { /* ignore */ }
  }
  function setMuted(m) {
    m = !!m;
    if (m === muted) return;
    muted = m;
    if (ac && master) { try { master.gain.setTargetAtTime(muted ? 0 : 0.5, ac.currentTime, 0.04); } catch (e) { /* ignore */ } }
  }

  const off = bus.on('sfx', (e) => { if (e) play(e.name, e.intensity === undefined ? 1 : e.intensity); });

  return {
    resume, play, setMuted, setAmbient,
    get ready() { return !!ac; },
    names: Object.keys(SFX),
    dispose() { off(); try { ac && ac.close(); } catch (e) { /* ignore */ } ac = null; },
  };
}
