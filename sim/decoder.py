"""Live EEG decoder: CSP spatial filters + log-variance features + LDA, as plain NumPy.

export_eeg.py trains a scikit-learn/MNE pipeline per subject and paradigm, then saves its
learned weights and that subject's held-out epochs to models/live_decoders.npz. This module
runs the same math at request time, so when a trial is dropped onto the robot it is decoded
from its EEG samples at that moment. The export verifies the result matches the pipeline's
own predict_proba.

Per epoch X (channels x samples, 8-30 Hz, 0.5-3.5 s after the cue):
    z = W @ X                    CSP spatial filtering        (components x samples)
    f = log(mean(z**2, axis=1))  log band power per component (MNE CSP, log=True)
    d = coef @ f + intercept     LDA decision values          (one per command)
    p = softmax(d)               posterior over commands      (sklearn LDA, >2 classes)
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np

CLASSES = ["left", "right", "fists", "feet", "rest"]
DEFAULT_PATH = Path(__file__).resolve().parent.parent / "models" / "live_decoders.npz"


def features(W: np.ndarray, X: np.ndarray) -> np.ndarray:
    """CSP log-power features for one epoch (ch x t) or a batch (n x ch x t)."""
    z = np.einsum("kc,...ct->...kt", W, X.astype(np.float64))
    return np.log((z**2).mean(axis=-1))


def posterior(coef: np.ndarray, intercept: np.ndarray, f: np.ndarray) -> np.ndarray:
    d = f @ coef.T + intercept
    d = d - d.max(axis=-1, keepdims=True)
    e = np.exp(d)
    return e / e.sum(axis=-1, keepdims=True)


class LiveDecoder:
    def __init__(self, path: Path = DEFAULT_PATH):
        self.path = Path(path)
        self.models: dict[str, dict] = {}
        self.index: dict[str, tuple[str, int]] = {}
        if not self.path.exists():
            return
        with np.load(self.path, allow_pickle=False) as z:
            keys = sorted({k.split("__")[0] for k in z.files})
            for key in keys:
                m = {part: z[f"{key}__{part}"] for part in ("W", "coef", "intercept", "X", "ids")}
                self.models[key] = m
                for row, cid in enumerate(m["ids"]):
                    self.index[str(cid)] = (key, row)

    @property
    def ready(self) -> bool:
        return bool(self.models)

    def decode(self, trial_id: str) -> dict:
        """Decode one held-out trial from its raw (band-passed) EEG, right now."""
        key, row = self.index[trial_id]
        m = self.models[key]
        t0 = time.perf_counter()
        X = m["X"][row]                                  # 21 sensorimotor channels x 480 samples
        f = features(m["W"], X)
        p = posterior(m["coef"], m["intercept"], f)
        ms = (time.perf_counter() - t0) * 1e3
        k = int(p.argmax())
        return {
            "trial": trial_id,
            "model": key,
            "command": CLASSES[k],
            "conf": round(float(p[k]), 3),
            "proba": {c: round(float(v), 3) for c, v in zip(CLASSES, p)},
            "samples": [int(X.shape[0]), int(X.shape[1])],
            "ms": round(ms, 3),
        }
