"""Run: python3 -m unittest worker/test_sweep.py  (stdlib only)."""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sweep import final_path, plan_sweep  # noqa: E402

NOW = datetime(2026, 11, 15, 12, 0, tzinfo=timezone.utc)
H = 60  # minutes per hour


def ago(minutes: float) -> str:
    return (NOW - timedelta(minutes=minutes)).isoformat()


def rec(status="recording", created=30 * H):
    return {"id": "r1", "session_id": "s1", "participant_id": "p1",
            "status": status, "created_at": ago(created)}


def batch(seq, status="uploaded", created=25 * H, updated=None, bid=None):
    return {"id": bid or f"b{seq}", "sequence_number": seq, "upload_status": status,
            "created_at": ago(created), "updated_at": ago(updated if updated is not None else created)}


class PlanSweep(unittest.TestCase):
    def test_recent_activity_leaves_the_take_alone(self):
        self.assertIsNone(plan_sweep(rec(), [batch(0, created=2)], NOW))

    def test_new_take_without_batches_is_left_alone(self):
        self.assertIsNone(plan_sweep(rec(created=3), [], NOW))

    def test_a_page_gone_for_hours_can_still_come_back(self):
        # Slow uplink: the person closed the laptop with a backlog on disk.
        # Closing now would throw that backlog away; wait for them.
        self.assertIsNone(plan_sweep(rec(created=30 * H), [batch(0, created=23 * H)], NOW))

    def test_silent_take_finalizes_its_uploaded_prefix(self):
        d = plan_sweep(rec(), [batch(0), batch(1), batch(2), batch(3, status="pending", created=24 * H)], NOW)
        self.assertEqual(d.action, "finalize")
        self.assertEqual(d.keep_seqs, [0, 1, 2])
        self.assertEqual(d.drop_ids, ["b3"])

    def test_gap_in_uploads_keeps_only_the_contiguous_prefix(self):
        d = plan_sweep(rec(), [batch(0), batch(1, status="pending"), batch(2)], NOW)
        self.assertEqual(d.action, "finalize")
        self.assertEqual(d.keep_seqs, [0])
        self.assertEqual(sorted(d.drop_ids), ["b1", "b2"])

    def test_no_uploaded_data_waits_a_day_then_fails(self):
        self.assertIsNone(plan_sweep(rec(created=23 * H), [batch(0, status="pending", created=23 * H)], NOW))
        d = plan_sweep(rec(created=25 * H), [], NOW)
        self.assertEqual(d.action, "fail")

    def test_only_open_takes_are_swept(self):
        for status in ("uploaded", "ready", "error"):
            self.assertIsNone(plan_sweep(rec(status=status), [batch(0)], NOW))

    def test_a_recently_updated_batch_keeps_the_take_alive(self):
        self.assertIsNone(plan_sweep(rec(), [batch(0, created=25 * H, updated=1)], NOW))

    def test_a_recent_heartbeat_keeps_a_slow_uploader_alive(self):
        # Browser still uploading its backlog long after Stop: no new batch
        # for 20 min, but it pinged 1 min ago.
        r = rec(created=40 * H)
        r["updated_at"] = ago(1)
        self.assertIsNone(plan_sweep(r, [batch(0, created=30 * H), batch(1, status="pending", created=30 * H)], NOW))

    def test_exactly_a_day_silent_is_swept(self):
        d = plan_sweep(rec(), [batch(0, created=24 * H)], NOW)
        self.assertEqual(d.action, "finalize")

    def test_final_path_matches_the_backend(self):
        self.assertEqual(
            final_path("s1", "p1", "r1"),
            "sessions/s1/participants/p1/recording-r1/original.webm",
        )


if __name__ == "__main__":
    unittest.main()
