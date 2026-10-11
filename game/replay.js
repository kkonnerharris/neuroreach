/* NeuroReach web edition: stands in for sim/server.py when the game is hosted statically.
 *
 * - /api/* requests are answered here instead of by Python.
 * - The brain signal you drop is decoded live in your browser (eegdecoder.js: the same
 *   CSP + LDA as the server, verified on all 374 trials).
 * - Robot motion is replayed from runs recorded in the real PyBullet simulation
 *   (sim/record_web.py): one clip per step when the decoded command matches, and the arm's
 *   "no" when it doesn't. Frames feed the viewer through the same interpolation path.
 */
(() => {
  "use strict";
  const listeners = new Set();
  const cache = {};
  let levels = null, level = null, data = null, decoder = null;
  let poses = {}, clip = null;
  const state = { phase: "booting", level: null, step: 0, levelDone: false, lampOn: false, flags: {}, holding: false,
    bins: { left: 0, right: 0, fists: 0, feet: 0, rest: 0, floor: 0 }, result: null, scene: "home" };
  const getJSON = (u) => (cache[u] ??= fetch(u).then((r) => r.json()));
  const decoderReady = import("./eegdecoder.js").then((m) => new m.BrowserDecoder().load("eeg/")).then((d) => (decoder = d));
  getJSON("levels.json").then((l) => (levels = l));

  function emit(name, payload) {
    const ev = { data: JSON.stringify(payload) };
    for (const es of listeners) (es.handlers[name] || []).forEach((f) => f(ev));
  }
  function applyFrame(f) {
    if (f.scene) emit("scene", f.scene);
    Object.assign(poses, f.p);
    Object.assign(state, f.s);
  }
  // 50 Hz: advance the playing clip and stream poses + state, like the live server does
  setInterval(() => {
    if (clip) {
      const t = (performance.now() - clip.t0) / 1000;
      while (clip.i < clip.frames.length && clip.frames[clip.i].t <= t) applyFrame(clip.frames[clip.i++]);
      if (clip.i >= clip.frames.length) {
        const c = clip; clip = null;
        if (!c.ok) state.step = c.step;                       // a "no" doesn't advance the task
        state.phase = "idle";
        state.result = { trial: c.id, ok: c.ok, expected: c.expected, commanded: c.dec.command, conf: c.dec.conf, landed: null };
      }
    }
    if (listeners.size) emit("pose", { t: performance.now() / 1000, poses, state });
  }, 20);

  async function loadLevel(id) {
    levels ??= await getJSON("levels.json");
    level = levels.find((l) => l.id === id);
    state.phase = "loading"; state.level = id;
    data = await getJSON(`levels/${id}.json`);
    poses = {}; clip = null;
    applyFrame(data.start);
    Object.assign(state, { level: id, step: 0, levelDone: false, lampOn: false, flags: {}, holding: false, result: null, scene: level.scene, phase: "idle" });
  }
  async function step(id, trial) {
    await decoderReady;
    if (!decoder.has(trial) || !level || clip) return null;
    const dec = decoder.decode(trial), i = state.step, st = level.steps[i];
    if (!st) return null;
    const ok = dec.command === st.cmd;
    state.phase = "acting"; state.result = null;
    clip = { frames: ok ? data.ok[i] : data.confused[i], i: 0, t0: performance.now(), ok, id, dec, step: i, expected: st.cmd };
    return { ok: true, decode: dec };
  }

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const m = url.match(/\/api\/([a-z/]+)/);
    if (!m) return realFetch(input, init);
    const body = init.body ? JSON.parse(init.body) : {};
    switch (m[1]) {
      case "levels": return json(await getJSON("levels.json"));
      case "state": return json(state);
      case "level": await loadLevel(body.id); return json({ ok: true });
      case "step": { const r = await step(body.id, body.trial); return r ? json(r) : json({ error: "busy" }, 409); }
      case "decode": await decoderReady; return json(decoder.decode(body.trial));
      default: return json({ ok: true }); // order, ship, reset...: visual-only in the web edition
    }
  };
  const RealES = window.EventSource;
  window.EventSource = class {
    constructor(url) {
      if (!/\/api\/events/.test(url)) return new RealES(url);
      this.handlers = {};
      listeners.add(this);
      // replay the current scene to a late subscriber
      setTimeout(() => { if (data) emit("scene", data.start.scene); }, 0);
    }
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    close() { listeners.delete(this); }
  };
  document.documentElement.classList.add("web-edition");
})();
