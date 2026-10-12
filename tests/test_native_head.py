import importlib.util
from pathlib import Path
import sys
import threading
import time
import math
import numpy as np
import pybullet as p
import pytest

STAGED = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(STAGED / 'sim'))
from head_camera import NativeHeadCamera, steer_tip
from head_pose import HeadControl
from arm import ProstheticArm


@pytest.mark.parametrize('velocity,axis,sign', [([1,0],1,1),([-1,0],1,-1),([0,1],2,1),([0,-1],2,-1)])
def test_head_steering_moves_existing_factory_arm(velocity,axis,sign):
    c=p.connect(p.DIRECT)
    arm=ProstheticArm(c)
    try:
        original=arm.tip.copy()
        for _ in range(25):
            arm.tip=steer_tip(arm.tip,velocity,1/30)
            arm._apply_ik(arm.tip)
            for _ in range(8): arm.step()
        assert (arm.tip[axis]-original[axis])*sign>0.05
        assert np.linalg.norm(np.asarray(arm._tip_now())-arm.tip)<0.03
    finally:
        p.disconnect(arm.ik_c)
        p.disconnect(c)


def test_neutral_and_stale_intervals_do_not_move():
    for dt, velocity in [(0.1,[0,0]),(2,[1,1]),(float('nan'),[1,1])]:
        np.testing.assert_equal(steer_tip([0.45,0,0.45],velocity,dt),[0.45,0,0.45])


def test_bounds_and_diagonal_steering():
    tip=np.array([0.45,0,0.45])
    for _ in range(500): tip=steer_tip(tip,[1,1],0.1)
    assert tip[2]==0.62
    assert math.atan2(tip[1],tip[0])==pytest.approx(math.radians(160))
    for _ in range(1000): tip=steer_tip(tip,[-1,-1],0.1)
    assert tip[2]==0.24
    assert math.atan2(tip[1],tip[0])==pytest.approx(-math.radians(160))


def test_stale_camera_snapshot_cannot_keep_steering():
    camera=NativeHeadCamera.__new__(NativeHeadCamera)
    camera.lock=threading.Lock()
    camera.closed=threading.Event()
    camera.report={'velocity':[1,1],'captured_at':time.monotonic()-1}
    assert camera.snapshot()['velocity']==[0,0]
    camera.report['captured_at']=time.monotonic()
    assert camera.snapshot()['velocity']==[1,1]
    camera.closed.set()
    assert camera.snapshot()['velocity']==[0,0]


def test_head_pose_calibration_and_loss_feed_zero_velocity():
    control=HeadControl(calibration_frames=3)
    for _ in range(3): control.update([0,0],.1)
    assert control.neutral is not None
    control.update([30,-30],.1)
    assert control.velocity[0]>0 and control.velocity[1]<0
    control.update(None,.1)
    assert not control.velocity.any()
