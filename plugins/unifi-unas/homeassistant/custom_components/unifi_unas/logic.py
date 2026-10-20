"""Pure decisions behind the alert-shaped entities.

Nothing here imports Home Assistant, so the rules can be tested on their own
and read without the entity plumbing around them.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

# A scheduled backup counts as overdue once its next run is this far behind.
BACKUP_OVERDUE_GRACE = timedelta(hours=1)

_BAY_PRESENT = re.compile(r"^unas_hdd_([^_]+)_present$")
_SCRUB_ACTION = re.compile(r"^unas_scrub_([^_]+)_action$")
_POOL_PROTECTION = re.compile(r"^unas_pool(\d+)_protection$")

def _parse_time(raw) -> datetime | None:
    if not raw or not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None

def backup_failed(task: dict) -> bool:
    """The last run reported error codes (the console's failed state)."""
    last_run = task.get("lastTaskRun") or {}
    return bool(last_run.get("errorCodes"))

def backup_running(task: dict) -> bool:
    status = (task.get("lastTaskRun") or {}).get("status")
    return status in ("pending", "in-progress")

def backup_overdue(task: dict, now: datetime, grace: timedelta = BACKUP_OVERDUE_GRACE) -> bool:
    """A scheduled task whose next run is in the past and is not running."""
    if not (task.get("schedule") or {}).get("enable"):
        return False
    if backup_running(task):
        return False
    next_run = _parse_time(task.get("nextBackup"))
    if next_run is None:
        return False
    return now - next_run > grace

def pool_unprotected(protection) -> bool | None:
    """`currentProtection` counts the disk failures the pool survives; 0 is none."""
    try:
        return int(protection) <= 0
    except (TypeError, ValueError):
        return None

def disk_problem(status) -> bool | None:
    if status is None or status == "":
        return None
    return str(status) != "Optimal"

def bays_from_keys(keys) -> list[str]:
    found = {m.group(1) for k in keys if (m := _BAY_PRESENT.match(k))}
    return sorted(found, key=lambda b: (not b.isdigit(), int(b) if b.isdigit() else 0, b))

def scrub_arrays_from_keys(keys) -> list[str]:
    return sorted({m.group(1) for k in keys if (m := _SCRUB_ACTION.match(k))})

def pools_with_protection(keys) -> list[str]:
    return sorted({m.group(1) for k in keys if (m := _POOL_PROTECTION.match(k))}, key=int)

def session_key(client: dict) -> tuple[str, str, str]:
    return (
        str(client.get("username", "unknown")),
        str(client.get("ip", "")),
        str(client.get("share", "")),
    )

def new_sessions(previous: set | None, clients) -> tuple[list[dict], set]:
    """Sessions in `clients` that were not in `previous`.

    `previous` of None means nothing has been seen yet: the current sessions
    become the baseline and none of them is reported, so a restart of Home
    Assistant does not announce every open connection as a new sign-in.
    """
    clients = [c for c in (clients or []) if isinstance(c, dict)]
    current = {session_key(c) for c in clients}
    if previous is None:
        return [], current
    fresh = []
    seen = set()
    for c in clients:
        key = session_key(c)
        if key not in previous and key not in seen:
            fresh.append(c)
            seen.add(key)
    return fresh, current
