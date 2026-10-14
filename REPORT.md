# Relay: Design report

## Architecture

Relay handles one task: find a member in a fictional banking app and read their savings balance. The app runs locally with synthetic records, so failures can be tested without real customer data or bank access. The implementation uses Node.js, with browser access kept in a separate adapter.

During discovery, the model sees the current page and proposes the next action. The runner checks the action, finds the matching control, applies the safety rules, and then acts. It repeats this process until it verifies the result or reaches a limit. A successful run produces a reusable JSON file called a capability. Replay follows that file with new inputs and makes no model calls.

The fresh submission discovery in `evidence/final-discovery/` came from a live Codex model using the hosted browser. Five model decisions produced four UI actions and a verified result. Its provider label is `codex-bridge`, but the run used `DiscoverySession` directly, not the separate HTTP bridge. `evidence/final-replay/` records successful replay with a different member and zero model calls. The project also includes a Playwright command-line path and an OpenAI provider. Neither standalone browser launch nor an API-backed discovery run was verified here: the host blocked browser launch, and no API key was configured.

## Artifact schema

The capability file contains the task and app version, starting route, input definitions, ordered actions, output definitions, success checks, known outcomes, and allowed recovery steps. It also records how it was discovered. Safety permissions live outside this file, so a learned flow cannot give itself more access.

The input, `member_id`, is a sensitive five-digit string. Actions refer to that parameter by name; they do not save the member ID used during discovery. The output definition says where to read the savings balance. The value is returned as a currency and integer cents, avoiding decimal rounding errors. Invalid amounts are rejected.

Targets describe controls by role, name, frame, or table row. They cannot contain executable code and must match exactly one visible control. Before reporting success, Relay checks that the account summary is open and the member ID matches the caller's input. It validates the extracted balance before saving the capability.

The schema deliberately supports a small set of actions. Unsupported versions, unknown actions, and invalid parameter references fail validation before the browser is used. Adding an action requires changes to both validation and execution.

## Determinism & error handling

Replay uses fixed actions and checks. It does not ask a model to improvise when the page changes. Before acting, the runner checks the destination, target, and expected page state. It waits for slow loads within a deadline and can dismiss the declared service notice once.

Runs return four kinds of result:

- `success`: the page and member identity were verified, and a valid balance was read.
- `business_outcome`: the app reported an expected result, such as a missing member or rejected input.
- `intervention_required`: execution paused because of an expired session, permission error, unexpected dialog, or missing or ambiguous control.
- `failure`: validation, a safety rule, or an execution error prevented completion. Examples include a checkpoint timeout, exhausted recovery, or a malformed balance.

A completed action is not repeated after handoff. Logs record the step, expected and observed state, reason for stopping, and control transfers. Linked hashes help detect later edits or reordered events; they are not a signed audit record. Hosted runs include redacted page snapshots, while the Playwright adapter also supports masked screenshots. The saved successful replay used zero model calls.

The operator console and saved-run viewer turn those events into a timeline. It distinguishes model proposals, executed actions, and recorded checkpoint checks. Earlier logs clearly mark details that were not recorded.

## Heterogeneity & multi-tenant

The browser adapter handles observation, control lookup, actions, and value extraction. This lets Playwright and the hosted browser use the same runner. The demo includes a nested frame and table-based labels, without special test IDs. That covers some awkward web layouts, but not every legacy application.

A desktop adapter could use operating-system accessibility controls. Coordinate-based clicks would need separate checks for screen size, anchor position, and whether the screenshot is still current. Neither desktop nor coordinate execution is implemented.

For multiple tenants, the proposed approach is one reviewed capability per app, task, and supported version range. Each tenant would supply its allowed address, starting route, and limited label or target overrides. Those settings could not expand safety permissions. Page checks would detect changes and disable the affected tenant configuration until a revised flow was reviewed. Shared capability and tenant configuration hashes would be recorded together. This is a design for future work, not a working multi-tenant service.

## Escalation & handoff

When a run is blocked, Relay pauses and records the task, step, page state, and reason. An operator can take control of the same browser session, preserving cookies and navigation. The runner cannot send actions while the operator owns that session.

The operator can use the console's control list or interact with the visible browser, then return control through the console. Console actions are logged without entered values. Direct browser recording is best effort: it can capture trusted clicks and changes, but it is not a complete record of every edit or navigation.

Before continuing, Relay checks that the page is allowed and the expected state has been restored. Returning control does not skip these checks. The final console GUI run in `evidence/console-automated/` used an automated actor to click Take control, Restore session, and Return control. It resumed the same hosted tab, page, and session with one handoff and zero model calls. Storage preservation was not separately asserted. Earlier session-expiry and unexpected-dialog runs also exercised recovery on the actual page. None claims a human participant.

The GUI check needed a verification-only file relay because the hosted CUA runtime cannot listen for HTTP requests. It uses the shipped console HTTP handler; the normal direct HTTP server remains the default. A separate manual check waits for a person and terminal attestation. It is implemented but has not been performed; automated GUI clicks do not certify human participation.

## Safety

The runner enforces permitted websites, routes, and actions independently of the model. It blocks irreversible actions and controls with known financial or destructive labels. Checks include the actual control name, so a model cannot bypass them by describing a transfer button as harmless. Label checks are useful for this demo; they cannot identify every risky action in unknown software.

Playwright also intercepts network requests. The hosted adapter checks page and frame destinations but does not provide the same network protection. Both limits matter when moving beyond the controlled local app.

Invocation values stay in memory, and the extracted balance is returned to the caller. Both are redacted from saved evidence. Logs and artifacts do not retain raw model transcripts, credentials, or unmasked page screenshots. Sensitive table values and form controls are masked or removed. This reduces exposure but does not guarantee that an unfamiliar page is safe to send to a model. A production deployment would need approved providers, authenticated operators, protected outputs, and data-retention rules. The local console and HTTP bridge are development tools restricted to the local machine.

Both browser adapters now share one observation filter. Private values found in any observed frame are removed from titles, control labels, frame names, row labels, target descriptions, URLs, and page text before the observation goes to a model or snapshot. Playwright screenshot masks also cover those values when repeated elsewhere on the page. If filtering changes a target, Relay refuses to act on that target. Tests deliberately repeat fictional private data across frames and labels to check these boundaries.

## Cuts

The project is limited to one task in a synthetic web app. It does not implement desktop automation, tenant infrastructure, work queues, signed capability approval, or real bank authentication. The test scenarios demonstrate specific recovery paths, not compatibility with arbitrary enterprise systems. Standalone Playwright tests and API-backed discovery remain unverified in this environment. The saved live evidence uses the hosted browser.

Additional verification commands cover native Playwright, API-backed discovery, and a person's manual takeover. These remain unverified here. The required real discovery and replay were demonstrated through the hosted browser, and the console GUI handoff was checked with a disclosed automated actor. These results do not claim native/API verification or actual human participation.

The next steps would be tests against independent legacy apps, reviewed capability versions, constrained tenant settings, and authenticated operator access. Financial writes would also need transaction-specific authorization, protection against duplicate submissions, and a way to resolve uncertain outcomes.
