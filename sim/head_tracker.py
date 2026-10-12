"""OpenCV image processing and MediaPipe face orientation estimation."""
from pathlib import Path
import cv2
import mediapipe as mp
from head_pose import pose_angles


class HeadTracker:
    def __init__(self, model: Path):
        if not model.is_file():
            raise FileNotFoundError(f"Missing {model}. Run make setup-head first.")
        self.detector = mp.tasks.vision.FaceLandmarker.create_from_options(
            mp.tasks.vision.FaceLandmarkerOptions(
                base_options=mp.tasks.BaseOptions(model_asset_buffer=model.read_bytes()),
                running_mode=mp.tasks.vision.RunningMode.VIDEO,
                num_faces=2,  # Detect ambiguity rather than steering with a bystander's face.
                min_face_detection_confidence=0.6,
                min_face_presence_confidence=0.6,
                min_tracking_confidence=0.6,
                output_facial_transformation_matrixes=True))
        self.timestamp = -1

    def detect(self, bgr, timestamp_ms):
        self.timestamp = max(self.timestamp + 1, int(timestamp_ms))
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        result = self.detector.detect_for_video(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), self.timestamp)
        if len(result.face_landmarks) != 1 or len(result.facial_transformation_matrixes) != 1:
            return None
        return pose_angles(result.facial_transformation_matrixes[0])

    def close(self):
        self.detector.close()
