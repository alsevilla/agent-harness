"""Deterministic checks for the offline routing evaluator and its fixture.

These prove evaluator behavior and fixture policy consistency only; they do not
measure model or runtime skill-activation accuracy.
"""
import copy
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "evaluate-routing.py"
CASES = ROOT / "examples" / "routing-cases.json"
AGENTS_DIR = Path(__file__).resolve().parents[3] / "agents"
SKILLS_DIR = ROOT.parent

spec = importlib.util.spec_from_file_location("evaluate_routing", SCRIPT)
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)


def load_fixture():
    return ev.parse_fixture(CASES.read_text(encoding="utf-8"))


def by_id(fixture):
    return {c["id"]: c for c in fixture["cases"]}


def calls_for(roles, tiers):
    """Native call(s) for the roles: one single call, or one chain (guaranteed order) for several.

    First accepted tier is used; `omitted` leaves modelTier absent.
    """
    entries = []
    for role in roles:
        entry = {"agent": role, "task": "t"}
        accepted = tiers.get(role)
        if accepted and accepted[0] != "omitted":
            entry["modelTier"] = accepted[0]
        entries.append(entry)
    return [{"chain": entries}] if len(entries) > 1 else entries


def perfect_predictions(fixture):
    rows = []
    for c in fixture["cases"]:
        e = c["expect"]
        row = {"id": c["id"], "route": e["routes"][0], "roles": e["roles_required"], "skills": e["skills_required"]}
        if "model_tiers" in e:
            row["calls"] = calls_for(e["roles_required"], e["model_tiers"])
            row["calls_provenance"] = "unit-test synthetic capture"
        rows.append(row)
    return rows


def to_jsonl(rows):
    return "\n".join(json.dumps(r) for r in rows) + "\n"


def evaluate_rows(rows, fixture=None):
    fixture = fixture or load_fixture()
    preds = ev.parse_predictions(to_jsonl(rows), {c["id"] for c in fixture["cases"]})
    return ev.evaluate(fixture, preds)


def set_row(rows, cid, **changes):
    for r in rows:
        if r["id"] == cid:
            r.update(changes)
            if "roles" in changes and "calls" in r and "calls" not in changes:
                r["calls"] = calls_for(r["roles"], by_id(load_fixture())[cid]["expect"].get("model_tiers", {}))
            return rows
    raise KeyError(cid)


def run_cli(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, encoding="utf-8")


class FixtureSpecimenTests(unittest.TestCase):
    def test_twenty_eight_unique_cases_with_positive_and_near_miss(self):
        fx = load_fixture()
        ids = [c["id"] for c in fx["cases"]]
        self.assertEqual(len(ids), 28)
        self.assertEqual(len(set(ids)), 28)
        kinds = [c["kind"] for c in fx["cases"]]
        self.assertGreaterEqual(kinds.count("near_miss"), 3)
        self.assertGreaterEqual(kinds.count("positive"), 3)

    def test_current_policy_expectations(self):
        c = by_id(load_fixture())
        # known backend -> backend-worker only; Rust guidance not required for a Go service
        self.assertEqual(c["R01"]["expect"]["roles_allowed"], ["backend-worker"])
        self.assertIn("backend/rust-axum-engineering", c["R01"]["expect"]["skills_forbidden"])
        # accepted UI -> frontend-worker; ui-ux-specialist not needed
        self.assertEqual(c["R03"]["expect"]["roles_allowed"], ["frontend-worker"])
        # unresolved UX -> ui-ux-specialist required; frontend-worker only allowed after the decision
        self.assertEqual(c["R04"]["expect"]["roles_required"], ["ui-ux-specialist"])
        self.assertEqual(c["R04"]["expect"]["roles_allowed"], ["ui-ux-specialist", "frontend-worker"])
        # unresolved owner key -> database-specialist required; database-worker only allowed after the decision
        self.assertEqual(c["R02"]["expect"]["roles_required"], ["database-specialist"])
        self.assertEqual(c["R02"]["expect"]["roles_allowed"], ["database-specialist", "database-worker"])
        # unknown cause -> debugger before backend-worker
        self.assertEqual(c["R05"]["expect"]["roles_required"], ["debugger", "backend-worker"])
        # standalone mechanical edit: main allowed, worker also valid
        self.assertIn("T0_MAIN", c["R07"]["expect"]["routes"])
        # tooling/docs -> general-worker
        self.assertEqual(c["R08"]["expect"]["roles_required"], ["general-worker"])
        # independent verify and review
        self.assertEqual(c["R09"]["expect"]["roles_required"], ["test-engineer"])
        self.assertEqual(c["R10"]["expect"]["roles_required"], ["reviewer"])
        # publish without authority holds; authorized ship -> release-engineer
        self.assertEqual(c["R20"]["expect"]["routes"], ["BLOCKED_NO_AUTHORITY"])
        self.assertEqual(c["R20"]["expect"]["roles_allowed"], [])
        self.assertEqual(c["R21"]["expect"]["roles_required"], ["release-engineer"])
        # unresolved narrow domain roles; confirmed contract policy excludes the specialist
        self.assertEqual(c["R16"]["expect"]["roles_required"], ["architecture-specialist"])
        self.assertEqual(c["R17"]["expect"]["roles_required"], ["concurrency-specialist"])
        self.assertEqual(c["R18"]["expect"]["roles_required"], ["security-specialist"])
        self.assertNotIn("architecture-specialist", c["R15"]["expect"]["roles_allowed"])
        # scout only for unknown location; no scout when location is supplied
        self.assertEqual(c["R13"]["expect"]["roles_required"], ["scout"])
        self.assertNotIn("scout", c["R14"]["expect"]["roles_allowed"])
        # oracle is exceptional; a passing localized change needs no review or oracle
        self.assertEqual(c["R12"]["expect"]["roles_required"], ["oracle"])
        self.assertEqual(c["R11"]["expect"]["roles_allowed"], [])
        # user stop and queue never launch
        self.assertEqual(c["R22"]["expect"]["roles_allowed"], [])
        self.assertEqual(c["R23"]["expect"]["roles_allowed"], [])
        # frontend keyword in a backend-only task must not select frontend guidance
        self.assertIn("frontend", c["R19"]["expect"]["skills_forbidden"])

    def test_platform_routing_examples_separate_platform_devops_and_release(self):
        c = by_id(load_fixture())
        for cid in ("R24", "R25", "R26", "R27", "R28"):
            self.assertIn(cid, c, f"missing platform routing example {cid}")
        # accepted Terraform, Kubernetes and GitHub Actions file edits -> platform-worker (editing only)
        for cid in ("R24", "R25", "R26"):
            self.assertEqual(c[cid]["expect"]["roles_required"], ["platform-worker"], cid)
            self.assertEqual(c[cid]["expect"]["roles_allowed"], ["platform-worker"], cid)
        # read-only devops advice on an unresolved topology decision is not a platform edit
        self.assertEqual(c["R27"]["expect"]["roles_required"], ["devops-specialist"])
        self.assertNotIn("platform-worker", c["R27"]["expect"]["roles_allowed"])
        # authorized release delivery stays with release-engineer, never platform-worker
        self.assertEqual(c["R28"]["expect"]["roles_required"], ["release-engineer"])
        self.assertNotIn("platform-worker", c["R28"]["expect"]["roles_allowed"])

    def test_roles_match_current_agent_directory(self):
        self.assertTrue(AGENTS_DIR.is_dir(), f"role registry missing: {AGENTS_DIR}")
        stems = {p.stem for p in AGENTS_DIR.glob("*.md")}
        self.assertEqual(stems, set(ev.ROLES))

    def test_fixture_skill_names_resolve_to_installed_skills(self):
        names = set()
        for c in load_fixture()["cases"]:
            names.update(c["expect"]["skills_required"], c["expect"]["skills_forbidden"])
        self.assertTrue(names)
        for name in sorted(names):
            folder = SKILLS_DIR / name
            self.assertTrue((folder / "SKILL.md").is_file() or (folder / "index.md").is_file(),
                            f"fixture skill not installed: {name}")


