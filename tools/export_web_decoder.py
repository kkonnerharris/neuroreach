"""Export the live decoders for the browser (web edition).

models/live_decoders.npz -> web/eeg/decoders.json (CSP filters, LDA weights, trial index)
                          + web/eeg/epochs.bin     (held-out epochs, int16 with a per-trial scale)

The browser runs the same math as sim/decoder.py. Run tests/test_web_decoder.mjs afterwards
to check it reproduces the Python decoder on every trial.
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "models" / "live_decoders.npz"
OUT = ROOT / "web" / "eeg"


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    z = np.load(SRC)
    keys = sorted({k.split("__")[0] for k in z.files})
    models, trials, chunks, offset = {}, {}, [], 0
    for key in keys:
        X = z[f"{key}__X"].astype(np.float64)       # n x 21 x 480, volts
        models[key] = {
            "W": z[f"{key}__W"].round(9).tolist(),
            "coef": z[f"{key}__coef"].tolist(),
            "intercept": z[f"{key}__intercept"].tolist(),
            "shape": list(X.shape[1:]),
        }
        for row, tid in enumerate(z[f"{key}__ids"]):
            x = X[row]
            scale = float(np.abs(x).max() / 32767) or 1e-12
            q = np.round(x / scale).astype(np.int16)
            chunks.append(q.tobytes())
            dev = key.split(".")[1] if "." in key else "cap"
            trials.setdefault(str(tid), {})[dev] = {"model": key, "offset": offset, "scale": scale}
            offset += q.size
    (OUT / "epochs.bin").write_bytes(b"".join(chunks))
    (OUT / "decoders.json").write_text(json.dumps({"classes": ["left", "right", "fists", "feet", "rest"], "models": models, "trials": trials}))
    print(f"{len(trials)} trials, {len(models)} models, epochs.bin {offset * 2 / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
