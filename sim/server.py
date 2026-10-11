"""NeuroReach sim server: PyBullet physics, mirrored live into the browser.

    python sim/server.py            # headless PyBullet, open http://localhost:4620
    python sim/server.py --gui      # also open the native PyBullet window
                                    #   (arrows/space jog the arm, R = reset, ESC = quit)

PyBullet owns the physics. Instead of streaming pixels (PyBullet's CPU renderer manages
~2 fps on Windows), the server streams every body's link poses at 30 Hz and the browser draws
the same URDF meshes with WebGL. All PyBullet calls happen on the sim thread; HTTP handlers
only enqueue commands and read snapshots.

API
  GET  /api/state                          phase, bins, last result
  GET  /api/events                         SSE: "scene" (visual shapes) and "pose" (30 Hz) events
  POST /api/trial/start   {id}                pick up the part and hold, waiting for intent
  POST /api/trial/decide  {id, trial}         decode the trial's EEG live -> left|right|fists|feet|rest
  POST /api/order         {zone, rgba}        light up the target bin, paint the waiting part
  POST /api/jog           {id, trial}         decode the trial's EEG live, then make one move with it
  POST /api/decode        {trial}             decode only: posterior, latency (no robot motion)
  POST /api/ship          {zone}              seal a full box and ship it (its computers leave the cell)
  GET  /api/levels                         everyday-task levels (sim/levels.py)
  POST /api/level         {id}                load a level: rebuilds the PyBullet scene
  POST /api/step          {id, trial}         decode the trial live; if it matches the step's command, do the step
  POST /api/reset
  GET  /pb/<path>                          mesh files from pybullet_data
"""
from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import queue
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pybullet as p
import pybullet_data

from arm import COMMANDS, HZ, ProstheticArm
from decoder import LiveDecoder
from levels import BY_ID as LEVELS_BY_ID, LEVELS

GAME_DIR = Path(__file__).resolve().parent.parent / "game"
PB_DIR = Path(pybullet_data.getDataPath()).resolve()
HESITATE_BELOW = 0.65
POSE_HZ = 50                 # browser interpolates between these snapshots
SCENE_REFRESH = 0.5          # full visual re-scan at most this often unless something changed
log = logging.getLogger("sim")


def empty_bins() -> dict:
    return {**{c: 0 for c in COMMANDS}, "floor": 0}