class EvaluatorTests(unittest.TestCase):
    def test_perfect_predictions_pass(self):
        rep = evaluate_rows(perfect_predictions(load_fixture()))
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["matched"], 28)
        self.assertEqual(rep["accuracy"], 1.0)
        self.assertEqual(rep["critical_failures"], 0)

    def test_wrong_role_on_critical_case_fails(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R05", roles=["backend-worker"])
        rep = evaluate_rows(rows, fx)
        self.assertFalse(rep["ok"])
        self.assertEqual(rep["violations"]["role_missing"], 1)
        self.assertEqual(rep["critical_failures"], 1)

    def test_unexpected_role_on_noncritical_case_is_mismatch_not_critical(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R14", roles=["scout", "backend-worker"])
        rep = evaluate_rows(rows, fx)
        self.assertEqual(rep["violations"]["role_unexpected"], 1)
        self.assertEqual(rep["mismatched"], 1)
        self.assertEqual(rep["critical_failures"], 0)
        self.assertFalse(rep["ok"])

    def test_forbidden_skill_is_critical_even_on_noncritical_case(self):
        fx = load_fixture()
        self.assertFalse(by_id(fx)["R01"]["critical"])
        rows = set_row(perfect_predictions(fx), "R01", skills=["backend", "backend/rust-axum-engineering"])
        rep = evaluate_rows(rows, fx)
        self.assertEqual(rep["violations"]["skill_forbidden"], 1)
        self.assertEqual(rep["critical_failures"], 1)
        self.assertFalse(rep["ok"])

    def test_single_critical_miss_not_hidden_by_high_aggregate(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R05", route="T1_WORKER", roles=["backend-worker"])
        rep = evaluate_rows(rows, fx)
        self.assertEqual(rep["matched"], 27)
        self.assertGreater(rep["accuracy"], 0.95)
        self.assertEqual(rep["critical_failures"], 1)
        self.assertFalse(rep["ok"])

    def test_swapped_critical_case_labels_both_flagged(self):
        fx = load_fixture()
        rows = perfect_predictions(fx)
        a = next(r for r in rows if r["id"] == "R05")
        b = next(r for r in rows if r["id"] == "R13")
        a["route"], b["route"] = b["route"], a["route"]
        a["roles"], b["roles"] = b["roles"], a["roles"]
        a.pop("calls")
        a.pop("calls_provenance")  # captured calls would contradict the swapped roles
        rep = evaluate_rows(rows, fx)
        mismatched = {m["id"] for m in rep["mismatches"]}
        self.assertEqual(mismatched, {"R05", "R13"})
        self.assertEqual(rep["critical_failures"], 1)
        self.assertFalse(rep["ok"])

    def test_role_order_violation_detected(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R05", roles=["backend-worker", "debugger"])
        rep = evaluate_rows(rows, fx)
        self.assertEqual(rep["violations"]["role_order"], 1)
        self.assertEqual(rep["violations"]["role_missing"], 0)

    def test_policy_valid_alternative_route_accepted(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R06", route="T2_DEBUG_WORKER", roles=["debugger", "backend-worker"])
        rep = evaluate_rows(rows, fx)
        self.assertTrue(rep["ok"])

    def test_wrong_route_detected(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R13", route="T1_WORKER", roles=[])
        rep = evaluate_rows(rows, fx)
        self.assertEqual(rep["violations"]["route"], 1)
        self.assertFalse(rep["ok"])

    def test_specialist_only_hold_passes_unresolved_cases(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R02", roles=["database-specialist"])
        rows = set_row(rows, "R04", roles=["ui-ux-specialist"])
        rep = evaluate_rows(rows, fx)
        self.assertTrue(rep["ok"], rep["mismatches"])

    def test_worker_without_specialist_on_unresolved_case_is_critical(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R02", roles=["backend-worker"])
        rep = evaluate_rows(rows, fx)
        self.assertEqual(rep["violations"]["role_missing"], 1)
        self.assertEqual(rep["critical_failures"], 1)

    def test_forbidden_router_rejects_child_skill(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R19", skills=["backend", "frontend/solidjs-engineering"])
        rep = evaluate_rows(rows, fx)
        self.assertEqual(rep["violations"]["skill_forbidden"], 1)
        self.assertEqual(rep["critical_failures"], 1)
        self.assertFalse(rep["ok"])

    def test_sibling_skill_name_not_forbidden_by_router_prefix(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R19", skills=["backend", "frontend-tools"])
        rep = evaluate_rows(rows, fx)
        self.assertEqual(rep["violations"]["skill_forbidden"], 0)
        self.assertTrue(rep["ok"])

    def test_unregistered_but_syntax_valid_predicted_skill_not_rejected(self):
        fx = load_fixture()
        rows = set_row(perfect_predictions(fx), "R19", skills=["backend", "generic/vocabulary-path"])
        self.assertTrue(evaluate_rows(rows, fx)["ok"])


class InputValidationTests(unittest.TestCase):
    def setUp(self):
        self.fx = load_fixture()
        self.ids = {c["id"] for c in self.fx["cases"]}
        self.good = to_jsonl(perfect_predictions(self.fx))

    def assertInvalid(self, text):
        with self.assertRaises(ev.RoutingEvalError):
            ev.parse_predictions(text, self.ids)

    def test_good_text_parses(self):
        self.assertEqual(len(ev.parse_predictions(self.good, self.ids)), 28)

    def test_malformed_json_line(self):
        self.assertInvalid(self.good[:-2] + "\n")  # truncated final object

    def test_missing_case(self):
        self.assertInvalid("\n".join(self.good.splitlines()[:-1]) + "\n")

    def test_duplicate_case(self):
        lines = self.good.splitlines()
        self.assertInvalid("\n".join(lines + [lines[0]]) + "\n")

    def test_unknown_case_id(self):
        self.assertInvalid(self.good + json.dumps({"id": "R99", "route": "T0_MAIN", "roles": [], "skills": []}) + "\n")

    def test_empty_predictions(self):
        self.assertInvalid("")

    def test_blank_interior_line(self):
        lines = self.good.splitlines()
        self.assertInvalid("\n".join(lines[:3] + [""] + lines[3:]) + "\n")

    def test_unrecognized_field(self):
        rec = json.loads(self.good.splitlines()[0])
        rec["confidence"] = 0.9
        self.assertInvalid(json.dumps(rec) + "\n" + "\n".join(self.good.splitlines()[1:]) + "\n")

    def test_wrong_types_fail_closed(self):
        base = json.loads(self.good.splitlines()[0])
        for patch in ({"roles": "backend-worker"}, {"route": True}, {"id": 1}, {"skills": ["ok", 2]}, {"route": "T9_UNKNOWN"}, {"roles": ["not-a-role"]}):
            rec = dict(base, **patch)
            self.assertInvalid(json.dumps(rec) + "\n" + "\n".join(self.good.splitlines()[1:]) + "\n")

    def test_non_finite_constants_rejected(self):
        for token in ("NaN", "Infinity", "-Infinity"):
            text = self.good.replace('"skills": []', '"skills": [' + token + ']', 1)
            self.assertInvalid(text)

    def test_duplicate_json_key_rejected(self):
        first = self.good.splitlines()[0]
        dup = first[:-1] + ', "route": "T0_MAIN"}'
        self.assertInvalid(dup + "\n" + "\n".join(self.good.splitlines()[1:]) + "\n")

    def text_with(self, cid, **changes):
        rows = perfect_predictions(self.fx)
        set_row(rows, cid, **changes)
        return to_jsonl(rows)

    def test_skill_with_trailing_newline_cr_or_noncanonical_is_malformed(self):
        for skill in ("frontend\n", "frontend\r", "frontend\r\n", " frontend", "Frontend"):
            self.assertInvalid(self.text_with("R19", skills=[skill]))

    def test_id_with_trailing_newline_or_cr_is_unknown(self):
        for cid in ("R19\n", "R19\r", " R19"):
            self.assertInvalid(self.text_with("R19", id=cid))

    def test_deeply_nested_json_is_routing_eval_error(self):
        self.assertInvalid("[" * 100000 + "]" * 100000 + "\n")


class FixtureValidationTests(unittest.TestCase):
    def raw(self):
        return json.loads(CASES.read_text(encoding="utf-8"))

    def assertBadFixture(self, data):
        with self.assertRaises(ev.RoutingEvalError):
            ev.parse_fixture(json.dumps(data))

    def test_empty_cases(self):
        d = self.raw()
        d["cases"] = []
        self.assertBadFixture(d)

    def test_duplicate_case_id(self):
        d = self.raw()
        d["cases"][1]["id"] = d["cases"][0]["id"]
        self.assertBadFixture(d)

    def test_critical_must_be_boolean(self):
        d = self.raw()
        d["cases"][0]["critical"] = 1
        self.assertBadFixture(d)

    def test_required_role_must_be_allowed(self):
        d = self.raw()
        d["cases"][0]["expect"]["roles_allowed"] = []
        self.assertBadFixture(d)

    def test_skill_cannot_be_required_and_forbidden(self):
        d = self.raw()
        d["cases"][0]["expect"]["skills_forbidden"] = ["backend"]
        self.assertBadFixture(d)

    def test_unknown_role_in_fixture(self):
        d = self.raw()
        d["cases"][0]["expect"]["roles_allowed"] = ["backend-worker", "backend-wrker"]
        d["cases"][0]["expect"]["roles_required"] = ["backend-wrker"]
        self.assertBadFixture(d)

    def test_unrecognized_top_level_field(self):
        d = self.raw()
        d["extra"] = 1
        self.assertBadFixture(d)

    def test_case_id_with_trailing_newline_is_malformed(self):
        d = self.raw()
        d["cases"][0]["id"] = "R01\n"
        self.assertBadFixture(d)

    def test_skill_name_with_trailing_newline_is_malformed(self):
        d = self.raw()
        d["cases"][0]["expect"]["skills_required"] = ["backend\n"]
        self.assertBadFixture(d)

    def test_required_skill_under_forbidden_router_rejected(self):
        d = self.raw()
        r19 = next(c for c in d["cases"] if c["id"] == "R19")
        r19["expect"]["skills_required"] = ["frontend/solidjs-engineering"]
        self.assertBadFixture(d)

    def test_deeply_nested_fixture_is_routing_eval_error(self):
        with self.assertRaises(ev.RoutingEvalError):
            ev.parse_fixture("[" * 100000 + "]" * 100000)


def case_row(rows, cid):
    return next(r for r in rows if r["id"] == cid)


class ModelTierTests(unittest.TestCase):
    """Tier expectations score recorded native subagent call arguments, never claimed intent."""

    def setUp(self):
        self.fx = load_fixture()
        self.ids = {c["id"] for c in self.fx["cases"]}

    def run_rows(self, rows):
        return evaluate_rows(rows, self.fx)

    def test_four_difficult_roles_require_explicit_capable_and_controls_allow_economy(self):
        c = by_id(self.fx)
        for cid, role in (("R18", "security-specialist"), ("R17", "concurrency-specialist"), ("R05", "debugger"), ("R10", "reviewer")):
            self.assertEqual(c[cid]["expect"]["model_tiers"][role], ["capable"], cid)
            self.assertTrue(c[cid]["critical"], cid)
        controls = [cid for cid, x in c.items() if any("capable" not in v for v in x["expect"].get("model_tiers", {}).values())]
        self.assertGreaterEqual(len(controls), 3)
        for cid in controls:
            for allowed in c[cid]["expect"]["model_tiers"].values():
                self.assertEqual(sorted(allowed), ["economy", "omitted"])

    def test_omitted_capable_is_critical_failure(self):
        rows = perfect_predictions(self.fx)
        case_row(rows, "R18")["calls"] = [{"agent": "security-specialist", "task": "t"}]
        rep = self.run_rows(rows)
        self.assertEqual(rep["violations"]["tier_omitted"], 1)
        self.assertEqual(rep["critical_failures"], 1)
        self.assertFalse(rep["ok"])

    def test_wrong_tier_economy_for_difficult_role_is_critical(self):
        rows = perfect_predictions(self.fx)
        case_row(rows, "R10")["calls"] = [{"agent": "reviewer", "task": "t", "modelTier": "economy"}]
        rep = self.run_rows(rows)
        self.assertEqual(rep["violations"]["tier_wrong"], 1)
        self.assertEqual(rep["critical_failures"], 1)

    def test_universal_capable_bias_fails_economy_controls(self):
        rows = perfect_predictions(self.fx)
        case_row(rows, "R01")["calls"] = [{"agent": "backend-worker", "task": "t", "modelTier": "capable"}]
        rep = self.run_rows(rows)
        self.assertEqual(rep["violations"]["tier_wrong"], 1)
        self.assertEqual(rep["critical_failures"], 0)
        self.assertEqual(rep["mismatched"], 1)

    def test_control_accepts_omission_and_explicit_economy(self):
        for call in ({"agent": "backend-worker", "task": "t"}, {"agent": "backend-worker", "task": "t", "modelTier": "economy"}):
            rows = perfect_predictions(self.fx)
            case_row(rows, "R01")["calls"] = [call]
            self.assertTrue(self.run_rows(rows)["ok"], call)

    def test_missing_calls_is_unobserved_not_a_pass(self):
        rows = perfect_predictions(self.fx)
        row = case_row(rows, "R17")
        row.pop("calls")
        row.pop("calls_provenance")
        rep = self.run_rows(rows)
        self.assertEqual(rep["violations"]["tier_unobserved"], 1)
        self.assertEqual(rep["critical_failures"], 1)

    def test_old_four_field_predictions_still_score_untiered_fixture(self):
        fx = json.loads(CASES.read_text(encoding="utf-8"))
        for c in fx["cases"]:
            c["expect"].pop("model_tiers", None)
        fixture = ev.parse_fixture(json.dumps(fx))
        rows = [{k: r[k] for k in ("id", "route", "roles", "skills")} for r in perfect_predictions(self.fx)]
        self.assertTrue(evaluate_rows(rows, fixture)["ok"])

    def test_every_batch_entry_is_scored(self):
        ok_entries = [{"agent": "debugger", "task": "t", "modelTier": "capable"}, {"agent": "backend-worker", "task": "t"}]
        bad_entries = [{"agent": "debugger", "task": "t", "modelTier": "capable"}, {"agent": "debugger", "task": "t"}, {"agent": "backend-worker", "task": "t"}]
        for key in ("chain", "tasks"):
            rows = perfect_predictions(self.fx)
            row = case_row(rows, "R05")
            row["calls"] = [{key: ok_entries}]
            rep = self.run_rows(rows)
            self.assertEqual(rep["violations"]["tier_omitted"] + rep["violations"]["tier_wrong"], 0, key)
            self.assertEqual(rep["ok"], key == "chain", key)  # parallel tasks prove no precedence
            row["calls"] = [{key: bad_entries}]
            row["roles"] = ["debugger", "debugger", "backend-worker"]
            self.assertEqual(self.run_rows(rows)["violations"]["tier_omitted"], 1, key)
        dag = [{"id": "a", "agent": "debugger", "task": "t", "modelTier": "capable"}, {"id": "b", "agent": "backend-worker", "task": "t", "dependsOn": ["a"]}]
        rows = perfect_predictions(self.fx)
        case_row(rows, "R05")["calls"] = [{"dag": dag}]
        self.assertTrue(self.run_rows(rows)["ok"])
        dag[0].pop("modelTier")
        self.assertEqual(self.run_rows(rows)["violations"]["tier_omitted"], 1)

    def test_separate_calls_do_not_prove_order_or_completion(self):
        rows = perfect_predictions(self.fx)
        case_row(rows, "R05")["calls"] = [{"agent": "debugger", "task": "t", "modelTier": "capable"}, {"agent": "backend-worker", "task": "t"}]
        rep = self.run_rows(rows)
        self.assertEqual(rep["violations"]["order_unobserved"], 1)
        self.assertEqual(rep["critical_failures"], 1)
        self.assertFalse(rep["ok"])

    def test_unexpected_role_in_calls_still_fails(self):
        rows = perfect_predictions(self.fx)
        row = case_row(rows, "R18")
        row["roles"] = ["security-specialist", "scout"]
        row["calls"] = [{"agent": "security-specialist", "task": "t", "modelTier": "capable"}, {"agent": "scout", "task": "t"}]
        self.assertEqual(self.run_rows(rows)["violations"]["role_unexpected"], 1)

    def assertBadRow(self, **changes):
        rows = perfect_predictions(self.fx)
        case_row(rows, "R18").update(changes)
        with self.assertRaises(ev.RoutingEvalError):
            ev.parse_predictions(to_jsonl(rows), self.ids)

    def test_malformed_calls_fail_closed(self):
        sec = {"agent": "security-specialist", "task": "t", "modelTier": "capable"}
        for calls in (
            [], "x", [{**sec, "model": "gpt"}], [{**sec, "modelTier": "premium"}],
            [{**sec, "modelTier": None}],  # runtime refuses null; the call never launched
            [{"agent": "security-specialist"}],  # single mode needs task
            [{"tasks": [sec], "agent": "security-specialist"}], [{"tasks": [sec], "chain": [sec]}],
            [{"tasks": [sec], "modelTier": "capable"}],  # root tier is single-mode only
            [{"tasks": []}], [{"dag": [{"agent": "security-specialist", "task": "t"}]}],  # dag node needs id
            [{"tasks": [{**sec, "id": "a"}]}],  # id is dag-only
        ):
            self.assertBadRow(calls=calls)
        self.assertBadRow(calls=[{"tasks": [{"agent": "nobody", "task": "t"}]}], roles=["security-specialist"])

    def test_roles_must_match_calls_and_provenance_is_required(self):
        self.assertBadRow(roles=["security-specialist", "scout"])
        self.assertBadRow(calls_provenance=" ")
        for field in ("calls_provenance", "calls"):  # each requires the other
            rows = perfect_predictions(self.fx)
            case_row(rows, "R18").pop(field)
            with self.assertRaises(ev.RoutingEvalError, msg=field):
                ev.parse_predictions(to_jsonl(rows), self.ids)

    def test_fixture_tier_expectations_validated(self):
        for bad in ({"scout": ["capable"]}, {"security-specialist": ["premium"]}, {"security-specialist": []},
                    {"security-specialist": ["capable", "capable"]}, {}, ["capable"]):
            d = json.loads(CASES.read_text(encoding="utf-8"))
            next(c for c in d["cases"] if c["id"] == "R18")["expect"]["model_tiers"] = bad
            with self.assertRaises(ev.RoutingEvalError, msg=bad):
                ev.parse_fixture(json.dumps(d))

    def test_native_contract_constants_match_subagent_source(self):
        self.assertEqual(native_drift(), [])

    def test_native_parity_check_detects_in_memory_drift(self):
        # The comparison must be able to fail: drift each evaluator constant in memory only.
        drifted = (
            ("NATIVE_ENTRY_KEYS", frozenset({"not_a_native_field"})),
            ("NATIVE_DAG_KEYS", frozenset({"id"})),
            ("NATIVE_ROOT_KEYS", frozenset({"agent"})),
            ("NATIVE_MAX_TASKS", 9),
            ("NATIVE_MAX_DAG_NODES", 9),
            ("NATIVE_DAG_ID", re.compile("x")),
            ("NATIVE_SCOPES", frozenset({"user"})),
            ("TIERS", frozenset({"economy"})),
        )
        for name, bad in drifted:
            with mock.patch.object(ev, name, bad):
                self.assertTrue(native_drift(), name)
        self.assertEqual(native_drift(), [])  # restored


SUBAGENT_DIR = AGENTS_DIR.parent / "extensions" / "subagent"


def ts_block(src, name):
    """(keys, tail) of `const NAME = Type.Object({ ... })`; keys are the properties at the block's top level."""
    m = re.search(rf"const {name} = Type\.Object\(\{{\n(.*?)^\}}([^\n]*)", src, re.S | re.M)
    return set(re.findall(r"^(?:\t| {4})(\w+):", m.group(1), re.M)), m.group(2), m.group(1)


def native_drift():
    """Differences between the evaluator's native-contract constants and the subagent TypeBox/DAG source."""
    src = (SUBAGENT_DIR / "index.ts").read_text(encoding="utf-8")
    dag_src = (SUBAGENT_DIR / "dag.ts").read_text(encoding="utf-8")
    found = []

    def check(label, native, local):
        if native != local:
            found.append(f"{label}: native {native!r} != evaluator {local!r}")

    task, _, task_body = ts_block(src, "TaskItem")
    chain, _, _ = ts_block(src, "ChainItem")
    dag, dag_tail, _ = ts_block(src, "DagNode")
    root, _, _ = ts_block(src, "SubagentParams")
    check("TaskItem keys", task, set(ev.NATIVE_ENTRY_KEYS))
    check("ChainItem keys", chain, set(ev.NATIVE_ENTRY_KEYS))
    check("DagNode keys", dag, set(ev.NATIVE_DAG_KEYS))
    check("SubagentParams keys", root, set(ev.NATIVE_ROOT_KEYS))
    check("DagNode additionalProperties false", "additionalProperties: false" in dag_tail, True)
    check("modelTier literals", set(re.findall(r'Type\.Literal\("(\w+)"\)', task_body)), set(ev.TIERS))
    node_keys = re.search(r"const NODE_KEYS = new Set\(\[(.*?)\]\)", dag_src, re.S).group(1)
    check("dag.ts NODE_KEYS", set(re.findall(r'"(\w+)"', node_keys)), set(ev.NATIVE_DAG_KEYS))
    check("MAX_PARALLEL_TASKS", int(re.search(r"const MAX_PARALLEL_TASKS = (\d+);", src).group(1)), ev.NATIVE_MAX_TASKS)
    check("DAG_NODE_LIMIT", int(re.search(r"DAG_NODE_LIMIT = (\d+)", dag_src).group(1)), ev.NATIVE_MAX_DAG_NODES)
    check("dag maxItems", int(re.search(r"dag: Type\.Optional\(Type\.Array\(DagNode, \{[^}]*maxItems: (\d+)", src).group(1)), ev.NATIVE_MAX_DAG_NODES)
    local_id = "^" + ev.NATIVE_DAG_ID.pattern + "$"
    check("DagNode id pattern", re.search(r'id: Type\.String\(\{ pattern: "([^"]+)"', src).group(1), local_id)
    check("dag.ts NODE_ID", re.search(r"const NODE_ID = /(.+)/;", dag_src).group(1), local_id)
    scopes = re.search(r"const AgentScopeSchema = StringEnum\(\[(.*?)\] as const", src, re.S).group(1)
    check("agentScope values", set(re.findall(r'"(\w+)"', scopes)), set(ev.NATIVE_SCOPES))
    return found


def node(nid, agent="security-specialist", **extra):
    return {"id": nid, "agent": agent, "task": "t", **extra}


def entry(agent="security-specialist", **extra):
    return {"agent": agent, "task": "t", **extra}


class NativeCallValidationTests(unittest.TestCase):
    """Calls the native tool would refuse launch nothing: invalid input (exit 2), never a scored dispatch."""

    def rejected(self, call, label=""):
        with self.assertRaisesRegex(ev.RoutingEvalError, r"calls\[0\]", msg=f"{label} {call!r}"):
            ev.parse_calls([call], "calls")

    def test_dag_graph_rules_match_native_validator(self):
        sec = node("s", modelTier="capable")
        for label, nodes in (
            ("self edge", [{**sec, "dependsOn": ["s"]}]),
            ("missing parent", [{**sec, "dependsOn": ["missing"]}]),
            ("string dependsOn", [{**sec, "dependsOn": "s"}]),
            ("null dependsOn", [{**sec, "dependsOn": None}]),
            ("non-string parent", [node("a"), {**sec, "dependsOn": [1]}]),
            ("duplicate parent", [node("a"), {**sec, "dependsOn": ["a", "a"]}]),
            ("duplicate id", [node("d", "debugger"), node("d", "backend-worker")]),
            ("two-node cycle", [node("d", "debugger", dependsOn=["w"]), node("w", "backend-worker", dependsOn=["d"])]),
            ("three-node cycle", [node("a", dependsOn=["c"]), node("b", dependsOn=["a"]), node("c", dependsOn=["b"])]),
            ("unknown key", [{**sec, "dependson": ["a"]}]),
            ("missing id", [entry()]),
            ("unknown agent", [node("a", "nobody")]),
            ("blank task", [{**sec, "task": "  "}]),
            ("node not object", ["s"]),
            ("nine nodes", [node(f"n{i}") for i in range(9)]),
            ("no nodes", []),
            ("dag not array", {"s": sec}),
        ):
            self.rejected({"dag": nodes}, label)

    def test_dag_node_id_syntax_matches_native_pattern(self):
        for bad in ("1a", "a b", "a\n", "", "_a", "x" * 33, 5, None, ["a"]):
            self.rejected({"dag": [node(bad)]}, f"id {bad!r}")
        for good in ("a", "A1", "a_b-c", "x" * 32):
            self.assertEqual(len(ev.parse_calls([{"dag": [node(good)]}], "calls")), 1, good)

    def test_optional_entry_values_are_typed_in_every_mode(self):
        for mode in ("tasks", "chain", "dag"):
            make = (lambda **kw: node("a", **kw)) if mode == "dag" else (lambda **kw: entry(**kw))
            for field, bad in (("cwd", 123), ("cwd", ""), ("cwd", "  "), ("cwd", None), ("readOnly", "yes"),
                               ("readOnly", 1), ("readOnly", 0), ("readOnly", None), ("task", 5), ("agent", 5)):
                self.rejected({mode: [make(**{field: bad})]}, f"{mode}.{field}")
            ok = ev.parse_calls([{mode: [make(cwd="C:/work", readOnly=True)]}], "calls")
            self.assertEqual(len(ok), 1, mode)

    def test_entry_count_limits(self):
        self.rejected({"tasks": [entry() for _ in range(ev.NATIVE_MAX_TASKS + 1)]})
        self.assertEqual(len(ev.parse_calls([{"tasks": [entry() for _ in range(ev.NATIVE_MAX_TASKS)]}], "c")), 8)
        self.assertEqual(len(ev.parse_calls([{"dag": [node(f"n{i}") for i in range(ev.NATIVE_MAX_DAG_NODES)]}], "c")), 8)
        # the native chain schema has no item limit, so the evaluator invents none
        self.assertEqual(len(ev.parse_calls([{"chain": [entry() for _ in range(9)]}], "c")), 9)

    def test_batch_entries_must_be_objects_with_known_keys(self):
        for mode in ("tasks", "chain"):
            self.rejected({mode: ["x"]}, mode)
            self.rejected({mode: [entry(dependsOn=["a"])]}, mode)
            self.rejected({mode: [entry(id="a")]}, mode)
            self.rejected({mode: {"a": entry()}}, mode)

    def test_root_option_types(self):
        base = entry(modelTier="capable")
        for field, bad in (("background", "yes"), ("background", 1), ("background", None), ("agentScope", "nobody"),
                           ("agentScope", ["user"]), ("agentScope", None), ("confirmProjectAgents", []),
                           ("confirmProjectAgents", 0), ("readOnly", "yes"), ("readOnly", 1), ("cwd", 123),
                           ("cwd", ""), ("cwd", None), ("surprise", True)):
            self.rejected({**base, field: bad}, field)
        ok = ev.parse_calls([{**base, "background": False, "agentScope": "both", "confirmProjectAgents": False,
                              "readOnly": False, "cwd": "C:/work"}], "calls")
        self.assertEqual(ok[0]["agent"], "security-specialist")

    def test_root_background_and_scope_types_checked_in_batch_modes(self):
        for call in ({"tasks": [entry()]}, {"chain": [entry()]}, {"dag": [node("a")]}):
            self.rejected({**call, "background": "no"})
            self.rejected({**call, "agentScope": "x"})
            self.rejected({**call, "confirmProjectAgents": "no"})
            self.assertEqual(len(ev.parse_calls([{**call, "background": False, "agentScope": "user"}], "c")), 1)

    def test_root_cwd_and_readonly_are_single_mode_only(self):
        # Batch modes ignore them natively; accepting them would credit an option that never applied.
        for call in ({"tasks": [entry()]}, {"chain": [entry()]}, {"dag": [node("a")]}):
            self.rejected({**call, "cwd": "C:/work"})
            self.rejected({**call, "readOnly": True})

    def test_single_mode_needs_nonblank_agent_and_task(self):
        for call in ({"agent": "reviewer"}, {"task": "t"}, {"agent": "reviewer", "task": ""},
                     {"agent": "reviewer", "task": 5}, {"agent": "", "task": "t"}, {"agent": None, "task": "t"}):
            self.rejected(call)

    def test_invalid_graph_never_scores_pass_for_a_difficult_role(self):
        # Reviewer probe: a self-dependent capable security-specialist node credited R18 and exited 0.
        rows = perfect_predictions(load_fixture())
        case_row(rows, "R18")["calls"] = [{"dag": [node("s", modelTier="capable", dependsOn=["s"])]}]
        with self.assertRaises(ev.RoutingEvalError):
            evaluate_rows(rows)

    def test_cli_exits_two_without_result_for_invalid_native_call(self):
        rows = perfect_predictions(load_fixture())
        case_row(rows, "R18")["calls"] = [{"dag": [node("s", modelTier="capable", dependsOn=["s"])]}]
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "bad.jsonl"
            p.write_text(to_jsonl(rows), encoding="utf-8")
            r = run_cli("--cases", str(CASES), "--predictions", str(p))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("calls[0]", r.stderr)
        self.assertIn("cannot depend on itself", r.stderr)
        self.assertNotIn("RESULT:", r.stdout)
        self.assertNotIn("Traceback", r.stderr)


class CallOrderTests(unittest.TestCase):
    """Precedence comes from chain order or dependency ancestry, never from array position or call order."""
    DBG = node("d", "debugger", modelTier="capable")
    WRK = node("w", "backend-worker")

    def setUp(self):
        self.fx = load_fixture()

    def r05(self, calls, roles=("debugger", "backend-worker")):
        rows = perfect_predictions(self.fx)
        row = case_row(rows, "R05")
        row["calls"], row["roles"] = calls, list(roles)
        return evaluate_rows(rows, self.fx)

    def test_dependency_ancestry_decides_not_declaration_order(self):
        dbg_first = [self.DBG, {**self.WRK, "dependsOn": ["d"]}]
        for label, nodes in (("debugger declared first", dbg_first), ("worker declared first", dbg_first[::-1])):
            rep = self.r05([{"dag": nodes}])
            self.assertTrue(rep["ok"], label)
            self.assertEqual(rep["critical_failures"], 0, label)

    def test_reversed_dependency_is_critical_whatever_the_declaration_order(self):
        reversed_edge = [{**self.DBG, "dependsOn": ["w"]}, self.WRK]
        for label, nodes in (("debugger declared first", reversed_edge), ("worker declared first", reversed_edge[::-1])):
            rep = self.r05([{"dag": nodes}])
            self.assertEqual(rep["violations"]["role_order"], 1, label)
            self.assertEqual(rep["critical_failures"], 1, label)
            self.assertFalse(rep["ok"], label)

    def test_roles_list_order_is_not_runtime_order(self):
        rep = self.r05([{"dag": [self.DBG, {**self.WRK, "dependsOn": ["d"]}]}], roles=("backend-worker", "debugger"))
        self.assertTrue(rep["ok"])

    def test_parallel_and_unrelated_nodes_prove_no_precedence(self):
        entries = [entry("debugger", modelTier="capable"), entry("backend-worker")]
        for label, call in (("tasks", {"tasks": entries}), ("dag without edge", {"dag": [self.DBG, self.WRK]})):
            rep = self.r05([call])
            self.assertEqual(rep["violations"]["order_unobserved"], 1, label)
            self.assertEqual(rep["violations"]["role_order"], 0, label)
            self.assertEqual(rep["critical_failures"], 1, label)
            self.assertFalse(rep["ok"], label)

    def test_chain_order_is_guaranteed_within_the_call(self):
        good = [entry("debugger", modelTier="capable"), entry("backend-worker")]
        self.assertTrue(self.r05([{"chain": good}])["ok"])
        rep = self.r05([{"chain": good[::-1]}])
        self.assertEqual(rep["violations"]["role_order"], 1)
        self.assertEqual(rep["critical_failures"], 1)

    def test_separate_calls_do_not_prove_order(self):
        rep = self.r05([entry("debugger", modelTier="capable"), entry("backend-worker")])
        self.assertEqual(rep["violations"]["order_unobserved"], 1)
        self.assertFalse(rep["ok"])

    def test_every_dispatch_of_the_later_role_needs_an_earlier_ancestor(self):
        free_worker = node("x", "backend-worker")
        rep = self.r05([{"dag": [self.DBG, {**self.WRK, "dependsOn": ["d"]}, free_worker]}],
                       roles=("debugger", "backend-worker", "backend-worker"))
        self.assertEqual(rep["violations"]["order_unobserved"], 1)

    def test_transitive_ancestry_counts(self):
        nodes = [self.DBG, {**self.WRK, "dependsOn": ["d"]}, node("w2", "backend-worker", dependsOn=["w"])]
        rep = self.r05([{"dag": nodes}], roles=("debugger", "backend-worker", "backend-worker"))
        self.assertTrue(rep["ok"])

    def test_roles_must_match_calls_as_a_multiset(self):
        rows = perfect_predictions(self.fx)
        row = case_row(rows, "R05")
        row["calls"] = [{"dag": [self.DBG, {**self.WRK, "dependsOn": ["d"]}]}]
        row["roles"] = ["debugger", "debugger", "backend-worker"]
        with self.assertRaises(ev.RoutingEvalError):
            evaluate_rows(rows, self.fx)

    def test_legacy_role_only_predictions_keep_list_order_semantics(self):
        fx = json.loads(CASES.read_text(encoding="utf-8"))
        for c in fx["cases"]:
            c["expect"].pop("model_tiers", None)
        fixture = ev.parse_fixture(json.dumps(fx))
        base = [{k: r[k] for k in ("id", "route", "roles", "skills")} for r in perfect_predictions(self.fx)]
        self.assertTrue(evaluate_rows(base, fixture)["ok"])
        case_row(base, "R05")["roles"] = ["backend-worker", "debugger"]
        rep = evaluate_rows(base, fixture)
        self.assertEqual(rep["violations"]["role_order"], 1)
        self.assertEqual(rep["critical_failures"], 1)


class MalformedTierTests(unittest.TestCase):
    """Unsupported modelTier values of any JSON type are contextual input errors, not TypeError."""
    VALUES = ([], {}, [1], {"a": 1}, 0, 1, 1.5, True, False, None, "premium", "", "Capable", "omitted")

    def test_every_mode_rejects_every_unsupported_tier_type(self):
        shapes = (
            ("single", lambda t: entry(modelTier=t)),
            ("tasks", lambda t: {"tasks": [entry(modelTier=t)]}),
            ("chain", lambda t: {"chain": [entry(modelTier=t)]}),
            ("dag", lambda t: {"dag": [node("a", modelTier=t)]}),
        )
        for label, make in shapes:
            for bad in self.VALUES:
                with self.assertRaisesRegex(ev.RoutingEvalError, r"modelTier", msg=f"{label} {bad!r}"):
                    ev.parse_calls([make(bad)], "calls")

    def test_cli_malformed_tier_container_exits_two_without_traceback(self):
        for bad in ([], {}):
            rows = perfect_predictions(load_fixture())
            case_row(rows, "R18")["calls"] = [entry(modelTier=bad)]
            with tempfile.TemporaryDirectory() as tmp:
                p = Path(tmp) / "t.jsonl"
                p.write_text(to_jsonl(rows), encoding="utf-8")
                r = run_cli("--cases", str(CASES), "--predictions", str(p))
            self.assertEqual(r.returncode, 2, r.stderr)
            self.assertIn("modelTier", r.stderr)
            self.assertNotIn("Traceback", r.stderr)
            self.assertNotIn("RESULT:", r.stdout)

    def test_internal_type_errors_are_not_masked(self):
        with mock.patch.object(ev, "_text", side_effect=TypeError("internal bug")):
            with self.assertRaises(TypeError):
                ev.parse_calls([entry()], "calls")


class CliTests(unittest.TestCase):
    def setUp(self):
        self.fx = load_fixture()
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        p = self.dir / name
        p.write_text(text, encoding="utf-8")
        return str(p)

    def test_perfect_predictions_exit_zero(self):
        p = self.write("pred.jsonl", to_jsonl(perfect_predictions(self.fx)))
        r = run_cli("--cases", str(CASES), "--predictions", p)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("matched: 28/28", r.stdout)
        self.assertIn("RESULT: PASS", r.stdout)
        self.assertIn("does NOT prove runtime skill activation", r.stdout)

    def test_mismatch_exit_one_with_report(self):
        rows = set_row(perfect_predictions(self.fx), "R05", roles=["backend-worker"])
        p = self.write("pred.jsonl", to_jsonl(rows))
        r = run_cli("--cases", str(CASES), "--predictions", p)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("MISMATCH R05 [CRITICAL]", r.stdout)
        self.assertIn("RESULT: FAIL", r.stdout)

    def test_invalid_input_exit_two(self):
        p = self.write("bad.jsonl", "{not json}\n")
        r = run_cli("--cases", str(CASES), "--predictions", p)
        self.assertEqual(r.returncode, 2)
        self.assertIn("error:", r.stderr)

    def test_missing_file_exit_two(self):
        r = run_cli("--cases", str(self.dir / "absent.json"), "--self-check")
        self.assertEqual(r.returncode, 2)
        self.assertIn("error:", r.stderr)

    def test_self_check_is_labelled_not_measured(self):
        r = run_cli("--cases", str(CASES), "--self-check")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("NOT measured model accuracy", r.stdout)

    def test_requires_one_input_source(self):
        r = run_cli("--cases", str(CASES))
        self.assertEqual(r.returncode, 2)

    def test_forbidden_child_skill_exit_one_critical(self):
        rows = set_row(perfect_predictions(self.fx), "R19", skills=["backend", "frontend/solidjs-engineering"])
        p = self.write("child.jsonl", to_jsonl(rows))
        r = run_cli("--cases", str(CASES), "--predictions", p)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("MISMATCH R19 [CRITICAL]", r.stdout)

    def test_trailing_newline_skill_exit_two(self):
        rows = set_row(perfect_predictions(self.fx), "R19", skills=["backend", "frontend\n"])
        p = self.write("nl.jsonl", to_jsonl(rows))
        r = run_cli("--cases", str(CASES), "--predictions", p)
        self.assertEqual(r.returncode, 2, r.stdout)
        self.assertIn("error:", r.stderr)

    def test_crlf_predictions_hash_raw_bytes(self):
        raw = to_jsonl(perfect_predictions(self.fx)).replace("\n", "\r\n").encode("utf-8")
        p = self.dir / "crlf.jsonl"
        p.write_bytes(raw)
        r = run_cli("--cases", str(CASES), "--predictions", str(p))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("sha256=" + hashlib.sha256(raw).hexdigest(), r.stdout)
        self.assertIn("matched: 28/28", r.stdout)

    def test_utf8_bom_and_invalid_utf8_predictions_exit_two(self):
        body = to_jsonl(perfect_predictions(self.fx)).encode("utf-8")
        for name, raw in (("bom.jsonl", b"\xef\xbb\xbf" + body), ("bad.jsonl", b"\xff" + body)):
            p = self.dir / name
            p.write_bytes(raw)
            r = run_cli("--cases", str(CASES), "--predictions", str(p))
            self.assertEqual(r.returncode, 2, name)
            self.assertIn("error:", r.stderr)

    def test_deeply_nested_predictions_exit_two_without_traceback(self):
        p = self.write("deep.jsonl", "[" * 100000 + "]" * 100000 + "\n")
        r = run_cli("--cases", str(CASES), "--predictions", p)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("error:", r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        self.assertNotIn("RESULT:", r.stdout)

    def test_deeply_nested_fixture_exit_two_without_traceback(self):
        p = self.write("deep.json", '{"schema": ' + "[" * 100000 + "]" * 100000 + "}\n")
        r = run_cli("--cases", p, "--self-check")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("error:", r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        self.assertNotIn("RESULT:", r.stdout)


if __name__ == "__main__":
    unittest.main()

