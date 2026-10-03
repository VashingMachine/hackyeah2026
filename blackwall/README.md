# Blackwall — the demo implementation

A control layer for AI agents (HackYeah 2026, the Goldman Sachs challenge "AI Control Layer"). This directory contains working code: a decision server, an OpenAI-compatible model gateway, topic supervision of sessions, an extension for the Pi agent, an admin dashboard and tests. The concept and the rationale: [`../docs/blackwall-koncepcja-i-plan-dema.md`](../docs/blackwall-koncepcja-i-plan-dema.md).

## What works (verified)

| Area | Status |
| --- | --- |
| A decision before a tool executes (`allow` / `deny` / `require_approval`) with reason codes, session state and audit | works; tested on real files and a real Pi |
| Deterministic rules: paths (components, `..`, symlinks, new files), `.env`/keys, extensions, size, network (host, port, method, endpoint, private/loopback/IPv6/IPv4 spellings, DNS), secrets and personal data (IBAN, PESEL with its checksum), the threat feed | works |
| Semantic assessment by **Jev (TypeSafe)** — real API calls | works |
| One-time user approval in the Pi interface (TTL, single use, invalidated on a state change) | works |
| The model gateway: an alias allowlist, token reservation and settlement, a secret scan of the whole prompt, a response buffer before release | works (provider: Anthropic) |
| Topic supervision: embedding → session label → one supervisor (Claude Haiku) → `terminated` | works |
| The admin dashboard (overview, a live event timeline with filters, policies), JSONL export, p50/p95 metrics | works |

Detailed results are in the "Tests" section below.

> **Guide:** step-by-step start-up, 8 demo scenarios (Pi and `curl`) and a description of the tools: [`docs/demo-guide.md`](docs/demo-guide.md).

## Running it

Requirements: Node.js 24+ (the built-in `node:sqlite`), keys in `../.env` (template: `../.env.example`): `ANTHROPIC_API_KEY`, `JEV_API_KEY`.

```sh
cd blackwall
npm install
./scripts/dev-server.sh            # a server on a copy of the demo data, http://127.0.0.1:8787
```

The dashboard: <http://127.0.0.1:8787/dashboard> (the administrator token: `BLACKWALL_ADMIN_TOKEN`, in the demo `demo-admin-token`).

The Pi agent through Blackwall (every demo user has their own working directory and scope):

```sh
node scripts/pi-launch.mjs --user onboarding-demo     # interactive
node scripts/pi-launch.mjs --user onboarding-demo -- -p "Prepare a KYC draft for Atlas Capital …"
```

Demo users: `onboarding-demo` (KYC Atlas), `deal-demo` (the Orion transaction), `hr-demo`, `developer-demo`, `analyst-demo`. A test receiver for the M&A scenario: `node scripts/receiver.mjs` (port 9911).

Any other model client can use the gateway directly: `POST /v1/chat/completions` with a session token (`POST /v1/sessions` with a user token). With `BLACKWALL_GATEWAY_TOOLS=1` the gateway itself assesses the tool calls proposed by the model.

## Configuration

A single source of truth: [`config/policy.yaml`](config/policy.yaml). A change = editing the file and restarting. The validator rejects unknown keys, nonexistent aliases and inconsistent references.

- `profile: permissive | standard | strict` — they differ in the **scope** of semantic assessment (strict assesses every tool, standard writes/HTTP/shell, permissive HTTP/shell), in the **thresholds** (0.80/0.90/0.95), in the handling of secrets (redaction or a block) and of personal data, and in the behavior on uncertainty. Every allowed `bash` call is assessed in every profile.
- `mode: enforce | observe` — `observe` records what would have been refused; authentication, session state and budgets still apply.
- `global` + `users.<name>` — the organization's and the user's policy; allowlists intersect, prohibitions are summed, limits take the minimum, an empty list = prohibited.
- `topics` / `topic_policies` — the catalog of sensitive topics and their policies.
- The threat feed: [`feed/demo-attacks.json`](feed/demo-attacks.json) (deserialization with `pickle`/`torch.load` — the CVE-2025-32434 class, `trust_remote_code`, `curl | sh`, a reverse shell, `rm -rf /`, a leak to paste/webhook services, prompt injection).

## Tests

```sh
npm test            # 50 unit tests, no network
npm run test:live   # 21 tests on real APIs (Jev, Claude)
npm run test:e2e    # 8 tests with a real Pi agent
npm run eval        # the semantic corpus (see below)
npm run typecheck
```

