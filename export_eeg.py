"""Build the game's EEG deck from the PhysioNet EEG Motor Movement/Imagery Dataset (EEGMMIDB).

Five brain commands, each drawn from the run type that defines it
(verified against https://physionet.org/content/eegmmidb/1.0.0/):

    runs 3, 7, 11   EXECUTED  T1 = left fist    T2 = right fist
    runs 4, 8, 12   IMAGINED  T1 = left fist    T2 = right fist
    runs 5, 9, 13   EXECUTED  T1 = both fists   T2 = both feet
    runs 6, 10, 14  IMAGINED  T1 = both fists   T2 = both feet
    T0 in any run = rest

T1/T2 mean different things in the two run families, so labels are assigned per run before
anything is concatenated.

Per subject and paradigm (imagined / executed), with nothing fitted outside the training split:
  1. Load the 6 runs, relabel annotations, standardize channels, average reference.
  2. Band-pass 8-30 Hz (mu + beta); epoch -1.0..4.0 s around every cue.
  3. Drop epochs > 300 uV peak-to-peak; subsample REST to the size of the task classes.
  4. Stratified 70/30 split. CSP (multi-class, joint diagonalization) + shrinkage LDA,
     5-fold CV on train, fit on train.
  5. Export ONLY held-out epochs: C3/Cz/C4 traces, per-trial mu ERD%, true label,
     decoder prediction + class probabilities.

Subjects are kept by *training* CV, so held-out accuracy is not inflated by selection.

    python export_eeg.py                      # subjects 1-12, both paradigms
    python export_eeg.py --subjects 1-20 --workers 8
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import mne
import numpy as np
from mne.datasets import eegbci
from mne.decoding import CSP
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.metrics import confusion_matrix
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline

sys.path.insert(0, str(Path(__file__).resolve().parent / "sim"))
from decoder import features, posterior  # noqa: E402  (the exact math the sim server runs live)

SEED = 42
CLASSES = ["left", "right", "fists", "feet", "rest"]
RUNS = {
    "imagined": {"lr": [4, 8, 12], "ff": [6, 10, 14]},
    "executed": {"lr": [3, 7, 11], "ff": [5, 9, 13]},
}
RELABEL = {"lr": {"T0": "rest", "T1": "left", "T2": "right"},
           "ff": {"T0": "rest", "T1": "fists", "T2": "feet"}}
MIN_TRAIN_CV = 0.40        # 5 classes -> chance is 0.20
MIN_PER_CLASS = 8
MAX_SUBJECTS = 6           # per paradigm
DISPLAY_SFREQ = 80.0
DISPLAY_WINDOW = (-0.5, 4.0)
TASK_WINDOW = (0.5, 3.5)   # window the classifier sees (skips the cue-evoked response)
BASE_WINDOW = (-1.0, 0.0)  # pre-cue, for ERD%
CHANNELS = ("C3", "Cz", "C4")
MOTOR_CHANNELS = [f"{row}{n}" for row in ("FC", "C", "CP") for n in ("5", "3", "1", "z", "2", "4", "6")]
DATA_DIR = Path(__file__).parent / "data"
OUT = Path(__file__).parent / "game" / "eeg-deck.js"
MODELS = Path(__file__).parent / "models" / "live_decoders.npz"

log = logging.getLogger("export")


def fetch(subject: int, run: int, attempts: int = 5) -> str:
    for k in range(attempts):  # physionet.org times out under load; back off and retry
        try:
            return eegbci.load_data(subject, [run], path=str(DATA_DIR), update_path=False, verbose="error")[0]
        except Exception as err:  # requests ConnectionError / ReadTimeout via pooch
            if k == attempts - 1:
                raise
            log.info("  S%03d R%02d: %s; retrying", subject, run, type(err).__name__)
            time.sleep(5 * (k + 1))


def prefetch(subjects, workers: int) -> None:
    pairs = [(s, r) for s in subjects for p in RUNS.values() for fam in p.values() for r in fam]
    with ThreadPoolExecutor(workers) as ex:
        for i, _ in enumerate(ex.map(lambda sr: fetch(*sr), pairs), 1):
            if i % 12 == 0 or i == len(pairs):
                log.info("  downloaded/cached %d/%d runs", i, len(pairs))


def load(subject: int, paradigm: str) -> mne.io.BaseRaw:
    raws = []
    for fam, runs in RUNS[paradigm].items():
        for r in runs:
            raw = mne.io.read_raw_edf(fetch(subject, r), preload=True, verbose="error")
            raw.annotations.rename(RELABEL[fam])
            raws.append(raw)
    raw = mne.concatenate_raws(raws)
    eegbci.standardize(raw)
    raw.set_montage(mne.channels.make_standard_montage("standard_1005"))
    raw.set_eeg_reference("average", projection=False, verbose="error")  # reference uses all 64 channels
    return raw.pick(MOTOR_CHANNELS)  # then keep the sensorimotor strip: standard for MI, ~3x less memory


def epoch(raw, l_freq, h_freq) -> mne.Epochs:
    filt = raw.copy().filter(l_freq, h_freq, fir_design="firwin", verbose="error")
    event_id = {c: i + 1 for i, c in enumerate(CLASSES)}
    events, _ = mne.events_from_annotations(filt, event_id=event_id, verbose="error")
    return mne.Epochs(filt, events, event_id, tmin=-1.0, tmax=4.0, baseline=None, preload=True, verbose="error")


def erd_percent(x: np.ndarray, times: np.ndarray) -> float:
    """Classic ERD%: (task power - rest power) / rest power. Negative = desynchronization."""
    base = x[(times >= BASE_WINDOW[0]) & (times < BASE_WINDOW[1])]
    task = x[(times >= TASK_WINDOW[0]) & (times < TASK_WINDOW[1])]
    pb, pt = np.mean(base**2), np.mean(task**2)
    return float(100 * (pt - pb) / pb)


def process(subject: int, paradigm: str) -> dict | None:
    raw = load(subject, paradigm)
    ep, mu = epoch(raw, 8.0, 30.0), epoch(raw, 8.0, 13.0)
    ptp = np.ptp(ep.get_data(), axis=-1).max(axis=1)
    keep = ptp < 300e-6
    n_dropped = int((~keep).sum())
    code_to_cls = {i + 1: c for i, c in enumerate(CLASSES)}
    labels = np.array([code_to_cls[c] for c in ep.events[:, 2]])

    # balance REST against the task classes (it has ~as many cues as all tasks together)
    rng = np.random.default_rng(SEED + subject)
    idx = np.flatnonzero(keep)
    task_counts = [int(((labels == c) & keep).sum()) for c in CLASSES[:-1]]
    if min(task_counts) < MIN_PER_CLASS:
        log.info("S%03d %-8s skipped: too few clean epochs per class %s (dropped %d)", subject, paradigm, task_counts, n_dropped)
        return None
    rest_idx = idx[labels[idx] == "rest"]
    rest_keep = rng.choice(rest_idx, size=min(len(rest_idx), int(np.median(task_counts))), replace=False)
    idx = np.sort(np.concatenate([idx[labels[idx] != "rest"], rest_keep]))
    ep, mu, labels = ep[idx], mu[idx], labels[idx]
    y = np.array([CLASSES.index(l) for l in labels])

    times = ep.times
    X = ep.get_data()[:, :, (times >= TASK_WINDOW[0]) & (times < TASK_WINDOW[1])]
    tr, te = train_test_split(np.arange(len(y)), test_size=0.3, stratify=y, random_state=SEED)
    clf = Pipeline([
        ("csp", CSP(n_components=10, reg="ledoit_wolf", log=True)),
        ("lda", LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto")),
    ])
    cv = cross_val_score(clf, X[tr], y[tr], cv=StratifiedKFold(5, shuffle=True, random_state=SEED))
    clf.fit(X[tr], y[tr])
    proba = clf.predict_proba(X[te])
    pred = proba.argmax(1)
    test_acc = float((pred == y[te]).mean())
    log.info("S%03d %-8s n=%d (dropped %d)  train CV=%.2f  held-out=%.2f  (chance 0.20)",
             subject, paradigm, len(y), n_dropped, cv.mean(), test_acc)
    if cv.mean() < MIN_TRAIN_CV:
        return None

    # Pull the learned weights out of the pipeline and re-run them as plain NumPy on the
    # float32 epochs the sim server will hold. Card predictions come from this path, so what
    # the library shows is exactly what live decoding will produce.
    W = clf.named_steps["csp"].filters_[:10]
    lda = clf.named_steps["lda"]
    Xte = X[te].astype(np.float32)
    live = posterior(lda.coef_, lda.intercept_, features(W, Xte))
    assert np.allclose(posterior(lda.coef_, lda.intercept_, features(W, X[te])), proba, atol=1e-6), "live math != sklearn"
    agree = float((live.argmax(1) == pred).mean())
    proba, pred = live, live.argmax(1)
    test_acc = float((pred == y[te]).mean())
    if agree < 1:
        log.info("    float32 storage changed %.0f%% of decisions", 100 * (1 - agree))

    disp = ep.copy().crop(*DISPLAY_WINDOW).resample(DISPLAY_SFREQ, verbose="error")
    dd, md = disp.get_data(), mu.get_data()
    ch = {n: disp.ch_names.index(n) for n in CHANNELS}
    mch = {n: mu.ch_names.index(n) for n in CHANNELS}
    tag = "I" if paradigm == "imagined" else "E"
    cards = []
    for k, i in enumerate(te):
        card = {
            "id": f"S{subject:03d}{tag}-{i:03d}",
            "paradigm": paradigm,
            "label": labels[i],
            "onsetSec": round(float(ep.events[i, 0] / ep.info["sfreq"]), 2),
            "pred": CLASSES[pred[k]],
            "conf": round(float(proba[k].max()), 3),
            "proba": {c: round(float(proba[k, j]), 3) for j, c in enumerate(CLASSES)},
        }
        for n in CHANNELS:
            key = n.lower()
            card[key] = np.round(dd[i, ch[n]] * 1e6, 1).tolist()
            card["erd" + n[0].upper() + n[1:].lower()] = round(erd_percent(md[i, mch[n]], mu.times), 1)
        cards.append(card)
    return {
        "subject": subject,
        "paradigm": paradigm,
        "nEpochs": int(len(y)),
        "nDropped": n_dropped,
        "nTrain": int(len(tr)),
        "nTest": int(len(te)),
        "trainCv": round(float(cv.mean()), 3),
        "testAcc": round(test_acc, 3),
        "confusion": confusion_matrix(y[te], pred, labels=list(range(len(CLASSES)))).tolist(),
        "cards": cards,
        "_live": {"W": W, "coef": lda.coef_, "intercept": lda.intercept_, "X": Xte,
                  "ids": np.array([c["id"] for c in cards])},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--subjects", default="1-12", help="range like 1-12")
    ap.add_argument("--workers", type=int, default=4, help="parallel downloads")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    mne.set_log_level("error")
    DATA_DIR.mkdir(exist_ok=True)
    a, b = map(int, args.subjects.split("-"))
    subjects = range(a, b + 1)

    log.info("Fetching %d runs from PhysioNet (%d workers)...", len(subjects) * 12, args.workers)
    prefetch(subjects, args.workers)

    kept = []
    for paradigm in RUNS:
        n = 0
        for s in subjects:
            if n >= MAX_SUBJECTS:
                break
            r = process(s, paradigm)
            if r:
                kept.append(r)
                n += 1
    deck = {
        "version": 2,
        "source": "PhysioNet EEG Motor Movement/Imagery Dataset v1.0.0 (Schalk et al., 2004; Goldberger et al., 2000)",
        "classes": CLASSES,
        "runs": {p: {"left/right fist": v["lr"], "both fists/feet": v["ff"]} for p, v in RUNS.items()},
        "sfreq": DISPLAY_SFREQ,
        "tmin": DISPLAY_WINDOW[0],
        "taskWindow": TASK_WINDOW,
        "baseWindow": BASE_WINDOW,
        "channels": list(CHANNELS),
        "selection": f"subjects {a}-{b}, 5-class decoder kept if 5-fold train CV >= {MIN_TRAIN_CV} (chance 0.20)",
        "subjects": kept,
    }
    live = {}
    for r in kept:
        key = f"S{r['subject']:03d}{'I' if r['paradigm'] == 'imagined' else 'E'}"
        for part, arr in r.pop("_live").items():
            live[f"{key}__{part}"] = arr
    MODELS.parent.mkdir(exist_ok=True)
    np.savez_compressed(MODELS, **live)
    log.info("Wrote %s (%.1f MB): live decoder weights + held-out epochs", MODELS, MODELS.stat().st_size / 1e6)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("window.EEG_DECK = " + json.dumps(deck, separators=(",", ":")) + ";\n", encoding="utf-8")
    for p in RUNS:
        sub = [s for s in kept if s["paradigm"] == p]
        nt = sum(s["nTest"] for s in sub)
        acc = sum(s["testAcc"] * s["nTest"] for s in sub) / max(1, nt)
        log.info("%-8s: %d subjects, %d held-out cards, pooled held-out acc %.2f (chance 0.20)", p, len(sub), nt, acc)
    log.info("Wrote %s (%.1f MB)", OUT, OUT.stat().st_size / 1e6)


if __name__ == "__main__":
    main()
