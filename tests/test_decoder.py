"""Live decoding must reproduce what the library promises: decoding a trial's stored EEG now
gives the same command (and posterior) the export computed, for every held-out trial."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sim"))
from decoder import LiveDecoder  # noqa: E402

DECK = ROOT / "game" / "eeg-deck.js"


@pytest.fixture(scope="module")
def decoder():
    d = LiveDecoder()
    if not d.ready:
        pytest.skip("run export_eeg.py first")
    return d


@pytest.fixture(scope="module")
def cards():
    text = DECK.read_text(encoding="utf-8").strip().removeprefix("window.EEG_DECK = ").removesuffix(";")
    return [c for s in json.loads(text)["subjects"] for c in s["cards"]]


def test_every_library_trial_is_decodable(decoder, cards):
    assert {c["id"] for c in cards} == set(decoder.index)


@pytest.mark.parametrize("device,nch", [("cap", 21), ("crown", 8), ("muse", 4)])
def test_live_decode_matches_library(decoder, cards, device, nch):
    """Each device's decoder sees only its own electrodes and reproduces the library."""
    for c in cards:
        dec = decoder.decode(c["id"], device)
        assert dec["command"] == c["dev"][device]["pred"], (device, c["id"])
        assert abs(dec["conf"] - c["dev"][device]["conf"]) < 1e-3
        assert dec["samples"] == [nch, 480]


def test_decoding_is_fast(decoder, cards):
    assert max(decoder.decode(c["id"])["ms"] for c in cards[:50]) < 50
