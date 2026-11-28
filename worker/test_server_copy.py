"""Run: python3 -m unittest worker/test_server_copy.py  (stdlib only)."""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from server_copy import (  # noqa: E402
    egress_done, egress_filepath, local_to_worker, plan_reconcile, storage_path,
)

NOW = datetime(2026, 11, 28, 12, 0, tzinfo=timezone.utc)
HOST, GUEST = "p-host", "p-guest"


def ago(seconds: float) -> str:
    return (NOW - timedelta(seconds=seconds)).isoformat()


def session(run="r1"):
    return {"id": "s1", "recording_run": run}


def copy(pid, run="r1", status="recording", cid=None, egress_id="EG_1", age=30):
    return {"id": cid or f"c-{pid}-{run}-{status}", "participant_id": pid, "run": run,
            "status": status, "egress_id": egress_id, "created_at": ago(age), "updated_at": ago(age)}


class PlanReconcile(unittest.TestCase):
    def test_start_for_everyone_in_room(self):
        p = plan_reconcile(session(), {HOST, GUEST}, [], NOW)
        self.assertEqual(p.start, [GUEST, HOST])
        self.assertEqual((p.stop, p.retire, p.clear_run), ([], [], False))

    def test_open_copy_is_not_started_twice(self):
        for status in ("starting", "recording"):
            p = plan_reconcile(session(), {HOST}, [copy(HOST, status=status)], NOW)
            self.assertEqual(p.start, [], status)

    def test_rejoin_after_copy_finished_starts_another(self):
        for status in ("importing", "ready", "stopping"):
            p = plan_reconcile(session(), {GUEST}, [copy(GUEST, status=status)], NOW)
            self.assertEqual(p.start, [GUEST], status)

    def test_new_run_stops_old_copies(self):
        old = copy(HOST, run="r1")
        p = plan_reconcile(session("r2"), {HOST}, [old], NOW)
        self.assertEqual(p.stop, [old])
        self.assertEqual(p.start, [HOST])

    def test_switch_off_stops_open_copies(self):
        rec, starting = copy(HOST), copy(GUEST, status="starting")
        p = plan_reconcile(session(None), None, [rec, starting, copy(GUEST, status="ready")], NOW)
        self.assertEqual(p.stop, [rec, starting])
        self.assertEqual((p.start, p.clear_run), ([], False))

    def test_recent_error_blocks_retry_for_a_minute(self):
        p = plan_reconcile(session(), {GUEST}, [copy(GUEST, status="error", age=20)], NOW)
        self.assertEqual(p.start, [])
        p = plan_reconcile(session(), {GUEST}, [copy(GUEST, status="error", age=90)], NOW)
        self.assertEqual(p.start, [GUEST])

    def test_missing_room_clears_run(self):
        rec = copy(HOST)
        p = plan_reconcile(session(), None, [rec], NOW)
        self.assertTrue(p.clear_run)
        self.assertEqual(p.start, [])
        self.assertEqual(p.stop, [rec])

    def test_stuck_starting_row_is_retired(self):
        stuck = copy(HOST, status="starting", egress_id=None, age=120)
        fresh = copy(GUEST, status="starting", egress_id=None, age=5)
        p = plan_reconcile(session(), {HOST, GUEST}, [stuck, fresh], NOW)
        self.assertEqual(p.retire, [stuck])
        self.assertEqual(p.start, [])  # HOST waits for the next tick, after the retire


class Helpers(unittest.TestCase):
    def test_egress_done(self):
        self.assertEqual([egress_done(s) for s in range(7)],
                         [False, False, False, True, True, True, True])

    def test_paths(self):
        self.assertEqual(egress_filepath("s", "p", "c"), "/out/s/p/c.mp4")
        self.assertEqual(local_to_worker("/out/s/p/c.mp4"), "/egress/s/p/c.mp4")
        self.assertEqual(storage_path("s", "p", "c"),
                         "sessions/s/participants/p/server-c/call.mp4")


if __name__ == "__main__":
    unittest.main()
