# Relay

**Discover once. Replay with a contract. Hand control to a person when the contract no longer holds.**

Relay is a small computer-use system for a synthetic bank servicing application. An LLM observes the live browser and decides how to find a member's savings balance. The successful run becomes a versioned, parameterized JSON capability. Later calls replay that capability without a model and return typed outputs or a deliberate business outcome.

The distinctive part is the boundary around each action: a model can suggest an action, but it cannot authorize a destination, invent a selector, mark an irreversible action safe, or declare success without the executor checking it. Recovery and operator control use the same boundary.

## Run locally

Requires **Node.js 22 or later** and a Playwright Chromium browser. No real banking connection, credentials, or customer data are used.

If Terminal reports `command not found: npm`, install **Node.js LTS** using the **macOS installer** from [the official Node.js download page](https://nodejs.org/en/download). The installer includes npm. Then reopen Terminal before running the commands below.

The commands below are the standalone Playwright path. This host's macOS sandbox blocked standalone browser launch, so the included successful live evidence was produced with the hosted computer-use browser adapter. Standalone Playwright and API-provider discovery are supplied for independent reproduction; neither is represented as verified here.

```sh
npm install
npx playwright install chromium
npm test
npm run sandbox
```

Keep the sandbox running in this terminal. It serves the bank at `http://127.0.0.1:4173/bank`. Use a second terminal for the commands below.

`npm test` runs the portable contract, policy, ownership, evidence, and engine checks. Include the real loopback operator-console checks with:

```sh
RELAY_HTTP_TESTS=1 npm test
```

Live Playwright surface tests require an installed browser and explicit opt-in:

```sh
RELAY_LIVE_TESTS=1 npm test
```

### Verify the standalone path

With Chromium installed, run:

```sh
npm run verify:live
```

This runs the real browser checks and replays the saved capability with a different member. It also repairs an expired session through the actual HTTP operator console and checks that the browser, storage, and session are preserved. The console is driven by an explicitly automated test actor; this does not claim human participation. Browser-launch errors make verification fail rather than silently skip.

For a fresh API discovery followed by model-free replay, set `OPENAI_API_KEY` and run `npm run verify:api`. It writes fresh, redacted evidence under `work/verification/` and preserves the checked-in example. The assignment leaves the model provider up to the implementer; OpenAI is the provider included here. A key is unnecessary for replay or the saved-run viewer. This host still blocks standalone Chromium launch, and the API check has not been performed here.

The API verification commands also load a private `.env` file in the Relay folder if the key is absent from the environment. `.env` is ignored by Git. An API key is a prerequisite for those commands; a hosted discovery run is not counted as API verification.

### Record a person taking control

From your own interactive terminal, run:

```sh
npm run verify:human
```

This starts its own synthetic bank and visible Playwright browser. When the run pauses, open the console address printed in the terminal. Personally click **Take control → Restore session → Return control**, then return to the terminal and type the requested attestation. The tool does not perform those three actions for you.

The check preserves the browser, session, and storage; verifies the paused checkpoint again; checks the output in memory; and saves redacted snapshots and a hash-chained action record. `human-verification.json` claims human participation only when both the recorded console protocol and your explicit attestation pass. The attestation is self-reported, not an identity check. The ordinary automated handoff tests cannot satisfy this check.

For an additional API-based verification sequence using a newly discovered capability, configure your API key and run:

```sh
npm run verify:end-to-end
```

This runs the native browser checks, genuine API discovery, replay with a different input, and the manual takeover check in that order. All runs use fresh directories under `work/verification/`. The command exits unsuccessfully if a prerequisite, replay, manual action, or attestation is missing. To check a previously discovered artifact manually, use `npm run verify:human -- --capability PATH`.

These additional checks are implemented. A successful native/API run and an actual participant's run have **not** been recorded here: this environment blocks browser launch, and no API key was configured. The required real discovery and model-free replay were demonstrated through the hosted browser; the console takeover evidence uses a disclosed automated actor.

The [final verification record](evidence/final-verification.json) lists the check counts, fresh discovery and replay results, console GUI verification, and remaining limits. See that record for the final passing and skipped counts. The earlier [privacy verification](evidence/completion-verification.json) covers private values repeated in titles and labels, including a multiline form value normalized by the hosted snapshot format. [The recovery timeline](evidence/privacy-verification/timeline.png) identifies its simulated test actor.

### Review the run timeline

```sh
npm run review -- --run-dir evidence/final-discovery
```

Open `http://127.0.0.1:4181` to see the latest saved discovery: the goal, five model decisions, recorded steps, and chronological events. The viewer checks the event hash chain and exposes no browser controls or private outputs. To view the successful console recovery instead, stop the viewer and run:

```sh
npm run review -- --run-dir evidence/console-automated
```

That run shows the automated console actor restoring the same session and finishing with zero model calls. [The console during takeover](evidence/console-automated/console-control.png) and [after successful replay](evidence/console-automated/console.png) show the actual controls and timeline.

The operator console also shows this timeline during a live run. New runs explicitly record checks before and after each action. Earlier logs identify unavailable checkpoint details and separately stored results; the viewer does not invent checks for them.

`evidence/timeline-replay/` and `evidence/timeline-handoff/` contain fresh live hosted-browser replays with these explicit checkpoint events. Both used zero model calls; the handoff run used the disclosed simulated operator actor on the same page. The hosted adapter remains distinct from the unverified standalone browser path.

### Reproduce discovery with your own model API access

Set `OPENAI_API_KEY` in your shell or secrets manager. Do not put it in a source file or commit it. The OpenAI provider performs real model requests; replay never needs a key.

```sh
export OPENAI_API_KEY='your-key'
node src/cli.mjs discover \
  --goal 'Look up member {{member_id}} and read their savings balance' \
  --target http://127.0.0.1:4173/bank \
  --inputs '{"member_id":"12345"}' \
  --provider openai \
  --artifact evidence/capability.json \
  --run-dir evidence/discovery
```

Use `--headed` to see the live browser. Discovery has bounded steps and timeouts, uses structured model decisions, and saves a capability only after its success checkpoint and output extraction pass.

Reusing `--run-dir` replaces that directory's event log. Use a fresh directory to preserve an earlier run. The commands above also replace the example artifact after successful discovery.

### Replay without live model services

The included capability is sufficient for this path; no API key or model request is needed.

```sh
node src/cli.mjs replay \
  --artifact evidence/capability.json \
  --inputs '{"member_id":"67890"}' \
  --scenario normal \
  --run-dir evidence/replay
```

The member differs from the discovery input to demonstrate that the artifact is a reusable contract, not a recording of literal customer data. The result returns the extracted balance to the caller in memory. The CLI display redacts it by default; add `--show-outputs` to display the synthetic demo values. On-disk evidence redacts invocation values and financial outputs.

### Exercise runtime conditions

```sh
node src/cli.mjs replay \
  --artifact evidence/capability.json \
  --inputs '{"member_id":"99999"}' \
  --scenario normal \
  --run-dir evidence/not-found

node src/cli.mjs replay \
  --artifact evidence/capability.json \
  --inputs '{"member_id":"67890"}' \
  --scenario session_expired \
  --headed \
  --operator-port 4180 \
  --run-dir evidence/handoff
```

The first returns a known business outcome. The second pauses for a person. Open `http://127.0.0.1:4180`, select **Take control**, use the **Restore session** control, and select **Return control**. The console drives the same bank browser used by the runner and shows a masked live preview. With `--headed`, you can also operate that existing browser window directly; direct browser action recording is best effort, while console actions pass through the logged ownership boundary. The run checks the restored state before it continues. Automation does not drive the browser while the operator owns it.

For an automated nine-scenario replay demonstration, run:

```sh
npm run demo
```

This starts its own local sandbox and exercises the saved capability against real Playwright UI sessions, without a model or API key. It writes run evidence under `work/demo/`. Its session-expiry case uses an **explicit simulated operator test actor** to claim the lease, click the real restore control, and return control; it does not simulate discovery. The manual console command above is the reproduction path for a person. This standalone demo was supplied but could not be launched in the restricted host environment.

| Scenario | Deliberate behavior |
| --- | --- |
| `normal` | Verify the account summary and return typed money |
| `not_found`, `validation` | Return a known business outcome |
| `slow` | Wait within the checkpoint deadline |
| `interstitial` | Dismiss the declared service notice once |
| `session_expired`, `unexpected_dialog`, `permission`, `app_error` | Pause for intervention; resume only if the expected state is restored |
| `ambiguous` | Pause before dispatch when two visible controls match the target |

## How it fits together

```text
goal + typed inputs
       |
       v
live UI observation --> model decision --> contract + policy --> browser action
       |                                                        |
       +--------------------- fresh observation <---------------+
                                  |
                          checked success
                                  |
                      versioned capability JSON
                                  |
                typed inputs --> deterministic replay
                                  |
                   success / business outcome / failure
                                  |
                  bounded recovery or operator handoff
```

The browser adapter uses accessibility-oriented control descriptions and exact locators, with no test IDs in the target application. The artifact describes intent, input bindings, control identity, output extraction, and success conditions; it carries no executable code. See [REPORT.md](REPORT.md) for the decisions, trade-offs, and extension seams.

## Evidence and provenance

`evidence/` contains the saved capability and structured logs for a genuine discovery run, deterministic replays, and exceptional states. The `run.started` event and capability provenance identify the model mode; results identify model-call counts and outcome categories.

The fresh submission discovery is in [evidence/final-discovery/](evidence/final-discovery/), including its saved `capability.json`. It records `codex-bridge` provenance: the live Codex model made **five decisions against the hosted computer-use browser** through the engine's incremental `DiscoverySession` interface. Those decisions produced four UI actions followed by checked completion. They were not a prerecorded action list or a simulated model. The connected adapter delegates browser operations to the hosted CUA surface, while sharing the contract, policy checks, and replay engine. [The fresh replay result](evidence/final-replay/result.json) records success with **zero model calls** and a different member input. The original discovery, example capability, and replay remain in their earlier directories.

`evidence/session_expired/` and `evidence/unexpected_dialog/` verify the takeover mechanism using an **explicit simulated operator test actor**. Both use the existing live hosted page, record a real repair click and ownership epoch transfers, and complete with one handoff and zero model calls. These runs verify the mechanism; they do not claim that a human participant operated the console. The standalone manual console reproduction is separate.

The final [console GUI verification](evidence/console-automated/console-verification.json) goes through the actual **Take control → Restore session → Return control** buttons using an **automated console test actor**. It verifies the same hosted tab, page, and session, one handoff, zero model calls, and a valid 36-event log. Storage preservation was not separately asserted for this hosted run. It does not claim human participation or manual attestation; [the console screenshot](evidence/console-automated/console.png) shows the recorded run.

That GUI check uses a verification-only file relay because the hosted CUA runtime cannot listen for HTTP requests. The relay calls the shipped console HTTP handler and passes its actions to the live hosted page. The normal console still uses its direct HTTP server; this testing transport does not replace that default.

The hosted reproduction helper is [tools/hosted-verification.mjs](tools/hosted-verification.mjs). It accepts an active CUA tab handle; discovery alternates `session.request()` with a fresh model inference and `session.apply(decision)`. It contains no prerecorded discovery decisions.

The HTTP `codex-bridge` provider is also available for an external live model controller, but the included run used the incremental session interface, not that HTTP transport. The standalone `openai` provider is the API path above and needs the reviewer's own key. **No OpenAI API-provider discovery run is claimed.**

Both browser adapters use the same observation extraction and privacy rules. They collect private table and form values across the observed frames, then filter all observation strings before they reach the model or saved snapshots. This includes page and frame titles, frame names, control names, row labels, target descriptors, and URLs. Generic filtering also covers credentials, identifiers, contact details, and money patterns. A target changed by redaction is rejected rather than used as a locator.

The Playwright adapter masks repeated private values outside table cells in screenshots, and filters recorded control descriptors. Logs retain structural evidence and action rationale; they also scrub invocation values and sensitive outputs. The included hosted runs retain redacted structural/DOM snapshots; screenshots are not produced for every hosted run. The event hash chain detects edited or reordered entries when verified; it is not an authenticated audit signature.

```sh
node src/cli.mjs verify-evidence --log evidence/final-discovery/events.jsonl
node src/cli.mjs verify-evidence --log evidence/final-replay/events.jsonl
```

This is a deliberately narrow privacy strategy, not a general guarantee that arbitrary enterprise pages are safe to send to an external provider. The hosted adapter checks application and frame destinations but cannot install the standalone adapter's browser-wide network interception; its live evidence is limited to this controlled local fixture.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/` | CLI, discovery/replay engine, browser adapter, model providers, policy, operator handoff, event timeline, and synthetic app |
| `schemas/` | Reviewable schema for the capability contract |
| `tests/` | Contract, policy, runtime outcomes, and handoff boundary tests |
| `tools/hosted-verification.mjs` | Hosted CUA discovery/replay helper used for the included live evidence |
| `tools/verify-live.mjs` | Standalone browser checks and optional genuine API discovery/replay verification |
| `tools/verify-human.mjs` | Manual console takeover, participant attestation, and same-session proof checks |
| `tools/console-verification.mjs` | Verification of recorded console actions, actor provenance, and session continuity |
| `tools/file-console-transport.mjs`, `tools/console-http-relay.mjs` | Verification-only relay for exercising the shipped console handler with a hosted CUA session |
| `evidence/capability.json` | Capability learned from the live discovery run |
| `evidence/final-discovery/`, `evidence/final-replay/` | Fresh genuine discovery and different-input replay for submission |
| `evidence/console-automated/` | Actual console GUI takeover by a disclosed automated test actor |
| `evidence/` | Sanitized run logs and richer failure evidence |
| `REPORT.md` | Seven-section design write-up required by the assignment |

## Scope

This is a working vertical slice, not a production banking connector. It implements one local web surface and one read-only task. It deliberately blocks risky actions. Desktop adapters, tenant isolation, distributed worker leases, encrypted data sinks, managed identity, formal approval workflows, and production operator authentication are design extensions described in the report.

The assignment also asks for a public repository and submission email. Those are external publishing steps; this local deliverable does not imply they have been performed.
