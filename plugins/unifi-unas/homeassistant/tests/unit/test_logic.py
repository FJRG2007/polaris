"""Rules behind the alert entities. `logic.py` has no Home Assistant import,
so it is loaded straight from its file without the integration package."""

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

_PATH = Path(__file__).resolve().parents[2] / "custom_components" / "unifi_unas" / "logic.py"
_SPEC = importlib.util.spec_from_file_location("unas_logic", _PATH)
logic = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(logic)

NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)


def test_backup_failed_reads_error_codes():
    assert logic.backup_failed({"lastTaskRun": {"errorCodes": ["E1"]}})
    assert not logic.backup_failed({"lastTaskRun": {"errorCodes": []}})
    assert not logic.backup_failed({})


def test_backup_overdue_needs_schedule_past_next_run_and_idle():
    task = {"schedule": {"enable": True}, "nextBackup": "2026-10-20T10:00:00Z", "lastTaskRun": {"status": "idle"}}
    assert logic.backup_overdue(task, NOW)
    assert not logic.backup_overdue({**task, "nextBackup": "2026-10-20T11:30:00Z"}, NOW)
    assert not logic.backup_overdue({**task, "schedule": {"enable": False}}, NOW)
    assert not logic.backup_overdue({**task, "lastTaskRun": {"status": "in-progress"}}, NOW)
    assert not logic.backup_overdue({**task, "nextBackup": "garbage"}, NOW)
    assert not logic.backup_overdue({**task, "nextBackup": None}, NOW)
    assert logic.backup_overdue(task, NOW, grace=timedelta(minutes=1))


def test_pool_and_disk_rules():
    assert logic.pool_unprotected(0) is True
    assert logic.pool_unprotected("1") is False
    assert logic.pool_unprotected(None) is None
    assert logic.disk_problem("Optimal") is False
    assert logic.disk_problem("Warning") is True
    assert logic.disk_problem(None) is None


def test_key_discovery():
    keys = ["unas_hdd_10_present", "unas_hdd_2_present", "unas_hdd_2_temperature",
            "unas_scrub_md3_action", "unas_scrub_md3_progress", "unas_pool1_protection", "unas_pool12_protection"]
    assert logic.bays_from_keys(keys) == ["2", "10"]
    assert logic.scrub_arrays_from_keys(keys) == ["md3"]
    assert logic.pools_with_protection(keys) == ["1", "12"]


def test_new_sessions_baseline_then_diff():
    a = {"username": "ana", "ip": "10.0.0.2", "share": "Media"}
    b = {"username": "bo", "ip": "10.0.0.3", "share": "Docs"}
    fresh, seen = logic.new_sessions(None, [a])
    assert fresh == []
    fresh, seen = logic.new_sessions(seen, [a, b, b, "junk"])
    assert fresh == [b]
    fresh, seen = logic.new_sessions(seen, [b])
    assert fresh == []
    fresh, _ = logic.new_sessions(seen, [a])
    assert fresh == [a]
    assert logic.new_sessions(set(), None) == ([], set())
