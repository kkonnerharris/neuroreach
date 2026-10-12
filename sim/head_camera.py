"""Native OpenCV head input for the existing factory simulator.

Capture and inference stay on camera threads. Only Sim.loop applies arm targets;
no PyBullet call runs on a camera thread, and there is no queue of stale turns.
"""
import math
from pathlib import Path
import threading
import time
import numpy as np
from head_pose import HeadControl


def steer_tip(tip, velocity, dt):
    """Bounded continuous left/right rotation and up/down height adjustment."""
    target = np.asarray(tip, dtype=float).copy()
    motion = np.asarray(velocity, dtype=float)
    if not np.isfinite(target).all() or motion.shape != (2,) or not np.isfinite(motion).all():
        raise ValueError("Expected finite tip and two-axis steering")
    if not math.isfinite(dt) or not 0 < dt <= 0.5 or not np.any(motion):
        return target
    dt = min(dt, 0.1)
    motion = np.clip(motion, -1, 1)
    radius = math.hypot(target[0], target[1])
    yaw = math.atan2(target[1], target[0])
    yaw = np.clip(yaw + motion[0] * math.radians(35) * dt, -math.radians(160), math.radians(160))
    target[:2] = [radius * math.cos(yaw), radius * math.sin(yaw)]
    target[2] = np.clip(target[2] + motion[1] * 0.14 * dt, 0.24, 0.62)
    return target


class NativeHeadCamera:
    def __init__(self, model: Path, camera_index=0, deadzone=7):
        if not model.is_file():
            raise FileNotFoundError(f"Missing face model: {model}")
        if camera_index < 0 or not 0 < deadzone < 25:
            raise ValueError("Use camera >= 0 and deadzone between 0 and 25 degrees")
        self.deadzone = deadzone
        self.model, self.camera_index = model, camera_index
        self.lock = threading.Lock()
        self.closed = threading.Event()
        self.report = {"velocity": [0.0, 0.0], "status": "Starting OpenCV camera", "angles": None,
                       "paused": False, "calibrated": False, "captured_at": 0.0}
        self.thread = threading.Thread(target=self._run, name="opencv-head-camera", daemon=True)
        self.thread.start()

    def snapshot(self):
        with self.lock:
            report = dict(self.report)
        if self.closed.is_set() or time.monotonic() - report.pop("captured_at") > 0.5:
            report["velocity"] = [0.0, 0.0]
        return report

    def _run(self):
        import cv2
        from native_capture import Camera
        from head_tracker import HeadTracker
        window = "NeuroReach - OpenCV camera controls the factory arm"
        camera = tracker = None
        try:
            tracker = HeadTracker(self.model)
            control = HeadControl(deadzone=self.deadzone)
            camera = Camera(self.camera_index)
            cv2.namedWindow(window, cv2.WINDOW_NORMAL)
            cv2.resizeWindow(window, 720, 620)
            preview = np.zeros((480, 640, 3), np.uint8)
            last_sequence, previous = -1, time.monotonic()
            announced = False
            print("Native OpenCV camera starting; Space pauses, C calibrates, Q closes the app.", flush=True)
            while not self.closed.is_set():
                latest, error = camera.snapshot()
                now = time.monotonic()
                if error or latest is None or now-latest[1] > 0.5:
                    control.update(None, 0)
                    with self.lock:
                        self.report.update(velocity=[0.0, 0.0], status=error or "Waiting for camera - arm held", captured_at=0.0)
                elif latest[0] != last_sequence:
                    last_sequence, captured_at, frame = latest
                    preview = cv2.resize(cv2.flip(frame, 1), (640, 480))
                    if now-previous > 0.5 and control.neutral is None:
                        control.samples.clear()
                    angles = tracker.detect(frame, now*1000)
                    control.update(angles, now-previous)
                    previous = now
                    with self.lock:
                        self.report = {"velocity": control.velocity.tolist(), "status": control.status,
                                       "angles": None if angles is None else np.round(angles, 1).tolist(),
                                       "paused": control.paused, "calibrated": control.neutral is not None,
                                       "captured_at": captured_at}
                    if not announced:
                        print(f"OpenCV camera connected: {frame.shape[1]}x{frame.shape[0]}", flush=True)
                        announced = True
                report = self.snapshot()
                panel = np.full((620, 720, 3), (32, 24, 18), np.uint8)
                panel[45:525, 40:680] = preview
                for text, y, color in [
                    ("OPENCV CAMERA -> EXISTING PYBULLET ARM", 28, (170,240,180)),
                    (report['status'][:85], 550, (170,240,180)),
                    ("Turn LEFT / RIGHT, look UP / DOWN. Face forward to hold.", 580, (230,230,230)),
                    ("SPACE pause/resume  |  C recalibrate  |  Q quit", 608, (230,230,230))]:
                    cv2.putText(panel, text, (14,y), cv2.FONT_HERSHEY_SIMPLEX, 0.47, color, 1, cv2.LINE_AA)
                cv2.imshow(window, panel)
                key = cv2.waitKey(10) & 0xFF
                if key in (27, ord('q')) or cv2.getWindowProperty(window, cv2.WND_PROP_VISIBLE) < 1:
                    break
                if key == 32:
                    control.paused = not control.paused
                    control.velocity[:] = 0
                    with self.lock:
                        self.report.update(velocity=[0.0, 0.0], paused=control.paused)
                elif key in (ord('c'), ord('C')):
                    control.recalibrate()
                    with self.lock:
                        self.report.update(velocity=[0.0, 0.0], calibrated=False)
        except Exception as exc:
            print(f"OpenCV camera stopped: {exc}", flush=True)
        finally:
            self.closed.set()
            if camera is not None:
                camera.close()
            if tracker is not None:
                tracker.close()
            cv2.destroyAllWindows()

    def close(self):
        self.closed.set()
        self.thread.join(timeout=3)