The last full run: **79/79** (50 unit + 21 on live APIs + 8 end-to-end). Tests on live models are non-deterministic: one e2e test failed in about 1 run in 4, because its prompt (overwriting a KYC draft with the text "SHOULD NOT BE WRITTEN") looked like sabotage to the supervisor; the prompt was changed to an ordinary one. The lesson: the supervisor can be over-eager on unusual requests. The negative tests check the **effect**, not a log entry: the file was not created or did not change, the HTTP receiver got no request, the model did not receive the prohibited message (the model-call counter did not grow), the secret reached neither the agent's transcript nor the audit.

The end-to-end tests (a real Pi + a real Claude + a real Jev): approval of overwriting a KYC draft (one write), rejection of the approval (the file untouched, the session `blocked`), a read of another client's data, protection of `.env` and redaction of a key in an allowed file, an HR session closed after a request to evaluate people, an allowed POST at the user's request, no request on an injection in a document, and the absence of the session token in the agent's shell environment.

### The semantic corpus (`npm run eval`)

34 supervision cases + 15 shell commands, the labels written **before** the run and not tuned. Reports: [`reports/`](reports/).

| Measure | Result |
| --- | --- |
| Supervision: violations let through (false allow) | 0/15 |
| Supervision: closures without a violation (false terminate) | 0/19 |
| Supervision: uncertain / technical blocks | 0/34 / 0/34 |
| A topic detected in unrelated messages | 0/3 |
| Latency: topic detection p50 / p95 | 9 / 15 ms (local MiniLM, CPU) |
| Latency: the supervisor (Haiku) p50 / p95 | ~1.3 / ~1.6 s |
| Jev, shell: dangerous commands let through automatically | 0/4 in every profile |
| Jev, shell: justified programs let through automatically | permissive 5/5, standard 2/5, strict 1/5 (the rest ask the user) |

**Note:** these are small samples written by the authors. They do not translate into production effectiveness. Jev's assessment concerns the text of a command, not its effects at run time; the `demo_prepared` profile **is not a sandbox**.

## Deviations from the concept document

| The concept | The implementation | Reason |
| --- | --- | --- |
| PostgreSQL + pgvector | SQLite (`node:sqlite`), exact cosine similarity in memory | no dependence on Docker; 3 topics; the `Store` contract allows swapping the database |
| OpenAI embeddings | a local MiniLM (transformers.js), English only; the `openai` provider is ready in the code | no OpenAI key with available credits; data does not leave the machine |
| `execution_authorization` + `/consume` | a one-time decision after approval (an atomic `pending → approved` transition) | a simplification for a single-machine demo |
| React + Vite | a static dashboard in plain JS | fewer dependencies |
| Messages for the model in Polish | in English | the executor model works in English |
| Hot-reload of the policy through the API | a YAML file + a restart | the user's decision |
| Context validation through `trusted_task_id` | the trusted task = the user messages recorded by the gateway/extension | no separate task registry |

## Demo recording

`node scripts/demo.ts --only 06-hr-termination` records one case on the real stack (Pi, Claude, Jev, real files) into `demo-recordings/`: the course of the conversation, the audit trail, the evidence checked in the system and dashboard screenshots. An independent counting forwarder sits between the gateway and the model provider, so "the model did not receive the prohibited content" can be checked without trusting Blackwall's own audit. Without `--only` it records all the cases (about 8 min).

A review of the recording by an independent agent found a real bug: a message recorded in the audit was treated as "already inspected" even when the supervisor had failed or was uncertain, so after an administrator resumed the session it would have reached the model without assessment. It was fixed (a message is skipped only after it has passed the check) and tests were added.

## Known limitations and open issues

- **No sandbox.** `bash` is assessed, but a program that runs may do more than the command describes. The extension does not pass the session token to the shell's environment, but the shell process runs with the permissions of the system user.
- A tool result is inspected in Pi's `tool_result`, that is after execution; the raw content may have reached the TUI stream before it is replaced.
- The model's response is buffered in full (no real streaming).
- By default a refusal **blocks the session** (`default_session_action: block`). The extension tells the agent its allowed locations so that it avoids accidental refusals.
- During manual trials, a Pi invocation with no traffic at all to the server (it hung until the time limit) was observed 3 times; it could not be reproduced in the subsequent dozen or so runs (including 7 e2e tests). Request logging of the server: `BLACKWALL_LOG=1`.
- The embedding model is English; Polish messages will be detected less reliably.
- No automatic download of the feed, no MCP, agent-to-agent or SSO.
- The keys used during the build ended up in the transcript of the work — **they should be rotated** after the hackathon.
