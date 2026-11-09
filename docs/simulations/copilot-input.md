# Copilot CLI input-token estimates

[Results](copilot-input-results.json) were recorded on Copilot CLI 1.0.107, Linux, Node 24.22.1. This uses the real CLI, plugin hooks and native `task` dispatch with a scripted localhost provider. **No OpenAI or GitHub-hosted model was called.** `gpt-6.1-sol` was the configured model ID for all contexts, not an inference run. Astra, Terra and Luna were not separately tested here.

## Reproduce

Install Copilot CLI separately, then run:

```sh
COPILOT_CLI=/path/to/copilot python3 scripts/simulate-copilot-input.py > results.json
```

The [script](../../scripts/simulate-copilot-input.py) requires Python 3 and defaults to `copilot` on PATH. It uses temporary fixture/config directories, `COPILOT_OFFLINE=true`, a localhost OpenAI-compatible SSE server and no provider credentials. Fixtures and configuration are removed on completion. Results include the CLI version and harness commit. Two original runs returned identical estimates in all 12 configurations; the checked-in script reproduced those same estimates. Absolute counts may change with CLI versions, installed paths, operating systems or injected context.

## Fixed workloads and comparisons

Each fixture consists only of file reads: four distinct 4,000-character files; twelve 8,000-character reads alternating between two files; or thirty distinct 20,000-character files. Each fixture runs four ways:

- `plain`: one fresh Copilot session with no harness plugin.
- `harness-one`: main adds two scouting reads, then delegates all original reads to one `agent-harness:general-worker`.
- `plain-fresh-three`: divide the original reads into three groups and start a fresh plain session for each group.
- `harness-three`: main adds two scouting reads, then delegates those same three groups to three sequential workers.

Plain and worker tool calls read the same files in the same order. The script verifies read-call counts and that actual fixture contents returned, rather than errors or denials. It scripts the packet, role choice and handoff; these are not decisions made by a model. The `STATUS: PASS` reply is scripted and is not task-success evidence. No edits, debugging, test execution, retry reasoning or writing a separate report file is modelled.

Every request's `messages` and `tools` are compact-JSON serialized; estimated input tokens are character count divided by four, rounded up per request. Totals sum all main and worker requests. These are not tokenizer counts or provider-reported usage. The main and child contexts have their native, different prompts and tool schemas; savings cannot be attributed solely to the plugin guidance. Copilot constructs its own requests: Pi masking, deduplication and folding are not running here.

## Results

| Workload | Plain session | Harness, one worker | Input-token change |
| --- | ---: | ---: | ---: |
| Small | 91,590 | 133,245 | 45.5% more |
| Repeated reads | 382,799 | 350,827 | 8.4% fewer |
| Large | 3,041,155 | 2,850,472 | 6.3% fewer |

Splitting context helps more on the large fixture, but fresh plain sessions are a stronger baseline:

| Workload | Three fresh plain sessions | Harness, three workers | Input-token change |
| --- | ---: | ---: | ---: |
| Small | 117,723 | 187,740 | 59.5% more |
| Repeated reads | 307,080 | 307,895 | 0.3% more |
| Large | 1,430,745 | 1,286,221 | 10.1% fewer |

The large three-worker run is 57.7% below one continuous plain session, but only 10.1% below three fresh plain sessions. It uses 39 requests versus 31 for one plain session or 33 for three fresh sessions. Delegation can reduce repeated input while increasing the number of requests.

## Limits

These narrow read-only fixtures show potential input-token savings and coordination overhead. They do not establish general coding-task savings, model capability, successful-task cost, Copilot subscription savings or API-dollar savings. Cache reads/writes, output/reasoning tokens and provider billing were not priced. A real model may make different calls, and cache reuse can erase a raw-token advantage. Hosted Copilot inference remained blocked by authentication in this environment.
