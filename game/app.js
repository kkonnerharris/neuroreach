/* NeuroReach Work Cell — operator console.
 *
 * Library: labeled, held-out PhysioNet EEGMMIDB epochs (export_eeg.py -> eeg-deck.js). Five
 * commands — left fist, right fist, both fists, both feet, rest — imagined and executed.
 * Program: drag labeled EEG trials in as robot instructions. Running the program plays each
 * trial back, applies the exported CSP+LDA decision, and sends the decoded command to the
 * PyBullet cell (sim/server.py), which reports where the part physically ended up. A step
 * succeeds when the robot did what the EEG's label intended.
 */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SIM = location.protocol.startsWith("http");
  const MAX_STEPS = 16;
  // EEG devices: which electrodes each one has, and the traces shown for it.
  const LANE_COLORS = ["#ffb547", "#b79cff", "#4fe3d1", "#ff8fb1"];
  const DEVICE = {
    cap: { name: "Lab EEG cap", short: "Lab cap", ch: 21, icon: "🧢", lanes: [["c3", "C3"], ["cz", "Cz"], ["c4", "C4"]],
      sites: ["FC5", "FC3", "FC1", "FCz", "FC2", "FC4", "FC6", "C5", "C3", "C1", "Cz", "C2", "C4", "C6", "CP5", "CP3", "CP1", "CPz", "CP2", "CP4", "CP6"],
      blurb: "Research cap: 21 electrodes right over the motor cortex." },
    crown: { name: "Crown-style headband", short: "Crown", ch: 8, icon: "🎧", lanes: [["c3", "C3"], ["cp3", "CP3"], ["c4", "C4"], ["cp4", "CP4"]],
      sites: ["C3", "C4", "CP3", "CP4", "F5", "F6", "PO3", "PO4"],
      blurb: "Consumer headband over the top of the head: 8 sensors, 4 of them over the motor strip." },
    muse: { name: "Muse-style headband", short: "Muse", ch: 4, icon: "🎀", lanes: [["af7", "AF7"], ["af8", "AF8"], ["t9", "TP9*"], ["t10", "TP10*"]],
      sites: ["AF7", "AF8", "T9", "T10"],
      blurb: "Forehead + behind-the-ear headband: 4 sensors, none over the motor cortex. (*TP9/TP10 approximated by T9/T10.)" },
  };
  let CH = [];
  const devOf = (c) => c?.dev?.[S.device] || c; // this device's decoder output for a trial
  function applyDeviceLanes() { CH = DEVICE[S.device].lanes.map(([k, n], i) => [k, n, LANE_COLORS[i]]); }
  // electrode positions on a top-down head (nose up), for the little head maps
  const SITE_XY = { FC5: [-.72, -.24], FC3: [-.46, -.26], FC1: [-.22, -.27], FCz: [0, -.27], FC2: [.22, -.27], FC4: [.46, -.26], FC6: [.72, -.24],
    C5: [-.75, 0], C3: [-.5, 0], C1: [-.25, 0], Cz: [0, 0], C2: [.25, 0], C4: [.5, 0], C6: [.75, 0],
    CP5: [-.72, .24], CP3: [-.46, .26], CP1: [-.22, .27], CPz: [0, .27], CP2: [.22, .27], CP4: [.46, .26], CP6: [.72, .24],
    F5: [-.55, -.5], F6: [.55, -.5], PO3: [-.24, .7], PO4: [.24, .7], AF7: [-.45, -.78], AF8: [.45, -.78], T9: [-.98, .1], T10: [.98, .1] };
  function headSvg(dev, size = 64) {
    const on = new Set(DEVICE[dev].sites), dot = ([x, y], lit) => `<circle cx="${x * 46}" cy="${y * 46}" r="${lit ? 5.2 : 2.6}" class="${lit ? "lit" : "off"}"/>`;
    const motor = `<ellipse cx="0" cy="0" rx="40" ry="12" class="strip"/>`;
    return `<svg class="headmap" viewBox="-60 -62 120 120" width="${size}" height="${size}" aria-hidden="true">
      <path d="M-7 -49 L0 -58 L7 -49" class="nose"/><path d="M-50 -6 q-7 6 0 12 M50 -6 q7 6 0 12" class="ear"/>
      <circle r="49" class="skull"/>${motor}${Object.entries(SITE_XY).map(([n, xy]) => dot(xy, on.has(n))).join("")}</svg>`;
  }

  const CMD = {
    left:  { name: "Left fist",  icon: "◀", zone: "BOX A",    act: "Pack in BOX A",     jog: "Rotate left",  part: "Computer",    color: "#5b9bff", rgba: [0.36, 0.61, 1, 1],   sig: "μ-ERD over C4 (right motor cortex)" },
    right: { name: "Right fist", icon: "▶", zone: "BOX B",    act: "Pack in BOX B",     jog: "Rotate right", part: "Computer",    color: "#ff8f3a", rgba: [1, 0.56, 0.23, 1],   sig: "μ-ERD over C3 (left motor cortex)" },
    fists: { name: "Both fists", icon: "◆", zone: "ASSEMBLY", act: "Send to ASSEMBLY",  jog: "Raise",        part: "Sub-assembly", color: "#e9eeeb", rgba: [0.91, 0.93, 0.92, 1], sig: "bilateral ERD over C3 and C4" },
    feet:  { name: "Both feet",  icon: "▼", zone: "REJECT",   act: "Send to REJECT",    jog: "Lower · grab / release", part: "Defective",    color: "#ff5d6c", rgba: [1, 0.36, 0.42, 1],   sig: "ERD at the vertex (Cz)" },
    rest:  { name: "Rest",       icon: "■", zone: "HOLD",     act: "Hold on infeed",    jog: "Hold still",   part: "Pending QC",   color: "#ffd84a", rgba: [1, 0.85, 0.29, 1],   sig: "no task-related ERD" },
  };
  const KEYS = Object.keys(CMD);
  const zoneName = (z) => (z === "floor" ? "DROPPED" : z === "rest" ? "HELD ON INFEED" : CMD[z]?.zone ?? z);

  const S = {
    deck: null, cards: [], paradigm: "imagined", subject: "all", cmd: "all",
    steps: [], busy: false, runSeq: 1, view: "task", jogs: [], jogSeq: 0, task: null,
    sim: null, counts: {}, history: [],
  };
  S.device = (() => { try { return localStorage.getItem("nr-device") || "crown"; } catch { return "crown"; } })();
  if (!DEVICE[S.device]) S.device = "crown";
  applyDeviceLanes();

  // ---------------------------------------------------------------- library
  function loadDeck(deck) {
    if (!deck || !Array.isArray(deck.subjects)) throw new Error("not an EEG library (missing subjects[])");
    const cards = [];
    for (const sub of deck.subjects) for (const c of sub.cards || []) {
      if (!Array.isArray(c.c3) || !Array.isArray(c.c4) || !c.label || !c.pred) throw new Error(`trial ${c.id} is missing fields`);
      const paradigm = c.paradigm || sub.paradigm || "imagined";
      const proba = c.proba || { [c.pred]: c.conf, [c.pred === "left" ? "right" : "left"]: 1 - c.conf };
      cards.push({ ...c, paradigm, proba, subject: sub.subject });
    }
    if (!cards.length) throw new Error("library has no trials");
    S.deck = deck; S.cards = cards; S.subject = "all"; S.cmd = "all"; S.steps = [];
    const paradigms = [...new Set(cards.map((c) => c.paradigm))];
    if (!paradigms.includes(S.paradigm)) S.paradigm = paradigms[0];
    $$("#paradigm-seg button").forEach((b) => { b.disabled = !paradigms.includes(b.dataset.paradigm); b.classList.toggle("on", b.dataset.paradigm === S.paradigm); });
    renderAll();
    $("#deck-empty").hidden = true;
    $("#deck-status").textContent = `${cards.length} trials · ${new Set(deck.subjects.map((s) => s.subject)).size} subjects`;
    $("#dot-deck").classList.add("on");
    $("#source").textContent = `${deck.source} · ${deck.selection || ""} · library holds held-out test epochs only; every decoder output shown is out-of-sample.`;
  }

  const pool = () => S.cards.filter((c) => c.paradigm === S.paradigm && (S.subject === "all" || c.subject === S.subject));
  const byId = (id) => S.cards.find((c) => c.id === id);
  const stepOf = (id) => S.steps.findIndex((s) => s.cardId === id);
  const pctStr = (v) => `${v > 0 ? "+" : ""}${Math.round(v)}%`;
  const erdOf = (c, ch) => c["erd" + ch[0].toUpperCase() + ch.slice(1)];

  function renderFilters() {
    const p = pool();
    const counts = Object.fromEntries(KEYS.map((k) => [k, p.filter((c) => c.label === k).length]));
    $("#cmd-chips").innerHTML = [`<button class="chip ${S.cmd === "all" ? "on" : ""}" data-c="all">All <b>${p.length}</b></button>`]
      .concat(KEYS.filter((k) => counts[k]).map((k) => `<button class="chip cmd ${S.cmd === k ? "on" : ""}" data-c="${k}" style="--c:${CMD[k].color}"><i class="sw"></i>${CMD[k].name} <b>${counts[k]}</b></button>`)).join("");
    const subs = S.deck.subjects.filter((s) => (s.paradigm || "imagined") === S.paradigm);
    $("#chips").innerHTML = [`<button class="chip ${S.subject === "all" ? "on" : ""}" data-s="all">All subjects</button>`]
      .concat(subs.map((s) => `<button class="chip ${S.subject === s.subject ? "on" : ""}" data-s="${s.subject}" title="held-out decoder accuracy ${Math.round(s.testAcc * 100)}% on ${s.nTest} trials">S${String(s.subject).padStart(3, "0")} · <b>${Math.round(s.testAcc * 100)}%</b></button>`)).join("");
  }

  function erdBars(c) {
    return CH.filter(([k]) => erdOf(c, k) !== undefined).map(([k, label]) => {
      const v = erdOf(c, k), x = clamp(v / 100, -1, 1);
      return `<span class="${k}">${label}</span><i style="--neg:${Math.min(x, 0)};--mag:${Math.abs(x)};--col:${x < 0 ? `var(--${k})` : "var(--faint)"}"></i><b>${pctStr(v)}</b>`;
    }).join("");
  }

  function renderCards() {
    let list = pool();
    if (S.cmd !== "all") list = list.filter((c) => c.label === S.cmd);
    const need = S.view === "task" ? currentJob() : null;
    if (need) { // the cards that do the current job go first: reliable ones, then the rest
      const rank = (c) => (c.label === need ? (c.pred === c.label ? 0 : 1) : 2);
      list = [...list].sort((a, b) => rank(a) - rank(b));
    }
    $("#lib-count").textContent = `${list.length} shown`;
    $("#cards").innerHTML = list.map((c, i) => {
      const m = CMD[c.label], used = stepOf(c.id), ok = c.pred === c.label;
      const suggest = need && c.label === need;
      return `<button class="card ${used >= 0 && S.view === "program" ? "used" : ""} ${suggest ? "suggest" : ""} ${need && !suggest ? "dim-card" : ""}" data-id="${c.id}" style="--c:${m.color};animation-delay:${Math.min(i, 16) * 18}ms"
          aria-label="${m.name} EEG trial ${c.id}. ${S.view === "direct" ? m.jog + ". Drag onto the robot or press Enter to send." : m.act + ". Drag into the robot program or press Enter to append."}">
        <div class="card-cmd"><span class="ico">${m.icon}</span><b>${m.name}</b><span class="act">→ ${S.view === "direct" ? m.jog.toUpperCase() : m.zone}</span>${used >= 0 ? `<span class="step-no">step ${used + 1}</span>` : ""}</div>
        ${suggest ? `<span class="use-this">${ok ? "Use this" : "Fits job · decoder may misread"}</span>` : ""}
        <canvas class="spark"></canvas>
        <div class="erd">${erdBars(c)}</div>
        <div class="card-foot"><span class="cid">${c.id} · ${c.paradigm === "executed" ? "EXEC" : "IMAG"}</span>
          <span class="dec ${ok ? "ok" : "bad"}" title="Preview of what the live decoder will read from this trial">${ok ? "✓" : "✗"} decodes ${ok ? "" : CMD[c.pred].name + " "}${Math.round(c.conf * 100)}%</span></div>
      </button>`;
    }).join("") || `<p class="none">No trials match this filter.</p>`;
    requestAnimationFrame(() => $$("#cards .card").forEach((el) => drawSpark(el.querySelector("canvas"), byId(el.dataset.id))));
  }

  function robustMax(c) {
    const v = CH.flatMap(([k]) => c[k] || []).map(Math.abs).sort((a, b) => a - b);
    return v[Math.floor(v.length * 0.98)] || 1;
  }
  function lane(g, arr, w, mid, half, m, color, upto = arr.length) {
    g.strokeStyle = color; g.lineWidth = 1.1; g.lineJoin = "round";
    g.beginPath();
    for (let i = 0; i < upto; i++) {
      const x = (i / (arr.length - 1)) * w, y = mid - clamp(arr[i] / m, -1.2, 1.2) * half;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  function drawSpark(cv, c) {
    if (!cv || !c) return;
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext("2d"); g.scale(dpr, dpr);
    const m = robustMax(c), lanes = CH.filter(([k]) => c[k]);
    const x0 = ((0 - S.deck.tmin) * S.deck.sfreq) / c.c3.length * w;
    g.fillStyle = "#ffffff14"; g.fillRect(x0, 0, 1, h);
    lanes.forEach(([k, , col], j) => lane(g, c[k], w, (h * (j + 0.5)) / lanes.length, h / lanes.length / 2.1, m, col));
  }

  // ---------------------------------------------------------------- program
  function renderSteps() {
    const rows = S.steps.map((st, i) => {
      const c = byId(st.cardId), m = CMD[c.label], r = st.result, ok = c.pred === c.label;
      const res = r ? `<span class="res ${r.ok ? "ok" : "bad"}">${r.ok ? "✓ Done" : "✗ " + zoneName(r.landed)}${r.cause ? `<small>${r.cause}</small>` : `<small>${zoneName(r.landed)}</small>`}</span>` : "";
      return `<li class="step ${r ? (r.ok ? "ok" : "bad") : ""}" data-i="${i}" style="--c:${m.color};--d:${i * 20}ms">
        <span class="grip" aria-hidden="true">⋮⋮</span>
        <span class="n">${String(i + 1).padStart(2, "0")}</span>
        <span class="instr"><span class="ico">${m.icon}</span><b>${m.name}</b><span class="arrow">→</span><span class="act">${m.act}</span></span>
        <canvas class="spark mini"></canvas>
        <span class="meta"><span class="cid">${c.id}</span><span class="dec ${ok ? "ok" : "bad"}">decoder: ${CMD[c.pred].name} ${Math.round(c.conf * 100)}%</span></span>
        <span class="result">${res}</span>
        <button class="x" data-x="${i}" aria-label="Remove step ${i + 1}">×</button>
      </li>`;
    });
    if (S.steps.length < MAX_STEPS) rows.push(`<li class="step end" data-i="${S.steps.length}"><span>${S.steps.length ? "Drop here to append an instruction" : "Drag labeled EEG trials here to build the robot's instructions"}</span></li>`);
    $("#lines").innerHTML = rows.join("");
    requestAnimationFrame(() => $$("#lines .step:not(.end)").forEach((el) => drawSpark(el.querySelector("canvas"), byId(S.steps[+el.dataset.i].cardId))));
    updatePerform();
  }
  function updatePerform() {
    const n = S.steps.length, mis = S.steps.filter((s) => { const c = byId(s.cardId); return c.pred !== c.label; }).length;
    $("#perform").disabled = S.busy || !n;
    $("#order-hint").textContent = S.busy ? "Running. The robot executes each instruction as the decoder reads it."
      : !n ? "Each EEG trial you add becomes one robot instruction, executed in order."
        : `${n} instruction${n > 1 ? "s" : ""}.${mis ? ` ${mis} will be misread by the decoder (marked ✗): that's the real BCI error rate.` : ""}`;
  }

  function insert(cardId, at, from = -1) {
    if (S.busy) return toast("The program is running");
    if (from < 0 && S.steps.length >= MAX_STEPS) return toast(`Programs are limited to ${MAX_STEPS} instructions`);
    let step = { cardId, result: null };
    if (from >= 0) { step = S.steps.splice(from, 1)[0]; if (from < at) at--; }
    else if (stepOf(cardId) >= 0) return toast(`Already used as step ${stepOf(cardId) + 1}`);
    S.steps.splice(clamp(at, 0, S.steps.length), 0, step);
    S.steps.forEach((s) => (s.result = null));
    renderSteps(); renderCards();
    $(`#lines .step[data-i="${clamp(at, 0, S.steps.length - 1)}"]`)?.classList.add("landed");
  }
  function remove(i) {
    if (S.busy) return;
    S.steps.splice(i, 1);
    S.steps.forEach((s) => (s.result = null));
    renderSteps(); renderCards();
  }

  $("#lines").addEventListener("click", (e) => { const x = e.target.closest("[data-x]"); if (x && !S.busy) remove(+x.dataset.x); });
  $("#clear").addEventListener("click", () => { if (S.busy) return; S.steps = []; renderSteps(); renderCards(); });
  $("#sample").addEventListener("click", () => {
    if (S.busy || !S.deck) return;
    const free = pool().filter((c) => stepOf(c.id) < 0);
    for (const k of KEYS) {
      const opts = free.filter((c) => c.label === k);
      if (opts.length && S.steps.length < MAX_STEPS) S.steps.push({ cardId: opts[Math.floor(Math.random() * opts.length)].id, result: null });
    }
    S.steps.forEach((s) => (s.result = null));
    renderSteps(); renderCards();
  });

  // ---------------------------------------------------------------- drag & drop (pointer events: mouse + touch)
  let press = null, drag = null, suppressClick = false;
  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || S.busy || e.target.closest(".x")) return;
    const card = e.target.closest("#cards .card, #tiles .tile[data-id]"), step = e.target.closest("#lines .step:not(.end)");
    const el = card || step;
    if (!el) return;
    const id = card ? card.dataset.id : S.steps[+step.dataset.i].cardId;
    press = { el, id, from: step ? +step.dataset.i : -1, x: e.clientX, y: e.clientY, pid: e.pointerId, type: e.pointerType };
  });
  window.addEventListener("pointermove", (e) => {
    if (drag) return moveGhost(e);
    if (!press || e.pointerId !== press.pid) return;
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (Math.hypot(dx, dy) < 7) return;
    if (press.type !== "mouse" && press.from < 0) {
      const horizontal = getComputedStyle($("#cards")).gridAutoFlow.startsWith("column");
      if (horizontal ? Math.abs(dx) > Math.abs(dy) : Math.abs(dy) > Math.abs(dx)) { press = null; return; }
    }
    startDrag(e);
  });
  window.addEventListener("pointerup", (e) => { if (drag) finishDrag(targetAt(e)); press = null; });
  window.addEventListener("pointercancel", () => { if (drag) finishDrag(undefined); press = null; });
  $("#cards").addEventListener("click", (e) => {
    const el = e.target.closest(".card");
    if (!el) return;
    if (suppressClick) { suppressClick = false; return; }
    if (S.view === "task") runTask(byId(el.dataset.id));
    else if (S.view === "direct") jog(byId(el.dataset.id));
    else insert(el.dataset.id, S.steps.length);
  });

  function startDrag(e) {
    const c = byId(press.id), m = CMD[c.label];
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.style.setProperty("--c", m.color);
    if (document.body.classList.contains("simple")) {
      ghost.innerHTML = `<div class="card-cmd"><span class="ico big">${PLAIN[c.label].icon}</span><b>${PLAIN[c.label].label}</b></div><canvas class="spark"></canvas><span class="ghost-hint">Drop on the robot</span>`;
    } else ghost.innerHTML = `<div class="card-cmd"><span class="ico">${m.icon}</span><b>${m.name}</b><span class="act">→ ${S.view === "direct" ? m.jog.toUpperCase() : m.zone}</span></div><canvas class="spark"></canvas><span class="ghost-hint">${press.from >= 0 ? "Move instruction · drop outside to remove" : S.view === "direct" ? "Drop on the robot to move it" : S.view === "task" ? "Drop on the robot to do this job" : "Drop into the robot program"}</span>`;
    document.body.append(ghost);
    drawSpark(ghost.querySelector("canvas"), c);
    press.el.classList.add("lifted");
    drag = { ...press, ghost };
    document.body.classList.add("dragging");
    moveGhost(e);
  }
  function targetAt(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (S.view === "direct") return el?.closest("#arena, #jogpad") && drag?.from < 0 ? "jog" : null;
    if (document.body.classList.contains("simple")) return el?.closest("#arena") && !el.closest("#hotbar") && drag?.from < 0 ? "level" : null;
    if (S.view === "task") return el?.closest("#arena, #task") && drag?.from < 0 ? "task" : null;
    const step = el?.closest("#lines .step");
    if (step) {
      const r = step.getBoundingClientRect(), i = +step.dataset.i;
      return step.classList.contains("end") ? i : e.clientY > r.top + r.height / 2 ? i + 1 : i; // insert above/below
    }
    if (el?.closest("#order, #arena")) return S.steps.length;
    return null;
  }
  function moveGhost(e) {
    drag.ghost.style.left = e.clientX + "px";
    drag.ghost.style.top = e.clientY + "px";
    const t = targetAt(e);
    $("#jogpad").classList.toggle("hover", t === "jog");
    $("#arena").classList.toggle("drop-hover", t === "jog" || t === "task" || t === "level");
    $("#job").classList.toggle("hover", t === "task");
    $$("#lines .step").forEach((li) => {
      const i = +li.dataset.i;
      li.classList.toggle("ins-before", t === i && !li.classList.contains("end"));
      li.classList.toggle("ins-after", t === i + 1 && i === S.steps.length - 1);
      li.classList.toggle("hover", li.classList.contains("end") && t === S.steps.length);
    });
  }
  function finishDrag(t) {
    const d = drag;
    drag = null;
    d.el.classList.remove("lifted");
    d.ghost.remove();
    document.body.classList.remove("dragging");
    $$("#lines .step").forEach((li) => li.classList.remove("ins-before", "ins-after", "hover"));
    $("#jogpad").classList.remove("hover"); $("#arena").classList.remove("drop-hover"); $("#job").classList.remove("hover");
    suppressClick = true; setTimeout(() => (suppressClick = false), 0);
    if (t === undefined) return;
    if (t === "jog") return jog(byId(d.id));
    if (t === "task") return runTask(byId(d.id));
    if (t === "level") return runLevelStep(byId(d.id));
    if (t !== null) insert(d.id, t, d.from);
    else if (d.from >= 0) remove(d.from); // dragged out of the program
  }

  // library files dropped from the desktop
  let fileDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); fileDepth++; $("#dropveil").hidden = false; });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; if (--fileDepth <= 0) { fileDepth = 0; $("#dropveil").hidden = true; } });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); fileDepth = 0; $("#dropveil").hidden = true;
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (S.busy) return toast("Wait for the program to finish before loading a library");
    try {
      const text = (await file.text()).trim().replace(/^window\.EEG_DECK\s*=\s*/, "").replace(/;\s*$/, "");
      loadDeck(JSON.parse(text));
      toast(`Loaded ${file.name}: ${S.cards.length} trials`);
    } catch (err) { toast(`Couldn't load ${file.name}: ${err.message}`); }
  });

  // ---------------------------------------------------------------- run
  $("#perform").addEventListener("click", run);

  async function run() {
    if (S.busy || !S.steps.length) return;
    if (!S.sim) toast("Simulator offline: decoding only, no physical execution");
    S.busy = true;
    document.body.classList.add("running");
    S.steps.forEach((s) => (s.result = null));
    renderSteps();
    const t0 = performance.now();
    for (let i = 0; i < S.steps.length; i++) {
      const st = S.steps[i], card = byId(st.cardId), intended = card.label;
      const li = $(`#lines .step[data-i="${i}"]`);
      li.classList.add("active");
      li.scrollIntoView({ block: "nearest", behavior: "smooth" });
      post("/api/order", { zone: intended, rgba: CMD[intended].rgba });
      const res = await runStep(card, i);
      const ok = res.landed === intended;
      st.result = { ok, landed: res.landed, offline: !!res.offline, cause: ok ? "" : card.pred !== card.label ? "decoder misread" : "handling" };
      renderSteps(); renderCards();
      banner(card, st.result);
      liveKpis((performance.now() - t0) / 1000);
      if (S.sim && !res.offline) await waitFor((s) => s.phase === "idle", 15000);
    }
    const secs = (performance.now() - t0) / 1000;
    post("/api/order", { zone: null });
    S.busy = false;
    document.body.classList.remove("running");
    $("#mon-id").textContent = "idle";
    setPhase(null);
    report(secs);
    updatePerform();
  }

  async function runStep(card, i) {
    $("#mon-id").textContent = `step ${i + 1} · ${card.id}`;
    resetMonitor();
    if (S.sim) post("/api/trial/start", { id: card.id }); // arm picks the part while the EEG plays
    await playback(card);
    setPhase("decode");
    const fallback = { landed: card.pred, offline: true };
    if (!S.sim) { showPosterior(asDecode(card)); await sleep(1200); return fallback; }
    const runId = `${card.id}#${++S.jogSeq}`;
    const resp = await postJson("/api/trial/decide", { id: runId, trial: card.id }); // server decodes the EEG now
    showPosterior(resp?.decode || asDecode(card));
    setPhase("act");
    if (!resp) return fallback;
    const st = await waitFor((s) => s.result && s.result.trial === runId, 25000);
    return st?.result || fallback;
  }

  function playback(card, speed = 1, onTick = null) {
    const { sfreq, tmin } = S.deck;
    const n = card.c3.length, dur = n / sfreq, pre = Math.round(-tmin * sfreq), win = Math.round(0.5 * sfreq);
    const base = Object.fromEntries(CH.filter(([k]) => card[k]).map(([k]) => [k, meanSq(card[k], 0, pre)]));
    const m = robustMax(card);
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        const t = Math.min(dur, ((now - t0) / 1000) * speed), i = Math.floor(t * sfreq), tt = t + tmin;
        setPhase(tt < 0 ? "rest" : tt < 0.5 ? "cue" : "imagery");
        drawScope(card, i, m);
        onTick?.(i);
        if (i > win) setGauges(Object.fromEntries(Object.entries(base).map(([k, b]) => [k, pct(meanSq(card[k], i - win, i), b)])));
        if (t < dur) requestAnimationFrame(tick);
        else { drawScope(card, n, m); setGauges(Object.fromEntries(CH.map(([k]) => [k, erdOf(card, k)]).filter(([, v]) => v !== undefined)), true); resolve(); }
      };
      requestAnimationFrame(tick);
    });
  }
  const meanSq = (a, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += a[i] * a[i]; return s / Math.max(1, i1 - i0); };
  const pct = (p, b) => clamp((100 * (p - b)) / (b || 1), -100, 200);

  // ---------------------------------------------------------------- direct control
  async function jog(card) {
    if (!card) return;
    if (S.busy) return toast("The robot is still moving");
    if (!S.sim) return toast("Simulator offline: start sim/server.py to move the robot");
    S.busy = true;
    document.body.classList.add("jogging");
    const m = CMD[card.label];
    $("#mon-id").textContent = card.id;
    resetMonitor();
    await playback(card, 3); // compressed playback keeps direct control responsive
    setPhase("decode");
    const moveId = `${card.id}#${++S.jogSeq}`; // unique per move: the same trial can be sent twice
    const resp = await postJson("/api/jog", { id: moveId, trial: card.id }); // server decodes the EEG now
    const dec = resp?.decode || asDecode(card);
    showPosterior(dec);
    setPhase("act");
    const st = resp ? await waitFor((s) => s.result && s.result.trial === moveId, 15000) : null;
    if (S.sim) await waitFor((s) => s.phase === "idle", 15000);
    const r = st?.result;
    const entry = { card, dec, action: r?.action || "no response", landed: r?.landed, match: dec.command === card.label };
    S.jogs.unshift(entry);
    renderJogLog();
    const b = $("#banner");
    b.className = `banner ${entry.match ? "ok" : "bad"}`;
    const d = CMD[dec.command];
    b.innerHTML = `<b>${d.icon} ${entry.action}${entry.landed ? ` → part in ${zoneName(entry.landed)}` : ""}</b><span>EEG: ${m.name} · decoded live ${d.name} ${Math.round(dec.conf * 100)}%${dec.ms !== undefined ? ` in ${dec.ms.toFixed(2)} ms` : ""}${entry.match ? "" : " · misread: intended " + m.jog.toLowerCase()}</span>`;
    b.hidden = false;
    clearTimeout(banner.t); banner.t = setTimeout(() => (b.hidden = true), 2600);
    setPhase(null);
    S.busy = false;
    document.body.classList.remove("jogging");
    const n = S.jogs.length, hit = S.jogs.filter((j) => j.match).length;
    $("#st-task").textContent = `${hit}/${n} moves`;
    $("#st-dec").textContent = `${Math.round((hit / n) * 100)}%`;
  }
  function renderJogMap() {
    $("#jogmap").innerHTML = KEYS.map((k) => `<li style="--c:${CMD[k].color}"><span class="ico">${CMD[k].icon}</span><b>${CMD[k].name}</b><span>${CMD[k].jog}</span></li>`).join("");
  }
  function renderJogLog() {
    $("#joglog").innerHTML = S.jogs.slice(0, 8).map((j) => `<li class="${j.match ? "ok" : "bad"}"><span class="mk">${j.match ? "✓" : "✗"}</span>
      <span><b style="color:${CMD[j.card.label].color}">${CMD[j.card.label].name}</b> → decoded ${CMD[j.dec.command].name} ${Math.round(j.dec.conf * 100)}%${j.dec.ms !== undefined ? ` · live ${j.dec.ms.toFixed(2)} ms` : ""}</span>
      <span class="what">${j.action}${j.landed ? ` · ${zoneName(j.landed)}` : ""}</span></li>`).join("");
  }
  $$(".tabs [data-view]").forEach((b) => b.addEventListener("click", () => {
    if (S.busy) return;
    S.view = b.dataset.view;
    $$(".tabs [data-view]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", x === b); });
    $("#task").hidden = S.view !== "task";
    document.body.dataset.view = S.view;
    $("#direct").hidden = S.view !== "direct";
    $("#order").hidden = S.view !== "program";
    $(".deck-hint").textContent = S.view === "task" ? "Drag a glowing card onto the robot to pack the computer. Each card is real EEG, labeled with what the person did." : S.view === "direct" ? "Every trial is labeled with the command the subject performed. Drag it onto the robot to move it." : "Every trial is labeled with the command the subject performed. Drag it into the robot program.";
    post("/api/order", { zone: S.view === "task" ? currentJob() : null, rgba: S.view === "task" && currentJob() ? CMD[currentJob()].rgba : undefined });
    renderCards(); renderCmdMap();
  }));

  // ---------------------------------------------------------------- simple mode: everyday-task levels
  // Very easy: tiles use imagined trials the live decoder reads correctly, so the right tile always works.
  const PLAIN = {
    left: { label: "Left hand", icon: "✊" }, right: { label: "Right hand", icon: "✊" },
    fists: { label: "Both hands", icon: "🙌" }, feet: { label: "Feet", icon: "🦶" }, rest: { label: "Relax", icon: "😌" },
  };
  // The board: all five commands, two real recordings each (10 tiles), in fixed "controller" slots.
  const SLOTS = 2;
  const easyPool = (k) => {
    const all = S.cards.filter((c) => c.label === k && c.paradigm === "imagined");
    if (S.hard) return all;
    const clean = all.filter((c) => devOf(c).pred === k); // recordings this device's decoder reads correctly
    return clean.length ? clean : all;
  };
  const tileCard = {}; // "left:0" -> card
  function nextTileCard(slot) {
    const k = slot.split(":")[0], pool = easyPool(k);
    const others = new Set(Object.entries(tileCard).filter(([s2]) => s2 !== slot).map(([, c]) => c?.id));
    const free = pool.filter((c) => !others.has(c.id)); // never show the same recording twice
    const from = free.length ? free : pool;
    if (!from.length) return null;
    return (tileCard[slot] = from[Math.floor(Math.random() * from.length)]);
  }
  S.levels = []; S.lv = 0;
  S.mode = (() => { try { if (!localStorage.getItem("nr-mode-v2")) { localStorage.setItem("nr-mode-v2", "1"); localStorage.setItem("nr-mode", "easy"); } return localStorage.getItem("nr-mode") || "easy"; } catch { return "easy"; } })(); // easy | normal | real
  S.hintCmd = null; // after a miss, the right command lights up until the step succeeds
  S.hard = S.mode === "real";
  S.progress = (() => { try { return JSON.parse(localStorage.getItem("nr-progress") || "{}"); } catch { return {}; } })();
  const saveProgress = () => { try { localStorage.setItem("nr-progress", JSON.stringify(S.progress)); } catch {} };
  S.run = null; // { t0, misses, points, combo, end }
  const unlocked = (k) => k === 0 || !!S.progress[S.levels[k - 1]?.id];
  const starStr = (n) => "★".repeat(n) + "☆".repeat(3 - n);
  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  setInterval(() => { if (S.run && !S.run.end) $("#gh-time").textContent = fmtTime((performance.now() - S.run.t0) / 1000); }, 250);
  function renderHud() {
    const r = S.run;
    $("#gamehud").hidden = !r;
    if (!r) return;
    $("#gh-score").textContent = r.points;
    $("#gh-combo").hidden = r.combo < 2;
    $("#gh-combo").textContent = `×${r.combo} combo`;
  }
  const level = () => S.levels[S.lv];
  const simStep = () => (S.sim && S.sim.level === level()?.id ? S.sim.step : 0);
  function currentStep() { const lv = level(); return lv ? lv.steps[Math.min(simStep(), lv.steps.length - 1)] : null; }

  async function initLevels() {
    try { S.levels = await (await fetch("/api/levels")).json(); } catch { S.levels = []; }
    if (!S.levels.length) { $("#step-say").textContent = "Simulator offline: start sim/server.py"; return; }
    let k = 0;
    while (k < S.levels.length - 1 && S.progress[S.levels[k].id]) k++;
    await loadLevel(k);
  }
  async function loadLevel(i) {
    if (S.busy) return;
    if (!unlocked(i)) return toast("Finish the previous level to unlock this one");
    S.busy = true; S.lv = i;
    $("#done").hidden = true; $("#hud").hidden = true;
    renderLevel();
    $("#step-say").textContent = `Setting up "${level().title}"…`;
    $("#q-say").textContent = `${level().icon} ${level().title}`; $("#q-need").innerHTML = `<span class="q-hint">Setting up…</span>`;
    $("#arena").classList.add("fading");
    await post("/api/level", { id: level().id });
    await waitFor((st) => st.level === level().id && st.phase === "idle" && st.step === 0, 20000);
    await sleep(250);
    $("#arena").classList.remove("fading");
    S.run = { t0: performance.now(), misses: 0, points: 0, combo: 1, end: null, log: [] };
    S.hintCmd = null;
    renderHud();
    S.busy = false;
    renderLevel();
  }
  function renderLevel() {
    const lv = level();
    if (!lv) return;
    const i = simStep(), done = S.sim?.level === lv.id && S.sim?.levelDone;
    renderLevelSelect();
    const pr = S.progress[lv.id];
    $("#level-btn-text").innerHTML = `<span class="lb-i">${lv.icon}</span>${lv.title}<span class="lb-s">${pr ? starStr(pr.stars) : ""}</span>`;
    const st = currentStep();
    $("#story").textContent = lv.story;
    $("#step-say").innerHTML = done ? `All steps done` : `<span class="step-n">Step ${i + 1} of ${lv.steps.length}</span>${st.say}`;
    $("#step-think").innerHTML = done ? "" : `🧠 ${st.think}`;
    renderQuest(lv, st, i, done);
    const guide = S.mode === "easy";
    const rows = S.mode === "real" ? [0, 1] : [0];
    $("#tiles").classList.toggle("big", rows.length === 1);
    $("#tiles").innerHTML = rows.flatMap((row) => KEYS.map((k, col) => {
      const slot = `${k}:${row}`, c = tileCard[slot] || nextTileCard(slot);
      if (!c) return "";
      const hinted = !done && S.hintCmd === st.cmd && st.cmd === k;
      const on = (guide || hinted) && !done && st.cmd === k;
      return `<button class="tile mini ${on ? "on" : guide && !done ? "off" : ""} ${hinted && !guide ? "hinted" : ""}" data-id="${c.id}" data-k="${k}" data-slot="${slot}" style="--c:${CMD[k].color}" aria-label="${PLAIN[k].label} brain signal, recording ${c.id}">
        <span class="tile-top"><span class="tile-ico ${k === "left" ? "is-l" : k === "right" ? "is-r" : ""}"><span class="glyph">${PLAIN[k].icon}</span>${k === "left" ? '<i class="side">L</i>' : k === "right" ? '<i class="side">R</i>' : ""}</span><b>${PLAIN[k].label}</b>${row === 0 ? `<kbd>${col + 1}</kbd>` : ""}</span>
        <canvas class="spark"></canvas>
        ${S.hard ? `<div class="erd">${erdBars(c)}</div>` : ""}
        <span class="tile-dest">${c.id}${S.hard ? ` <span class="reroll" data-reroll="${slot}" title="Draw another recording">⟳</span>` : ""}</span>
        ${on ? `<span class="tile-cta">${hinted && !guide ? "Try this one" : "Use me"}</span>` : ""}
      </button>`;
    })).join("");
    requestAnimationFrame(() => { $$("#tiles .tile").forEach((el) => drawSpark(el.querySelector("canvas"), byId(el.dataset.id))); placeHandHint(); });
    const target = !done && st && ["pick", "place", "press"].includes(st.do[0]) ? "obj-" + st.do[1] : null;
    window.dispatchEvent(new CustomEvent("sim-focus", { detail: target }));
  }
  function renderTiles() { if (document.body.classList.contains("simple")) renderLevel(); }

  // ---------------------------------------------------------------- neuro insights on the results screen
  // What a BCI paper would report: which rhythm drove each command, decoder accuracy, bit rate.
  const SIGNATURE = {
    left: ["C4", "c4", "right motor cortex"], right: ["C3", "c3", "left motor cortex"],
    fists: ["C3+C4", null, "both motor cortices"], feet: ["Cz", "cz", "foot area at the vertex"], rest: [null, null, "no task rhythm"],
  };
  function renderInsights(r) {
    const all = r.log || [], log = all.filter((x) => !x.head), n = log.length;
    const headN = all.filter((x) => x.head && x.ok).length;
    if (!all.length) { $("#insights").innerHTML = ""; return; }
    if (!n) { $("#insights").innerHTML = `<div class="ins-head"><span>📷 Look control</span><span class="ins-kpis">${headN} steps by looking left/right</span></div>`; return; }
    const acc = log.filter((x) => x.dec.command === x.card.label).length / n;
    const P = Math.min(acc, 0.999), N = 5;
    const bits = P <= 1 / N ? 0 : Math.log2(N) + P * Math.log2(P) + (1 - P) * Math.log2((1 - P) / (N - 1));
    const secs = ((r.end - r.t0) / 1000) / n;
    const rows = log.filter((x) => x.ok).map(({ card, dec }) => {
      const [ch, key, area] = SIGNATURE[card.label];
      const sites = DEVICE[S.device].sites, sees = ch == null || ch.split("+").every((c) => sites.includes(c));
      const v = key ? erdOf(card, key) : card.label === "fists" ? Math.min(erdOf(card, "c3"), erdOf(card, "c4")) : null;
      const what = v == null ? "no motor rhythm change (rest)"
        : sees ? `μ-rhythm ${v < 0 ? "suppression" : "change"} over ${ch} (${area}): <b>${v > 0 ? "+" : ""}${Math.round(v)}%</b>`
          : `${DEVICE[S.device].short} has no sensor over ${ch} (${area}); decoded from ${sites.join(", ")}`;
      return `<li style="--c:${CMD[card.label].color}"><span class="ins-ico">${PLAIN[card.label].icon}</span><span><b>${PLAIN[card.label].label}</b> · ${what}<small>decoded ${Math.round(dec.conf * 100)}% · ${card.id}</small></span></li>`;
    }).join("");
    $("#insights").innerHTML = `<div class="ins-head"><span>${DEVICE[S.device].icon} ${DEVICE[S.device].name} · ${DEVICE[S.device].ch} ch</span><span class="ins-kpis">${headN ? `${headN} by head turn · ` : ""}decoder ${Math.round(acc * 100)}% · ITR ${((bits * 60) / Math.max(secs, 1)).toFixed(1)} bit/min</span></div><ul>${rows}</ul>`;
  }

  // ---------------------------------------------------------------- level select + settings
  const levelArt = (id) => `assets/levels/${id}.jpg`;
  function renderLevelSelect() {
    const total = S.levels.reduce((n, l) => n + (S.progress[l.id]?.stars || 0), 0);
    $("#ls-total").textContent = `★ ${total} / ${S.levels.length * 3}`;
    const chapters = [...new Set(S.levels.map((l) => l.chapter))];
    $("#levelgrid").innerHTML = chapters.map((ch) => `<section class="ls-chap"><h3>${ch}</h3><div class="ls-cards">${S.levels.map((l, k) => {
      if (l.chapter !== ch) return "";
      const pr = S.progress[l.id], lock = !unlocked(k);
      return `<button class="ls-card ${k === S.lv ? "on" : ""} ${lock ? "locked" : ""}" data-lv="${k}" ${lock ? 'aria-disabled="true"' : ""}>
        <span class="ls-img" style="background-image:url('${levelArt(l.id)}')"><span class="ls-icon">${lock ? "🔒" : l.icon}</span></span>
        <span class="ls-title">${l.title}</span>
        <span class="ls-meta"><span class="ls-stars">${pr ? starStr(pr.stars) : lock ? "Locked" : "New"}</span><span>${l.steps.length} steps</span></span>
      </button>`;
    }).join("")}</div></section>`).join("");
  }
  const openLevels = () => { renderLevelSelect(); $("#levelsel").hidden = false; };
  $("#level-btn").addEventListener("click", openLevels);
  $("#ls-close").addEventListener("click", () => ($("#levelsel").hidden = true));
  $("#levelgrid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lv]"); if (!b) return;
    if (!unlocked(+b.dataset.lv)) return toast("Finish the task before it to unlock this one");
    $("#levelsel").hidden = true; loadLevel(+b.dataset.lv);
  });
  $("#done-all").addEventListener("click", () => { $("#done").hidden = true; openLevels(); });
  $("#settings-btn").addEventListener("click", (e) => { e.stopPropagation(); $("#settings").hidden = !$("#settings").hidden; });
  document.addEventListener("click", (e) => { if (!$("#settings").hidden && !e.target.closest("#settings, #settings-btn")) $("#settings").hidden = true; });
  $("#mute2").addEventListener("click", () => $("#mute").click());
  $("#mode-chip").addEventListener("click", (e) => { e.stopPropagation(); $("#settings").hidden = false; });

  // ---------------------------------------------------------------- game UX: quest card, hints, juice, onboarding
  const OBJ_ICON = { mug: "☕", apple: "🍎", plate: "🍽️", lamp: "💡", phone: "📱", pills: "💊", book: "📘", stack: "📚",
    remote: "📺", tray: "🧺", bowl: "🥣", glass: "🥛", coaster: "🟤" };
  function stepIcon(st, lv) {
    const [kind, arg] = st.do;
    if (kind === "pack") return "📦";
    if (kind === "handoff") return "🤲";
    if (kind === "wait") return "😌";
    if (kind === "pick" && arg === "apple" && lv.id === "table") return "🍐";
    return OBJ_ICON[arg] || lv.icon;
  }
  function renderQuest(lv, st, i, done) {
    $("#q-dots").innerHTML = lv.steps.map((_, k) => `<i class="${k < i || done ? "q-ok" : k === i ? "q-now" : ""}"></i>`).join("");
    if (done || !st) { $("#q-obj").textContent = "✅"; $("#q-say").textContent = "Done!"; $("#q-need").innerHTML = ""; return; }
    $("#q-obj").textContent = stepIcon(st, lv);
    $("#q-say").textContent = st.say;
    const m = PLAIN[st.cmd];
    $("#q-need").style.setProperty("--c", CMD[st.cmd].color);
    const HEAD = { left: "←", right: "→" };
    const headHint = window.NR_headOn && HEAD[st.cmd] ? `<span class="q-head">or look ${HEAD[st.cmd]}</span>` : "";
    $("#q-need").innerHTML = headHint + (S.mode === "easy"
      ? `<span class="q-chip"><span>${m.icon}</span>${m.label}</span><span class="q-hint">${st.think.replace(/^Imagine /, "imagine ")}</span>`
      : `<span class="q-hint strong">🧠 ${st.think}</span>`);
  }
  // a ghost hand demonstrates the drag until the player has done it twice
  let handAnim = null;
  const handDone = () => { try { return +localStorage.getItem("nr-drags") || 0; } catch { return 0; } };
  function placeHandHint() {
    const hand = $("#hand-hint");
    handAnim?.cancel(); handAnim = null; hand.hidden = true;
    if (!document.body.classList.contains("simple") || S.mode !== "easy" || handDone() >= 2 || S.busy || !$("#start").hidden || !$("#coach").hidden) return;
    const tile = $("#tiles .tile.on"), arena = $("#arena");
    if (!tile) return;
    const a = tile.getBoundingClientRect(), b = arena.getBoundingClientRect();
    const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2, x1 = b.left + b.width / 2, y1 = b.top + b.height * 0.55;
    hand.hidden = false;
    handAnim = hand.animate([
      { transform: `translate(${x0}px, ${y0}px) scale(1)`, opacity: 0 },
      { transform: `translate(${x0}px, ${y0}px) scale(.85)`, opacity: 1, offset: 0.15 },
      { transform: `translate(${x1}px, ${y1}px) scale(.85)`, opacity: 1, offset: 0.7 },
      { transform: `translate(${x1}px, ${y1}px) scale(1)`, opacity: 0 },
    ], { duration: 2200, iterations: Infinity, easing: "cubic-bezier(.45,0,.25,1)" });
  }
  window.addEventListener("resize", () => placeHandHint());
  function popPoints(text, good) {
    const el = $("#pop");
    el.textContent = text; el.className = `pop ${good ? "good" : "bad"}`;
    void el.offsetWidth; el.classList.add("go");
  }
  // first-time coach marks
  const COACH = [
    ["#quest", "This is your task. The robot needs one brain command to do it."],
    [() => $("#tiles .tile.on") || $("#tiles .tile"), "These are real brain signals recorded from people imagining a movement. The glowing one is the command you need."],
    ["#arena", "Drag it onto the robot (or press its number key). The headset decodes it and the robot does the job."],
  ];
  let coachI = 0;
  function showCoach(k) {
    if (k >= COACH.length) { $("#coach").hidden = true; try { localStorage.setItem("nr-coached", "1"); } catch {} placeHandHint(); return; }
    coachI = k;
    const [sel, text] = COACH[k], el = typeof sel === "function" ? sel() : $(sel);
    $("#coach").hidden = false;
    $("#coach-n").textContent = `${k + 1}/${COACH.length}`;
    $("#coach-text").textContent = text;
    $("#coach-next").textContent = k === COACH.length - 1 ? "Got it" : "Next";
    if (!el) return;
    const r = el.getBoundingClientRect(), box = $("#coach-box"), hole = $("#coach-hole"), pad = 8;
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    const below = r.bottom + 170 < innerHeight;
    box.style.left = `${Math.min(innerWidth - 340, Math.max(16, r.left + r.width / 2 - 160))}px`;
    box.style.top = `${below ? r.bottom + 14 : Math.max(16, r.top - 150)}px`;
  }
  $("#coach-next").addEventListener("click", () => showCoach(coachI + 1));
  $("#start-play").addEventListener("click", () => {
    window.__sfx?.unlock?.();
    $("#start").classList.add("leaving");
    setTimeout(() => {
      $("#start").hidden = true;
      let coached = false; try { coached = localStorage.getItem("nr-coached") === "1"; } catch {}
      if (!coached && document.body.classList.contains("simple")) showCoach(0); else placeHandHint();
    }, 350);
  });

  const hudCanvas = $("#hud-scope");
  function hudDraw(card, upto) {
    const dpr = devicePixelRatio || 1, w = hudCanvas.clientWidth, h = hudCanvas.clientHeight;
    if (!w) return;
    if (hudCanvas.width !== Math.round(w * dpr)) { hudCanvas.width = w * dpr; hudCanvas.height = h * dpr; }
    const g = hudCanvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const m = robustMax(card), lanes = CH.filter(([k]) => card[k]);
    lanes.forEach(([k, label, col], j) => {
      const mid = (h * (j + 0.5)) / lanes.length;
      lane(g, card[k], w, mid, h / lanes.length / 2.3, m, col, upto);
      g.fillStyle = col; g.font = "9px 'IBM Plex Mono', monospace"; g.fillText(label, 3, mid - 6);
    });
  }

  // head turns (OpenCV) arrive here: a motion command, not an EEG recording
  window.NR_headCommand = (cmd, dir) => {
    if (!document.body.classList.contains("simple") || !$("#start").hidden) return;
    runLevelStep({ id: "head", label: cmd, head: true, dir });
  };
  window.addEventListener("headcontrol", () => renderLevel());
  async function runLevelStep(card) {
    const lv = level(), st = currentStep();
    if (!lv || !st || !card) return;
    if (S.sim?.levelDone) return toast("Level complete. Pick the next level.");
    if (S.busy) return toast("The robot is still busy");
    if (S.mode === "easy" && card.label !== st.cmd) return nudge(card, st);
    if (card.head) return runHeadStep(card, lv, st);
    S.busy = true;
    $$("#tiles .tile").forEach((t) => t.classList.toggle("busy", t.dataset.id === card.id));
    $("#hud").hidden = false; $("#hud").className = "hud";
    $("#hud-state").textContent = "recording";
    $("#hud-read").textContent = "Reading your brain signal…";
    window.dispatchEvent(new CustomEvent("sfx", { detail: "scan" }));
    await playback(card, 1.6, (i) => hudDraw(card, i));
    $("#hud-state").textContent = "decoding";
    const runId = `${card.id}#${++S.jogSeq}`;
    const resp = await postJson("/api/step", { id: runId, trial: card.id, device: S.device }); // decoded live, this device's electrodes only
    const dec = resp?.decode || asDecode(card);
    const match = dec.command === st.cmd;
    $("#hud").className = `hud ${match ? "ok" : "bad"}`;
    $("#hud-state").textContent = match ? "intention detected" : "no match";
    $("#hud-read").innerHTML = `Intention: <b>${PLAIN[dec.command].label}</b> ${Math.round(dec.conf * 100)}%` +
      (match ? ` → robot: <b>${st.say.toLowerCase()}</b>` : ` → not "${PLAIN[st.cmd].label}", the robot waits`);
    const res = resp ? await waitFor((s) => s.result && s.result.trial === runId, 30000) : null;
    if (resp) await waitFor((s) => s.phase === "idle", 15000);
    const ok = res?.result?.ok ?? match;
    S.run?.log.push({ card, dec, ok });
    if (ok) { try { localStorage.setItem("nr-drags", String(handDone() + 1)); } catch {} }
    if (!ok) { $("#quest").classList.remove("shake"); void $("#quest").offsetWidth; $("#quest").classList.add("shake"); }
    window.dispatchEvent(new CustomEvent("sfx", { detail: ok ? "ok" : "fail" }));
    if (S.run) {
      if (ok) { const gain = 100 * S.run.combo + (S.run.lastMiss ? 0 : 50); S.run.points += gain; popPoints(`+${gain}${S.run.combo > 1 ? ` ×${S.run.combo}` : ""}`, true); S.run.combo = Math.min(4, S.run.combo + 1); S.run.lastMiss = false; }
      else { S.run.misses++; S.run.combo = 1; S.run.lastMiss = true; popPoints("Missed", false); }
      renderHud();
    }
    S.hintCmd = ok ? null : st.cmd;
    const b = $("#banner");
    b.className = `banner ${ok ? "ok" : "bad"}`;
    const sent = PLAIN[card.label], read = PLAIN[dec.command], need = PLAIN[st.cmd];
    b.innerHTML = ok ? `<b>✓ ${st.say}</b><span>Your headset read ${read.icon} ${read.label} and the robot did it.</span>`
      : card.label !== st.cmd
        ? `<b>Wrong signal: you sent ${sent.icon} ${sent.label}</b><span>This step needs ${need.icon} ${need.label}. It's lit up below.</span>`
        : `<b>The decoder misread it as ${read.icon} ${read.label}</b><span>Real brain signals are noisy. Try another ${need.icon} ${need.label} recording.</span>`;
    b.hidden = false; clearTimeout(banner.t); banner.t = setTimeout(() => (b.hidden = true), 2600);
    for (const [slot, c] of Object.entries(tileCard)) if (c?.id === card.id) nextTileCard(slot); // fresh recording in that slot
    S.busy = false;
    renderLevel();
    if (S.sim?.levelDone) finishLevel(lv);
    setTimeout(() => { if (!S.busy) $("#hud").hidden = true; }, 3500);
  }
  $("#levels").addEventListener("click", (e) => { const b = e.target.closest("[data-lv]"); if (b) loadLevel(+b.dataset.lv); });
  $("#done-next").addEventListener("click", () => loadLevel(S.lv >= S.levels.length - 1 ? 0 : S.lv + 1));
  $("#done-retry").addEventListener("click", () => loadLevel(S.lv));
  async function runHeadStep(card, lv, st) {
    S.busy = true;
    $("#hud").hidden = false; $("#hud").className = "hud";
    $("#hud-state").textContent = "motion";
    $("#hud-read").innerHTML = `Head turn ${({ left: "←", right: "→", up: "↑", down: "↓" })[card.dir]}: <b>${PLAIN[card.label].label}</b> (motion sensor, not EEG)`;
    const runId = `head#${++S.jogSeq}`;
    const resp = await postJson("/api/step", { id: runId, command: card.label, source: "head" });
    const res = resp ? await waitFor((s) => s.result && s.result.trial === runId, 30000) : null;
    if (resp) await waitFor((s) => s.phase === "idle", 15000);
    const ok = res?.result?.ok ?? card.label === st.cmd;
    S.run?.log.push({ card, dec: { command: card.label, conf: 1 }, ok, head: true });
    window.dispatchEvent(new CustomEvent("sfx", { detail: ok ? "ok" : "fail" }));
    if (S.run) {
      if (ok) { const gain = 100 * S.run.combo; S.run.points += gain; popPoints(`+${gain}`, true); S.run.combo = Math.min(4, S.run.combo + 1); }
      else { S.run.misses++; S.run.combo = 1; popPoints("Missed", false); }
      renderHud();
    }
    S.hintCmd = ok ? null : st.cmd;
    const b = $("#banner");
    b.className = `banner ${ok ? "ok" : "bad"}`;
    b.innerHTML = ok ? `<b>✓ ${st.say}</b><span>Head turn → ${PLAIN[card.label].label}. The robot did it.</span>`
      : `<b>Head turn read as ${PLAIN[card.label].label}</b><span>This step needs ${PLAIN[st.cmd].icon} ${PLAIN[st.cmd].label}.</span>`;
    b.hidden = false; clearTimeout(banner.t); banner.t = setTimeout(() => (b.hidden = true), 2400);
    S.busy = false;
    renderLevel();
    if (S.sim?.levelDone) finishLevel(lv);
  }
  function finishLevel(lv) {
    lv.done = true;
    const r = S.run || { t0: performance.now(), misses: 0, points: 0 };
    r.end = performance.now();
    const secs = (r.end - r.t0) / 1000, par = lv.par || 40;
    const timeBonus = Math.max(0, Math.round((par - secs) * 5));
    r.points += timeBonus + (S.mode === "real" ? 200 : S.mode === "normal" ? 100 : 0);
    const stars = r.misses === 0 && secs <= par ? 3 : r.misses <= 1 ? 2 : 1;
    const prev = S.progress[lv.id];
    S.progress[lv.id] = { stars: Math.max(stars, prev?.stars || 0), best: Math.max(r.points, prev?.best || 0) };
    saveProgress(); renderHud(); renderLevel();
    const last = S.lv >= S.levels.length - 1;
    $("#done-title").textContent = `${lv.icon} ${lv.title}`;
    $$("#done-stars i").forEach((el, k) => { el.className = ""; void el.offsetWidth; if (k < stars) { el.className = "on"; el.style.animationDelay = `${0.25 + k * 0.28}s`; } });
    $("#done-stats").innerHTML = `<div><dt>Time</dt><dd>${fmtTime(secs)} <small>par ${fmtTime(par)}</small></dd></div>
      <div><dt>Misreads</dt><dd>${r.misses}</dd></div><div><dt>Score</dt><dd>${r.points}${prev && r.points > prev.best ? " <small>new best!</small>" : ""}</dd></div>`;
    renderInsights(r);
    $("#done-text").textContent = stars < 3 ? (r.misses ? "Tip: pick recordings with a strong drop on the right channel, and go a little faster for 3 stars." : `Under ${fmtTime(par)} earns 3 stars.`)
      : last ? "Perfect. You finished every task using only brain signals." : `Perfect run. Next up: ${S.levels[S.lv + 1].icon} ${S.levels[S.lv + 1].title}`;
    $("#done-next").textContent = last ? "Back to the start" : "Next level";
    $("#done").hidden = false;
    window.dispatchEvent(new CustomEvent("sfx", { detail: "level" }));
  }
  function nudge(card, st) { // Easy mode: point at the right tile instead of failing
    const need = PLAIN[st.cmd], wrong = $(`#tiles .tile[data-id="${card.id}"]`);
    wrong?.classList.remove("nope"); void wrong?.offsetWidth; wrong?.classList.add("nope");
    const b = $("#banner");
    b.className = "banner bad";
    b.innerHTML = `<b>That's ${PLAIN[card.label].icon} ${PLAIN[card.label].label}</b><span>This step needs ${need.icon} ${need.label}: the glowing one.</span>`;
    b.hidden = false; clearTimeout(banner.t); banner.t = setTimeout(() => (b.hidden = true), 2200);
    const right = $("#tiles .tile.on"); right?.classList.remove("pulse"); void right?.offsetWidth; right?.classList.add("pulse");
  }
  function renderModeChip() { $("#mode-chip").textContent = { easy: "Easy", normal: "Normal", real: "Real decoder" }[S.mode]; }
  function deviceAcc(dev) { // pooled held-out accuracy on imagined movement, from the library
    let n = 0, ok = 0;
    for (const c of S.cards) if (c.paradigm === "imagined" && c.dev) { n++; if (c.dev[dev].pred === c.label) ok++; }
    return n ? Math.round((ok / n) * 100) : null;
  }
  function renderDevicePickers() {
    const html = Object.entries(DEVICE).map(([k, d]) => `<button class="devopt ${k === S.device ? "on" : ""}" data-dev="${k}">
      ${headSvg(k, 46)}<span class="dv-t"><b>${d.short}</b><small>${d.ch} sensors</small></span><span class="dv-acc">${deviceAcc(k) ?? "–"}<small>%</small></span></button>`).join("");
    $$(".devpick").forEach((el) => (el.innerHTML = html));
    $("#dev-blurb").textContent = DEVICE[S.device].blurb;
    $("#start-dev-blurb").textContent = DEVICE[S.device].blurb;
    $("#device-chip").innerHTML = `${DEVICE[S.device].icon} ${DEVICE[S.device].short} · ${DEVICE[S.device].ch} ch`;
    $("#hud-device").innerHTML = `${headSvg(S.device, 30)}<span>${DEVICE[S.device].name}</span>`;
  }
  function setDevice(dev) {
    if (!DEVICE[dev] || S.busy) return;
    S.device = dev;
    try { localStorage.setItem("nr-device", dev); } catch {}
    applyDeviceLanes();
    for (const k in tileCard) delete tileCard[k]; // a fresh hand of recordings this device can read
    renderDevicePickers(); renderLevel();
  }
  document.addEventListener("click", (e) => { const b = e.target.closest(".devopt"); if (b) setDevice(b.dataset.dev); });
  $("#device-chip").addEventListener("click", (e) => { e.stopPropagation(); $("#settings").hidden = false; });
  function setMode(m) {
    S.mode = m; S.hard = m === "real";
    try { localStorage.setItem("nr-mode", m); } catch {}
    $$("#mode [data-mode]").forEach((b) => { b.classList.toggle("on", b.dataset.mode === m); b.setAttribute("aria-pressed", b.dataset.mode === m); });
    for (const k in tileCard) delete tileCard[k];
    renderModeChip();
    renderLevel();
  }
  $("#mode").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b && !S.busy) setMode(b.dataset.mode); });
  setMode(S.mode);
  window.addEventListener("load", renderDevicePickers);
  // keys 1-5 send the top-row recording of each command (left, right, both hands, feet, relax)
  window.addEventListener("keydown", (e) => {
    if (!document.body.classList.contains("simple") || !$("#start").hidden || !$("#coach").hidden || e.target.closest?.("input, textarea, select")) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 5) { const c = tileCard[`${KEYS[n - 1]}:0`]; if (c) { e.preventDefault(); runLevelStep(c); } }
  });
  $("#tiles").addEventListener("click", (e) => {
    const rr = e.target.closest("[data-reroll]");
    if (rr) { if (!S.busy) { nextTileCard(rr.dataset.reroll); renderLevel(); } return; }
    const t = e.target.closest(".tile");
    if (!t) return;
    if (suppressClick) { suppressClick = false; return; }
    runLevelStep(byId(t.dataset.id));
  });
  $("#view-toggle").addEventListener("click", () => {
    const adv = document.body.classList.toggle("simple") === false;
    $("#view-toggle").textContent = adv ? "Simple view" : "Advanced view";
    $("#view-toggle").setAttribute("aria-pressed", adv);
    if (adv) post("/api/level", { id: "work" }); // the advanced tabs run in the packing cell
    else loadLevel(S.lv);
    renderCards(); drawScope(scopeCard, scopeUpto, scopeCard ? robustMax(scopeCard) : 1);
  });

  // ---------------------------------------------------------------- factory task (easy mode)
  const SHIFT = ["left", "left", "left", "left", "right", "right", "right", "right"]; // 8 computers, 2 boxes
  const BOX_CAPACITY = 4;
  const currentJob = () => (S.task && S.task.i < S.task.jobs.length ? S.task.jobs[S.task.i] : null);
  function newShift() {
    const jobs = [...SHIFT];
    for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }
    S.task = { jobs, i: 0, done: [], t0: null, fill: { left: 0, right: 0 }, shipped: 0 };
    renderTask(); renderCards(); renderTiles();
  }
  function renderTask() {
    const t = S.task, need = currentJob(), n = t.jobs.length;
    $("#pills").innerHTML = t.jobs.map((k, i) => {
      const d = t.done[i], cls = d ? (d.ok ? "ok" : "bad") : i === t.i ? "now" : "";
      return `<li class="${cls}" style="--c:${CMD[k].color}" title="${CMD[k].part} → ${CMD[k].zone}">${d ? (d.ok ? "✓" : "✗") : i + 1}</li>`;
    }).join("");
    const okN = t.done.filter((d) => d.ok).length;
    $("#task-score").innerHTML = `Box A <b>${t.fill.left}/${BOX_CAPACITY}</b> · Box B <b>${t.fill.right}/${BOX_CAPACITY}</b> · Shipped <b>${t.shipped}</b>`;
    if (need) {
      const m = CMD[need];
      $("#job").style.setProperty("--c", m.color);
      $("#job-kicker").textContent = `Computer ${t.i + 1} of ${n}`;
      $("#job-title").innerHTML = `Pack this computer in <b class="hl">${m.zone}</b> <span class="side">(${need === "left" ? "left" : "right"})</span>`;
      $("#job-how").innerHTML = `Drag a <b class="hl">${m.icon} ${m.name}</b> EEG card onto the robot. The decoder reads it and the arm packs the computer.`;
      $("#job").classList.remove("finished");
      if (S.view === "task" && !document.body.classList.contains("simple")) post("/api/order", { zone: need, rgba: m.rgba });
    } else {
      const decOk = t.done.filter((d) => d.dec.command === d.card.label).length;
      $("#job").style.setProperty("--c", "var(--hot)");
      $("#job-kicker").textContent = "Shift complete";
      $("#job-title").innerHTML = `<b class="hl">${okN} of ${n}</b> computers packed in the right box`;
      $("#job-how").textContent = `${t.shipped} box${t.shipped === 1 ? "" : "es"} shipped. The decoder read ${decOk} of ${n} brain signals correctly${t.t0 ? ` · ${Math.round((performance.now() - t.t0) / 1000)} s` : ""}. Press New shift to go again.`;
      $("#job").classList.add("finished");
      post("/api/order", { zone: null });
    }
  }
  async function runTask(card) {
    if (!card) return;
    const need = currentJob();
    if (!need) return toast("Shift complete. Press New shift to start again.");
    if (S.busy) return toast("The robot is still packing the last computer");
    S.busy = true;
    S.task.t0 ??= performance.now();
    document.body.classList.add("jogging");
    $("#job").classList.add("working");
    $$("#tiles .tile").forEach((t) => t.classList.toggle("busy", t.dataset.id === card.id));
    $("#simple-hint").innerHTML = `<span class="working-dot"></span>Reading the brain signal… the robot is packing the computer.`;
    $("#mon-id").textContent = card.id;
    resetMonitor();
    await playback(card, 2);
    setPhase("decode");
    const runId = `${card.id}#${++S.jogSeq}`;
    const resp = await postJson("/api/trial/decide", { id: runId, trial: card.id }); // decoded live on the server
    const dec = resp?.decode || asDecode(card);
    showPosterior(dec);
    setPhase("act");
    let landed = dec.command;
    if (resp) {
      const st = await waitFor((s) => s.result && s.result.trial === runId, 25000);
      landed = st?.result?.landed ?? landed;
      await waitFor((s) => s.phase === "idle", 15000);
    } else await sleep(800);
    const ok = landed === need;
    S.task.done.push({ card, dec, landed, ok });
    S.task.i++;
    let shippedNow = null;
    if (landed in S.task.fill && ++S.task.fill[landed] >= BOX_CAPACITY) { // full box: seal it and ship it
      shippedNow = landed;
      S.task.fill[landed] = 0;
      S.task.shipped++;
      window.dispatchEvent(new CustomEvent("box-ship", { detail: shippedNow })); // flaps fold, tape, box slides out
      setTimeout(() => post("/api/ship", { zone: shippedNow }), 700);
    }
    const b = $("#banner"), m = CMD[need];
    b.className = `banner ${ok ? "ok" : "bad"}`;
    b.innerHTML = ok
      ? `<b>✓ Packed in ${m.zone}${shippedNow ? ` · box full, sealed & shipped` : ""}</b><span>Decoded live: ${CMD[dec.command].name} ${Math.round(dec.conf * 100)}%</span>`
      : `<b>✗ Went to ${zoneName(landed)} instead of ${m.zone}</b><span>${card.label !== need ? `That card was ${CMD[card.label].name}, not ${m.name}` : `The decoder misread it as ${CMD[dec.command].name}`}</span>`;
    b.hidden = false;
    clearTimeout(banner.t); banner.t = setTimeout(() => (b.hidden = true), 2800);
    setPhase(null);
    $("#job").classList.remove("working");
    document.body.classList.remove("jogging");
    S.busy = false;
    const done = S.task.done, okN = done.filter((d) => d.ok).length;
    $("#st-task").textContent = `${okN}/${done.length} packed`;
    $("#st-dec").textContent = `${Math.round((done.filter((d) => d.dec.command === d.card.label).length / done.length) * 100)}%`;

    renderTask(); renderCards(); renderTiles();
  }
  $("#new-shift").addEventListener("click", () => { if (!S.busy) { post("/api/reset", {}); newShift(); } });

  // ---------------------------------------------------------------- scoring
  function wolpawBits(P, N) {
    if (P <= 1 / N) return 0;
    if (P >= 1) return Math.log2(N);
    return Math.log2(N) + P * Math.log2(P) + (1 - P) * Math.log2((1 - P) / (N - 1));
  }
  function score(steps, secs) {
    const n = steps.length, cards = steps.map((s) => byId(s.cardId));
    const ok = steps.filter((s) => s.result?.ok).length;
    const decOk = cards.filter((c) => c.pred === c.label).length;
    const trialSec = cards[0] ? cards[0].c3.length / S.deck.sfreq : 4.5;
    const P = n ? ok / n : 0;
    return { n, ok, decOk, P, trialSec, bitsPerMin: (wolpawBits(P, KEYS.length) * 60) / trialSec,
      perMin: secs ? (n / secs) * 60 : 0, meanConf: cards.reduce((a, c) => a + c.conf, 0) / Math.max(1, n) };
  }
  function liveKpis(secs) {
    const done = S.steps.filter((s) => s.result);
    if (!done.length) return;
    const sc = score(done, secs);
    $("#st-task").textContent = `${sc.ok}/${sc.n}`;
    $("#st-dec").textContent = `${Math.round((sc.decOk / sc.n) * 100)}%`;
    $("#st-itr").textContent = `${sc.bitsPerMin.toFixed(1)} bit/min`;
    $("#st-tp").textContent = `${sc.perMin.toFixed(1)} parts/min`;
  }

  function report(secs) {
    const sc = score(S.steps, secs);
    const causes = { "decoder misread": 0, handling: 0 };
    S.steps.forEach((s) => { if (s.result && !s.result.ok) causes[s.result.cause]++; });
    const used = KEYS.filter((k) => S.steps.some((s) => { const c = byId(s.cardId); return c.label === k || c.pred === k; }));
    const conf = used.map((r) => used.map((p) => S.steps.filter((s) => { const c = byId(s.cardId); return c.label === r && c.pred === p; }).length));
    const maxCell = Math.max(1, ...conf.flat());
    const offline = S.steps.some((s) => s.result?.offline);
    const pctDone = Math.round(sc.P * 100), runId = `RUN-${String(S.runSeq++).padStart(3, "0")}`;
    S.history.unshift({ runId, P: sc.P });
    $("#report-when").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("#report-body").innerHTML = `
      <div class="score ${pctDone >= 80 ? "great" : pctDone >= 60 ? "ok" : "low"}">
        <div class="score-big">${pctDone}<small>%</small></div>
        <div><b>${runId} · ${sc.n} instructions</b>
        <span>${sc.ok} of ${sc.n} carried out as the EEG intended · ${S.paradigm} EEG${offline ? " · simulator offline" : ""}</span></div>
      </div>
      <dl class="kpis">
        <div><dt>Decoder accuracy</dt><dd>${sc.decOk}/${sc.n}<small> (chance 20%)</small></dd></div>
        <div><dt>Info. transfer</dt><dd>${sc.bitsPerMin.toFixed(1)}<small> bit/min</small></dd></div>
        <div><dt>Throughput</dt><dd>${sc.perMin.toFixed(1)}<small> parts/min</small></dd></div>
        <div><dt>Mean confidence</dt><dd>${Math.round(sc.meanConf * 100)}%</dd></div>
      </dl>
      <p class="causes">${sc.ok === sc.n ? "Every instruction was decoded correctly and executed by the robot." :
        `Failures: <b>${causes["decoder misread"]}</b> decoder misread · <b>${causes.handling}</b> handling`}</p>
      <div class="cm-wrap">
        <span class="cm-title">Decoder confusion (this run)</span>
        <table class="cm"><thead><tr><th>label ↓ / decoded →</th>${used.map((k) => `<th title="${CMD[k].name}" style="--c:${CMD[k].color}">${CMD[k].icon}</th>`).join("")}</tr></thead>
        <tbody>${conf.map((row, r) => `<tr><th>${CMD[used[r]].icon} ${CMD[used[r]].name}</th>${row.map((v, c) => `<td class="${r === c ? "diag" : ""}" style="--a:${v / maxCell}">${v || ""}</td>`).join("")}</tr>`).join("")}</tbody></table>
      </div>
      <p class="itr-note">ITR: Wolpaw, ${KEYS.length} commands, ${pctDone}% accuracy, ${sc.trialSec.toFixed(1)} s of EEG per instruction. Throughput includes robot motion.</p>
      ${S.history.length > 1 ? `<div class="history"><span>Earlier runs</span>${S.history.slice(1, 6).map((h) => `<i title="${h.runId}">${Math.round(h.P * 100)}%</i>`).join("")}</div>` : ""}`;
    liveKpis(secs);
    $("#report").classList.remove("flash"); void $("#report").offsetWidth; $("#report").classList.add("flash");
  }

  // ---------------------------------------------------------------- monitor
  const scope = $("#scope");
  let scopeCard = null, scopeUpto = 0;
  function drawScope(card, upto, m) {
    scopeCard = card; scopeUpto = upto;
    const dpr = devicePixelRatio || 1, w = scope.clientWidth, h = scope.clientHeight;
    if (scope.width !== Math.round(w * dpr)) { scope.width = w * dpr; scope.height = h * dpr; }
    const g = scope.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!S.deck) return;
    const { sfreq, tmin, taskWindow } = S.deck;
    const span = card ? card.c3.length / sfreq : 4.5, tx = (t) => ((t - tmin) / span) * w;
    g.strokeStyle = "#ffffff08"; g.lineWidth = 1;
    for (let t = Math.ceil(tmin * 2) / 2; t <= 4; t += 0.5) { g.beginPath(); g.moveTo(tx(t), 0); g.lineTo(tx(t), h); g.stroke(); }
    g.fillStyle = "#d7ff3a0a"; g.fillRect(tx(taskWindow[0]), 0, tx(taskWindow[1]) - tx(taskWindow[0]), h);
    g.fillStyle = "#d7ff3a"; g.fillRect(tx(0), 0, 1, h);
    g.font = "10px 'IBM Plex Mono', monospace";
    g.fillStyle = "#7f8f86"; g.fillText("CUE", tx(0) + 4, 11);
    const lanes = card ? CH.filter(([k]) => card[k]) : CH;
    lanes.forEach(([k, label, col], j) => {
      const mid = (h * (j + 0.5)) / lanes.length;
      g.fillStyle = col; g.fillText(label, 6, mid - h / lanes.length / 2 + 12);
      if (j) { g.fillStyle = "#ffffff0a"; g.fillRect(0, (h * j) / lanes.length, w, 1); }
      if (card) lane(g, card[k], w, mid, h / lanes.length / 2.4, m, col, upto);
    });
    if (card && upto < card.c3.length) {
      const x = (upto / (card.c3.length - 1)) * w;
      g.fillStyle = "#e8efe9"; g.fillRect(x, 0, 1.5, h);
    }
  }
  new ResizeObserver(() => drawScope(scopeCard, scopeUpto, scopeCard ? robustMax(scopeCard) : 1)).observe(scope);

  function setGauges(vals, final = false) {
    for (const [k] of CH) {
      const v = vals[k], f = $(`#gf-${k}`);
      if (!f) continue; // the research monitor only has C3/Cz/C4 gauges
      if (v === undefined) { f.style.width = "0"; $(`#v-${k}`).textContent = "—"; $(`#glow-${k}`).setAttribute("opacity", 0); continue; }
      const x = clamp(v, -100, 100) / 100;
      f.style.left = `${50 + Math.min(x, 0) * 50}%`;
      f.style.width = `${Math.abs(x) * 50}%`;
      $(`#v-${k}`).textContent = pctStr(v);
      $(`#glow-${k}`).setAttribute("opacity", clamp(-v / 50, 0, 1).toFixed(2));
    }
    $("#g-note").innerHTML = final
      ? "Trial μ-band (8&ndash;13&nbsp;Hz) ERD over the 0.5&ndash;3.5&nbsp;s task window. Negative = desynchronisation."
      : "Live 8&ndash;30&nbsp;Hz power vs. pre-cue baseline. Negative = desynchronisation.";
  }
  const asDecode = (card) => { const d = devOf(card); return { command: d.pred, conf: d.conf, proba: d.proba }; }; // offline fallback
  function renderProbs(dec) {
    $("#probs").innerHTML = KEYS.map((k) => {
      const v = dec ? dec.proba[k] ?? 0 : 0, win = dec && dec.command === k;
      return `<div class="prob ${win ? "win" : ""}" style="--c:${CMD[k].color}"><span>${CMD[k].icon} ${CMD[k].name}</span><i><b style="width:${(v * 100).toFixed(1)}%"></b></i><em>${dec ? Math.round(v * 100) + "%" : ""}</em></div>`;
    }).join("");
  }
  function showPosterior(dec) {
    renderProbs(dec);
    const c = CMD[dec.command], live = dec.ms !== undefined;
    $("#dec-text").innerHTML = `<b style="color:${c.color}">${c.name}</b> → ${S.view === "direct" ? c.jog : c.zone}${dec.conf < 0.65 ? " · low confidence" : ""}`;
    $("#dec-live").innerHTML = live
      ? `<span class="live-dot"></span>Decoded live by the sim server: CSP + LDA on ${dec.samples[0]} ch × ${dec.samples[1]} samples in ${dec.ms.toFixed(2)} ms`
      : "Offline: showing the decoder output stored at export";
  }
  function resetMonitor() {
    setGauges({});
    renderProbs(null);
    $("#dec-live").textContent = "";
    $("#dec-text").textContent = "acquiring…";
    drawScope(null, 0, 1);
  }
  function setPhase(p) {
    $$("#phase-bar span").forEach((s) => s.classList.toggle("now", s.dataset.p === p));
  }
  function banner(card, r) {
    const b = $("#banner");
    b.className = `banner ${r.ok ? "ok" : "bad"}`;
    b.innerHTML = `<b>${r.ok ? "✓" : "✗"} ${CMD[card.label].name} → ${zoneName(r.landed)}</b><span>instruction: ${CMD[card.label].act} · decoded ${CMD[card.pred].name} (${Math.round(card.conf * 100)}%)${r.cause ? ` · ${r.cause}` : ""}</span>`;
    b.hidden = false;
    clearTimeout(banner.t);
    banner.t = setTimeout(() => (b.hidden = true), 2600);
  }
  function renderCmdMap() {
    $("#cmdmap").innerHTML = `<thead><tr><th>EEG command</th><th>Signature</th><th>Robot action</th></tr></thead><tbody>${KEYS.map((k) =>
      `<tr><td><i class="sw" style="--c:${CMD[k].color}"></i>${CMD[k].icon} ${CMD[k].name}</td><td>${CMD[k].sig}</td><td><b>${S.view === "direct" ? CMD[k].jog : CMD[k].act}</b></td></tr>`).join("")}</tbody>`;
  }

  // ---------------------------------------------------------------- simulator link (state arrives from viewer.js over SSE)
  window.addEventListener("sim-state", (e) => {
    S.sim = e.detail;
    $("#sim-phase").textContent = S.sim ? S.sim.phase : "offline";
    $("#dot-sim").classList.toggle("on", !!S.sim);
    if (!S.sim) return;
    for (const k of KEYS) {
      const v = S.sim.bins[k] ?? 0;
      if (v !== S.counts[k]) {
        const el = $(`#cnt-${k}`);
        if (el) { el.textContent = v; const tag = el.parentElement; tag.classList.remove("bump"); void tag.offsetWidth; tag.classList.add("bump"); }
      }
    }
    S.counts = { ...S.sim.bins };
  });
  async function post(path, body) {
    if (!SIM) return false;
    try { return (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).ok; }
    catch { return false; }
  }
  async function postJson(path, body) {
    if (!SIM) return null;
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }
  async function waitFor(pred, timeout) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      if (S.sim && pred(S.sim)) return S.sim;
      await sleep(60);
    }
    return null;
  }

  // ---------------------------------------------------------------- chrome
  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    S.subject = b.dataset.s === "all" ? "all" : Number(b.dataset.s);
    renderFilters(); renderCards();
  });
  $("#cmd-chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    S.cmd = b.dataset.c; renderFilters(); renderCards();
  });
  $$("#paradigm-seg button").forEach((b) => b.addEventListener("click", () => {
    if (S.busy || b.disabled) return;
    S.paradigm = b.dataset.paradigm; S.subject = "all"; S.cmd = "all";
    $$("#paradigm-seg button").forEach((x) => x.classList.toggle("on", x === b));
    renderFilters(); renderCards();
  }));
  function renderAll() { renderFilters(); renderCards(); renderSteps(); }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3400);
  }

  // ---------------------------------------------------------------- boot
  document.body.dataset.view = S.view;
  renderCmdMap();
  renderJogMap();
  $(".deck-hint").textContent = "Drag a glowing card onto the robot to pack the computer. Each card is real EEG, labeled with what the person did.";
  try {
    if (window.EEG_DECK) { loadDeck(window.EEG_DECK); newShift(); renderDevicePickers(); if (SIM) initLevels(); }
    else { $("#deck-empty").hidden = false; renderSteps(); }
  } catch (err) {
    $("#deck-empty").hidden = false;
    toast(`EEG library error: ${err.message}`);
  }
  resetMonitor();
  if (!SIM) { $("#feed-off").hidden = false; $("#sim-phase").textContent = "offline"; }
})();