class Sim:
    def __init__(self, gui: bool):
        self.gui = gui
        self.c = p.connect(p.GUI, options="--width=1280 --height=760") if gui else p.connect(p.DIRECT)
        if gui:
            p.configureDebugVisualizer(p.COV_ENABLE_GUI, 0, physicsClientId=self.c)
            p.configureDebugVisualizer(p.COV_ENABLE_SHADOWS, 1, physicsClientId=self.c)
            p.resetDebugVisualizerCamera(2.1, 90, -40, [0.0, 0, 0.15], physicsClientId=self.c)
        self.arm = ProstheticArm(self.c)
        self.decoder = LiveDecoder()
        self.cmds: queue.Queue = queue.Queue()
        self.visual: queue.Queue = queue.Queue()  # instant visual changes, applied between steps
        self.lock = threading.Lock()
        self.tick = threading.Condition()
        self.scene: dict = {"version": 0, "bodies": {}}
        self.poses: dict = {"t": 0, "bodies": {}}
        self.pose_no = 0
        self.state = {"phase": "booting", "trial": None, "bins": empty_bins(),
                      "result": None, "holding": False, "simTime": 0.0,
                      "scene": "packing", "level": None, "step": 0, "levelDone": False, "lampOn": False, "flags": {}}
        self.running = True

    # ---------- jobs (generators of physics steps)
    def _set(self, **kw):
        with self.lock:
            self.state.update(kw)

    def job_boot(self):
        self._set(phase="spawning")
        yield from self.arm.spawn_part()
        yield from self.arm.return_to_neutral()
        self._set(phase="idle")

    def job_start(self, trial):
        self._set(phase="picking", trial=trial, result=None)
        if not self.arm.holding():
            yield from self.arm.pick()
        self._set(phase="holding", holding=True)
        yield from self.arm.hold()

    def job_decide(self, trial, command, conf):
        if not self.arm.holding():  # decide without start (e.g. keyboard): pick first
            yield from self.job_start(trial)
        self._set(phase="deciding")
        if conf < HESITATE_BELOW:
            yield from self.arm.hesitate(command)
        self._set(phase="acting")
        body = self.arm.part
        yield from self.arm.execute(command)
        self._set(holding=False)
        yield from self.arm.wait(0.9)  # let the part settle, then read where physics put it
        landed = self.arm.landed_zone(body)
        if command == "rest" and landed != "rest":  # fell off the infeed: clear it
            self.arm.parts_landed.append(body)
            self.arm.part = None
        with self.lock:
            self.state["bins"][landed] += 1
            self.state["result"] = {"trial": trial, "commanded": command, "landed": landed, "conf": conf}
        self._set(phase="returning")
        yield from self.arm.return_to_neutral()
        self._set(phase="spawning")
        yield from self.arm.spawn_part()
        self._set(phase="idle", trial=None)

    def job_jog(self, trial, command, conf):
        self._set(phase="jogging", trial=trial, result=None)
        yield from self.arm.jog(command)
        info = dict(self.arm.jog_info)
        landed = None
        if info["released"] is not None:
            body = info["released"]
            yield from self.arm.wait(0.9)
            landed = self.arm.landed_zone(body)
            if landed != "rest":  # left the infeed: it's done, bring in the next part
                self.arm.parts_landed.append(body)
                self.arm.part = None
            with self.lock:
                self.state["bins"][landed] += 1
        with self.lock:
            self.state["holding"] = self.arm.holding()
            self.state["result"] = {"trial": trial, "commanded": command, "action": info["action"], "landed": landed, "conf": conf}
        if self.arm.part is None:
            self._set(phase="spawning")
            yield from self.arm.spawn_part()
        self._set(phase="idle", trial=None)

    def job_level(self, level_id):
        lv = LEVELS_BY_ID[level_id]
        self._set(phase="loading", level=level_id, step=0, levelDone=False, lampOn=False, flags={}, result=None, holding=False,
                  scene=lv["scene"], bins=empty_bins())
        # a fresh PyBullet world for the level's scene
        p.disconnect(self.arm.ik_c)
        p.resetSimulation(physicsClientId=self.c)
        self.arm = ProstheticArm(self.c, scene=lv["scene"])
        for o in lv["objects"]:
            self.arm.add_object(o["name"], o["shape"], o["size"], o["pos"], o.get("rgba", (0.9, 0.9, 0.9, 1)),
                                o.get("mass", 0.2), o.get("static", False))
        yield from self.arm.wait(0.3)
        if lv["scene"] == "packing":
            yield from self.arm.spawn_part()
        self._set(phase="idle")

    def job_step(self, trial, dec):
        with self.lock:
            level_id, i = self.state["level"], self.state["step"]
        lv = LEVELS_BY_ID.get(level_id)
        if not lv or i >= len(lv["steps"]):
            return
        st = lv["steps"][i]
        self._set(phase="acting", trial=trial)
        ok = dec["command"] == st["cmd"]
        landed = None
        if not ok:  # the headset read a different intention: the arm does nothing (a small 'no')
            yield from self.arm.confused()
        else:
            kind = st["do"][0]
            if kind == "pick":
                yield from self.arm.pick_object(st["do"][1])
            elif kind == "handoff":
                yield from self.arm.handoff(st["do"][1])
            elif kind == "place":
                yield from self.arm.place_on(st["do"][1])
                yield from self.arm.return_to_neutral()
            elif kind == "press":
                yield from self.arm.press(st["do"][1])
                yield from self.arm.return_to_neutral()
            elif kind == "pour":
                yield from self.arm.pour_over(st["do"][1])
            elif kind == "wait":
                yield from self.arm.wait(1.0)
            elif kind == "pack":
                if not self.arm.holding():
                    yield from self.arm.pick()
                body = self.arm.part
                yield from self.arm.execute(st["do"][1])
                yield from self.arm.wait(0.9)
                landed = self.arm.landed_zone(body)
                with self.lock:
                    self.state["bins"][landed] += 1
                yield from self.arm.return_to_neutral()
                yield from self.arm.spawn_part()
                ok = landed == st["do"][1]
        if ok and st.get("then") == "lamp_on":
            self._set(lampOn=True)
        elif ok and st.get("then"):  # level-specific effects: TV on, phone charging, plant watered...
            with self.lock:
                self.state["flags"] = {**self.state["flags"], st["then"]: True}
        with self.lock:
            if ok:
                self.state["step"] = i + 1
                self.state["levelDone"] = i + 1 >= len(lv["steps"])
            self.state["holding"] = self.arm.holding()
            self.state["result"] = {"trial": trial, "ok": ok, "expected": st["cmd"], "commanded": dec["command"],
                                    "conf": dec["conf"], "landed": landed}
        self._set(phase="idle", trial=None)

    def job_reset(self):
        self._set(phase="resetting", trial=None, result=None, holding=False, bins=empty_bins())
        self.arm.clear()
        yield from self.arm.return_to_neutral()
        yield from self.job_boot()

    # ---------- mirroring
    def _visuals(self, body: int) -> list[dict]:
        out = []
        for v in p.getVisualShapeData(body, physicsClientId=self.c):
            _, link, gtype, dims, fname, lpos, lorn, rgba = v[:8]
            item = {"link": link, "type": gtype, "dims": list(dims), "pos": list(lpos), "orn": list(lorn), "rgba": list(rgba)}
            if gtype == p.GEOM_MESH:
                path = Path(fname.decode()).resolve()
                try:
                    item["mesh"] = "/pb/" + path.relative_to(PB_DIR).as_posix()
                except ValueError:
                    continue
            out.append(item)
        return out

    def _role(self, body: int) -> str:
        a = self.arm
        if body == a.robot: return "robot"
        if body == a.plane: return "plane"
        if body == a.cup: return "tool"
        if body == a.pedestal: return "infeed"
        for name, b in a.objects.items():
            if body == b: return "obj-" + name
        if body in a.bins.values(): return "bin-" + next(k for k, v in a.bins.items() if v == body)
        if body == a.part or body in a.parts_landed: return "part"
        return "fixture"

    def sync_scene(self, force: bool = False):
        """Rebuild the visual description if bodies or colours changed. The full scan is costly
        (it reads every visual shape), so it runs only when the set of bodies changes, after a
        visual edit, or every SCENE_REFRESH seconds as a safety net."""
        ids = tuple(p.getBodyUniqueId(i, physicsClientId=self.c) for i in range(p.getNumBodies(physicsClientId=self.c)))
        now = time.perf_counter()
        if not force and ids == getattr(self, "_scene_ids", None) and now - getattr(self, "_scene_at", 0) < SCENE_REFRESH:
            return
        self._scene_ids, self._scene_at = ids, now
        bodies = {}
        for i in range(p.getNumBodies(physicsClientId=self.c)):
            b = p.getBodyUniqueId(i, physicsClientId=self.c)
            bodies[str(b)] = {"role": self._role(b), "visuals": self._visuals(b)}
        if bodies != self.scene["bodies"]:
            self.scene = {"version": self.scene["version"] + 1, "bodies": bodies}

    def snapshot_poses(self, t: float):
        poses = {}
        for i in range(p.getNumBodies(physicsClientId=self.c)):
            b = p.getBodyUniqueId(i, physicsClientId=self.c)
            pos, orn = p.getBasePositionAndOrientation(b, physicsClientId=self.c)
            ipos, iorn = p.getDynamicsInfo(b, -1, physicsClientId=self.c)[3:5]
            inv = p.invertTransform(ipos, iorn)
            bpos, born = p.multiplyTransforms(pos, orn, *inv)  # base inertial frame -> URDF base frame
            links = [[round(x, 4) for x in bpos + born]]
            n = p.getNumJoints(b, physicsClientId=self.c)
            if n:
                for ls in p.getLinkStates(b, list(range(n)), computeForwardKinematics=True, physicsClientId=self.c):
                    links.append([round(x, 4) for x in ls[4] + ls[5]])
            poses[str(b)] = links
        with self.tick:
            self.poses = {"t": round(t, 4), "bodies": poses}
            self.pose_no += 1
            self.tick.notify_all()

    def keyboard(self):
        keys = p.getKeyboardEvents(physicsClientId=self.c)
        hit = lambda k: k in keys and keys[k] & p.KEY_WAS_TRIGGERED
        for key, cmd in ((p.B3G_LEFT_ARROW, "left"), (p.B3G_RIGHT_ARROW, "right"), (p.B3G_UP_ARROW, "fists"),
                         (p.B3G_DOWN_ARROW, "feet"), (ord(" "), "rest")):
            if hit(key):
                self.cmds.put(("jog", "kbd", cmd, 1.0))
        if hit(ord("r")):
            self.cmds.put(("reset",))
        if hit(27):
            self.running = False

    # ---------- main loop
    def loop(self):
        job = self.job_boot()
        sim_t, wall0, last_pose = 0.0, time.perf_counter(), 0.0
        while self.running:
            if job is None:
                try:
                    cmd = self.cmds.get_nowait()
                    job = {"start": self.job_start, "decide": self.job_decide, "jog": self.job_jog, "reset": self.job_reset,
                           "level": self.job_level, "step": self.job_step}[cmd[0]](*cmd[1:])
                except queue.Empty:
                    pass
            dirty = False
            while not self.visual.empty():
                dirty = True
                zone, rgba = self.visual.get_nowait()
                if zone == "__ship__":
                    log.info("shipped %d computers from %s", self.arm.ship(rgba), rgba)
                    continue
                self.arm.set_target(zone)
                if rgba:
                    self.arm.paint_part(rgba)
            target = time.perf_counter() - wall0
            steps = 0
            while sim_t < target and steps < HZ // 10:
                if job is not None:
                    try:
                        next(job)
                    except StopIteration:
                        job = None
                        dirty = True
                        self.arm.step()
                else:
                    self.arm.step()
                sim_t += 1 / HZ
                steps += 1
            if sim_t < target - 0.5:  # fell far behind: drop the debt instead of fast-forwarding
                sim_t = target
            if self.gui:
                self.keyboard()
            now = time.perf_counter()
            if now - last_pose >= 1 / POSE_HZ:
                self.sync_scene(force=dirty)
                self.snapshot_poses(sim_t)
                self._set(simTime=round(sim_t, 2))
                last_pose = now
            time.sleep(0.002)
        p.disconnect(self.c)


