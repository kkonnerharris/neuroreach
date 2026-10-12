/* Look-left / look-right control with OpenCV (opencv.js, in the browser).
 *
 * Headbands like Muse and Crown carry motion sensors, so head gestures are a real headband
 * input next to EEG. Here the webcam stands in for that sensor. OpenCV tracks your face and
 * estimates which way you are looking:
 *     look left  -> Left hand        look right -> Right hand
 *
 * How the direction is found (each frame, on a 320x240 grey image):
 *   1. Frontal-face Haar cascade. As your head turns, your face slides sideways in the image;
 *      the shift from your calibrated centre, in face widths, is the yaw signal.
 *   2. When the turn is big enough that the frontal detector loses you, the profile-face
 *      cascade (run on the image and on its mirror) still finds a side-on face, which
 *      tells us which way you turned.
 * A look has to be held for a few frames to fire, and you look back at the screen to re-arm,
 * so glancing around doesn't send commands. Commands are sent as motion commands (not EEG).
 */
(() => {
  "use strict";
  const OPENCV = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
  const CASCADES = "https://cdn.jsdelivr.net/gh/opencv/opencv@4.10.0/data/haarcascades/";
  const MAP = { left: "left", right: "right" };
  const ARROW = { left: "←", right: "→" };
  const TH = 0.16;        // yaw threshold, in face widths of sideways shift
  const HOLD = 3;         // detections a look must be held before it fires
  const W = 320, H = 240;
  const $ = (s) => document.querySelector(s);

  let cv = null, frontal = null, profile = null, stream = null, running = false;
  let base = null, calib = [], held = { dir: null, n: 0 }, armed = true, lastFire = 0, lastSeen = 0, yaw = 0;
  let swap = false;
  try { swap = localStorage.getItem("nr-head-swap") === "1"; } catch {}
  const video = document.createElement("video");
  video.playsInline = true; video.muted = true;
  const work = document.createElement("canvas"); work.width = W; work.height = H;
  const wctx = work.getContext("2d", { willReadFrequently: true });

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.async = true; s.onload = res; s.onerror = rej; document.head.append(s); });
  }
  async function cascade(file) {
    const xml = new Uint8Array(await (await fetch(CASCADES + file)).arrayBuffer());
    try { cv.FS_createDataFile("/", file, xml, true, false, false); } catch {}
    const c = new cv.CascadeClassifier();
    c.load(file);
    return c;
  }
  async function loadOpenCV() {
    if (cv) return cv;
    status("Loading computer vision (OpenCV)…", "loading"); calibBar(0.15);
    await loadScript(OPENCV);
    let m = window.cv;
    if (m instanceof Promise) m = await m;
    if (!m.Mat) await new Promise((r) => { m.onRuntimeInitialized = r; });
    cv = m;
    [frontal, profile] = await Promise.all([cascade("haarcascade_frontalface_default.xml"), cascade("haarcascade_profileface.xml")]);
    return cv;
  }
  function status(t, state) {
    const el = $("#hc-status"); if (el) el.textContent = t;
    if (state) $("#headcam").dataset.state = state;
  }
  function calibBar(f) { const b = $("#hc-calib-bar"); if (b) b.style.width = `${Math.round(f * 100)}%`; }
  function syncSwap() { $("#hc-swap")?.setAttribute("aria-pressed", String(swap)); }
  function light(dir) {
    document.querySelectorAll("#hc-arrows [data-dir]").forEach((el) => el.classList.toggle("on", el.dataset.dir === dir));
  }

  async function start() {
    $("#headcam").hidden = false;
    $("#head-btn").classList.add("on");
    syncSwap();
    status("Starting camera…", "loading");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: W, height: H, facingMode: "user" }, audio: false });
    } catch {
      status("Camera blocked. Allow camera access in your browser to use look control.", "error");
      return;
    }
    video.srcObject = stream;
    await video.play();
    try { await loadOpenCV(); } catch { status("Couldn't load OpenCV. Check your internet connection.", "error"); return; }
    recalibrate();
    running = true;
    window.NR_headOn = true;
    window.dispatchEvent(new Event("headcontrol"));
    loop();
  }
  function stop() {
    running = false;
    window.NR_headOn = false;
    window.dispatchEvent(new Event("headcontrol"));
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    $("#headcam").hidden = true;
    $("#head-btn").classList.remove("on");
  }
  function recalibrate() {
    base = null; calib = []; armed = true; held = { dir: null, n: 0 }; yaw = 0;
    status("Look straight at the screen to calibrate…", "calib"); calibBar(0);
  }

  // ---- detection -------------------------------------------------------------------------
  function biggest(rects, flipped) {
    let best = null;
    for (let i = 0; i < rects.size(); i++) {
      const r = rects.get(i);
      if (!best || r.width > best.width) best = { x: flipped ? W - r.x - r.width : r.x, y: r.y, width: r.width, height: r.height };
    }
    return best;
  }
  /** One frame -> {face, kind: "frontal" | "profile-a" | "profile-b"} or null. */
  function detect() {
    const src = cv.imread(work), gray = new cv.Mat(), rects = new cv.RectVector();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.equalizeHist(gray, gray);
    const min = new cv.Size(46, 46), max = new cv.Size(0, 0);
    let hit = null;
    try {
      frontal.detectMultiScale(gray, rects, 1.15, 4, 0, min, max);
      let f = biggest(rects, false);
      if (f) hit = { face: f, kind: "frontal" };
      else if (base) { // turned too far for the frontal detector: look for a side-on face
        profile.detectMultiScale(gray, rects, 1.15, 4, 0, min, max);
        f = biggest(rects, false);
        if (f) hit = { face: f, kind: "profile-a" };
        else {
          cv.flip(gray, gray, 1);
          profile.detectMultiScale(gray, rects, 1.15, 4, 0, min, max);
          f = biggest(rects, true);
          if (f) hit = { face: f, kind: "profile-b" };
        }
      }
    } finally { src.delete(); gray.delete(); rects.delete(); }
    return hit;
  }

  let lastProc = 0;
  function loop(now = 0) {
    if (!running) return;
    requestAnimationFrame(loop);
    if (now - lastProc < 66) return; // ~15 detections per second is plenty
    lastProc = now;
    wctx.drawImage(video, 0, 0, W, H);
    const hit = detect();
    if (hit) { lastSeen = now; track(hit, now); }
    else if (now - lastSeen > 900) {
      status(base ? "Face lost. Look back at the screen." : "Looking for your face…", base ? "lost" : "calib");
      held = { dir: null, n: 0 }; yaw *= 0.8;
    }
    draw(hit);
  }

  /** Yaw in face widths: + means you are looking to your right. */
  function yawOf(hit) {
    const f = hit.face, cx = f.x + f.width / 2;
    // In the raw (un-mirrored) camera image your face slides right when you look to your left.
    const d = (base.cx - cx) / base.w;
    if (hit.kind === "frontal") return d;
    // A profile hit means a big turn. Trust the sideways shift for the side when it is clear;
    // otherwise use which cascade fired (profile-a: nose toward image-left = your right).
    const side = Math.abs(d) > 0.06 ? Math.sign(d) : hit.kind === "profile-a" ? 1 : -1;
    return side * Math.max(Math.abs(d), TH * 1.6);
  }

  function track(hit, now) {
    const f = hit.face, cx = f.x + f.width / 2, cy = f.y + f.height / 2, w = f.width;
    if (!base) { // calibrate on ~1 s of a steady, centred frontal face
      if (hit.kind !== "frontal") return;
      calib.push({ cx, cy, w });
      status("Hold still, calibrating…", "calib"); calibBar(calib.length / 14);
      if (calib.length >= 14) {
        const m = (k) => calib.map((c) => c[k]).sort((a, b) => a - b)[calib.length >> 1];
        base = { cx: m("cx"), cy: m("cy"), w: m("w") };
        status("Ready. Look left or right to move the robot.", "ready");
      }
      return;
    }
    const raw = yawOf(hit) * (swap ? -1 : 1);
    yaw += (raw - yaw) * 0.6; // light smoothing against detector jitter
    const dir = yaw <= -TH ? "left" : yaw >= TH ? "right" : null;
    if (hit.kind === "frontal" && Math.abs(yaw) < TH * 0.45) { // resting at centre: follow posture drift, re-arm
      base.cx += (cx - base.cx) * 0.03; base.cy += (cy - base.cy) * 0.03; base.w += (w - base.w) * 0.03;
      if (!armed || $("#headcam").dataset.state !== "ready") status("Ready. Look left or right to move the robot.", "ready");
      armed = true; light(null);
    }
    if (dir && armed) {
      held = held.dir === dir ? { dir, n: held.n + 1 } : { dir, n: 1 };
      light(dir);
      if (held.n >= HOLD && now - lastFire > 900) { // a deliberate look, not a glance
        armed = false; lastFire = now; held = { dir: null, n: 0 };
        status(`${ARROW[dir]} Looked ${dir}: ${dir} hand sent. Look back to re-arm.`, "fired");
        const el = document.querySelector(`#hc-arrows [data-dir="${dir}"]`);
        el?.classList.add("fire"); setTimeout(() => el?.classList.remove("fire"), 600);
        window.NR_headCommand?.(MAP[dir], dir);
      }
    } else if (!dir) held = { dir: null, n: 0 };
  }

  // ---- preview ---------------------------------------------------------------------------
  function draw(hit) {
    const c = $("#hc-view"); if (!c) return;
    const g = c.getContext("2d"), sx = c.width / W, sy = c.height / H;
    g.save(); g.translate(c.width, 0); g.scale(-1, 1); // mirror, like a selfie camera
    g.drawImage(video, 0, 0, c.width, c.height);
    if (base) { g.strokeStyle = "#ffffff55"; g.setLineDash([4, 4]); g.strokeRect((base.cx - base.w / 2) * sx, (base.cy - base.w / 2) * sy, base.w * sx, base.w * sy); g.setLineDash([]); }
    if (hit) { const f = hit.face; g.strokeStyle = hit.kind === "frontal" ? "#d7ff3a" : "#ffb03a"; g.lineWidth = 2; g.strokeRect(f.x * sx, f.y * sy, f.width * sx, f.height * sy); }
    g.restore();
    // look meter: where you are looking, with the two trigger zones
    const mw = c.width - 24, mx = 12, my = c.height - 14, half = mw / 2, k = half / (TH * 2.2);
    g.fillStyle = "#00000088"; g.fillRect(mx - 4, my - 7, mw + 8, 14);
    g.fillStyle = "#d7ff3a33";
    g.fillRect(mx, my - 4, half - TH * k, 8); g.fillRect(mx + half + TH * k, my - 4, half - TH * k, 8);
    if (base) {
      const p = Math.max(-half, Math.min(half, yaw * k));
      g.fillStyle = Math.abs(yaw) >= TH ? "#d7ff3a" : "#ffffff";
      g.beginPath(); g.arc(mx + half + p, my, 5, 0, Math.PI * 2); g.fill();
    }
  }

  // automated checks: feed a still image instead of the camera
  window.NR_headDebug = {
    loadOpenCV, ready: () => !!frontal && !frontal.empty() && !!profile && !profile.empty(),
    detectImage(img, dx = 0) { wctx.fillStyle = "#000"; wctx.fillRect(0, 0, W, H); wctx.drawImage(img, dx, 0, W, H); return detect(); },
    track(img, dx, now) { wctx.fillStyle = "#000"; wctx.fillRect(0, 0, W, H); wctx.drawImage(img, dx, 0, W, H); const h = detect(); if (h) track(h, now); return { hit: h, yaw, base, armed }; },
  };
  document.addEventListener("click", (e) => {
    if (e.target.closest("#head-btn")) (running || !$("#headcam").hidden ? stop : start)();
    if (e.target.closest("#hc-close")) stop();
    if (e.target.closest("#hc-recal")) recalibrate();
    if (e.target.closest("#hc-swap")) {
      swap = !swap; yaw = 0;
      try { localStorage.setItem("nr-head-swap", swap ? "1" : "0"); } catch {}
      syncSwap();
      if (base) status(swap ? "Sides swapped. Look left or right." : "Sides normal. Look left or right.", "ready");
    }
  });
})();
