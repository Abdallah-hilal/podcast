"""Run: python3 -m unittest worker/test_sources.py  (stdlib only)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from sources import choose_sources, summarize_people  # noqa: E402

HOST, GUEST = "p-host", "p-guest"


def take(tid, pid, run, status="ready", start="2026-11-28T10:00:00+00:00", dur=None):
    return {"id": tid, "participant_id": pid, "run": run, "status": status,
            "created_at": start, "final_storage_path": f"hq/{tid}.webm", "duration_seconds": dur}


def copy(cid, pid, run, status="ready", start="2026-11-28T10:00:01+00:00", dur=None):
    return {"id": cid, "participant_id": pid, "run": run, "status": status,
            "started_at": start, "storage_path": f"server/{cid}.mp4", "duration_seconds": dur}


def picked(items):
    return [(i["kind"], i["id"]) for i in items]


class ChooseSources(unittest.TestCase):
    def test_complete_hq_wins(self):
        out = choose_sources([take("t1", HOST, "r1")], [copy("c1", HOST, "r1")])
        self.assertEqual(picked(out), [("hq", "t1")])
        self.assertEqual(out[0]["path"], "hq/t1.webm")
        self.assertEqual(out[0]["start"], "2026-11-28T10:00:00+00:00")
        self.assertEqual(out[0]["participant_id"], HOST)

    def test_incomplete_hq_falls_back_to_server(self):
        out = choose_sources([take("t1", GUEST, "r1", status="recording")],
                             [copy("c1", GUEST, "r1")])
        self.assertEqual(picked(out), [("server", "c1")])
        self.assertEqual(out[0]["path"], "server/c1.mp4")
        self.assertEqual(out[0]["start"], "2026-11-28T10:00:01+00:00")

    def test_one_unfinished_take_in_a_run_sends_the_whole_run_to_server(self):
        takes = [take("t1", GUEST, "r1"), take("t2", GUEST, "r1", status="uploaded",
                                                   start="2026-11-28T10:20:00+00:00")]
        copies = [copy("c1", GUEST, "r1"),
                  copy("c2", GUEST, "r1", start="2026-11-28T10:20:01+00:00")]
        self.assertEqual(picked(choose_sources(takes, copies)),
                         [("server", "c1"), ("server", "c2")])

    def test_partial_hq_without_server_copy_uses_ready_hq(self):
        takes = [take("t1", GUEST, "r1"), take("t2", GUEST, "r1", status="error")]
        copies = [copy("c1", GUEST, "r1", status="error")]
        self.assertEqual(picked(choose_sources(takes, copies)), [("hq", "t1")])

    def test_server_copy_still_importing_is_not_used(self):
        out = choose_sources([take("t1", GUEST, "r1", status="recording")],
                             [copy("c1", GUEST, "r1", status="importing")])
        self.assertEqual(out, [])

    def test_legacy_take_without_run_is_hq(self):
        out = choose_sources([take("t0", HOST, None)], [])
        self.assertEqual(picked(out), [("hq", "t0")])

    def test_server_copy_without_any_hq_take_is_used(self):
        # The guest's browser couldn't record locally at all.
        self.assertEqual(picked(choose_sources([], [copy("c1", GUEST, "r1")])),
                         [("server", "c1")])

    def test_runs_and_people_decided_independently(self):
        takes = [take("t1", HOST, "r1"),
                 take("t2", GUEST, "r1", status="recording"),
                 take("t3", GUEST, "r2", start="2026-11-28T11:00:00+00:00")]
        copies = [copy("c1", HOST, "r1"), copy("c2", GUEST, "r1"),
                  copy("c3", GUEST, "r2", start="2026-11-28T11:00:01+00:00")]
        self.assertEqual(picked(choose_sources(takes, copies)),
                         [("hq", "t1"), ("server", "c2"), ("hq", "t3")])


class TruncatedHQ(unittest.TestCase):
    # The guest closed the laptop with an upload backlog and never came back;
    # a day later the sweeper closed the take with only its uploaded prefix,
    # so it's "ready" but holds 20 of 60 minutes.
    def test_truncated_hq_loses_to_longer_server_copy(self):
        out = choose_sources([take("t1", GUEST, "r1", dur=1200.0)],
                             [copy("c1", GUEST, "r1", dur=3600.0)])
        self.assertEqual(picked(out), [("server", "c1")])
        self.assertEqual(summarize_people([take("t1", GUEST, "r1", dur=1200.0)],
                                          [copy("c1", GUEST, "r1", dur=3600.0)])[GUEST]["source"], "server")

    def test_hq_missing_its_last_minute_loses(self):
        out = choose_sources([take("t1", GUEST, "r1", dur=3540.0)],
                             [copy("c1", GUEST, "r1", dur=3600.0)])
        self.assertEqual(picked(out), [("server", "c1")])

    def test_hq_about_as_long_as_server_copy_wins(self):
        # HQ starts ~2-4 s before the egress and stops about when it does.
        for hq, sv in ((89.9, 88.4), (3590.0, 3600.0), (40.0, 49.0)):
            out = choose_sources([take("t1", HOST, "r1", dur=hq)], [copy("c1", HOST, "r1", dur=sv)])
            self.assertEqual(picked(out), [("hq", "t1")], (hq, sv))

    def test_segments_are_summed_per_run(self):
        takes = [take("t1", GUEST, "r1", dur=1000.0), take("t2", GUEST, "r1", dur=2590.0)]
        copies = [copy("c1", GUEST, "r1", dur=1000.0), copy("c2", GUEST, "r1", dur=2600.0)]
        self.assertEqual(picked(choose_sources(takes, copies)), [("hq", "t1"), ("hq", "t2")])

    def test_missing_durations_fall_back_to_status(self):
        out = choose_sources([take("t1", HOST, "r1", dur=None)], [copy("c1", HOST, "r1", dur=3600.0)])
        self.assertEqual(picked(out), [("hq", "t1")])


class SummarizePeople(unittest.TestCase):
    def test_summary_reports_source_per_person(self):
        takes = [take("t1", HOST, "r1"), take("t2", GUEST, "r1", status="uploaded")]
        copies = [copy("c1", HOST, "r1"), copy("c2", GUEST, "r1")]
        s = summarize_people(takes, copies)
        self.assertEqual(s[HOST], {"source": "hq", "hq_ready": 1, "hq_total": 1, "server_ready": 1})
        self.assertEqual(s[GUEST], {"source": "server", "hq_ready": 0, "hq_total": 1, "server_ready": 1})

    def test_person_with_nothing_ready_is_none(self):
        s = summarize_people([take("t1", GUEST, "r1", status="recording")],
                             [copy("c1", GUEST, "r1", status="recording")])
        self.assertEqual(s[GUEST]["source"], "none")


class BackendCopy(unittest.TestCase):
    def test_backend_copy_is_identical(self):
        here = Path(__file__).parent
        worker = (here / "sources.py").read_bytes()
        backend = (here.parent / "backend" / "app" / "services" / "sources.py").read_bytes()
        self.assertEqual(worker, backend, "backend/app/services/sources.py must stay a copy of worker/sources.py")


if __name__ == "__main__":
    unittest.main()
