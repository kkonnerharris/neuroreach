"""Calibrated head angles to bounded arm motion; no camera dependency here."""
from collections import deque
import math
import numpy as np


def pose_angles(matrix) -> np.ndarray:
    """MediaPipe face transform -> degrees (person's right, looking up).

    The canonical face looks along +Z, with +Y up. Use its transformed
    forward axis so roll alone does not produce a steering command.
    Input frames must be unmirrored; mirror only the displayed preview.
    """
    matrix = np.asarray(matrix, dtype=float)
    if matrix.shape != (4, 4) or not np.isfinite(matrix).all():
        raise ValueError("Expected a finite 4x4 face transform")
    x, y, z = matrix[:3, 2]
    if np.linalg.norm([x, y, z]) < 1e-6:
        raise ValueError("Invalid face rotation")
    return np.degrees([-math.atan2(x, z), math.atan2(y, math.hypot(x, z))])


class HeadControl:
    """Rate control: turn to move, face forward to hold the current target."""

    def __init__(self, deadzone=7.0, full_scale=25.0, calibration_frames=20):
        if not 0 < deadzone < full_scale < 80 or calibration_frames < 2:
            raise ValueError("Invalid head-control sensitivity or calibration size")
        self.deadzone = deadzone
        self.full_scale = full_scale
        self.samples = deque(maxlen=calibration_frames)
        self.target = np.array([0.43, 0.0, 0.67])
        self.paused = False
        self.recalibrate()

    def recalibrate(self):
        self.samples.clear()
        self.neutral = None
        self.filtered = np.zeros(2)
        self.velocity = np.zeros(2)
        self.status = "Face forward and hold still to calibrate"

    def update(self, angles, dt):
        self.velocity[:] = 0
        if angles is None:
            self.filtered[:] = 0
            if self.neutral is None:
                self.samples.clear()
            self.status = "No single tracked face - holding arm"
            return self.target.copy()
        angles = np.asarray(angles, dtype=float)
        if angles.shape != (2,) or not np.isfinite(angles).all() or np.any(np.abs(angles) > 65):
            return self.update(None, dt)
        if self.neutral is None:
            self.samples.append(angles.copy())
            self.status = f"Face forward: calibrating {len(self.samples)}/{self.samples.maxlen}"
            if len(self.samples) == self.samples.maxlen:
                if np.max(np.ptp(self.samples, axis=0)) <= 4:
                    self.neutral = np.mean(self.samples, axis=0)
                    self.status = "Calibrated - turn your head to move"
                else:
                    self.status = "Hold still facing forward to calibrate"
            return self.target.copy()
        if self.paused:
            self.filtered[:] = 0
            self.status = "Paused - holding arm"
            return self.target.copy()
        if not math.isfinite(dt) or not 0 < dt <= 0.5:
            self.filtered[:] = 0
            self.status = "Camera interrupted - holding arm"
            return self.target.copy()
        delta = angles - self.neutral
        alpha = 1 - math.exp(-dt / 0.10)
        self.filtered += alpha * (delta - self.filtered)
        # Neutral stops immediately instead of coasting through the smoothing tail.
        self.filtered[np.abs(delta) <= self.deadzone] = 0
        self.velocity = np.sign(self.filtered) * np.clip(
            (np.abs(self.filtered) - self.deadzone) / (self.full_scale - self.deadzone), 0, 1)
        dt = min(dt, 0.1)  # Never jump after a slow frame.
        radius = math.hypot(self.target[0], self.target[1])
        azimuth = math.atan2(self.target[1], self.target[0])
        azimuth = np.clip(azimuth + self.velocity[0] * math.radians(45) * dt,
                          math.radians(-45), math.radians(45))
        self.target[0:2] = [radius * math.cos(azimuth), radius * math.sin(azimuth)]
        self.target[2] = np.clip(self.target[2] + self.velocity[1] * 0.18 * dt, 0.40, 0.82)
        directions = []
        if abs(self.velocity[0]) > 0:
            directions.append("RIGHT" if self.velocity[0] > 0 else "LEFT")
        if abs(self.velocity[1]) > 0:
            directions.append("UP" if self.velocity[1] > 0 else "DOWN")
        self.status = " + ".join(directions) or "Neutral - holding arm"
        return self.target.copy()