def make_handler(sim: Sim):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(GAME_DIR), **kw)

        def log_message(self, fmt, *args):
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")

        def do_GET(self):
            if self.path.startswith("/api/state"):
                with sim.lock:
                    return self._json(json.loads(json.dumps(sim.state)))
            if self.path.startswith("/api/levels"):
                return self._json(LEVELS)
            if self.path.startswith("/api/events"):
                return self.events()
            if self.path.startswith("/pb/"):
                return self.pb_file()
            return super().do_GET()

        def pb_file(self):
            rel = self.path[4:].split("?")[0]
            path = (PB_DIR / rel).resolve()
            if PB_DIR not in path.parents or path.suffix.lower() not in (".obj", ".mtl", ".jpg", ".png", ".stl") or not path.is_file():
                return self._json({"error": "not found"}, 404)
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _live(self, data):
            """Decode the named trial from its EEG now (NumPy, off the physics thread)."""
            trial = data.get("trial")
            if not trial or trial not in sim.decoder.index:
                return None
            dec = sim.decoder.decode(trial)
            with sim.lock:
                sim.state["lastDecode"] = dec
            log.info("decoded %s live in %.2f ms -> %s (%.0f%%)", trial, dec["ms"], dec["command"], dec["conf"] * 100)
            return dec

        def do_POST(self):
            try:
                data = self._body()
            except json.JSONDecodeError:
                return self._json({"error": "bad json"}, 400)
            if self.path == "/api/trial/start":
                sim.cmds.put(("start", str(data.get("id"))))
            elif self.path == "/api/decode":
                dec = self._live(data)
                return self._json(dec) if dec else self._json({"error": "unknown trial"}, 404)
            elif self.path == "/api/trial/decide":
                dec = self._live(data)
                command, conf = (dec["command"], dec["conf"]) if dec else (data.get("command"), float(data.get("conf", 1.0)))
                if command not in COMMANDS:
                    return self._json({"error": f"command must be one of {COMMANDS}"}, 400)
                sim.cmds.put(("decide", str(data.get("id")), command, conf))
                return self._json({"ok": True, "decode": dec})
            elif self.path == "/api/jog":
                dec = self._live(data)
                command, conf = (dec["command"], dec["conf"]) if dec else (data.get("command"), float(data.get("conf", 1.0)))
                if command not in COMMANDS:
                    return self._json({"error": f"command must be one of {COMMANDS}"}, 400)
                sim.cmds.put(("jog", str(data.get("id")), command, conf))
                return self._json({"ok": True, "decode": dec})
            elif self.path == "/api/order":
                zone = data.get("zone")
                rgba = data.get("rgba")
                rgba = [float(x) for x in rgba][:4] if isinstance(rgba, list) and len(rgba) == 4 else None
                sim.visual.put((zone if zone in COMMANDS else None, rgba))
            elif self.path == "/api/level":
                if data.get("id") not in LEVELS_BY_ID:
                    return self._json({"error": "unknown level"}, 404)
                sim.cmds.put(("level", data["id"]))
            elif self.path == "/api/step":
                dec = self._live(data)
                if not dec:
                    return self._json({"error": "unknown trial"}, 404)
                sim.cmds.put(("step", str(data.get("id")), dec))
                return self._json({"ok": True, "decode": dec})
            elif self.path == "/api/ship":
                if data.get("zone") not in ("left", "right"):
                    return self._json({"error": "zone must be left|right"}, 400)
                sim.visual.put(("__ship__", data["zone"]))
            elif self.path == "/api/reset":
                sim.cmds.put(("reset",))
            else:
                return self._json({"error": "not found"}, 404)
            return self._json({"ok": True})

        def events(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            seen_scene, seen_pose = -1, -1
            try:
                while sim.running:
                    with sim.tick:
                        sim.tick.wait_for(lambda: sim.pose_no != seen_pose or not sim.running, timeout=2)
                        poses, seen_pose = sim.poses, sim.pose_no
                    msg = b""
                    if sim.scene["version"] != seen_scene:
                        scene = sim.scene
                        seen_scene = scene["version"]
                        msg += b"event: scene\ndata: " + json.dumps(scene).encode() + b"\n\n"
                    with sim.lock:
                        st = json.dumps(sim.state)
                    msg += b"event: pose\ndata: " + json.dumps({"t": poses.get("t", 0), "poses": poses.get("bodies", {}), "state": json.loads(st)}).encode() + b"\n\n"
                    self.wfile.write(msg)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gui", action="store_true", help="also open the native PyBullet window")
    ap.add_argument("--port", type=int, default=4620)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    sim = Sim(args.gui)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(sim))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log.info("NeuroReach sim running -> http://localhost:%d  (%s)", args.port, "with PyBullet window" if args.gui else "headless")
    log.info("live decoder: %d models, %d trials%s", len(sim.decoder.models), len(sim.decoder.index),
             "" if sim.decoder.ready else "  (run export_eeg.py to build models/live_decoders.npz)")
    try:
        sim.loop()
    except KeyboardInterrupt:
        sim.running = False
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
