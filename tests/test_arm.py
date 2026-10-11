"""Physics regression tests for the PyBullet arm: every decoded command must put the part in
its matching zone, and the tool must track its IK target closely the whole way."""
import sys
from pathlib import Path

import numpy as np
import pybullet as p
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sim"))
from arm import COMMANDS, HOME, ProstheticArm  # noqa: E402


@pytest.fixture
def arm():
    c = p.connect(p.DIRECT)
    a = ProstheticArm(c)
    yield a
    p.disconnect(a.ik_c)
    p.disconnect(c)


def run(arm, gen):
    lag = 0.0
    for _ in gen:
        lag = max(lag, float(np.linalg.norm(np.array(arm._tip_now()) - arm.tip)))
    return lag


@pytest.mark.parametrize("command", COMMANDS)
def test_command_lands_part_in_matching_zone(arm, command):
    run(arm, arm.spawn_part())
    assert run(arm, arm.pick()) < 0.03
    assert arm.holding()
    body = arm.part
    assert run(arm, arm.execute(command)) < 0.03
    assert not arm.holding()
    run(arm, arm.wait(1.0))
    assert arm.landed_zone(body) == command


def test_rest_keeps_part_on_infeed_for_next_pick(arm):
    run(arm, arm.spawn_part())
    run(arm, arm.pick())
    body = arm.part
    run(arm, arm.hold_part())
    run(arm, arm.spawn_part())  # infeed occupied: must not spawn a second part
    assert arm.part == body
    run(arm, arm.pick())
    run(arm, arm.move_left())
    run(arm, arm.wait(1.0))
    assert arm.landed_zone(body) == "left"


def test_low_confidence_hesitation_returns_home(arm):
    run(arm, arm.spawn_part())
    run(arm, arm.pick())
    run(arm, arm.hold())
    assert run(arm, arm.hesitate("feet")) < 0.03
    assert np.allclose(arm._tip_now(), HOME, atol=0.01)
    assert arm.holding()


def test_return_to_neutral(arm):
    run(arm, arm.spawn_part())
    run(arm, arm.pick())
    run(arm, arm.move_reject())
    run(arm, arm.return_to_neutral())
    assert np.allclose(arm._tip_now(), HOME, atol=0.01)


def test_bin_fills_without_parts_bouncing_out(arm):
    """A full shipping box (4 computers) plus margin: they must all stay in it."""
    bodies = []
    for _ in range(6):
        run(arm, arm.spawn_part())
        run(arm, arm.pick())
        bodies.append(arm.part)
        run(arm, arm.move_right())
    run(arm, arm.wait(1.0))
    assert [arm.landed_zone(b) for b in bodies] == ["right"] * 6
    assert arm.ship("right") == 6 and not arm.parts_landed


def test_eeg_jogging_picks_and_places(arm):
    """Direct control: lower until it grabs, raise, rotate left x4, lower (release) -> BOX A."""
    run(arm, arm.spawn_part())
    body = arm.part
    for _ in range(3):
        run(arm, arm.jog("feet"))
        if arm.holding():
            break
    assert arm.holding() and arm.jog_info["action"] == "lower + grab part"
    for cmd in ["fists", "left", "left", "left", "left", "feet"]:
        assert run(arm, arm.jog(cmd)) < 0.03
    assert arm.jog_info["released"] == body
    run(arm, arm.wait(1.0))
    assert arm.landed_zone(body) == "left"


def test_rest_jog_holds_still(arm):
    before = arm.tip.copy()
    run(arm, arm.jog("rest"))
    assert np.allclose(arm.tip, before)
