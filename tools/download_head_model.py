"""Download Google's versioned face landmark model for local inference."""
import hashlib
from pathlib import Path
import urllib.request

MODEL = Path(__file__).resolve().parents[1] / "models" / "face_landmarker.task"
SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"


def main():
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    if not MODEL.exists():
        temporary = MODEL.with_suffix(".download")
        try:
            with urllib.request.urlopen(URL, timeout=60) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != SHA256:
                raise RuntimeError("Face model checksum mismatch; download was not installed")
            temporary.replace(MODEL)
        finally:
            temporary.unlink(missing_ok=True)
    if hashlib.sha256(MODEL.read_bytes()).hexdigest() != SHA256:
        raise RuntimeError(f"Model checksum mismatch: {MODEL}. Move it aside and rerun setup.")
    print(f"Model ready: {MODEL}")
    print(f"SHA256: {hashlib.sha256(MODEL.read_bytes()).hexdigest()}")


if __name__ == "__main__":
    main()
