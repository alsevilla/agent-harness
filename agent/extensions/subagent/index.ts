/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { BackgroundWorkers, formatUsageSummary, LogicalUsage, RpcWorker, type UsageScope } from "./background.ts";
import { WorkerMonitor } from "./monitor.ts";
import { acquireWorkspace, releaseWorkspace, WorkspaceAdmissionError, type WorkspaceAccess, type WorkspaceLease } from "./workspace-admission.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, packageRoot } from "./agents.ts";
import { attemptOf, identityOf, observeAssistant, observedId, type AttemptProvenance, type ObservedModel } from "./provenance.ts";
import { getFallbackSequence, nextFallbackModel, resolveModelTier, type ModelSlot, type ModelTier, type SelectedAgent } from "./model-routing.ts";
import { registerMainPolicy } from "./main-policy.ts";
import { assembleChildSystemPrompt, configureCodeIntegrations } from "./code-integrations.ts";
import { PRINTED_MARKUP_LABEL, extractFinalText, failureDiagnostics, incompleteLabel, isIncompleteStop, markupNotice, printedToolMarkup, retainedEntryBlock, withTerminalDiagnostics } from "./compact-handoff.ts";
import { appendParentReports, runDag, validateDag, type DagNodeSpec, type DagStatus } from "./dag.ts";
import { cargoEnvDefaults } from "./build-env.ts";
import { DECISION_RECORD_PREFIX, DECISION_RELAY_ENV, DECISION_TOOL, DecisionRelay } from "./decision-relay-state.ts";
import { guardRefusalReplayable, providerLaunchState, registerProviderCooldown, runProviderCooldownCommand } from "./provider-cooldown-entry.ts";
import { assertBatchDisplayable, authorizableOp, bindDelivery, type BoundState, canonicalCwd, claimChildGuard, createGrantStore, describeOp, GRANT_TTL_DEFAULT_MS, GRANT_TTL_MAX_MS, guardToolCall, LEASE_ROLE, MAX_DELIVERY_GRANTS, MAX_GRANT_OPS, parseRepoFromPushUrl, planPushRequest, authorizationStatus, pushBranchTarget, type ClaimWindow, type DeliveryBinding, type GuardOp, validateArtifactDir, verifyDeliveryTarget } from "./safety-core.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
// Sibling runtime files (pause-gate, decision-relay, provider-cooldown-entry) resolve from this extension, not the profile, so the installed package works.
const extensionDir = path.dirname(fileURLToPath(import.meta.url));
// In-memory exact single-use grants for main and child risky operations; never persisted or relayed.
const safetyGrants = createGrantStore();

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

// Tier and explicit-slot provenance carried on results; the slot key is absent for every ordinary run.
const tierFields = (agent: SelectedAgent | undefined) => ({ ...(agent?.modelTier !== undefined ? { modelTier: agent.modelTier } : {}), ...(agent?.modelSlot !== undefined ? { modelSlot: agent.modelSlot } : {}) });

interface SingleResult {
	workerId?: string;
	modelTier?: ModelTier;
	modelSlot?: ModelSlot; // present only when the run was explicitly started on the tier fallback
	nodeId?: string; // DAG mode: node identity, stable even when agents repeat
	dag?: { status: DagStatus; blockedBy?: string[]; started: boolean }; // DAG mode: node outcome
    toolActivity?: boolean;
	agent: string;
	agentSource: "user" | "project" | "package" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string; // effective route-provider/(responseModel ?? model) once a complete identity was reported (served is verified only by responseModel); otherwise the launch request (see modelSource)
	modelSource?: "observed" | "requested";
	requestedModel?: string; // this attempt's --model argument, never evidence of what ran
	observed?: ObservedModel[]; // distinct identities this attempt's assistant messages reported, in first-seen order
	attempts?: AttemptProvenance[]; // only after an availability fallback: every launched attempt, earliest first
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "dag";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	return extractFinalText(messages); // every text block of the last text-bearing assistant, not only the first
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || isIncompleteStop(result);
}

