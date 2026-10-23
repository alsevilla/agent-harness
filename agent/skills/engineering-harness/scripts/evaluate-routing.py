#!/usr/bin/env python3
"""Offline routing-fixture evaluator (stdlib only; no model, network or provider calls).

Scores explicitly provided routing predictions (JSONL, one object per case) against
examples/routing-cases.json. Passing provided predictions does NOT prove runtime skill
activation; --self-check only proves fixture/evaluator consistency. A prediction may carry
`calls`: the recorded argument objects of native `subagent` calls; cases with
`expect.model_tiers` score the modelTier of every dispatched entry from those calls, and cases with
`expect.max_dispatches` count the recorded dispatches per role (absent calls = unobserved, never a pass).
An optional `read_observations` object feeds NON-SCORING read diagnostics (see read_diagnostics): observed
reads only, never skill activation or use.
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
EXPECT_OPTIONAL = frozenset({"model_tiers", "max_dispatches", "required_reads"})
PRED_KEYS = frozenset({"id", "route", "roles", "skills"})
PRED_OPTIONAL = frozenset({"calls", "calls_provenance", "read_observations"})
READ_KEYS = frozenset({"provenance", "complete", "events"})
EVENT_KEYS = frozenset({"path", "status"})
# full: a successful read of the whole file; partial: offset/limit read; truncated: output cut by a limit;
# failed: attempted but errored; injected / retained: context supplied or kept, not a read call.
READ_STATUSES = ("full", "partial", "truncated", "failed", "injected", "retained")
# Native `subagent` tool contract; tests compare these with agent/extensions/subagent/index.ts and dag.ts.
TIERS = frozenset({"economy", "capable"})
TIER_CHOICES = frozenset({"economy", "capable", "omitted"})  # omitted: modelTier absent, role default runs
SLOTS = frozenset({"fallback"})  # optional per-entry modelSlot; requires an explicit modelTier
NATIVE_ENTRY_KEYS = frozenset({"agent", "task", "cwd", "readOnly", "modelTier", "modelSlot", "prBase"})
NATIVE_DAG_KEYS = NATIVE_ENTRY_KEYS | {"id", "dependsOn"}
NATIVE_ROOT_KEYS = frozenset({"background", "modelTier", "modelSlot", "agent", "task", "tasks", "chain", "agentScope", "dag",
                              "readOnly", "confirmProjectAgents", "cwd", "prBase", "cleanup"})
NATIVE_CLEANUP_KEYS = frozenset({"checkout", "branch", "base", "pr", "headSha", "mergeCommit", "quiescent"})  # CLEANUP schema / CLEANUP_REQUEST_KEYS
NATIVE_CLEANUP_ROLE = "release-engineer"  # the only role whose single-mode launch accepts `cleanup` (LEASE_ROLE)
NATIVE_SHA = re.compile(r"[0-9a-f]{40}")  # BARE_SHA, used with fullmatch
BATCH_MODES = ("tasks", "chain", "dag")
NATIVE_MAX_TASKS = 8  # MAX_PARALLEL_TASKS in index.ts; the native chain schema has no item limit
NATIVE_MAX_DAG_NODES = 8  # DAG_NODE_LIMIT in dag.ts and the dag schema maxItems
NATIVE_DAG_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,31}")  # dag.ts NODE_ID, used with fullmatch
NATIVE_SCOPES = frozenset({"user", "project", "both"})
# Used with fullmatch: a `$` anchor would accept a trailing newline.
ID_RE = re.compile(r"R[0-9]{2,3}")
SKILL_RE = re.compile(r"[a-z0-9][a-z0-9/-]*")
VIOLATION_KINDS = ("route", "role_missing", "role_order", "role_unexpected", "skill_missing", "skill_forbidden",
                   "order_unobserved", "tier_unobserved", "tier_omitted", "tier_wrong", "dispatch_unobserved", "dispatch_over")


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
        if "max_dispatches" in exp:
            limits = exp["max_dispatches"]
            if not isinstance(limits, dict) or not limits:
                raise RoutingEvalError(f"{cid}.max_dispatches: expected non-empty object")
            for role, limit in limits.items():
                if role not in allowed:
                    raise RoutingEvalError(f"{cid}.max_dispatches: {role!r} must be in roles_allowed")
                if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
                    raise RoutingEvalError(f"{cid}.max_dispatches.{role}: expected an integer >= 1, got {limit!r}")
        if "required_reads" in exp:
            paths = exp["required_reads"]
            if not _names(paths, f"{cid}.required_reads", unique=True):
                raise RoutingEvalError(f"{cid}.required_reads: must be non-empty")
            for path in paths:
                _text(path, f"{cid}.required_reads")
    return data


def _tier(value, where):
    # Type before membership: an unhashable JSON container must be an input error, not a TypeError.
    # null is refused by the runtime before launch, so it is never a dispatch observation either.
    if not isinstance(value, str) or value not in TIERS:
        raise RoutingEvalError(f"{where}.modelTier: expected economy or capable when present, got {value!r}")
    return value


def _slot(entry, where):
    """modelSlot is only the string "fallback" and needs an explicit modelTier beside it (null is refused by the runtime)."""
    if "modelSlot" not in entry:
        return
    value = entry["modelSlot"]
    if not isinstance(value, str) or value not in SLOTS:
        raise RoutingEvalError(f"{where}.modelSlot: expected fallback when present, got {value!r}")
    if "modelTier" not in entry:
        raise RoutingEvalError(f"{where}.modelSlot: requires an explicit modelTier")


def _flag(value, where):
    if not isinstance(value, bool):
        raise RoutingEvalError(f"{where}: expected boolean, got {value!r}")
    return value


def _cleanup(call, at):
    """Shape of the root `cleanup` request as the runtime mints it (offline: no live PR, git or authorization claim is made)."""
    where = f"{at}.cleanup"
    value = _obj(call["cleanup"], NATIVE_CLEANUP_KEYS, where)
    for key in ("checkout", "branch", "base"):
        _text(value[key], f"{where}.{key}")
    pr = value["pr"]
    if isinstance(pr, bool) or not isinstance(pr, int) or not 1 <= pr <= 999999999:
        raise RoutingEvalError(f"{where}.pr: expected a positive integer PR number")
    for key in ("headSha", "mergeCommit"):
        if not isinstance(value[key], str) or not NATIVE_SHA.fullmatch(value[key]):
            raise RoutingEvalError(f"{where}.{key}: expected a 40-hex lowercase commit id")
    if value["quiescent"] is not True:
        raise RoutingEvalError(f"{where}.quiescent: main must declare the checkout quiescent (true)")
    if call.get("agent") != NATIVE_CLEANUP_ROLE:
        raise RoutingEvalError(f"{at}.cleanup: only a single-mode launch of {NATIVE_CLEANUP_ROLE} accepts it")
    if "cwd" not in call or "prBase" in call or call.get("readOnly") is True:
        raise RoutingEvalError(f"{at}.cleanup: needs cwd (the primary checkout), no prBase and not readOnly")


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
    _slot(entry, where)
    if "prBase" in entry:
        _text(entry["prBase"], f"{where}.prBase")  # shape only; branch syntax and live-branch checks stay runtime (checkPrBase)
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
    # Top-level empty list = complete observation of zero dispatches; nested batch lists stay non-empty.
    if not isinstance(value, list):
        raise RoutingEvalError(f"{where}: expected list of call objects")
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
            for key in ("modelTier", "modelSlot", "agent", "task", "prBase", "cleanup"):
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
            _slot(call, at)
            if "prBase" in call:
                _text(call["prBase"], f"{at}.prBase")
            if "cleanup" in call:
                _cleanup(call, at)
            dispatches.append({"agent": _choice(call["agent"], ROLES, f"{at}.agent"), "tier": tier, "before": frozenset()})
        if call.get("agentScope") == "project" and any(d["tier"] is not None for d in dispatches[base:]):
            raise RoutingEvalError(f"{at}.agentScope: project scope cannot take an explicit modelTier; "
                                   "canonical package roles are not in project-only discovery")
    return dispatches


def parse_read_observations(value, where):
    """Validate one optional read-observation record (diagnostics only; nothing here is a claim of use).

    `complete` is the operator's statement that `events` lists every read attempt of the observed session
    scope; the evaluator cannot verify it. Paths are matched later by exact string equality.
    """
    obs = _obj(value, READ_KEYS, where)
    _text(obs["provenance"], f"{where}.provenance")
    _flag(obs["complete"], f"{where}.complete")
    if not isinstance(obs["events"], list):
        raise RoutingEvalError(f"{where}.events: expected list")
    events = []
    for i, raw in enumerate(obs["events"]):
        event = _obj(raw, EVENT_KEYS, f"{where}.events[{i}]")
        events.append({"path": _text(event["path"], f"{where}.events[{i}].path"),
                       "status": _choice(event["status"], READ_STATUSES, f"{where}.events[{i}].status")})
    return {"complete": obs["complete"], "events": events}


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
            "reads": parse_read_observations(rec["read_observations"], f"{where}.read_observations")
            if "read_observations" in rec else None,
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


def read_diagnostics(fixture, predictions):
    """Optional, NON-SCORING diagnostics over provided read observations; never part of accuracy, ok or critical.

    Only observed reads: a full read of a required path is not use or activation. A case with a required-path
    map is measured only when its observation is declared complete; a missing or incomplete observation is
    UNKNOWN, never zero. Injected and retained events are context, not reads, and never count as full reads.
    """
    statuses = dict.fromkeys(READ_STATUSES, 0)
    observed = mapped = measured = full = total = zero = 0
    unknown = []
    for case in fixture["cases"]:
        reads, required = predictions[case["id"]]["reads"], case["expect"].get("required_reads")
        if reads is not None:
            observed += 1
            for event in reads["events"]:
                statuses[event["status"]] += 1
        if required is None:
            continue
        mapped += 1
        if reads is None or not reads["complete"]:
            unknown.append(case["id"])
            continue
        got = sum(1 for path in required if any(e["path"] == path and e["status"] == "full" for e in reads["events"]))
        measured, full, total = measured + 1, full + got, total + len(required)
        zero += 1 if got == 0 else 0
    return {"observations": observed, "statuses": statuses, "mapped_cases": mapped, "measured_cases": measured,
            "unknown_cases": unknown, "required_full": full, "required_total": total,
            "recall": full / total if measured else None, "zero_observed_cases": zero,
            "zero_rate": zero / measured if measured else None}


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
        for role, limit in exp.get("max_dispatches", {}).items():
            if pred["dispatches"] is None:
                found.append(("dispatch_unobserved", f"no recorded native calls to count dispatches of {role}"))
                continue
            made = sum(1 for d in pred["dispatches"] if d["agent"] == role)
            if made > limit:
                found.append(("dispatch_over", f"{role} dispatched {made} times in recorded calls, at most {limit} expected"))
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
        "dispatch_cases": sum(1 for c in cases if "max_dispatches" in c["expect"]),
        "dispatch_observed": sum(1 for c in cases if "max_dispatches" in c["expect"] and predictions[c["id"]]["dispatches"] is not None),
        "read_diagnostics": read_diagnostics(fixture, predictions),
        "violations": counts, "critical_failures": critical_total,
        "mismatches": [r for r in results if not r["matched"]],
        "ok": matched == total and critical_total == 0,
    }


def format_read_diagnostics(d):
    head = "read_diagnostics (non-scoring; observed reads only, NOT skill use or activation): "
    if not d["observations"] and not d["mapped_cases"]:
        return head + "none provided"
    pct = lambda value: "UNKNOWN" if value is None else f"{value:.4f}"
    return (head + f"observations={d['observations']} required_read_cases={d['mapped_cases']} measured={d['measured_cases']} "
            f"unknown={len(d['unknown_cases'])} required_full_read_recall={pct(d['recall'])} "
            f"({d['required_full']}/{d['required_total']}) zero_observed_read_rate={pct(d['zero_rate'])} "
            + " ".join(f"{k}={v}" for k, v in d["statuses"].items()))


def format_report(rep, provenance):
    lines = [
        f"provenance: {provenance}",
        f"cases: {rep['total']} (positive {rep['positive']}, near_miss {rep['near_miss']}, critical {rep['critical_cases']})",
        f"matched: {rep['matched']}/{rep['total']} accuracy: {rep['accuracy']:.4f}",
        "violations: " + " ".join(f"{k}={v}" for k, v in rep["violations"].items()),
        f"critical_failures: {rep['critical_failures']}",
        f"tier_cases: {rep['tier_cases']} (with calls provided: {rep['tier_observed']})",
        f"dispatch_cases: {rep['dispatch_cases']} (with calls provided: {rep['dispatch_observed']})",
        format_read_diagnostics(rep["read_diagnostics"]),
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
        if "model_tiers" in exp or "max_dispatches" in exp:  # synthetic call mirroring the expectation; a chain when order matters
            steps = []
            for r in exp["roles_required"]:
                step = {"agent": r, "task": "synthetic self-check"}
                tier = exp.get("model_tiers", {}).get(r, ["omitted"])[0]
                if tier != "omitted":
                    step["modelTier"] = tier
                steps.append(step)
            calls = parse_calls([{"chain": steps} if len(steps) > 1 else steps[0]], "self-check") if steps else []
        preds[c["id"]] = {"route": exp["routes"][0], "roles": list(exp["roles_required"]),
                          "skills": list(exp["skills_required"]), "dispatches": calls, "reads": None}
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
