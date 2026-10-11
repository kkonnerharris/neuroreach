# NeuroReach Work Cell

An EEG-commanded robotic disposition station. Real PhysioNet motor EEG drives a KUKA iiwa
in a PyBullet work cell: drag labeled EEG trials into a robot program, run it, and the cell decodes
each trial and physically routes each part. The run is scored like an operator shift.

## Controls: five brain commands

| EEG command (PhysioNet EEGMMIDB) | Signature | Part | Disposition |
|---|---|---|---|
| Left fist  (runs 3/4, 7/8, 11/12 · T1) | μ-ERD over C4 | Housing A | **LINE A** bin |
| Right fist (runs 3/4, 7/8, 11/12 · T2) | μ-ERD over C3 | Housing B | **LINE B** bin |
| Both fists (runs 5/6, 9/10, 13/14 · T1) | bilateral C3 + C4 | Sub-assembly | **ASSEMBLY** bin |
| Both feet  (runs 5/6, 9/10, 13/14 · T2) | vertex (Cz) | Defective | **REJECT** bin |
| Rest (T0, all runs) | no ERD | Pending QC | **HOLD**: back on the infeed |

Each command comes in two paradigms: **imagined** (runs 4/6/8/10/12/14) and **executed**
(runs 3/5/7/9/11/13). Each has its own decoder.

```
PhysioNet ─ export_eeg.py ─▶ game/eeg-deck.js ─▶ browser console ─▶ sim/server.py ─▶ PyBullet
12 runs/subject   8–30 Hz, CSP (multi-class)     work order,         execute(command)   KUKA iiwa,
                  + shrinkage LDA, per subject   drag & drop,        landed_zone()      suction tool,
                  & paradigm, held-out only      decoder posterior                      4 bins + infeed
```

PyBullet owns the physics at 240 Hz. The browser draws the same URDF meshes with WebGL from
link poses streamed at 30 Hz over Server-Sent Events. Whether a line succeeded is read back
from where the part physically came to rest.

## Live decoding

Decoding happens at the moment you drop a trial. `export_eeg.py` trains a CSP + shrinkage-LDA
decoder per subject and paradigm, then saves its weights and that subject's held-out,
band-passed epochs to `models/live_decoders.npz`. When a trial is dropped, the sim server
(`sim/decoder.py`) runs the decoder on that trial's 21 channels × 480 samples of EEG
(CSP filtering → log band power → LDA → softmax, about 1 ms), and the robot acts on that
output. The export asserts the NumPy decoder matches scikit-learn's `predict_proba` to 1e-6,
and `tests/test_decoder.py` checks that live decoding reproduces the library for all trials.

What it is not: the EEG is recorded PhysioNet data replayed from disk, not a live headset.

## Setup

PyBullet has no Windows wheels on PyPI, so everything runs in a conda-forge environment. Use
OpenBLAS: on this machine conda-forge's MKL 2026 build crashes NumPy matrix ops (0xc06d007f).

```powershell
conda env create -p .conda -f environment.yml
.conda\python export_eeg.py --subjects 1-8     # downloads EEG, trains decoders, writes library + live models
.conda\python sim\server.py --gui             # PyBullet window + console at http://localhost:4620
```

Current library (subjects 1–8, 21 sensorimotor channels): 5-class held-out accuracy
**62% imagined** (5 subjects, 170 trials) and **69% executed** (6 subjects, 204 trials); chance is 20%.

`sim\server.py --gui` also opens the native PyBullet window (arrow keys and space issue
commands, R resets, ESC quits).

## Web edition (play in any browser)

`dist/` is a fully static build of the game, published to GitHub Pages. No Python needed:

- **Decoding stays real and live:** the trained CSP+LDA weights and the real held-out
  PhysioNet epochs ship with the page, and `game/eegdecoder.js` runs the same math in the
  browser (`node tests/test_web_decoder.mjs`: identical commands on all 374 trials).
- **Physics is replayed:** every level step was run in PyBullet and recorded
  (`sim/record_web.py`), including the arm's "no" when the decoded command doesn't match.
  `game/replay.js` stands in for the server and streams those frames to the same viewer.

```powershell
.conda\python tools\export_web_decoder.py
.conda\python simecord_web.py
.conda\python toolsuild_web.py        # -> dist/
```

## Everyday-task levels (default, Simple view)

First person at a dining table: you can't use your hands, but an EEG headset reads what you
intend and an assistive arm does it. Each level is a short real-life task (`sim/levels.py`):

| Level | Steps (brain command → robot) |
|---|---|
| ☕ Morning coffee | right hand → pick up the mug · feet → bring it to me |
| 🍎 Breakfast | left hand → pick up the apple · right hand → put it on my plate |
| 💡 Lights | both hands → press the lamp button (the room lights up) · relax → nothing moves |
| 📱 Phone call | right hand → pick up the ringing phone · feet → bring it to my ear |
| 📦 Back to work | left / right hand → pack computers into Box A / Box B |

Drag the glowing EEG tile onto the robot. The EEG headset panel shows the recording, the sim
server decodes it live, and the step runs only if the decoded intention matches. Otherwise
the arm gives a small "no" and waits. Simple view uses imagined trials the decoder reads
correctly, so the right tile always works. Each level rebuilds its own PyBullet scene. The
kitchen backdrop, oak tabletop and warehouse backdrop were generated with kie.ai
(`game/assets/`); everything else is modelled in code.

## Direct control (default tab)

Drop a labeled EEG trial onto the robot (or the jog pad) and the arm makes one move,
using whatever the decoder reads from that trial:

| EEG | Move |
|---|---|
| Left fist / Right fist | rotate the arm 20° left / right about its base |
| Both fists | raise 12 cm |
| Both feet | lower 12 cm; grabs a part it lands on, or releases the part it holds |
| Rest | hold still |

The infeed and all four bins sit on one circle around the base, so these five moves are
enough to pick a part up and put it in any bin: e.g. *feet, feet (grab), fists, left ×4,
feet (release)* drops it in LINE A. The same moves are on the keyboard in the native
PyBullet window (`--gui`): arrows, and space for rest.

## Using the console (Program tab)

1. **EEG instruction library** (left): labeled, held-out trials. Filter by paradigm, command
   and subject. Each card shows its command, the robot action, C3/Cz/C4 traces and ERD, and
   whether the decoder reads it correctly (✓/✗).
2. **Robot program** (centre): drag labeled EEG trials in as instructions. Drop on a step
   to insert above or below it, drag steps to reorder, drag one out to delete it. Tapping a
   trial appends it; **Add one of each** appends one trial per command.
3. **Run program**: each trial plays back (C3/Cz/C4, live band power, electrode map), the
   5-class posterior is shown, and the arm executes the decoded command. Commands under 65%
   confidence make the arm hesitate first.
4. **Shift report**: the share of instructions carried out as the EEG intended, decoder accuracy
   (chance 20%), Wolpaw ITR (5 commands), throughput, failures split into *decoder misread* /
   *handling*, and a decoder confusion matrix.

## Methodology notes

- T1/T2 mean different things in the left/right runs and the fists/feet runs, so labels are
  assigned per run before anything is concatenated.
- Rest epochs are subsampled to the size of the task classes.
- Everything learned is fit on each subject's training split. The library holds only held-out
  epochs, so every decoder output in the console is out-of-sample.
- Subjects are kept by *training* CV (≥ 0.40 for 5 classes), never by test accuracy.

## Tests

```powershell
.conda\python -m pytest tests -q     # every command lands in its zone; bins fill without spilling; tracking < 3 cm
```
