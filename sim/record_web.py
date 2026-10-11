"""Record every level from the real PyBullet simulation for the static web edition.

For each level we capture the scene (visual shapes) and, for every step, two clips of link
poses at 30 Hz:
    ok[i]        the robot performing step i (what happens when the decoded command matches)
    confused[i]  the robot's small "no" when the decoded command doesn't match (state unchanged)
The browser replays these through the same interpolation path the live server feeds.

    python sim/record_web.py   ->  web/levels.json, web/levels/<id>.json
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pybullet as p

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402
from levels import LEVELS  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "web"
EVERY = 8                       # 240 Hz physics / 8 = 30 Hz frames
STATE_KEYS = ("phase", "holding", "step", "levelDone", "lampOn", "flags", "bins")


def r(links):
    return [[round(v, 4) for v in l] for l in links]


class Recorder:
    def __init__(self, sim: server.Sim):
        self.sim = sim
        self.last: dict = {}

    def scene(self):
        self.sim.sync_scene(force=True)
        sc = copy.deepcopy(self.sim.scene)
        for b in sc["bodies"].values():           # mesh urls relative to the site, not /pb/
            for v in b["visuals"]:
                if "mesh" in v:
                    v["mesh"] = v["mesh"].lstrip("/")
        return sc

    def frame(self, t, full=False):
        self.sim.snapshot_poses(t)
        poses = {k: r(v) for k, v in self.sim.poses["bodies"].items()}
        changed = poses if full else {k: v for k, v in poses.items() if self.last.get(k) != v}
        self.last.update(poses)
        st = {k: copy.deepcopy(self.sim.state.get(k)) for k in STATE_KEYS}
        return {"t": round(t, 4), "p": changed, "s": st}

    def clip(self, gen):
        """Run a job generator (one physics step per next()) and capture 30 Hz frames."""
        frames, n, ids = [self.frame(0.0, full=True)], 0, self._ids()
        frames[0]["scene"] = self.scene()
        for _ in gen:
            n += 1
            if n % EVERY == 0:
                f = self.frame(n / server.HZ)
                if self._ids() != ids:             # a body appeared or vanished (new computer...)
                    ids = self._ids()
                    f["scene"] = self.scene()
                    f["p"] = {k: r(v) for k, v in self.sim.poses["bodies"].items()}
                frames.append(f)
        frames.append(self.frame((n + 1) / server.HZ))
        return frames

    def _ids(self):
        c = self.sim.c
        return tuple(p.getBodyUniqueId(i, physicsClientId=c) for i in range(p.getNumBodies(physicsClientId=c)))


def snapshot(sim):
    a = sim.arm
    return (p.saveState(physicsClientId=sim.c), a.tip.copy(), list(a.q), a.tool_yaw, a.part, list(a.parts_landed),
            a.grip, a.held_h, copy.deepcopy(sim.state))


def restore(sim, snap):
    sid, tip, q, yaw, part, landed, grip, held, state = snap
    p.restoreState(sid, physicsClientId=sim.c)
    a = sim.arm
    a.tip, a.q, a.tool_yaw, a.part, a.parts_landed, a.grip, a.held_h = tip, q, yaw, part, landed, grip, held
    sim.state = state
    p.removeState(sid, physicsClientId=sim.c)


def main():
    (OUT / "levels").mkdir(parents=True, exist_ok=True)
    sim = server.Sim(False)
    for _ in sim.job_boot():
        pass
    index = []
    for lv in LEVELS:
        for _ in sim.job_level(lv["id"]):
            pass
        rec = Recorder(sim)
        start = rec.frame(0.0, full=True)
        start["scene"] = rec.scene()
        ok, confused = [], []
        for i, st in enumerate(lv["steps"]):
            snap = snapshot(sim)
            rec.last = {}
            sim._set(phase="acting")
            confused.append(rec.clip(sim.arm.confused()))
            restore(sim, snap)
            rec.last = {}
            ok.append(rec.clip(sim.job_step(f"rec{i}", {"command": st["cmd"], "conf": 0.9})))
            assert sim.state["result"]["ok"], (lv["id"], i)
        data = {"id": lv["id"], "start": start, "ok": ok, "confused": confused}
        (OUT / "levels" / f"{lv['id']}.json").write_text(json.dumps(data, separators=(",", ":")))
        index.append(lv)
        size = (OUT / "levels" / f"{lv['id']}.json").stat().st_size / 1e6
        print(f"{lv['id']:10s} {len(lv['steps'])} steps  {sum(len(c) for c in ok)} frames  {size:.2f} MB")
    (OUT / "levels.json").write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
