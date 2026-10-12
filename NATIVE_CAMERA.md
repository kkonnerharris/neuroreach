# Native OpenCV camera control

Double-click **Open-Head-Camera.cmd**, or run:

```powershell
.conda\python.exe sim\server.py --gui --head-camera
```

Python opens your webcam with OpenCV and runs face tracking locally. The camera
preview and existing PyBullet robot window belong to the same simulator process.
Turn your head left/right to rotate the arm, look up/down to change its height,
and face forward to hold position. Both axes can move together. Hold still facing
forward for initial calibration. Space pauses/resumes; C recalibrates; Q closes
the camera and simulator. Keyboard controls still work in the PyBullet window.

This drives the existing factory arm directly from the simulator thread. There
is no browser camera, no HTTP command relay, and no separate robot simulation.
EEG/task actions retain priority while they are running; head steering resumes
when the arm is idle. Head input never queues a backlog of movements. Face loss,
neutral posture, or camera frames older than half a second stop further steering.
Head steering moves the arm only; existing task controls still handle grasp/release.

Options: `--camera 1` selects another webcam; `--deadzone 5` increases sensitivity
(default 7 degrees). If the webcam is busy, close the old browser camera page or
other apps using it. Windows must allow camera access for desktop apps.

First-time setup in the existing working conda environment:

```powershell
.conda\python.exe -m pip install -r requirements-camera.txt
.conda\python.exe tools\download_head_model.py
```

The model is downloaded from Google's versioned MediaPipe model URL and checked
by SHA256. Frames remain in memory and are not recorded. Dependencies are optional
for the original EEG-only `sim/server.py` launch.
