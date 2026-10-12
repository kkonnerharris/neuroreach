"""Latest-frame native OpenCV capture; no browser or networking."""
import os
import threading
import time
import cv2

class Camera:
    """Keep only the latest frame; blocked camera reads cannot block the UI."""

    def __init__(self, index=0, backend="auto"):
        self.index, self.backend = index, backend
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.latest = None
        self.error = None
        self.sequence = 0
        self.thread = threading.Thread(target=self._capture, daemon=True)
        self.thread.start()

    def _capture(self):
        choices = {"dshow": cv2.CAP_DSHOW, "msmf": cv2.CAP_MSMF, "auto": cv2.CAP_ANY}
        backends = [cv2.CAP_DSHOW, cv2.CAP_MSMF] if os.name == "nt" and self.backend == "auto" else [choices[self.backend]]
        capture = None
        try:
            for backend in backends:
                capture = cv2.VideoCapture(self.index, backend)
                if capture.isOpened():
                    break
                capture.release()
                capture = None
            if capture is None:
                raise RuntimeError(f"Cannot open camera {self.index}. Close other camera apps, check camera permission, or use --camera 1.")
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            capture.set(cv2.CAP_PROP_FPS, 30)
            capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            while not self.stop.is_set():
                ok, frame = capture.read()
                if not ok or frame is None:
                    raise RuntimeError("Camera disconnected or stopped delivering images. Close and restart the app.")
                with self.lock:
                    self.sequence += 1
                    self.latest = (self.sequence, time.monotonic(), frame)
        except Exception as exc:
            with self.lock:
                self.error = str(exc)
        finally:
            if capture is not None:
                capture.release()

    def snapshot(self):
        with self.lock:
            return self.latest, self.error

    def close(self):
        self.stop.set()
        self.thread.join(timeout=1)

