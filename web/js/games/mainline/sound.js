// Optional sound for Mainline: short blips synthesised with Web Audio (no audio files), in the spirit of the trailer's
// coded score (web/dev/trailer/score.js). Off by default. The AudioContext is created only when the player turns
// sound on (a click, so browsers allow it) and nothing plays before that. View-only: never touches the sim.
//
//   makeSound() → {on, setOn(bool), play("build" | "turn" | "disaster"), close()}

/** The blips: [type, start Hz, end Hz, start s, length s, peak gain] per voice. Pure data, so tests can check it. */
export const BLIPS = {
  // a short wooden "clack" of track going down
  build: [["square", 300, 140, 0, 0.07, 0.10], ["triangle", 900, 500, 0, 0.04, 0.06]],
  // two rising notes, a soft station chime
  turn: [["sine", 660, 660, 0, 0.16, 0.16], ["sine", 880, 880, 0.11, 0.24, 0.14]],
  // a low falling rumble
  disaster: [["sawtooth", 110, 45, 0, 0.55, 0.14], ["triangle", 70, 40, 0.05, 0.6, 0.18]],
};

export function makeSound() {
  let ac = null, master = null;
  // Create (or wake) the AudioContext. Only ever called from a click or key handler: setOn from the toggle, or play
  // from building / ending a turn, so a remembered "on" still waits for the player's first action.
  function ensure() {
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return false;
      if (!ac) {
        ac = new AC();
        master = ac.createGain();
        master.gain.value = 0.6;
        master.connect(ac.destination);
      }
      if (ac.state === "suspended") ac.resume?.().catch(() => {});
      return true;
    } catch { return false; }
  }
  const api = {
    on: false,
    /** Turn sound on or off (the preference). Call from a click handler when the player flips the toggle. */
    setOn(v, { gesture = true } = {}) {
      api.on = !!v;
      if (!api.on) ac?.suspend?.().catch(() => {});
      else if (gesture) ensure();
    },
    play(name) {
      const voices = BLIPS[name];
      if (!api.on || !voices || !ensure()) return;
      const t0 = ac.currentTime + 0.01;
      for (const [type, f0, f1, at, len, peak] of voices) {
        const o = ac.createOscillator(), gn = ac.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, t0 + at);
        if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + at + len);
        gn.gain.setValueAtTime(0.0001, t0 + at);
        gn.gain.exponentialRampToValueAtTime(peak, t0 + at + Math.min(0.012, len / 4));
        gn.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
        o.connect(gn).connect(master);
        o.start(t0 + at);
        o.stop(t0 + at + len + 0.02);
      }
    },
    close() {
      try { ac?.close?.(); } catch { /* ignore */ }
      ac = null;
      master = null;
    },
  };
  return api;
}
