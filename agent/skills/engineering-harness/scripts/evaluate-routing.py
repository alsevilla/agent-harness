#!/usr/bin/env python3
"""Offline routing-fixture evaluator (stdlib only; no model, network or provider calls).

Scores explicitly provided routing predictions (JSONL, one object per case) against
examples/routing-cases.json. Passing provided predictions does NOT prove runtime skill
activation; --self-check only proves fixture/evaluator consistency. A prediction may carry
`calls`: the recorded argument objects of native `subagent` calls; cases with
`expect.model_tiers` score the modelTier of every dispatched entry from those calls.
Exit: 0 all matched and no critical failure; 1 mismatch or critical failure; 2 invalid input or usage.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

SCHEMA = "engineering-harness/routing-cases/v1"
ROUTES = frozenset({
    "T0_MAIN", "T1_WORKER", "T2_DEBUG_WORKER", "T3_SPECIALIST_FIRST", "T4_ORACLE_ESCALATION",
    "DISCOVER_SCOUT_FIRST", "LOCAL_DONE", "VERIFY_INDEPENDENT", "REVIEW", "SHIP_AUTHORIZED",
    "BLOCKED_NO_AUTHORITY", "STOP_NO_LAUNCH", "QUEUE_NO_LAUNCH",
})
# Mirrors agent/agents/*.md; tests/test_evaluate_routing.py checks the drift.
ROLES = frozenset({
    "api-specialist", "architecture-specialist", "backend-worker", "concurrency-specialist",
    "debugger", "devops-specialist", "frontend-worker", "general-worker",
    "observability-specialist", "oracle", "performance-specialist", "platform-worker", "release-engineer",
    "reviewer", "scout", "security-specialist", "database-specialist", "database-worker",
    "test-engineer", "ui-ux-specialist",
})
KINDS = frozenset({"positive", "near_miss"})
FIXTURE_KEYS = frozenset({"schema", "description", "cases"})
CASE_KEYS = frozenset({"id", "kind", "question", "context", "critical", "expect"})
EXPECT_KEYS = frozenset({"routes", "roles_required", "roles_allowed", "skills_required", "skills_forbidden"})
EXPECT_OPTIONAL = frozenset({"model_tiers"})
PRED_KEYS = frozenset({"id", "route", "roles", "skills"})
PRED_OPTIONAL = frozenset({"calls", "calls_provenance"})
# Native `subagent` tool contract; tests compare these with agent/extensions/subagent/index.ts and dag.ts.
TIERS = frozenset({"economy", "capable"})
TIER_CHOICES = frozenset({"economy", "capable", "omitted"})  # omitted: modelTier absent, role default runs
NATIVE_ENTRY_KEYS = frozenset({"agent", "task", "cwd", "readOnly", "modelTier"})
NATIVE_DAG_KEYS = NATIVE_ENTRY_KEYS | {"id", "dependsOn"}
NATIVE_ROOT_KEYS = frozenset({"background", "modelTier", "agent", "task", "tasks", "chain", "agentScope", "dag",
                              "readOnly", "confirmProjectAgents", "cwd"})
BATCH_MODES = ("tasks", "chain", "dag")
NATIVE_MAX_TASKS = 8  # MAX_PARALLEL_TASKS in index.ts; the native chain schema has no item limit
NATIVE_MAX_DAG_NODES = 8  # DAG_NODE_LIMIT in dag.ts and the dag schema maxItems
NATIVE_DAG_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,31}")  # dag.ts NODE_ID, used with fullmatch
NATIVE_SCOPES = frozenset({"user", "project", "both"})
# Used with fullmatch: a `$` anchor would accept a trailing newline.
ID_RE = re.compile(r"R[0-9]{2,3}")
SKILL_RE = re.compile(r"[a-z0-9][a-z0-9/-]*")
VIOLATION_KINDS = ("route", "role_missing", "role_order", "role_unexpected", "skill_missing", "skill_forbidden",
                   "order_unobserved", "tier_unobserved", "tier_omitted", "tier_wrong")


class RoutingEvalError(ValueError):
    """Invalid fixture, predictions or usage. The evaluator fails closed."""


def _reject_constant(token):
    raise RoutingEvalError(f"non-finite or unsupported JSON constant: {token}")


def _no_duplicate_keys(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise RoutingEvalError(f"duplicate JSON key: {key}")
        out[key] = value
    return out


def _loads(text, where):
    try:
        return json.loads(text, parse_constant=_reject_constant, object_pairs_hook=_no_duplicate_keys)
    except json.JSONDecodeError as exc:
        raise RoutingEvalError(f"{where}: malformed JSON ({exc.msg}, line {exc.lineno})") from exc
    except RecursionError as exc:
        raise RoutingEvalError(f"{where}: JSON nesting too deep") from exc


def _obj(value, keys, where, optional=frozenset()):
    if not isinstance(value, dict):
        raise RoutingEvalError(f"{where}: expected object")
    unknown = sorted(set(value) - keys - optional)
    if unknown:
        raise RoutingEvalError(f"{where}: unrecognized fields {unknown}")
    missing = sorted(keys - set(value))
    if missing:
        raise RoutingEvalError(f"{where}: missing fields {missing}")
    return value


def _text(value, where):
    if not isinstance(value, str) or not value.strip():
        raise RoutingEvalError(f"{where}: expected non-empty string")
    return value


def _choice(value, allowed, where):
    if not isinstance(value, str) or value not in allowed:
        raise RoutingEvalError(f"{where}: unknown value {value!r}")
    return value


def _names(value, where, allowed=None, pattern=None, unique=True):
    if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
        raise RoutingEvalError(f"{where}: expected list of strings")
    if unique and len(set(value)) != len(value):
        raise RoutingEvalError(f"{where}: duplicate entries")
    for item in value:
        if allowed is not None and item not in allowed:
            raise RoutingEvalError(f"{where}: unknown value {item!r}")
        if pattern is not None and not pattern.fullmatch(item):
            raise RoutingEvalError(f"{where}: malformed value {item!r}")
    return value


def _covers(router, skill):
    # Path-component boundary: `frontend` covers `frontend/x`, not `frontend-tools`.
    return skill == router or skill.startswith(router + "/")


def parse_fixture(text):
    data = _obj(_loads(text, "fixture"), FIXTURE_KEYS, "fixture")
    if data["schema"] != SCHEMA:
        raise RoutingEvalError(f"fixture: schema must be {SCHEMA}")
    _text(data["description"], "fixture.description")
    cases = data["cases"]
    if not isinstance(cases, list) or not cases:
        raise RoutingEvalError("fixture: cases must be a non-empty list")
    seen = set()
    for index, raw in enumerate(cases):
        case = _obj(raw, CASE_KEYS, f"case[{index}]")
        cid = case["id"]
        if not isinstance(cid, str) or not ID_RE.fullmatch(cid):
            raise RoutingEvalError(f"case[{index}]: malformed id {cid!r}")
        if cid in seen:
            raise RoutingEvalError(f"fixture: duplicate case id {cid}")
        seen.add(cid)
        _choice(case["kind"], KINDS, f"{cid}.kind")
        _text(case["question"], f"{cid}.question")
        _text(case["context"], f"{cid}.context")
        if not isinstance(case["critical"], bool):
            raise RoutingEvalError(f"{cid}.critical: expected boolean")
        exp = _obj(case["expect"], EXPECT_KEYS, f"{cid}.expect", EXPECT_OPTIONAL)
        if not _names(exp["routes"], f"{cid}.routes", allowed=ROUTES):
            raise RoutingEvalError(f"{cid}.routes: must be non-empty")
        required = _names(exp["roles_required"], f"{cid}.roles_required", allowed=ROLES)
        allowed = _names(exp["roles_allowed"], f"{cid}.roles_allowed", allowed=ROLES)
        if not set(required) <= set(allowed):
            raise RoutingEvalError(f"{cid}: roles_required must be a subset of roles_allowed")
        s_req = _names(exp["skills_required"], f"{cid}.skills_required", pattern=SKILL_RE)
        s_forb = _names(exp["skills_forbidden"], f"{cid}.skills_forbidden", pattern=SKILL_RE)
        if any(_covers(f, r) for f in s_forb for r in s_req):
            raise RoutingEvalError(f"{cid}: a skill cannot be both required and forbidden")
        if "model_tiers" in exp:
            tiers = exp["model_tiers"]
            if not isinstance(tiers, dict) or not tiers:
                raise RoutingEvalError(f"{cid}.model_tiers: expected non-empty object")
            for role, accepted in tiers.items():
                if role not in required:
                    raise RoutingEvalError(f"{cid}.model_tiers: {role!r} must be in roles_required")
                if not _names(accepted, f"{cid}.model_tiers.{role}", allowed=TIER_CHOICES):
                    raise RoutingEvalError(f"{cid}.model_tiers.{role}: must be non-empty")
    return data


def _tier(value, where):
    # Type before membership: an unhashable JSON container must be an input error, not a TypeError.
    # null is refused by the runtime before launch, so it is never a dispatch observation either.
    if not isinstance(value, str) or value not in TIERS:
        raise RoutingEvalError(f"{where}.modelTier: expected economy or capable when present, got {value!r}")
    return value


def _flag(value, where):
    if not isinstance(value, bool):
        raise RoutingEvalError(f"{where}: expected boolean, got {value!r}")
    return value


def _entry(item, keys, where, dag):
    """Validate one tasks/chain/dag entry like the native TypeBox schema and dag validator."""
    required = {"agent", "task", "id"} if dag else {"agent", "task"}
    entry = _obj(item, required, where, keys - required)
    _text(entry["task"], f"{where}.task")
    if "cwd" in entry:
        _text(entry["cwd"], f"{where}.cwd")
    if "readOnly" in entry:
        _flag(entry["readOnly"], f"{where}.readOnly")
    tier = _tier(entry["modelTier"], where) if "modelTier" in entry else None
    return {"agent": _choice(entry["agent"], ROLES, f"{where}.agent"), "tier": tier}


def _dag(items, where):
    """Validate a dag like agent/extensions/subagent/dag.ts validateDag; returns dispatches with ancestry."""
    if not isinstance(items, list) or not items:
        raise RoutingEvalError(f"{where}: expected non-empty list")
    if len(items) > NATIVE_MAX_DAG_NODES:
        raise RoutingEvalError(f"{where}: {len(items)} nodes; the native limit is {NATIVE_MAX_DAG_NODES}")
    nodes, deps_of = [], []
    for i, item in enumerate(items):
        at = f"{where}[{i}]"
        nodes.append(_entry(item, NATIVE_DAG_KEYS, at, True))
        nid = item["id"]
        if not isinstance(nid, str) or not NATIVE_DAG_ID.fullmatch(nid):
            raise RoutingEvalError(f"{at}.id: invalid dag node id {nid!r}")
        if any(n.get("id") == nid for n in nodes[:-1]):
            raise RoutingEvalError(f"{at}.id: duplicate dag node id {nid!r}")
        nodes[-1]["id"] = nid
        deps = item.get("dependsOn", [])
        if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
            raise RoutingEvalError(f"{at}.dependsOn: expected a list of node ids, got {deps!r}")
        deps_of.append(deps)
    ids = {n["id"] for n in nodes}
    for i, node in enumerate(nodes):
        seen = set()
        for dep in deps_of[i]:
            at = f"{where}[{i}].dependsOn"
            if dep == node["id"]:
                raise RoutingEvalError(f"{at}: dag node {dep!r} cannot depend on itself")
            if dep not in ids:
                raise RoutingEvalError(f"{at}: depends on missing node {dep!r}")
            if dep in seen:
                raise RoutingEvalError(f"{at}: lists parent {dep!r} more than once")
            seen.add(dep)
    # Kahn: nodes never reached sit on a cycle. Ancestry is built in topological order.
    ancestors, pending = {}, {n["id"]: len(deps_of[i]) for i, n in enumerate(nodes)}
    ready = [n["id"] for i, n in enumerate(nodes) if not deps_of[i]]
    for nid in ready:
        ancestors[nid] = set()
    while ready:
        done = ready.pop(0)
        for i, node in enumerate(nodes):
            if done in deps_of[i]:
                pending[node["id"]] -= 1
                if pending[node["id"]] == 0:
                    ancestors[node["id"]] = set().union(*({d} | ancestors[d] for d in deps_of[i]))
                    ready.append(node["id"])
    if len(ancestors) != len(nodes):
        raise RoutingEvalError(f"{where}: dag contains a dependency cycle")
    index = {n["id"]: i for i, n in enumerate(nodes)}
    for node in nodes:
        node["before_local"] = {index[a] for a in ancestors[node.pop("id")]}
    return nodes


def parse_calls(value, where):
    """Validate recorded native `subagent` call arguments; return dispatches {agent, tier, before}.

    `before` holds indexes of dispatches in the same call guaranteed to complete first: earlier chain
    steps and transitive dag dependencies. Array position of tasks/dag entries and call order are
    never precedence.
    """
    if not isinstance(value, list) or not value:
        raise RoutingEvalError(f"{where}: expected non-empty list of call objects")
    dispatches = []
    for n, call in enumerate(value):
        at = f"{where}[{n}]"
        if not isinstance(call, dict):
            raise RoutingEvalError(f"{at}: expected object")
        unknown = sorted(set(call) - NATIVE_ROOT_KEYS)
        if unknown:
            raise RoutingEvalError(f"{at}: unrecognized fields {unknown}")
        batch = [m for m in BATCH_MODES if m in call]
        single = "agent" in call or "task" in call
        if len(batch) + (1 if single else 0) != 1:
            raise RoutingEvalError(f"{at}: expected exactly one of agent+task, tasks, chain or dag")
        if "background" in call:
            _flag(call["background"], f"{at}.background")
        if "agentScope" in call:
            _choice(call["agentScope"], NATIVE_SCOPES, f"{at}.agentScope")
        if "confirmProjectAgents" in call:
            _flag(call["confirmProjectAgents"], f"{at}.confirmProjectAgents")
        base = len(dispatches)
        if batch:
            mode = batch[0]
            for key in ("modelTier", "agent", "task"):
                if key in call:
                    raise RoutingEvalError(f"{at}.{key}: single-mode field; batch modes set it per entry")
            for key in ("cwd", "readOnly"):
                if key in call:
                    raise RoutingEvalError(f"{at}.{key}: applies to single mode only; batch modes ignore it")
            items = call[mode]
            if mode == "dag":
                found = _dag(items, f"{at}.dag")
                for d in found:
                    d["before"] = frozenset(base + i for i in d.pop("before_local"))
            else:
                if not isinstance(items, list) or not items:
                    raise RoutingEvalError(f"{at}.{mode}: expected non-empty list")
                if mode == "tasks" and len(items) > NATIVE_MAX_TASKS:
                    raise RoutingEvalError(f"{at}.tasks: {len(items)} entries; the native limit is {NATIVE_MAX_TASKS}")
                found = [_entry(item, NATIVE_ENTRY_KEYS, f"{at}.{mode}[{i}]", False) for i, item in enumerate(items)]
                for i, d in enumerate(found):
                    d["before"] = frozenset(range(base, base + i)) if mode == "chain" else frozenset()
            dispatches += found
        else:
            if "agent" not in call or "task" not in call:
                raise RoutingEvalError(f"{at}: single mode needs agent and task")
            if "cwd" in call:
                _text(call["cwd"], f"{at}.cwd")
            if "readOnly" in call:
                _flag(call["readOnly"], f"{at}.readOnly")
            _text(call["task"], f"{at}.task")
            tier = _tier(call["modelTier"], at) if "modelTier" in call else None
            dispatches.append({"agent": _choice(call["agent"], ROLES, f"{at}.agent"), "tier": tier, "before": frozenset()})
        if call.get("agentScope") == "project" and any(d["tier"] is not None for d in dispatches[base:]):
            raise RoutingEvalError(f"{at}.agentScope: project scope cannot take an explicit modelTier; "
                                   "canonical package roles are not in project-only discovery")
    return dispatches


def parse_predictions(text, case_ids):
    lines = text.splitlines()
    if not lines:
        raise RoutingEvalError("predictions: empty dataset")
    preds = {}
    for number, line in enumerate(lines, 1):
        where = f"predictions line {number}"
        if not line.strip():
            raise RoutingEvalError(f"{where}: blank line")
        rec = _obj(_loads(line, where), PRED_KEYS, where, PRED_OPTIONAL)
        pid = rec["id"]
        if not isinstance(pid, str) or pid not in case_ids:
            raise RoutingEvalError(f"{where}: unknown case id {pid!r}")
        if pid in preds:
            raise RoutingEvalError(f"{where}: duplicate case id {pid}")
        preds[pid] = {
            "route": _choice(rec["route"], ROUTES, f"{where}.route"),
            "roles": _names(rec["roles"], f"{where}.roles", allowed=ROLES, unique=False),
            "skills": _names(rec["skills"], f"{where}.skills", pattern=SKILL_RE),
            "dispatches": None,
        }
        if ("calls" in rec) != ("calls_provenance" in rec):
            raise RoutingEvalError(f"{where}: calls and calls_provenance must be given together")
        if "calls" in rec:
            _text(rec["calls_provenance"], f"{where}.calls_provenance")
            preds[pid]["dispatches"] = parse_calls(rec["calls"], f"{where}.calls")
            # Roles must be the calls' agents; as a multiset, because list order is not runtime order.
            if sorted(d["agent"] for d in preds[pid]["dispatches"]) != sorted(preds[pid]["roles"]):
                raise RoutingEvalError(f"{where}: roles do not match the agents in calls")
    missing = sorted(set(case_ids) - set(preds))
    if missing:
        raise RoutingEvalError(f"predictions: missing case ids {missing}")
    return preds


def _in_order(needed, actual):
    rest = iter(actual)
    return all(item in rest for item in needed)


def _call_order(needed, dispatches):
    """First unmet precedence between consecutive required roles, from chain/dependency ancestry only.

    Returns None when every dispatch of the later role has an earlier-role ancestor in its call,
    else ("role_order", ...) when ancestry proves the reverse, else ("order_unobserved", ...).
    """
    for earlier, later in zip(needed, needed[1:]):
        first = {i for i, d in enumerate(dispatches) if d["agent"] == earlier}
        second = [i for i, d in enumerate(dispatches) if d["agent"] == later]
        if all(first & dispatches[j]["before"] for j in second):
            continue
        if any(j in dispatches[i]["before"] for i in first for j in second):
            return ("role_order", f"{later} is a prerequisite of {earlier}; required order {needed}")
        return ("order_unobserved", f"recorded calls do not establish {earlier} completing before {later} "
                "(only chain order or dependsOn does; parallel entries, array position and separate calls do not)")
    return None


def evaluate(fixture, predictions):
    results, counts, critical_total = [], dict.fromkeys(VIOLATION_KINDS, 0), 0
    for case in fixture["cases"]:
        exp, pred = case["expect"], predictions[case["id"]]
        found = []
        if pred["route"] not in exp["routes"]:
            found.append(("route", f"route {pred['route']} not in {exp['routes']}"))
        missing = [r for r in exp["roles_required"] if r not in pred["roles"]]
        if missing:
            found.append(("role_missing", f"missing roles {missing}"))
        elif pred["dispatches"] is None:
            if not _in_order(exp["roles_required"], pred["roles"]):  # legacy role-only prediction: list order
                found.append(("role_order", f"roles out of order, required {exp['roles_required']}"))
        else:
            unmet = _call_order(exp["roles_required"], pred["dispatches"])
            if unmet:
                found.append(unmet)
        extra = [r for r in pred["roles"] if r not in exp["roles_allowed"]]
        if extra:
            found.append(("role_unexpected", f"roles not allowed {extra}"))
        missing_skills = [s for s in exp["skills_required"] if s not in pred["skills"]]
        if missing_skills:
            found.append(("skill_missing", f"missing skills {missing_skills}"))
        forbidden = [s for s in exp["skills_forbidden"] if any(_covers(s, p) for p in pred["skills"])]
        if forbidden:
            found.append(("skill_forbidden", f"forbidden skills selected {forbidden}"))
        for role, accepted in exp.get("model_tiers", {}).items():
            if pred["dispatches"] is None:
                found.append(("tier_unobserved", f"no recorded native calls to observe modelTier for {role}"))
                continue
            for d in (d for d in pred["dispatches"] if d["agent"] == role):
                tier = d["tier"] or "omitted"
                if tier not in accepted:
                    kind = "tier_omitted" if tier == "omitted" else "tier_wrong"
                    found.append((kind, f"{role} dispatched with modelTier {tier}, expected one of {accepted}"))
                    break
        # Critical: any miss in a critical case, or any forbidden skill (always critical).
        critical = bool(found) and (case["critical"] or any(k == "skill_forbidden" for k, _ in found))
        for kind, _ in found:
            counts[kind] += 1
        critical_total += 1 if critical else 0
        results.append({"id": case["id"], "matched": not found, "critical_failure": critical,
                        "details": [detail for _, detail in found]})
    total = len(results)
    matched = sum(1 for r in results if r["matched"])
    cases = fixture["cases"]
    return {
        "total": total, "matched": matched, "mismatched": total - matched, "accuracy": matched / total,
        "positive": sum(1 for c in cases if c["kind"] == "positive"),
        "near_miss": sum(1 for c in cases if c["kind"] == "near_miss"),
        "critical_cases": sum(1 for c in cases if c["critical"]),
        "tier_cases": sum(1 for c in cases if "model_tiers" in c["expect"]),
        "tier_observed": sum(1 for c in cases if "model_tiers" in c["expect"] and predictions[c["id"]]["dispatches"] is not None),
        "violations": counts, "critical_failures": critical_total,
        "mismatches": [r for r in results if not r["matched"]],
        "ok": matched == total and critical_total == 0,
    }


def format_report(rep, provenance):
    lines = [
        f"provenance: {provenance}",
        f"cases: {rep['total']} (positive {rep['positive']}, near_miss {rep['near_miss']}, critical {rep['critical_cases']})",
        f"matched: {rep['matched']}/{rep['total']} accuracy: {rep['accuracy']:.4f}",
        "violations: " + " ".join(f"{k}={v}" for k, v in rep["violations"].items()),
        f"critical_failures: {rep['critical_failures']}",
        f"tier_cases: {rep['tier_cases']} (with calls provided: {rep['tier_observed']})",
    ]
    for m in rep["mismatches"]:
        tag = " [CRITICAL]" if m["critical_failure"] else ""
        lines.append(f"MISMATCH {m['id']}{tag}: " + "; ".join(m["details"]))
    lines.append("RESULT: " + ("PASS" if rep["ok"] else "FAIL"))
    return "\n".join(lines)


def _self_check_predictions(fixture):
    preds = {}
    for c in fixture["cases"]:
        exp = c["expect"]
        calls = None
        if "model_tiers" in exp:  # synthetic call mirroring the expectation; a chain when order matters
            steps = []
            for r in exp["roles_required"]:
                step = {"agent": r, "task": "synthetic self-check"}
                tier = exp["model_tiers"].get(r, ["omitted"])[0]
                if tier != "omitted":
                    step["modelTier"] = tier
                steps.append(step)
            calls = parse_calls([{"chain": steps} if len(steps) > 1 else steps[0]], "self-check")
        preds[c["id"]] = {"route": exp["routes"][0], "roles": list(exp["roles_required"]),
                          "skills": list(exp["skills_required"]), "dispatches": calls}
    return preds


def main(argv=None):
    parser = argparse.ArgumentParser(description="Score recorded routing predictions against the routing fixture (offline).")
    parser.add_argument("--cases", required=True, type=Path, help="routing fixture JSON")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--predictions", type=Path, help="JSONL: one prediction object per case id")
    source.add_argument("--self-check", action="store_true", help="mirror the fixture expectations (consistency only)")
    args = parser.parse_args(argv)
    try:
        fixture = parse_fixture(args.cases.read_text(encoding="utf-8"))
        if args.self_check:
            preds = _self_check_predictions(fixture)
            provenance = ("self-check: fixture expectations mirrored as predictions; fixture consistency only, "
                          "NOT measured model accuracy; tier checks use synthetic calls")
        else:
            raw = args.predictions.read_bytes()
            text = raw.decode("utf-8")
            preds = parse_predictions(text, {c["id"] for c in fixture["cases"]})
            digest = hashlib.sha256(raw).hexdigest()
            provenance = (f"recorded predictions {args.predictions} sha256={digest}; scores provided labels only, "
                          "does NOT prove runtime skill activation; tier checks read recorded native call arguments as "
                          "provided and do not verify the capture")
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    report = evaluate(fixture, preds)
    print(format_report(report, provenance))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
