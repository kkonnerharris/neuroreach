"""PyBullet disposition cell: KUKA iiwa (bundled with pybullet_data) with a suction tool, an
infeed pedestal, and four outfeed bins. Five EEG commands drive five dispositions:

    left   (left fist)    -> LINE A bin      move_left()
    right  (right fist)   -> LINE B bin      move_right()
    fists  (both fists)   -> ASSEMBLY bin    move_assembly()
    feet   (both feet)    -> REJECT bin      move_reject()
    rest   (rest)         -> HOLD: part goes back on the infeed   hold_part()

Every motion is a generator that advances one physics step per `next()`, so a single sim
thread can interleave stepping, mirroring and command handling without any PyBullet call
ever leaving that thread.
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Iterator

import numpy as np
import pybullet as p
import pybullet_data

HZ = 240
EE_LINK = 6
TOOL_LEN = 0.075                      # flange -> suction-cup tip
# Viewed from the default camera (+x looking back at the robot), screen-right is +y.
BINS = {
    "left": (0.12, -0.62, 0.0),       # BOX A (cardboard shipping box)
    "right": (0.12, 0.62, 0.0),       # BOX B (cardboard shipping box)
    "fists": (-0.5, -0.42, 0.0),      # ASSEMBLY
    "feet": (-0.5, 0.42, 0.0),        # REJECT
}
COMMANDS = ("left", "right", "fists", "feet", "rest")
BIN_HALF = 0.2                        # traybox.urdf at scale 0.8 -> ~0.4 m inner
BIN_TOP = 0.3                         # anything inside the footprint below this is in the bin
PEDESTAL = (0.62, 0.0)
PEDESTAL_HALF = (0.16, 0.22)
PEDESTAL_TOP = 0.16
PART_HALF = (0.035, 0.05, 0.055)      # a small desktop computer (tower), 7 x 10 x 11 cm
PART_H = 2 * PART_HALF[2]
BOX_INNER, BOX_WALL, BOX_H = 0.17, 0.008, 0.2   # shipping box: 34 cm square, 20 cm tall
HOME = (0.45, 0.0, 0.45)
HOME_TABLE = (0.3, 0.0, 0.5)          # at the dining table the arm waits upright, out of the person's face
HANDOFF = (0.72, 0.0)                 # in front of the seated person (home scene)
JOG_R = 0.63                          # radius of the infeed/bin circle
JOG_YAW = math.radians(20)
JOG_YAW_MAX = math.radians(160)
JOG_Z, JOG_Z_MIN, JOG_Z_MAX = 0.12, 0.24, 0.62
BIN_IDLE = [0.55, 0.6, 0.58, 1]
CARDBOARD = [0.74, 0.55, 0.34, 1]
BIN_TARGET = [0.84, 1.0, 0.23, 1]
PART_IDLE = [0.78, 0.8, 0.82, 1]
# Null-space IK setup adapted from pybullet's kuka example, with the base joint opened to its
# real range so the arm can swing to the side and rear bins; joint 4 stays positive (elbow up).
LL = [-2.9, -2.0, -2.9, 0.19, -2.9, -2.05, -3.0]   # small margin inside the URDF limits
UL = [2.9, 2.0, 2.9, 2.29, 2.9, 2.05, 3.0]
JR = [u - l for l, u in zip(LL, UL)]
REST_POSE = [0.0, 0.0, 0.0, 0.5 * math.pi, 0.0, -math.pi * 0.5 * 0.66, 0.0]


def smooth(t: float) -> float:
    """Minimum-jerk profile (Flash & Hogan): zero velocity *and* acceleration at both ends,
    the same bell-shaped speed curve as a human reach."""
    return t * t * t * (10 - 15 * t + 6 * t * t)


class ProstheticArm:
    def __init__(self, client: int, scene: str = "packing"):
        """scene="packing": infeed + shipping boxes. scene="home": the plane is a table top and
        everyday objects are added with add_object() (see sim/levels.py)."""
        self.c = client
        self.scene = scene
        self.objects: dict[str, int] = {}
        p.setAdditionalSearchPath(pybullet_data.getDataPath(), physicsClientId=client)
        p.setGravity(0, 0, -9.81, physicsClientId=client)
        p.setTimeStep(1 / HZ, physicsClientId=client)

        self.plane = p.loadURDF("plane.urdf", physicsClientId=client)
        p.changeVisualShape(self.plane, -1, rgbaColor=[0.2, 0.23, 0.22, 1], physicsClientId=client)

        self.robot = p.loadURDF("kuka_iiwa/model.urdf", [0, 0, 0], useFixedBase=True, physicsClientId=client)
        self.n_joints = p.getNumJoints(self.robot, physicsClientId=client)
        # Kinematic twin in its own client: IK is solved there, seeded with the previous
        # solution, so targets stay continuous even while the physical arm lags behind.
        self.ik_c = p.connect(p.DIRECT)
        self.ghost = p.loadURDF(str(Path(pybullet_data.getDataPath()) / "kuka_iiwa/model.urdf"), useFixedBase=True, physicsClientId=self.ik_c)
        self.q = list(REST_POSE)
        self.tool_yaw = 0.0
        self.home = HOME_TABLE if scene == "home" else HOME
        self.q = self._solve(self.home, iters=4)
        for j, q in enumerate(self.q):
            p.resetJointState(self.robot, j, q, physicsClientId=client)

        # suction cup: visual-only and kinematic (re-posed onto the flange every step), so it
        # exerts no force on the arm
        cup_v = p.createVisualShape(p.GEOM_CYLINDER, radius=0.028, length=0.05, rgbaColor=[0.84, 1.0, 0.23, 1], physicsClientId=client)
        self.cup = p.createMultiBody(0, -1, cup_v, basePosition=[0, 0, 1], physicsClientId=client)

        self.bins, self.bin_idle = {}, {}
        self.pedestal = None
        if scene == "packing":
            self._build_packing_cell()

        self.part_shape = p.createCollisionShape(p.GEOM_BOX, halfExtents=PART_HALF, physicsClientId=client)
        self.part: int | None = None
        self.part_rgba = PART_IDLE
        self.parts_landed: list[int] = []
        self.grip: int | None = None
        self.held_h = PART_H
        self.rng = np.random.default_rng(7)
        self.tip = np.array(self.home, dtype=float)
        self._apply_ik(self.tip)

    def _build_packing_cell(self) -> None:
        client = self.c
        hx, hy = PEDESTAL_HALF
        ped_c = p.createCollisionShape(p.GEOM_BOX, halfExtents=[hx, hy, PEDESTAL_TOP / 2], physicsClientId=client)
        ped_v = p.createVisualShape(p.GEOM_BOX, halfExtents=[hx, hy, PEDESTAL_TOP / 2], rgbaColor=[0.16, 0.19, 0.17, 1], physicsClientId=client)
        self.pedestal = p.createMultiBody(0, ped_c, ped_v, [PEDESTAL[0], PEDESTAL[1], PEDESTAL_TOP / 2], physicsClientId=client)
        stripe_v = p.createVisualShape(p.GEOM_BOX, halfExtents=[hx + 0.001, hy + 0.001, 0.006], rgbaColor=[0.84, 1.0, 0.23, 1], physicsClientId=client)
        p.createMultiBody(0, -1, stripe_v, [PEDESTAL[0], PEDESTAL[1], PEDESTAL_TOP - 0.02], physicsClientId=client)

        self.bins, self.bin_idle = {}, {}
        for zone, pos in BINS.items():
            if zone in ("left", "right"):
                bid, idle = self._shipping_box(pos), CARDBOARD
            else:
                bid, idle = p.loadURDF("tray/traybox.urdf", pos, globalScaling=0.8, useFixedBase=True, physicsClientId=client), BIN_IDLE
            p.changeVisualShape(bid, -1, rgbaColor=idle, physicsClientId=client)
            self.bins[zone], self.bin_idle[zone] = bid, idle

    def _shipping_box(self, pos) -> int:
        """Open-top cardboard box: a floor and four walls in one static body."""
        i, w, h = BOX_INNER, BOX_WALL, BOX_H / 2
        halves = [[i + w, i + w, w / 2], [w / 2, i + w, h], [w / 2, i + w, h], [i + w, w / 2, h], [i + w, w / 2, h]]
        frames = [[0, 0, w / 2], [i + w / 2, 0, h], [-i - w / 2, 0, h], [0, i + w / 2, h], [0, -i - w / 2, h]]
        col = p.createCollisionShapeArray([p.GEOM_BOX] * 5, halfExtents=halves, collisionFramePositions=frames, physicsClientId=self.c)
        vis = p.createVisualShapeArray([p.GEOM_BOX] * 5, halfExtents=halves, visualFramePositions=frames, physicsClientId=self.c)
        return p.createMultiBody(0, col, vis, basePosition=pos, physicsClientId=self.c)

    def ship(self, zone: str) -> int:
        """Seal and ship a full box: its computers leave the cell, an empty box remains."""
        gone = [b for b in self.parts_landed if self.landed_zone(b) == zone]
        for b in gone:
            p.removeBody(b, physicsClientId=self.c)
            self.parts_landed.remove(b)
        return len(gone)

    # ---------- low level
    def _tip_now(self):
        ls = p.getLinkState(self.robot, EE_LINK, computeForwardKinematics=True, physicsClientId=self.c)
        return (ls[4][0], ls[4][1], ls[4][2] - TOOL_LEN)

    def _solve(self, tip, iters=2, tool_yaw=None):
        """IK for a downward-pointing tool tip. The suction cup is round, so the tool's spin
        is free: it is chosen per transfer (see `transfer`) and held during Cartesian moves."""
        target = [tip[0], tip[1], tip[2] + TOOL_LEN]
        yaw = math.atan2(tip[1], tip[0])
        orn = p.getQuaternionFromEuler([0, -math.pi, self.tool_yaw if tool_yaw is None else tool_yaw])
        rest = [yaw] + REST_POSE[1:]  # null space prefers the base facing the target
        q = self.q
        for _ in range(iters):
            for j in range(self.n_joints):
                p.resetJointState(self.ghost, j, q[j], physicsClientId=self.ik_c)
            q = list(p.calculateInverseKinematics(
                self.ghost, EE_LINK, target, orn,
                lowerLimits=LL, upperLimits=UL, jointRanges=JR, restPoses=rest,
                maxNumIterations=200, residualThreshold=1e-6, physicsClientId=self.ik_c,
            ))
        return q

    def _apply_ik(self, tip):
        self.q = self._solve(tip)
        p.setJointMotorControlArray(
            self.robot, list(range(self.n_joints)), p.POSITION_CONTROL, targetPositions=self.q,
            targetVelocities=[0] * self.n_joints, forces=[600] * self.n_joints,
            positionGains=[0.35] * self.n_joints, velocityGains=[1.0] * self.n_joints, physicsClientId=self.c,
        )

    def step(self):
        p.stepSimulation(physicsClientId=self.c)
        ls = p.getLinkState(self.robot, EE_LINK, computeForwardKinematics=True, physicsClientId=self.c)
        pos, _ = p.multiplyTransforms(ls[4], ls[5], [0, 0, TOOL_LEN - 0.025], [0, 0, 0, 1])
        p.resetBasePositionAndOrientation(self.cup, pos, ls[5], physicsClientId=self.c)

    def wait(self, sec: float) -> Iterator[None]:
        for _ in range(int(sec * HZ)):
            self.step()
            yield

    def move_to(self, tip, sec: float) -> Iterator[None]:
        """Interpolate the tool tip in cylindrical coordinates about the base so the arm
        sweeps around itself instead of cutting through its own body."""
        a, b = self.tip.copy(), np.array(tip, dtype=float)
        ra, rb = math.hypot(a[0], a[1]), math.hypot(b[0], b[1])
        ta, tb = math.atan2(a[1], a[0]), math.atan2(b[1], b[0])
        dt = math.atan2(math.sin(tb - ta), math.cos(tb - ta))
        n = max(1, int(sec * HZ))
        for i in range(1, n + 1):
            s = smooth(i / n)
            r, th = ra + (rb - ra) * s, ta + dt * s
            self.tip = np.array([r * math.cos(th), r * math.sin(th), a[2] + (b[2] - a[2]) * s])
            self._apply_ik(self.tip)
            self.step()
            yield
        yield from self.wait(0.05)  # let the position controller settle

    def _fk_tip(self, q):
        for j in range(self.n_joints):
            p.resetJointState(self.ghost, j, q[j], physicsClientId=self.ik_c)
        ls = p.getLinkState(self.ghost, EE_LINK, computeForwardKinematics=True, physicsClientId=self.ik_c)
        return np.array([ls[4][0], ls[4][1], ls[4][2] - TOOL_LEN])

    def transfer(self, tip, sec: float) -> Iterator[None]:
        """Long moves in joint space. The goal posture is solved from a clean seed with the
        base facing the target, so twist accumulated by earlier Cartesian moves can't drive a
        joint into its limit; the joints then interpolate smoothly to it."""
        yaw = math.atan2(tip[1], tip[0])
        q0 = np.array(self.q)
        best = None
        for ty in (0.0, yaw, yaw + math.pi):  # pick the tool spin that gives the cleanest posture
            self.q = [yaw] + REST_POSE[1:]
            q = self._solve(tip, iters=4, tool_yaw=ty)
            err = float(np.linalg.norm(self._fk_tip(q) - np.array(tip)))
            score = err + 0.01 * abs(q[6])
            if best is None or score < best[0]:
                best = (score, q, ty)
        _, q1, self.tool_yaw = best
        q1 = np.array(q1)
        n = max(1, int(sec * HZ))
        for i in range(1, n + 1):
            q = q0 + (q1 - q0) * smooth(i / n)
            self.q = q.tolist()
            self.tip = self._fk_tip(self.q)
            p.setJointMotorControlArray(
                self.robot, list(range(self.n_joints)), p.POSITION_CONTROL, targetPositions=self.q,
                targetVelocities=[0] * self.n_joints, forces=[600] * self.n_joints,
                positionGains=[0.35] * self.n_joints, velocityGains=[1.0] * self.n_joints, physicsClientId=self.c,
            )
            self.step()
            yield
        self.tip = np.array(tip, dtype=float)
        yield from self.wait(0.05)

    # ---------- parts
    def spawn_part(self, rgba=None) -> Iterator[None]:
        """Drop a fresh part onto the infeed (only if the infeed is empty)."""
        if self.part is not None:
            return
        self.part_rgba = list(rgba or PART_IDLE)
        vis = p.createVisualShape(p.GEOM_BOX, halfExtents=PART_HALF, rgbaColor=self.part_rgba, physicsClientId=self.c)
        self.part = p.createMultiBody(
            0.08, self.part_shape, vis,
            basePosition=[PEDESTAL[0], PEDESTAL[1], PEDESTAL_TOP + 0.25],
            baseOrientation=p.getQuaternionFromEuler([0, 0, np.random.uniform(0, math.pi)]),
            physicsClientId=self.c,
        )
        p.changeDynamics(self.part, -1, lateralFriction=0.9, restitution=0.15, physicsClientId=self.c)
        yield from self.wait(0.8)

    def paint_part(self, rgba) -> None:
        """Mark the waiting part with its work-order type colour."""
        self.part_rgba = list(rgba)
        if self.part is not None:
            p.changeVisualShape(self.part, -1, rgbaColor=self.part_rgba, physicsClientId=self.c)

    def _attach(self):
        ee = p.getLinkState(self.robot, EE_LINK, physicsClientId=self.c)
        pp, po = p.getBasePositionAndOrientation(self.part, physicsClientId=self.c)
        inv_p, inv_o = p.invertTransform(ee[4], ee[5])
        rel_p, rel_o = p.multiplyTransforms(inv_p, inv_o, pp, po)
        self.grip = p.createConstraint(self.robot, EE_LINK, self.part, -1, p.JOINT_FIXED, [0, 0, 0],
                                       rel_p, [0, 0, 0], rel_o, [0, 0, 0, 1], physicsClientId=self.c)
        p.changeConstraint(self.grip, maxForce=200, physicsClientId=self.c)

    def _release(self):
        if self.grip is not None:
            p.removeConstraint(self.grip, physicsClientId=self.c)
            self.grip = None

    def holding(self) -> bool:
        return self.grip is not None

    # ---------- task-level motions (the controller surface)
    def pick(self) -> Iterator[None]:
        if self.part is None:
            yield from self.spawn_part()
        (x, y, _), _ = p.getBasePositionAndOrientation(self.part, physicsClientId=self.c)
        lo, hi = p.getAABB(self.part, physicsClientId=self.c)
        top, self.held_h = hi[2], hi[2] - lo[2]
        yield from self.transfer((x, y, top + 0.15), 1.1)
        yield from self.move_to((x, y, top + 0.004), 0.6)
        self._attach()
        r = math.hypot(x, y)  # lift straight up and slightly in toward the robot
        yield from self.move_to((x * (r - 0.1) / r, y * (r - 0.1) / r, top + 0.25), 0.7)

    def hold(self) -> Iterator[None]:
        yield from self.transfer(self.home, 0.8)

    def hesitate(self, towards: str) -> Iterator[None]:
        """Low-confidence decode: visibly lean toward the decoded side before committing."""
        lean = {"left": -1, "fists": -1, "right": 1, "feet": 1}.get(towards, 0)
        hx, hy, hz = self.home
        yield from self.move_to((hx, hy + lean * 0.16, hz), 0.45)
        yield from self.move_to((hx, hy - lean * 0.12, hz), 0.5)
        yield from self.move_to(self.home, 0.35)

    def _carry_to(self, zone: str) -> Iterator[None]:
        bx, by, _ = BINS[zone]
        # spread drops over the bin floor so parts don't pile up and bounce out
        tx, ty = bx + self.rng.uniform(-0.1, 0.1), by + self.rng.uniform(-0.1, 0.1)
        yield from self.transfer((tx, ty, 0.42), 1.4 if bx > 0 else 2.0)
        yield from self.move_to((tx, ty, 0.2), 0.4)
        self._release()
        if self.part is not None:
            self.parts_landed.append(self.part)
            self.part = None
        yield from self.move_to((tx, ty, 0.45), 0.4)

    def move_left(self) -> Iterator[None]:
        yield from self._carry_to("left")

    def move_right(self) -> Iterator[None]:
        yield from self._carry_to("right")

    def move_assembly(self) -> Iterator[None]:
        yield from self._carry_to("fists")

    def move_reject(self) -> Iterator[None]:
        yield from self._carry_to("feet")

    def hold_part(self) -> Iterator[None]:
        """REST: no disposition. Set the part back down on the infeed."""
        x, y = PEDESTAL
        yield from self.transfer((x, y, PEDESTAL_TOP + PART_H + 0.15), 1.0)
        yield from self.move_to((x, y, PEDESTAL_TOP + PART_H + 0.012), 0.5)
        self._release()
        yield from self.move_to((x - 0.1, y, PEDESTAL_TOP + 0.35), 0.5)

    def execute(self, command: str) -> Iterator[None]:
        yield from {
            "left": self.move_left, "right": self.move_right, "fists": self.move_assembly,
            "feet": self.move_reject, "rest": self.hold_part,
        }[command]()

    def return_to_neutral(self) -> Iterator[None]:
        yield from self.transfer(self.home, 1.0)

    # ---------- direct control: one EEG command = one jog of the arm
    # The infeed and all four bins sit on one circle around the base, so rotate + raise/lower
    # is enough to pick a part up and drop it anywhere.
    def jog(self, command: str) -> Iterator[None]:
        """left/right rotate the arm about its base, fists raises, feet lowers (grabbing a
        part it lands on, or releasing one it holds), rest holds still. Sets self.jog_info."""
        x, y, z = self.tip
        th = math.atan2(y, x)
        self.jog_info = {"action": "hold", "released": None}
        if command in ("left", "right"):
            th = float(np.clip(th + (JOG_YAW if command == "right" else -JOG_YAW), -JOG_YAW_MAX, JOG_YAW_MAX))
            self.jog_info["action"] = f"rotate {command} to {math.degrees(th):.0f}°"
            yield from self.transfer((JOG_R * math.cos(th), JOG_R * math.sin(th), z), 0.7)
        elif command == "fists":
            z = min(z + JOG_Z, JOG_Z_MAX)
            self.jog_info["action"] = f"raise to {z:.2f} m"
            yield from self.move_to((JOG_R * math.cos(th), JOG_R * math.sin(th), z), 0.5)
        elif command == "feet":
            yield from self._jog_down(th, z)
        else:
            yield from self.wait(0.4)

    def _jog_down(self, th, z) -> Iterator[None]:
        cx, cy = JOG_R * math.cos(th), JOG_R * math.sin(th)
        if self.holding():
            floor = PEDESTAL_TOP + PART_H + 0.012 if abs(th) < 0.3 else 0.2
            yield from self.move_to((cx, cy, floor), 0.6)
            body = self.part
            self._release()
            self.jog_info.update(action="lower + release", released=body)
            yield from self.move_to((cx, cy, max(z, 0.4)), 0.4)
            return
        if self.part is not None:
            (px, py, pz), _ = p.getBasePositionAndOrientation(self.part, physicsClientId=self.c)
            if math.hypot(px - cx, py - cy) < 0.08 and z - (pz + PART_H / 2) < JOG_Z + 0.1:
                top = pz + PART_H / 2
                yield from self.move_to((px, py, top + 0.004), 0.6)
                self._attach()
                self.jog_info["action"] = "lower + grab part"
                yield from self.move_to((px, py, max(z, top + 0.2)), 0.5)
                return
        z = max(z - JOG_Z, JOG_Z_MIN)
        self.jog_info["action"] = f"lower to {z:.2f} m"
        yield from self.move_to((cx, cy, z), 0.5)

    def landed_zone(self, body: int) -> str:
        """Where did the part physically end up? a bin key, 'rest' (infeed) or 'floor'."""
        (x, y, z), _ = p.getBasePositionAndOrientation(body, physicsClientId=self.c)
        for zone, (bx, by, _) in BINS.items():
            if abs(x - bx) < BIN_HALF and abs(y - by) < BIN_HALF and z < BIN_TOP:
                return zone
        if abs(x - PEDESTAL[0]) < PEDESTAL_HALF[0] and abs(y - PEDESTAL[1]) < PEDESTAL_HALF[1] and z > PEDESTAL_TOP:
            return "rest"
        return "floor"

    def set_target(self, zone: str | None) -> None:
        for z, bid in self.bins.items():
            p.changeVisualShape(bid, -1, rgbaColor=BIN_TARGET if z == zone else self.bin_idle[z], physicsClientId=self.c)

    # ---------- everyday objects (home scene)
    def add_object(self, name: str, shape: str, size, pos, rgba=(0.9, 0.9, 0.9, 1), mass: float = 0.2,
                   static: bool = False, friction: float = 1.0) -> int:
        """shape: 'box' (size = half extents), 'cylinder' (size = [radius, height]), 'sphere' ([radius])."""
        if shape == "box":
            col = p.createCollisionShape(p.GEOM_BOX, halfExtents=size, physicsClientId=self.c)
            vis = p.createVisualShape(p.GEOM_BOX, halfExtents=size, rgbaColor=rgba, physicsClientId=self.c)
            z = size[2]
        elif shape == "cylinder":
            col = p.createCollisionShape(p.GEOM_CYLINDER, radius=size[0], height=size[1], physicsClientId=self.c)
            vis = p.createVisualShape(p.GEOM_CYLINDER, radius=size[0], length=size[1], rgbaColor=rgba, physicsClientId=self.c)
            z = size[1] / 2
        else:
            col = p.createCollisionShape(p.GEOM_SPHERE, radius=size[0], physicsClientId=self.c)
            vis = p.createVisualShape(p.GEOM_SPHERE, radius=size[0], rgbaColor=rgba, physicsClientId=self.c)
            z = size[0]
        body = p.createMultiBody(0 if static else mass, col, vis, [pos[0], pos[1], z + 0.001], physicsClientId=self.c)
        p.changeDynamics(body, -1, lateralFriction=friction, rollingFriction=0.02, spinningFriction=0.02, physicsClientId=self.c)
        self.objects[name] = body
        return body

    def top_of(self, name: str):
        lo, hi = p.getAABB(self.objects[name], physicsClientId=self.c)
        return (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2]

    def pick_object(self, name: str) -> Iterator[None]:
        self.part = self.objects[name]
        yield from self.pick()

    def place_on(self, name: str) -> Iterator[None]:
        """Set the held object down on top of another object (e.g. the apple on the plate)."""
        x, y, top = self.top_of(name)
        yield from self.transfer((x, y, top + self.held_h + 0.12), 1.3)
        yield from self.move_to((x, y, top + self.held_h + 0.008), 0.6)
        self._release()
        yield from self.move_to((x, y, top + self.held_h + 0.15), 0.5)

    def handoff(self, z: float = 0.3) -> Iterator[None]:
        """Bring the held object to the person and hold it there."""
        yield from self.transfer((HANDOFF[0], HANDOFF[1], z), 1.4)

    def pour_over(self, name: str) -> Iterator[None]:
        """Hold the carried object just above another one for a moment (watering the plant),
        then carry it back home without letting go."""
        x, y, top = self.top_of(name)
        r = math.hypot(x, y)
        ox, oy = x * (r - 0.06) / r, y * (r - 0.06) / r   # hover slightly in front of it
        yield from self.transfer((ox, oy, top + self.held_h + 0.1), 1.3)
        yield from self.move_to((ox, oy, top + self.held_h + 0.05), 0.5)
        yield from self.wait(1.4)
        yield from self.move_to((ox, oy, top + self.held_h + 0.12), 0.5)

    def press(self, name: str) -> Iterator[None]:
        """Tap a button on top of an object and come back up."""
        x, y, top = self.top_of(name)
        yield from self.transfer((x, y, top + 0.12), 1.1)
        yield from self.move_to((x, y, top + 0.004), 0.45)
        yield from self.wait(0.25)
        yield from self.move_to((x, y, top + 0.14), 0.45)

    def confused(self) -> Iterator[None]:
        """Decoded intention didn't match the task: a small 'no' wiggle, nothing moved."""
        x, y, z = self.tip
        th = math.atan2(y, x)
        for d in (0.08, -0.08, 0):
            yield from self.move_to((x - math.sin(th) * d, y + math.cos(th) * d, z), 0.25)

    def clear(self) -> None:
        self._release()
        for b in self.parts_landed + ([self.part] if self.part is not None else []):
            p.removeBody(b, physicsClientId=self.c)
        self.parts_landed, self.part = [], None