function getResultOutput(result: SingleResult): string {
	// INCOMPLETE keeps every text block of the final message plus its terminal diagnostics: the partial report is the evidence.
	if (isIncompleteStop(result)) return markupNotice(withTerminalDiagnostics(extractFinalText(result.messages), result), result) || "(no output)";
	if (isFailedResult(result)) {
		return [...failureDiagnostics(result).map((d, i) => (i === 0 ? d.value : `${d.label}: ${d.value}`)), getFinalOutput(result.messages)].filter(Boolean).join("\n\n") || "(no output)";
	}
	return markupNotice(getFinalOutput(result.messages), result) || "(no output)";
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	waitKey?: string; // DAG node ID: keys queued-claim accounting per job
    runtime?: BackgroundWorkers;
    jobId?: string;
    usageScope?: UsageScope; // launch-scope usage ledger captured at dispatch (background.ts); a job charges only this scope
	onSpawn?: () => void; // called at the physical spawn attempt only; DAG reports started from it
	monitor?: WorkerMonitor;
	contextWindowFor?: (model: string) => number | undefined;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

const WORKSPACE_WAITING = "Waiting for workspace";

// Admission boundary for every launch path (single, chain, parallel, background, future DAG): the claim is registered before any await and held across declared fallbacks.
async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: SelectedAgent[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	access: WorkspaceAccess = "write",
): Promise<SingleResult> {
	// One usage job per logical request, charged to the scope captured at dispatch; it settles exactly once here.
	const logical = dispatchDefaults.usageScope ? new LogicalUsage(dispatchDefaults.usageScope, Boolean(dispatchDefaults.jobId)) : undefined;
	try {
		const result = await runSingleAgentJob(defaultCwd, dispatchDefaults, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, access, logical);
		logical?.settle(result.stopReason === "aborted" ? "aborted" : isFailedResult(result) ? "failed" : "completed");
		return result;
	} catch (error) {
		logical?.settle(signal?.aborted ? "aborted" : "failed");
		throw error;
	}
}

async function runSingleAgentJob(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: SelectedAgent[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	access: WorkspaceAccess,
	logical: LogicalUsage | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	// One claim window per logical job: fallback attempts of this job share it, so only the first actual spawn may claim grants.
	const grantWindow: ClaimWindow = { open: true };
	if (!agent) return runAgentAttempt(defaultCwd, dispatchDefaults, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, undefined, grantWindow, undefined, undefined, logical);
	const { jobId, runtime } = dispatchDefaults;
	// One claim key per workspace request: parallel entries without a node ID must not clear each other's waiting state.
	const claim = dispatchDefaults.waitKey ?? randomUUID();
	const setWaiting = (waiting?: string) => { if (jobId) runtime?.setWaiting(jobId, waiting, claim); };
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	let lease: WorkspaceLease;
	try {
		lease = await acquireWorkspace(cwd ?? defaultCwd, {
			access,
			signal,
			onQueued: () => {
				setWaiting(WORKSPACE_WAITING);
				if (!jobId) onUpdate?.({ content: [{ type: "text", text: WORKSPACE_WAITING }], details: makeDetails([{ agent: agentName, agentSource: agent.source, task, exitCode: -1, messages: [], stderr: "", usage, step, ...tierFields(agent) }]) });
			},
		});
	} catch (error) {
		setWaiting(undefined);
		if (signal?.aborted) throw new Error("Subagent was aborted");
		if (error instanceof WorkspaceAdmissionError) return { agent: agentName, agentSource: agent.source, task, exitCode: 1, messages: [], stderr: error.message, usage, step, stopReason: "error", errorMessage: error.message, ...tierFields(agent) };
		throw error;
	}
	setWaiting(undefined);
	try {
		return await runAgentAttempt(defaultCwd, dispatchDefaults, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, lease, grantWindow, undefined, undefined, logical);
	} finally {
		releaseWorkspace(lease);
	}
}

// One launch attempt under an already-held workspace lease; fallback attempts reuse that lease.
async function runAgentAttempt(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: SelectedAgent[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	lease: WorkspaceLease | undefined,
	grantWindow: ClaimWindow,
	attemptModel?: string,
	fallbackModels?: string[],
	logical?: LogicalUsage,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// Canonical package roles must carry roles.json model and tools; a gap never inherits the session model or the host's full tool set.
	if (agent.source === "package" && (!agent.model || !agent.tools?.length)) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Package role "${agentName}" has no model or tools in roles.json; refusing to launch with inherited settings.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--offline"];
	const inheritsDispatchConfig = !agent.model;
	const model = attemptModel ?? agent.model ?? dispatchDefaults.model;
	const workerController = new AbortController();
    const parentSignal = signal;
    const parentAbort = () => workerController.abort();
    parentSignal?.addEventListener("abort", parentAbort, {once: true});
    if (parentSignal?.aborted) workerController.abort();
    if (dispatchDefaults.jobId) signal = workerController.signal;
    let release: (() => void) | undefined;
    try {
        const { runtime, jobId } = dispatchDefaults;
        if (runtime) {
            // A job paused after its grant hands the slot back and waits, so unrelated jobs keep the capacity.
            for (;;) {
                if (jobId) await runtime.waitRunnable(jobId, signal);
                release = await runtime.acquire(MAX_CONCURRENCY, signal);
                if (!jobId || !runtime.jobs.get(jobId)?.paused) break;
                release(); release = undefined;
            }
        }
    }
    catch (error) { release?.(); parentSignal?.removeEventListener("abort", parentAbort); throw error; }
    // Declared provider check before any spawn: cooling, blocked, unavailable or probe-busy never launches a child.
    if (model) {
        const launch = await providerLaunchState(model);
        if (signal?.aborted) { release?.(); parentSignal?.removeEventListener("abort", parentAbort); throw new Error("Subagent was aborted"); } // an abort during the check spawns nothing and starts no fallback
        if (launch.state !== "launch") {
            release?.(); parentSignal?.removeEventListener("abort", parentAbort);
            const remaining = fallbackModels ?? getFallbackSequence(model, agent.fallbackModel);
            if (launch.replayable && remaining.length) {
                const fallback = await runAgentAttempt(defaultCwd, dispatchDefaults, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, lease, grantWindow, remaining[0], remaining.slice(1), logical);
                fallback.stderr = `Model ${model} skipped (provider cooldown ${launch.state}); retried with ${remaining[0]}.\n${fallback.stderr}`;
                return fallback;
            }
            return { agent: agentName, agentSource: agent.source, task, exitCode: 1, messages: [], stderr: `Model ${model} not launched: provider cooldown ${launch.state}.`, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, model, modelSource: "requested", requestedModel: model, observed: [], step, stopReason: "error", errorMessage: `provider cooldown ${launch.state}`, attempts: [], ...tierFields(agent) }; // attempts: [] = no child launched, so a caller's `?? [attemptOf(..)]` cannot invent one
        }
    }
    const worker = dispatchDefaults.monitor?.store.begin(agentName, task, model ?? "inherited", (inheritsDispatchConfig ? dispatchDefaults.thinkingLevel : undefined) ?? agent.thinking ?? "provider default", model ? dispatchDefaults.contextWindowFor?.(model) : undefined, agent.modelTier, agent.modelSlot);
    if (worker && dispatchDefaults.jobId) dispatchDefaults.runtime?.note(dispatchDefaults.jobId, worker.id, dispatchDefaults.waitKey);
    let codeIntegrationsEnabled = false;
    try {
	if (model) args.push("--model", model);
	if (model?.startsWith("anthropic/")) {
		const guardPath = path.join(getAgentDir(), "npm", "node_modules", "pi-claude-subscription-connector", "extensions", "subscription-guard.ts");
		if (!fs.existsSync(guardPath)) throw new Error("Claude subscription guard missing. Install npm:pi-claude-subscription-connector before launching an Anthropic subagent.");
		args.push("--extension", guardPath);
	}
	args.push("--extension", path.join(extensionDir, "provider-cooldown-entry.ts")); // child guard, explicit despite --no-extensions
	if (agent.thinking) args.push("--thinking", agent.thinking);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	codeIntegrationsEnabled = configureCodeIntegrations(args, agent, dispatchDefaults.jobId ? [DECISION_TOOL] : []);

    } catch (error) {
        if (worker) dispatchDefaults.monitor?.store.finish(worker.id, "failed", String(error));
        release?.(); parentSignal?.removeEventListener("abort", parentAbort);
        throw error;
    }

	let controlDir: string | undefined;
    let controlPath: string | undefined;
	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;


    const currentResult: SingleResult = {
        workerId: worker?.id,
		...tierFields(agent),
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		modelSource: "requested",
		...(model !== undefined ? { requestedModel: model } : {}),
		observed: [],
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, assembleChildSystemPrompt(agent, { codeIntegrationsEnabled, cwd: cwd ?? defaultCwd, packageRoot: packageRoot(), launchArgs: args }));
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		if (dispatchDefaults.jobId) {
            controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worker-control-"));
            controlPath = path.join(controlDir, "control.json");
            fs.writeFileSync(controlPath, "0");
            args.push("--extension", path.join(extensionDir, "pause-gate.ts"));
            args.push("--extension", path.join(extensionDir, "decision-relay.ts"));
        }
		if (signal?.aborted) throw new Error("Subagent was aborted"); // an abort during the prompt-file write spawns nothing
		// Guard entry is always injected after pause-gate/relay; a missing guard file throws (fail closed). Grants are claimed only by the job's first actual spawn (grantWindow).
		const guard = claimChildGuard(safetyGrants, agentName, canonicalCwd(cwd ?? defaultCwd), path.join(extensionDir, "safety-guard-entry.ts"), grantWindow, agent?.source === "user" || agent?.source === "package");
		args.push("--extension", guard.entry);
		let wasAborted = false;

		let removeAbort = () => {};
        const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			logical?.attempt();
			dispatchDefaults.onSpawn?.();
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
                env: guard.childEnv({...process.env, ...cargoEnvDefaults(cwd ?? defaultCwd), PI_SUBAGENT_CONTROL_FILE: controlPath ?? "", [DECISION_RELAY_ENV]: dispatchDefaults.jobId ? "1" : ""}),
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const client = new RpcWorker(proc, controlPath);
            proc.on("spawn", () => {
                if (worker) dispatchDefaults.monitor?.store.started(worker.id);
                if (client) {
                    void client.send("prompt", "Task: " + task).catch(error => {
                        if (client.closed && currentResult.messages.length) return;
                        currentResult.stopReason = "error"; currentResult.errorMessage = error.message;
                        proc.stdin?.end();
                    });
                    if (worker && dispatchDefaults.jobId) dispatchDefaults.runtime?.attach(dispatchDefaults.jobId, worker.id, client, workerController);
                }
            });
            let buffer = "";
            // One decoder per stream per spawn: a pipe chunk may end inside a multi-byte codepoint.
            const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				client?.event(event);
                const relayed = Boolean(client && worker && dispatchDefaults.jobId && event.type === "extension_ui_request");
                if (relayed && event.method === "notify" && typeof event.message === "string" && event.message.startsWith(DECISION_RECORD_PREFIX)) dispatchDefaults.runtime?.announceDecision(dispatchDefaults.jobId!, worker!.id, cwd ?? defaultCwd, event.message);
                // Only the exact dialog of an announced request is held; every other dialog keeps the auto-cancel below.
                const held = relayed && dispatchDefaults.runtime?.holdDecisionDialog(dispatchDefaults.jobId!, worker!.id, event);
                if (client && !held && event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
                    // Detached workers cannot leave an unanswered dialog hanging.
                    proc.stdin?.write(JSON.stringify({type: "extension_ui_response", id: event.id, cancelled: true}) + "\n");
                    currentResult.stderr += `Worker dialog canceled: ${event.method} ${event.title ?? ""}\n`;
                }
                if (event.type === "tool_execution_start") currentResult.toolActivity = true;
                if (event.type === "agent_settled" && client) { client.close(); proc.stdin?.end(); if (worker) dispatchDefaults.runtime?.detach(worker.id); }
                if (worker) dispatchDefaults.monitor?.store.event(worker.id, event);
                if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						logical?.turn(msg.usage);
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						observeAssistant(currentResult.observed!, msg);
						const reported = observedId(identityOf(msg)); // complete provider/model only; a partial report never replaces the request
						if (reported) { currentResult.model = reported; currentResult.modelSource = "observed"; }
						currentResult.stopReason = msg.stopReason; // the latest assistant decides; a missing reason must clear an earlier stop
						currentResult.errorMessage = msg.errorMessage; // latest assistant decides, like stopReason
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += stdoutDecoder.write(data);
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += stderrDecoder.write(data);
			});

			proc.on("close", (code) => {
				buffer += stdoutDecoder.end(); currentResult.stderr += stderrDecoder.end(); // flush a truncated trailing sequence before the trailing parse
				if (buffer.trim()) processLine(buffer);
				client?.close(); if (worker) dispatchDefaults.runtime?.detach(worker.id);
                resolve(code ?? 1);
			});

			proc.on("error", (error) => {
                currentResult.stderr += error.message;
                client?.close(error.message); if (worker) dispatchDefaults.runtime?.detach(worker.id);
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					const forceKill = setTimeout(() => {
						if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
					}, 5000);
                    forceKill.unref(); proc.once("close", () => clearTimeout(forceKill));
				};
				if (signal.aborted) killProc();
				else { signal.addEventListener("abort", killProc, { once: true }); removeAbort = () => signal?.removeEventListener("abort", killProc); }
			}
		});

		removeAbort(); release?.(); release = undefined;
        currentResult.exitCode = exitCode;
        if (worker) dispatchDefaults.monitor?.store.finish(worker.id, wasAborted ? "aborted" : isFailedResult(currentResult) ? "failed" : "completed", wasAborted ? "Subagent was aborted" : isFailedResult(currentResult) ? getResultOutput(currentResult) : undefined);
        if (wasAborted && dispatchDefaults.jobId) { currentResult.stopReason = "aborted"; currentResult.errorMessage = "Subagent was stopped"; return currentResult; }
		if (wasAborted) throw new Error("Subagent was aborted");
		const remainingFallbacks = fallbackModels ?? getFallbackSequence(model, agent.fallbackModel);
		const retryResult = {
			...currentResult,
			output: getFinalOutput(currentResult.messages),
			toolActivity: currentResult.toolActivity || currentResult.messages.some(
				(message) => message.role === "toolResult" || (message.role === "assistant" && message.content.some((part) => part.type === "toolCall")),
			),
		};
		// A child guard refusal replays only when this parent's own store still says replayable (no health is read from text).
		const guardRefused = !wasAborted && !retryResult.toolActivity && retryResult.stopReason === "error" && model !== undefined && await guardRefusalReplayable(model, retryResult.errorMessage);
		const nextModel = guardRefused ? remainingFallbacks[0] : nextFallbackModel(retryResult, remainingFallbacks, wasAborted);
		if (nextModel) {
			const primaryError = getResultOutput(currentResult);
            const updates = worker ? dispatchDefaults.runtime?.steeringFor(worker.id) ?? [] : [];
			const fallbackResult = await runAgentAttempt(
				defaultCwd,
				dispatchDefaults,
				agents,
				agentName,
				updates.length ? task + "\n\nAcknowledged updates from the orchestrator (latest instructions apply):\n" + updates.join("\n") : task,
				cwd,
				step,
				signal,
				onUpdate,
				makeDetails,
				lease,
				grantWindow,
				nextModel,
				remainingFallbacks.slice(1),
				logical,
			);
			fallbackResult.attempts = [attemptOf(currentResult), ...(fallbackResult.attempts ?? [attemptOf(fallbackResult)])];
			fallbackResult.stderr = `Model ${model ?? "(inherited)"} failed; retried with ${nextModel}. ${primaryError}\n${fallbackResult.stderr}`;
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
				fallbackResult.usage[key] += currentResult.usage[key];
			}
			return fallbackResult;
		}
		return currentResult;
    } catch (error) {
        if (worker) dispatchDefaults.monitor?.store.finish(worker.id, signal?.aborted ? "aborted" : "failed", String(error));
        throw error;
    } finally {
        release?.(); parentSignal?.removeEventListener("abort", parentAbort);
        if (controlDir) { for (const file of ["control.json", "control.json.next"]) try { fs.unlinkSync(path.join(controlDir, file)); } catch {} try { fs.rmdirSync(controlDir); } catch {} }
        if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

// Null is listed (like modelTier) so the SDK keeps it for runtime refusal instead of dropping it into the ordinary primary run.
const MODEL_SLOT = Type.Union([Type.Literal("fallback"), Type.Null()]);

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	readOnly: Type.Optional(Type.Boolean({ description: "Trusted declaration: this task only reads its checkout (default write). Not an OS sandbox." })),
	modelTier: Type.Optional(Type.Union([Type.Literal("economy"), Type.Literal("capable"), Type.Null()])),
	modelSlot: Type.Optional(MODEL_SLOT),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	readOnly: Type.Optional(Type.Boolean({ description: "Trusted declaration: this step only reads its checkout (default write). Not an OS sandbox." })),
	modelTier: Type.Optional(Type.Union([Type.Literal("economy"), Type.Literal("capable"), Type.Null()])),
	modelSlot: Type.Optional(MODEL_SLOT),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const DagNode = Type.Object({
	id: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$", description: "Unique node ID: a letter first, then letters, digits, _ or -; max 32" }),
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task for this node; direct parent reports are appended after it" }),
	// Null is listed so the SDK keeps it for runtime refusal (its optional-null normalization would otherwise drop it); runtime treats null as invalid.
	cwd: Type.Optional(Type.Union([Type.String({ description: "Working directory for this node" }), Type.Null()])),
	dependsOn: Type.Optional(Type.Union([Type.Array(Type.String(), { description: "IDs of direct parent nodes" }), Type.Null()])),
	readOnly: Type.Optional(Type.Union([Type.Boolean({ description: "Trusted declaration: this node only reads its checkout (default write). Not an OS sandbox." }), Type.Null()])),
	modelTier: Type.Optional(Type.Union([Type.Literal("economy"), Type.Literal("capable"), Type.Null()])),
	modelSlot: Type.Optional(MODEL_SLOT),
}, { additionalProperties: false });

const SubagentParams = Type.Object({
    background: Type.Optional(Type.Boolean({description: "Default true: return a job ID immediately; completion arrives automatically. Set false to explicitly wait for the entire task.", default: true})),
	modelTier: Type.Optional(Type.Union([Type.Literal("economy"), Type.Literal("capable"), Type.Null()], { description: "Optional Pi model tier for a single task; select per entry in batch modes." })),
	modelSlot: Type.Optional(Type.Union([Type.Literal("fallback"), Type.Null()], { description: "Optional explicit Pi fallback start for a single task; requires modelTier. Select per entry in batch modes." })),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	dag: Type.Optional(Type.Array(DagNode, { minItems: 1, maxItems: 8, description: "DAG mode: up to 8 nodes with dependsOn edges; each node runs as its own agent" })),
	readOnly: Type.Optional(Type.Boolean({ description: "Trusted declaration for single mode: the task only reads its checkout (default write). Not an OS sandbox." })),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

// Root keys come from the schema itself: dag mode refuses any other top-level key before launch.
const SUBAGENT_ROOT_KEYS = new Set(Object.keys(SubagentParams.properties ?? {})); // no schema properties: empty set, dag mode fails closed

// Bare aliases for harness skills; they forward to the native /skill:NAME command so skill loading is unchanged.
const SKILL_ALIASES = ["engineering-harness", "agent-creation"];

function registerSkillAliases(pi: ExtensionAPI) {
	const collided = new Set<string>();
	for (const name of SKILL_ALIASES) {
		pi.registerCommand(name, {
			description: `Run /skill:${name}`,
			handler: async (args, ctx) => {
				if (collided.has(name)) {
					ctx.ui?.notify?.(`/${name} is unavailable; use /skill:${name}.`, "error");
					return;
				}
				const text = args.trim();
				const message = text ? `/skill:${name} ${text}` : `/skill:${name}`;
				// expandPromptTemplates is required: without it the literal "/skill:..." text reaches the model unexpanded.
				if (ctx.isIdle?.() === false) {
					pi.sendUserMessage(message, { expandPromptTemplates: true, deliverAs: "followUp" });
					ctx.ui?.notify?.(`${name} queued as follow-up.`, "info");
					return;
				}
				pi.sendUserMessage(message, { expandPromptTemplates: true });
			},
		});
	}
	// Pi suffixes duplicate command names instead of overwriting, so a bare name not uniquely ours is a collision.
	pi.on("session_start", (_event, ctx) => {
		collided.clear();
		const commands = pi.getCommands();
		for (const name of SKILL_ALIASES) {
			const hits = commands.filter((c) => c.name === name);
			if (hits.length === 1 && hits[0].source === "extension") continue;
			collided.add(name);
			ctx.ui?.notify?.(`/${name} collides with another command; use /skill:${name}.`, "warning");
		}
	});
}

// One TUI confirmation per new binding; a live binding already approved this session is reused without a dialog. Revalidates repo and URL before and after the dialog.
async function authorizePushBranch(params: { role?: string; ttl_minutes?: number; push_branch: { branch: string; cwd?: string; commits?: boolean; artifact_dir?: string } }, ctx: { cwd: string; ui: { confirm(title: string, message: string, options?: { timeout?: number }): Promise<boolean> } }) {
	const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
	const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
	if (params.role !== undefined && params.role !== LEASE_ROLE) return fail(`push_branch is only for role ${LEASE_ROLE}; no lease minted.`);
	if (params.ttl_minutes !== undefined) return fail("push_branch leases are session-only and take no ttl; no lease minted.");
	const { commits, artifact_dir: artifactInput } = params.push_branch;
	if (commits !== undefined && typeof commits !== "boolean") return fail("push_branch.commits must be true or false; no lease minted.");
	if (artifactInput !== undefined && commits !== true) return fail("push_branch.artifact_dir needs commits: true; no lease minted.");
	let target: ReturnType<typeof pushBranchTarget>;
	try {
		target = pushBranchTarget(path.resolve(ctx.cwd, params.push_branch.cwd ?? "."), params.push_branch.branch);
	} catch (error) {
		return fail(`${(error as Error).message}; no lease minted.`);
	}
	if (!target) return fail("not a verified git repository with exactly one origin push URL; no lease minted.");
	let artifactDir: string | undefined;
	try {
		artifactDir = artifactInput === undefined ? undefined : validateArtifactDir(artifactInput, target.candidate);
	} catch (error) {
		return fail(`${(error as Error).message}; no lease minted.`);
	}
	const request = { commits: commits === true, artifactDir };
	const plan = planPushRequest(safetyGrants, target, request);
	const kind = request.commits ? "push and commit" : "push";
	// Repeats are covered and open no dialog.
	if (plan.action === "covered") return ok(`Already authorized this session: ${LEASE_ROLE} may ${kind} ${target.branch} to the approved origin of ${target.candidate}.`);
	const scope = request.commits ? `normal push and normal commits on this branch (git commit -m, or -F ${artifactDir ?? "no artifact directory"}; no amend, signing, hooks, pathspec or other commit options)` : "normal push of this branch";
	const text = `Role: ${LEASE_ROLE}\nCandidate: ${target.candidate}\nBranch: ${target.branch}\nPush URL: ${target.pushUrl}\nScope: this session only; ${scope} (no tags, force, delete, mirror or other refs). /revoke-authorization or session end withdraws it.`;
	const title = request.commits ? "Authorize release-engineer branch pushes and commits?" : "Authorize release-engineer branch pushes?";
	const approved = await ctx.ui.confirm(title, text, { timeout: 120_000 });
	if (!approved) return fail("Not authorized by the operator; no lease minted.");
	let again: ReturnType<typeof pushBranchTarget>;
	try {
		again = pushBranchTarget(target.candidate, target.branch);
	} catch {
		again = undefined;
	}
	if (!again || again.candidate !== target.candidate || again.pushUrl !== target.pushUrl) return fail("repository binding changed during approval; no lease minted.");
	try {
		safetyGrants.mintLease({ ...again, commits: request.commits, artifactDir });
	} catch (error) {
		return fail(`${(error as Error).message}; no lease minted.`);
	}
	return ok(`Authorized ${LEASE_ROLE} to ${kind} ${target.branch} for this session.`);
}

interface DeliveryParams { action: "merge" | "release"; branch: string; base: string; pr: number; sha: string; cwd?: string; version?: string; latest?: boolean; artifact_dir?: string; bind?: { exclude?: string[]; expect?: string } }

// Session-scoped merge OR release approval (never both in one grant), like a push lease: one TUI confirm per new action binding; an identical live binding returns without a dialog; live PR state and the candidate binding are re-verified after the dialog; no time expiry. Push, PR create and PR edit are automatic for the trusted release-engineer and are not carried here.
async function authorizeDelivery(params: { role?: string; ttl_minutes?: number; delivery: DeliveryParams }, ctx: { cwd: string; ui: { confirm(title: string, message: string, options?: { timeout?: number }): Promise<boolean> } }) {
	const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
	const d = params.delivery;
	if (params.role !== undefined && params.role !== LEASE_ROLE) return fail(`delivery is only for role ${LEASE_ROLE}; no delivery grant minted.`);
	if (params.ttl_minutes !== undefined) return fail("delivery grants are session-scoped; TTL unsupported (ttl_minutes rejected); no delivery grant minted.");
	if (d.action !== "merge" && d.action !== "release") return fail("delivery.action must be merge or release; legacy combined delivery grants are not accepted; no delivery grant minted.");
	if (d.action === "merge" && (d.version !== undefined || d.latest !== undefined || d.bind?.expect === undefined)) return fail("a merge grant needs bind.expect (the verified candidate fingerprint) and carries no release fields; no delivery grant minted.");
	if (d.action === "release" && (d.bind !== undefined || d.version === undefined)) return fail("a release grant needs version and sha (the merge commit) and takes no bind; no delivery grant minted.");
	let target: ReturnType<typeof pushBranchTarget>;
	try {
		target = pushBranchTarget(path.resolve(ctx.cwd, d.cwd ?? "."), d.branch);
	} catch (error) {
		return fail(`${(error as Error).message}; no delivery grant minted.`);
	}
	if (!target) return fail("not a verified git repository with exactly one origin push URL; no delivery grant minted.");
	const repo = parseRepoFromPushUrl(target.pushUrl);
	if (!repo) return fail("origin is not a github.com repository in a supported URL form; no delivery grant minted.");
	// Merge only: the fingerprint is computed before the dialog and recomputed after it; any refusal mints nothing.
	let bound: BoundState | undefined;
	if (d.action === "merge") {
		try { bound = bindDelivery(target.candidate, target.branch, d.bind); } catch (error) { return fail(`${(error as Error).message}; no delivery grant minted.`); }
	}
	const binding = { role: LEASE_ROLE, candidate: target.candidate, pushUrl: target.pushUrl, repo, branch: target.branch, base: d.base, action: d.action, pr: d.pr, sha: d.sha, version: d.version, latest: d.latest, artifactDir: d.artifact_dir, ...(bound ? { bound } : {}) };
	let artifactDir: string | undefined;
	let superseded: ReturnType<typeof safetyGrants.findSuperseded>;
	try {
		artifactDir = d.artifact_dir === undefined ? undefined : validateArtifactDir(d.artifact_dir, target.candidate);
		const live = safetyGrants.findDelivery(binding);
		if (live) return { content: [{ type: "text" as const, text: `Already authorized: ${d.action} of PR #${d.pr} at ${d.sha.slice(0, 7)} for ${repo} is live for this PI session; no new dialog.` }], details: {} };
		superseded = safetyGrants.findSuperseded(binding);
		if (!superseded && safetyGrants.deliveryCount() >= MAX_DELIVERY_GRANTS) return fail(`at most ${MAX_DELIVERY_GRANTS} live merge/release grants; no delivery grant minted.`);
		const refusal = verifyDeliveryTarget(binding as DeliveryBinding);
		if (refusal) return fail(`${refusal}; no delivery grant minted.`);
	} catch (error) {
		return fail(`${(error as Error).message}; no delivery grant minted.`);
	}
	const identity = `Repo: ${repo}\nPR: #${d.pr} only (${target.branch} into ${d.base})\nSHA: ${d.sha}`;
	const detail = d.action === "merge"
		? `Action: MERGE only (squash, --match-head-commit ${d.sha}). Bound candidate state: HEAD ${bound?.head} on ${bound?.ref}; fingerprint ${bound?.fingerprint}; excluded paths: ${bound?.exclude.join(", ") || "none"}${superseded?.bound ? `; replaces bound state ${superseded.bound.head.slice(0, 7)}` : ""}. Refused if the live PR head or the candidate (HEAD, branch, staged, unstaged or untracked files) differs. Ignored files are outside the fingerprint; not race-free. This does not approve any release.`
		: `Action: RELEASE only: tag ${d.version}${d.latest ? " as latest" : ""} at target ${d.sha} (the merge commit of PR #${d.pr}); refused if the tag already exists. This does not approve any merge.`;
	const text = `Role: ${LEASE_ROLE}\nCandidate: ${target.candidate}\nPush URL: ${target.pushUrl}\n${identity}\n${detail}\nArtifact directory: ${artifactDir ?? "none (no --body-file or --notes-file)"}${artifactDir === undefined ? "" : "\nArtifact files: *.md or *.txt regular files, 1 byte to 64 KiB, credential-scanned, directly inside that directory (no links, hard links or dot segments)"}\nScope: this PI session (no time expiry). No push, PR create/edit, other tags, force, delete, other refs, npm, deploy or API. Abort keeps it; /revoke-authorization or session end withdraws it. Running children keep their copy until they exit.`;
	const approved = await ctx.ui.confirm(d.action === "merge" ? "Authorize PR merge?" : "Authorize release creation?", text, { timeout: 120_000 });
	if (!approved) return fail("Not authorized by the operator; no delivery grant minted.");
	let again: ReturnType<typeof pushBranchTarget>;
	try {
		again = pushBranchTarget(target.candidate, target.branch);
	} catch {
		again = undefined;
	}
	if (!again || again.candidate !== target.candidate || again.pushUrl !== target.pushUrl) return fail("repository binding changed during approval; no delivery grant minted.");
	if (bound) {
		let after: BoundState | undefined;
		try { after = bindDelivery(target.candidate, target.branch, { exclude: bound.exclude }); } catch { after = undefined; }
		if (!after || after.head !== bound.head || after.ref !== bound.ref || after.fingerprint !== bound.fingerprint) return fail("candidate changed during approval; no delivery grant minted.");
	}
	const stale = verifyDeliveryTarget(binding as DeliveryBinding);
	if (stale) return fail(`${stale} (changed during approval); no delivery grant minted.`);
	try {
		safetyGrants.addDeliveryGrant(binding);
		return { content: [{ type: "text" as const, text: `Authorized ${LEASE_ROLE} ${d.action} of PR #${d.pr} at ${d.sha.slice(0, 7)} for ${repo} for this PI session (until /revoke-authorization or session end; running children keep copies until they exit).` }], details: {} };
	} catch (error) {
		return fail(`${(error as Error).message}; no delivery grant minted.`);
	}
}

export default function (pi: ExtensionAPI) {
	registerProviderCooldown(pi);
	pi.on("tool_call", (event, ctx) => guardToolCall({ scope: "main", store: safetyGrants, agentDir: getAgentDir() }, event.toolName, event.input, ctx.cwd));
	pi.on("agent_settled", (event) => { if (event.aborted) safetyGrants.revokeAll(); });
	pi.on("session_shutdown", () => safetyGrants.revokeAll(true));
	pi.registerCommand("authorization", {
		description: "Show session authorizations (read-only, secret-free): single-use grant counts, push and push+commit leases, delivery grants and their validity",
		handler: async (_args, ctx) => {
			ctx.ui.notify(authorizationStatus(safetyGrants, Date.now()), "info");
		},
	});
	pi.registerCommand("revoke-authorization", {
		description: "Withdraw session authorizations: single-use grants, release-engineer push leases and release delivery (running children keep copies until they exit or expire)",
		handler: async (_args, ctx) => {
			safetyGrants.revokeAll(true);
			ctx.ui.notify("Authorizations revoked; the next risky push needs a new approval. Pause or cancel running workers separately.", "info");
		},
	});
	registerSkillAliases(pi);
	registerMainPolicy(pi, packageRoot());
	pi.registerCommand("provider-cooldown", {
		description: "Show provider cooldown state, or refresh one provider's auth after re-authenticating",
		handler: async (args, ctx) => {
			const result = await runProviderCooldownCommand(args);
			ctx.ui.notify(result.message, result.type);
		},
	});
	const monitor = new WorkerMonitor(pi);
    const decisions = new DecisionRelay();
    const runtime = new BackgroundWorkers(pi, monitor, decisions);
    const subagentTool = {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context. Background by default: return a job ID and keep responding to the user. Use subagent_control to list, steer, cancel or retrieve results. Do not repeatedly poll; completions arrive automatically. Do not claim a job is finished until its result arrives.",
			"Available user roles: " + discoverAgents(process.cwd(), "user").agents.map(a => a.name).join(", "),
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder), dag (up to 8 nodes with dependsOn; a node runs after its parents are accepted).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx, preparedDispatch?: { discovery: ReturnType<typeof discoverAgents>; selected: Map<number, SelectedAgent> }) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
                monitor, runtime, usageScope: runtime.usage, jobId: (ctx as any).subagentJobId,
                contextWindowFor: ref => {
                    const slash = ref.indexOf("/");
                    return slash < 0 ? undefined : ctx.modelRegistry?.find(ref.slice(0, slash), ref.slice(slash + 1))?.contextWindow;
                },
			};
			const discovery = preparedDispatch?.discovery ?? discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const hasDag = params.dag !== undefined; // an empty dag array is still a present, ambiguous mode
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasDag);
			const mode = hasDag ? "dag" : hasChain ? "chain" : hasTasks ? "parallel" : "single";

			const makeDetails =
				(mode: "single" | "parallel" | "chain" | "dag") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			// Fail closed: an untrustworthy package/user registry launches nothing, before any provider work.
			if (discovery.error) {
				return {
					content: [{ type: "text", text: `Subagent roles unavailable; nothing was launched: ${discovery.error}` }],
					details: makeDetails(mode)([]),
					isError: true,
				};
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			// Validated before any project prompt, runtime start or launch: an invalid graph spawns nothing.
			let dagNodes: DagNodeSpec[] | undefined;
			if (hasDag) {
				const unknownRoot = Object.keys(params).find((key) => !SUBAGENT_ROOT_KEYS.has(key));
				if (unknownRoot !== undefined) return { content: [{ type: "text", text: `Invalid parameters: unknown top-level key "${unknownRoot}" in dag mode.` }], details: makeDetails("dag")([]), isError: true };
				try {
					dagNodes = validateDag(params.dag, { has: (name) => agents.some((a) => a.name === name) });
				} catch (error) {
					return { content: [{ type: "text", text: `Invalid DAG: ${error instanceof Error ? error.message : String(error)}` }], details: makeDetails("dag")([]), isError: true };
				}
			}

			const batchMode = hasChain || hasTasks || hasDag;
			if (batchMode && (params.modelTier !== undefined || params.modelSlot !== undefined)) return { content: [{ type: "text", text: `Invalid ${params.modelTier !== undefined ? "modelTier" : "modelSlot"}: root selection is only valid for a single task.` }], details: makeDetails(mode)([]), isError: true };
			const tierRequests = hasDag ? dagNodes! : hasChain ? params.chain! : hasTasks ? params.tasks! : hasSingle ? [{ agent: params.agent!, modelTier: params.modelTier, modelSlot: params.modelSlot }] : [];
			const selected = preparedDispatch?.selected ?? new Map<number, SelectedAgent>();
			if (!preparedDispatch) {
				for (let i = 0; i < tierRequests.length; i++) {
					const request = tierRequests[i] as { agent: string; modelTier?: unknown; modelSlot?: unknown; id?: string };
					const location = hasDag ? `dag node "${request.id}"` : hasChain ? `chain[${i}]` : hasTasks ? `tasks[${i}]` : "single";
					if (request.modelTier !== undefined && request.modelTier !== "economy" && request.modelTier !== "capable") return { content: [{ type: "text", text: `Invalid modelTier: ${location}: expected economy or capable.` }], details: makeDetails(mode)([]), isError: true };
					const agent = agents.find((entry) => entry.name === request.agent);
					if (!agent) {
						if (request.modelTier === undefined && request.modelSlot === undefined) continue; // unknown omitted role keeps the existing unknown-agent path
						return { content: [{ type: "text", text: `Invalid modelTier: ${location}: unknown agent "${request.agent}".` }], details: makeDetails(mode)([]), isError: true };
					}
					try { selected.set(i, resolveModelTier(agent, request.modelTier as ModelTier | undefined, request.modelSlot as ModelSlot | undefined)); }
					catch (error) { return { content: [{ type: "text", text: `Invalid modelTier: ${location}: ${error instanceof Error ? error.message : String(error)}` }], details: makeDetails(mode)([]), isError: true }; }
				}
			}
			const taskAgents = (index: number): SelectedAgent[] => selected.has(index) ? [selected.get(index)!] : agents;

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.dag) for (const node of params.dag) requestedAgentNames.add(node.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

            if (!(ctx as any).subagentJobId) {
                try { runtime.assertCanLaunch((params.dag ?? params.chain ?? params.tasks ?? [{agent: params.agent!}]).map(t => t.agent)); }
                catch (error) { return {isError: true, content: [{type: "text", text: String(error)}]}; }
            }
            if (params.background !== false) {
                const requests = params.dag ?? params.chain ?? params.tasks ?? [{agent: params.agent!, task: params.task!, cwd: params.cwd}];
                if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) return {isError: true, content: [{type: "text", text: "Max parallel tasks is 8."}], details: makeDetails("parallel")([])};
                const unknown = requests.filter(t => !agents.some(a => a.name === t.agent)).map(t => t.agent);
                if (unknown.length) return {isError: true, content: [{type: "text", text: "Unknown agents: " + unknown.join(", ")}], details: makeDetails("single")([])};
                if (signal?.aborted) throw new Error("Dispatch was aborted");
                const job = runtime.start((jobSignal, jobId) => subagentTool.execute(_toolCallId, {...params, background: false, confirmProjectAgents: false}, jobSignal, undefined, {...ctx, subagentJobId: jobId} as any, { discovery, selected }));
                return {content: [{type: "text", text: "Started background job " + job.id + ". Roles: " + requests.map(t => t.agent).join(", ") + ". This is a launch acknowledgement, not a completed task. Continue responding or doing independent work; completion will arrive automatically. Use subagent_control list to obtain worker IDs, steer to change direction, or cancel to stop."}], details: {...makeDetails(mode)([]), jobId: job.id, background: true}};
            }

			if (dagNodes) {
				const launched = new Set<string>();
				const rows = await runDag(dagNodes, {
					agents: { has: (name) => agents.some((a) => a.name === name) },
					concurrency: MAX_CONCURRENCY,
					signal,
					accept: (result: SingleResult) => !isFailedResult(result) && !printedToolMarkup(result),
					report: (result: SingleResult) => withTerminalDiagnostics(extractFinalText(result.messages), result),
					run: (node, parents, nodeSignal) => {
						return runSingleAgent(ctx.cwd, { ...dispatchDefaults, waitKey: node.id, onSpawn: () => launched.add(node.id) }, taskAgents(dagNodes!.findIndex((entry) => entry.id === node.id)), node.agent, appendParentReports(node.task, parents), node.cwd, undefined, nodeSignal, undefined, makeDetails("dag"), node.readOnly ? "read" : "write");
					},
				});
				const rowById = new Map(rows.map((row) => [row.nodeId, row]));
				const results: SingleResult[] = dagNodes.map((node) => {
					const row = rowById.get(node.id)!;
					const cause = row.cause === undefined ? undefined : row.cause instanceof Error ? row.cause.message : String(row.cause);
					const base: SingleResult = row.result ?? { agent: node.agent, agentSource: "unknown", task: node.task, exitCode: 1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, stopReason: cause === undefined ? undefined : "error", errorMessage: cause };
					const selectedAgent = selected.get(dagNodes!.indexOf(node));
					return { ...base, ...tierFields(selectedAgent), nodeId: node.id, dag: { status: row.status, blockedBy: row.blockedBy, started: launched.has(node.id) } };
				});
				const accepted = results.filter((r) => r.dag?.status === "accepted").length;
				return {
					content: [{ type: "text", text: `DAG: ${accepted}/${results.length} nodes accepted\n\n${results.map(retainedEntryBlock).join("\n\n---\n\n")}` }],
					details: makeDetails("dag")(results),
					isError: accepted < results.length,
				};
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, () => previousOutput); // function replacer: `$&`, `$'` etc. in prior output stay literal

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						taskAgents(i),
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						step.readOnly ? "read" : "write",
					);
					results.push(result);

					// Printed markup is not executed, so a successor must not run on it; a final step keeps its labelled presentation.
					const isError = isFailedResult(result) || (i < params.chain.length - 1 && printedToolMarkup(result));
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = extractFinalText(result.messages);
				}
				return {
					content: [{ type: "text", text: getResultOutput(results[results.length - 1]) }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						...tierFields(selected.get(i)),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						taskAgents(index),
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						t.readOnly ? "read" : "write",
					).catch((error): SingleResult => {
						// Per-task fail closed: a launch that throws (e.g. missing Claude subscription guard) is one failed task; siblings keep their evidence. Abort still rejects.
						if (signal?.aborted) throw error;
						const message = error instanceof Error ? error.message : String(error);
						return { agent: t.agent, agentSource: agents.find((a) => a.name === t.agent)?.source ?? "unknown", task: t.task, exitCode: 1, messages: [], stderr: message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, stopReason: "error", errorMessage: message, ...tierFields(selected.get(index)) };
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = getResultOutput(r);
					const status = printedToolMarkup(r) ? PRINTED_MARKUP_LABEL : isIncompleteStop(r) ? incompleteLabel(r.stopReason) : isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
                    isError: successCount < results.length,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					taskAgents(0),
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					params.readOnly ? "read" : "write",
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${isIncompleteStop(result) ? incompleteLabel(result.stopReason) : result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getResultOutput(result) }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

        renderShell: "self",
        renderCall(args, theme) {
            if (args.background !== false) return {invalidate() {}, render: () => []};
            const items = args.dag ?? args.chain ?? args.tasks ?? (args.agent ? [{agent: args.agent}] : []);
            const mode = args.dag ? "dag" : args.chain ? "chain" : args.tasks ? "parallel" : "single";
            const names = items.map(item => item.agent).join(", ").replace(/[\r\n\x1b]/g, " ").slice(0, 160);
            return monitor.compact(theme.fg("toolTitle", `subagent · ${mode} · ${names}`));
        },
        renderResult(result, {isPartial, expanded}, theme) {
            if ((result.details as any)?.background) return expanded
                ? monitor.compact(theme.fg("muted", "Launched background job " + (result.details as any).jobId))
                : {invalidate() {}, render: () => []};
            const results = result.details?.results ?? [];
            const failed = results.filter(r => r.exitCode !== -1 && isFailedResult(r)).length;
            const done = results.filter(r => r.exitCode === 0 && !isFailedResult(r)).length;
            const status = isPartial ? `Working · ${done} done · ${failed} failed` : result.isError || failed ? `Finished with errors · ${failed} failed` : `Finished · ${done} done`;
            const names = results.map(r => `${r.agent}${r.modelTier !== undefined ? ` [tier: ${r.modelTier}${r.modelSlot !== undefined ? `, slot: ${r.modelSlot}` : ""}]` : ""}`).join(", ").replace(/[\r\n\x1b]/g, " ").slice(0, 120);
            const hint = results.length ? "Click to inspect · /subagent" : (result.content.find(c => c.type === "text")?.text ?? "No workers launched").replace(/\s+/g, " ").slice(0, 180);
            return monitor.compact(theme.fg(failed || result.isError ? "error" : "muted", `${status} · ${names}`) + "\n" + hint, results[0]?.workerId);
        },
    };
    pi.registerTool({
        ...subagentTool,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            return subagentTool.execute(_toolCallId, params, signal, onUpdate, ctx);
        },
    });
    pi.registerTool({
        name: "request_authorization", label: "Request authorization",
        description: "Not needed for an explicitly requested ordinary commit, feature-branch push or PR creation by a trusted release-engineer (no authorization is required; do not call this proactively). Use it only for risky operations the guard genuinely blocked, with separate operator approval. PR merge and release create are never single-use operations: each needs its own delivery action grant (exact PR + SHA pins; merge also the verified candidate fingerprint). Same-owned PR edit is automatic for the trusted release-engineer. Ask the human operator in the TUI to grant exact single-use authorization (max " + MAX_GRANT_OPS + " operations) for risky operations the safety guard blocked, or exclusively via push_branch a session-only release-engineer push lease for one feature branch (commits: true also allows normal commits, artifact_dir binds -F message files), or exclusively via delivery a session-scoped release-engineer merge OR release approval bound to one repo/PR/SHA. Refused outside the interactive TUI.",
        parameters: Type.Object({
            operations: Type.Optional(Type.Array(Type.Object({ kind: StringEnum(["shell", "write"] as const), value: Type.String({ description: "Exact shell command or file path" }) }), { minItems: 1, maxItems: MAX_GRANT_OPS })),
            push_branch: Type.Optional(Type.Object({ branch: Type.String({ description: "Feature branch name; protected branches are refused" }), cwd: Type.Optional(Type.String({ description: "Candidate folder; default the session cwd" })), commits: Type.Optional(Type.Boolean({ description: "true also allows normal git commit -m or -F commits on this branch (policy-enforced only for release-engineer children)" })), artifact_dir: Type.Optional(Type.String({ description: "With commits true: absolute forward-slash folder under worktrees/<repo>/_scratch or _evidence/<task> holding the -F message file" })) }, { description: "Exclusive with operations: one session release-engineer PR-branch push lease" })),
            delivery: Type.Optional(Type.Object({ action: StringEnum(["merge", "release"] as const, { description: "One action per grant: merge or release; separate approvals" }), branch: Type.String({ description: "Feature branch of the PR" }), base: Type.String({ description: "PR base branch, e.g. main" }), pr: Type.Number({ minimum: 1, description: "Exact PR number" }), sha: Type.String({ description: "40-hex SHA. merge: the reviewed PR head (must equal the candidate HEAD). release: the release target = merge commit of the PR" }), cwd: Type.Optional(Type.String({ description: "Candidate folder; default the session cwd" })), version: Type.Optional(Type.String({ description: "release only: approved tag, e.g. v1.2.3 (must not exist yet)" })), latest: Type.Optional(Type.Boolean({ description: "release only: approve --latest" })), artifact_dir: Type.Optional(Type.String({ description: "Absolute forward-slash folder under worktrees/<repo>/_scratch or _evidence/<task> holding --body-file/--notes-file" })), bind: Type.Optional(Type.Object({ exclude: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: "Relative untracked output folders left out of the fingerprint; never tracked paths" })), expect: Type.Optional(Type.String({ description: "64-hex candidate fingerprint of the reviewed candidate; mint refused if the live state differs" })) }, { description: "merge only and mandatory (expect required): binds the grant to the candidate HEAD (= sha) and fingerprint verified at approval. Not allowed for release. Not race-free" })) }, { description: "Exclusive with operations and push_branch: session-scoped reusable release-engineer merge OR release approval (no time expiry); legacy combined grants are rejected" })),
            role: Type.Optional(Type.String({ description: "Child role the grant binds to; omit for main" })),
            ttl_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: GRANT_TTL_MAX_MS / 60_000, description: "Default 30; rejected for push_branch and delivery (delivery is session-scoped; TTL unsupported)" })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const denied = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
            if (ctx.mode !== "tui" || !ctx.hasUI) return denied("request_authorization requires the human TUI; no grant minted.");
            if (params.push_branch !== undefined && params.operations !== undefined) return denied("push_branch is exclusive with operations; no grant minted.");
            if (params.delivery !== undefined && (params.operations !== undefined || params.push_branch !== undefined)) return denied("delivery is exclusive with operations and push_branch; no grant minted.");
            if (params.delivery !== undefined) return authorizeDelivery(params, ctx);
            if (params.push_branch !== undefined) return authorizePushBranch(params, ctx);
            if (!params.operations) return denied("operations or push_branch is required; no grant minted.");
            const role = params.role ?? null;
            if (role !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(role)) return denied("invalid role name; no grant minted.");
            const candidate = canonicalCwd(ctx.cwd);
            let ops: GuardOp[];
            try { ops = params.operations.map((o) => authorizableOp(o.kind, o.value, candidate, getAgentDir(), role === LEASE_ROLE)); assertBatchDisplayable(ops); } catch (error) { return denied(`${(error as Error).message}; no grant minted.`); }
            const ttlMs = Math.min(GRANT_TTL_MAX_MS, Math.max(1, params.ttl_minutes ?? GRANT_TTL_DEFAULT_MS / 60_000) * 60_000);
            const list = ops.map((op, i) => `${i + 1}. ${describeOp(op)}`).join("\n");
            const approved = await ctx.ui.confirm("Authorize exact risky operations?", `Role: ${role ?? "main"}\nCandidate: ${candidate}\nTTL: ${ttlMs / 60_000} min, each single use\n${list}`, { timeout: 120_000 });
            if (!approved) return denied("Not authorized by the operator; no grant minted.");
            const minted = safetyGrants.mint({ role, candidate, ops, ttlMs });
            return { content: [{ type: "text" as const, text: `Authorized ${minted.length} single-use operation(s) for ${role ?? "main"}; they expire in ${ttlMs / 60_000} min.` }], details: { count: minted.length } };
        },
    });
    pi.registerTool({
        name: "subagent_control", label: "Subagent control",
        description: "Manage existing background jobs. list returns job/worker IDs and current activity. steer sends a new instruction to an active worker at its next tool boundary; use its unique worker ID when a job has multiple workers. pause enforces a hold after the current tool/model call; resume continues the same worker. Pause a job to hold all active workers and later chain steps. A steering message alone is model advice, not an enforced stop. cancel stops a worker or job. result retrieves a finished job. Completions arrive automatically, so do not busy-poll. Never restart or duplicate a running worker just to steer it. decisions lists worker decision requests; answer or decline a requestId only with its traceable basis or reason. Answers never resume a paused job; steer never answers a decision.",
        parameters: Type.Object({action: StringEnum(["list", "steer", "pause", "resume", "cancel", "result", "decisions", "answer", "decline"] as const), target: Type.Optional(Type.String({description: "Job ID bg-N, full worker ID, #N, or decision requestId dec-…"})), message: Type.Optional(Type.String()), answer: Type.Optional(Type.String({description: "Freeform answer text (action answer)"})), basis: Type.Optional(StringEnum(["user_answer", "existing_authorization"] as const)), reference: Type.Optional(Type.String({description: "Traceable source of the answer or authorization"})), reason: Type.Optional(Type.String({description: "Why the request is declined (action decline)"}))}),
        async execute(_id, params) {
            try {
                if (params.action === "list") return {content: [{type: "text", text: JSON.stringify(runtime.list())}]};
                if (params.action === "decisions") return {content: [{type: "text", text: JSON.stringify(decisions.list())}]};
                if (!params.target) throw new Error("target is required");
                if (params.action === "answer" || params.action === "decline") return {content: [{type: "text", text: await runtime.answerDecision(params.target, params.action === "answer" ? {kind: "answer", answer: params.answer, basis: params.basis, reference: params.reference} : {kind: "decline", reason: params.reason})}]};
                if (params.action === "result") return runtime.result(params.target);
                if (params.action === "steer" && !params.message?.trim()) throw new Error("A nonempty steering message is required");
                const text = params.action === "steer" ? await runtime.steer(params.target, params.message!) : params.action === "pause" || params.action === "resume" ? runtime.pause(params.target, params.action === "pause") : runtime.cancel(params.target);
                return {content: [{type: "text", text}]};
            } catch (error) { return {isError: true, content: [{type: "text", text: String(error)}]}; }
        },
    });
    monitor.control = async (args, ctx) => {
        if (args.trim() === "roles") { const { editRoleConfig } = await import("./roles-editor.ts"); await editRoleConfig(ctx); return; }
        const match = args.trim().match(/^(steer|pause|resume|stop|cancel|list|result|usage)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/);
        if (!match) { ctx.ui.notify("Use /subagent steer #N message, pause bg-N, resume bg-N, stop bg-N, list, result bg-N, usage, roles, create, or /subagent to inspect", "warning"); return; }
        // Command operations use the same runtime without a model request.
        try {
            const [, action, target, message] = match;
            if (action === "usage") ctx.ui.notify(formatUsageSummary(runtime.usage), "info");
            else if (action === "list") ctx.ui.notify(JSON.stringify(runtime.list()), "info");
            else if (!target) throw new Error("A worker or job ID is required");
            else if (action === "steer") { if (!message?.trim()) throw new Error("A message is required"); ctx.ui.notify(await runtime.steer(target, message), "info"); }
            else if (action === "result") ctx.ui.notify(JSON.stringify(runtime.result(target)).slice(0, 800), "info");
            else if (action === "pause" || action === "resume") ctx.ui.notify(runtime.pause(target, action === "pause"), "info");
            else ctx.ui.notify(runtime.cancel(target), "info");
        } catch (error) { ctx.ui.notify(String(error), "error"); }
    };
}
