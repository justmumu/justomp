---
title: Make Justomp's own repository use its managed checks
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
date: 2026-11-02
type: refactor
---

# Make Justomp's own repository use its managed checks

## Goal Capsule

**Objective:** Contributors can develop Justomp under the same lint, format, typing, test and Git-hook checks that Justomp provides to managed projects.

**Means:** Reuse Justomp's services from repository commands, configure the repository through its own config, and bring its code into conformance (KTD1–KTD6).

**Authority:** The user's settled decisions govern scope; this plan defines the implementation; repository AGENTS.md and the testing pack govern execution. Continue on `codex/self-managed-development`. This is a plan for review, not permission to begin implementation.

**Execution profile:** Cross-cutting refactor with a small JS/TS exclusion feature. Implement and verify in dependency order. Keep source behavior intact while fixing actual strictness errors. The implementer completes local code, documentation and review; publishing requires separate user authorization.

**Stop conditions:** Do not silently disable rules, lower coverage, exclude difficult owned code, patch OMP, replace tooling, or accept incomplete checks. Report a newly required product decision or an unmet timing target. Existing host guard refusals do not authorize bypassing the guard.

## Product Contract

### Summary and problem frame

The repo currently uses a hand-written `tsc`, `biome check` and Bun-test chain. Its managed project policy is stricter and uses Prettier for formatting. Consequently the current contributor gate does not demonstrate that Justomp can manage its own code.

Prior preparation installed Biome 2.6.4 and produced managed projections. Prior diagnostics found 2,948 lint errors, 407 formatting differences and 83 type errors: 43 in owned source/tests/scripts, 21 in dependency declaration files and 19 in private archives. These are previous diagnostic observations, not passing checks. Managed lint correctly reported an incomplete result when output was truncated. Coverage for the intended owned-source set has not yet been measured.

### Requirements

#### Contributor workflow

- **R1.** Repository commands and installed pre-commit/pre-push hooks use the existing Justomp service implementations. Contributors do not need a running OMP session or a self-dependency on Justomp.
- **R2.** The complete repository check verifies lock consistency, formatting, lint, strict typing, unit tests and coverage. Integration tests remain a separate explicit command; the cost gate includes both lanes exactly once.
- **R3.** Setup uses existing managed preparation and hook installation, preserves existing hook conflicts and reports partial failure. It must not install known-failing hooks during the migration. Routine invocations preserve the existing preparation/latest-alignment lifecycle rather than forcing upgrades on every run.
- **R4.** Commands preserve service failures, incomplete results and cancellation. A missing root project, empty effective owned-source set or missing unit result cannot establish that this repository passed.

#### Configuration and conformance

- **R5.** Track the repo's `.justomp/config.json`; continue missing-attribute default flushing and honor explicit values. Runtime state and generated projections remain untracked.
- **R6.** Add optional JS/TS lint and typecheck exclusions through config, defaulting to empty arrays. Only this repository explicitly excludes `.private/**`. Exclusions change selected source entry scope; they are not a filesystem or import-security boundary. Other projects' default scope and test/coverage policy remain unchanged.
- **R7.** Use `skipLibCheck: true` only in this repository's managed TypeScript config. Own source and tests keep strict checks. This skips internal checking of all declaration files, including owned `.d.ts` files; it is not limited to dependencies. Global extension defaults remain unchanged.
- **R8.** Keep the agreed managed Biome, Prettier and TypeScript settings, including complexity maximum 10. Fix owned code and tests without behavior changes or blanket suppressions. Keep the default 70% unit coverage requirement.
- **R9.** Coverage can import all selected owned source and script modules without executing commands, installing hooks, spawning test gates or changing process exit state. Preserve actual direct CLI execution.

#### Evidence and scope

- **R10.** Structured check and integration results remain available to the cost reporter after native temporary artifacts are cleaned up. Report completeness, counts, coverage and costs honestly.
- **R11.** Tests prove Justomp-owned decisions and real integration flows at the cheapest sufficient boundary. Do not add upstream rule catalogues, duplicate native matrices or remove existing boundary evidence to meet timing goals. Apply the declared testing pack.
- **R12.** Document bootstrap, commands, config ownership, editor setup and hook behavior. CI, release/publishing, new public agent tools, new commit-msg hooks, Python/Go exclusion APIs and general coverage redesign are outside this change.

### Settled decisions

- **D1 — repo-only declaration exception.** `session-settled: user-approved` Use R7 rather than patching dependency declarations or blocking on a compatible dependency graph. The user explicitly approved this tradeoff. Governs R7.
- **D2 — explicit private-source exclusion.** `session-settled: user-approved` Add configurable exclusion support and use it for `.private/**`; retain private archives in the repo rather than moving them elsewhere. The user explicitly approved the feature. The JS/TS implementation is sufficient for this repository; arbitrary Go-file exclusion would misrepresent package compilation. Governs R6.
- **D3 — common policy.** `session-settled: user-directed` Biome lint and Prettier format remain the selected tools; this work completes adoption rather than selecting alternatives. Governs R8.

### Flows and acceptance examples

- **F1 / AE1 — checkout and setup:** After locked dependency bootstrap, a contributor prepares the repository and installs the owned hooks through the repo command. A conflicting existing hook is preserved and identified. Running setup again uses the existing idempotence rules.
- **F2 / AE2 — full check:** The root JavaScript project is discovered, lock consistency runs before preparation, and the existing pre-push pipeline runs all R2 checks. A failing early stage cannot be reported as a successful test gate.
- **F3 / AE3 — private archives:** An unimported `.private/archive/example.ts` is omitted by this repo's lint/typecheck configuration. `src/example.ts` remains checked. Removing the exclusion changes subsequent scope and projections; an explicit empty array is honored.
- **F4 / AE4 — imported scripts:** Coverage imports a CLI and the cost script without spawning children, installing hooks, registering live signal handlers or changing exit code. Directly launching the CLI still performs its command and returns its documented result.
- **F5 / AE5 — costs:** Check succeeds only with a complete passing unit result and coverage; integration succeeds only with complete results. The cost report survives managed artifact cleanup and does not infer success from missing reports or shell exit alone.

### Open questions

No launch-blocking product questions remain. Actual coverage percentage, residual refactor defects and full-gate duration are implementation measurements, not assumptions that the plan declares satisfied.

## Planning Contract

### Key technical decisions

**KTD1 — repository-only service dispatcher (R1–R4).** Add an import-safe `scripts/development.ts` for setup, check, lint, lint-fix, format, typecheck, test and integration. Resolve root from the script location and verify `javascript:package.json` through inspection. `check` calls `runPrepush`; individual commands call the existing corresponding services and preparation paths. The public lint CLI is check-only, so the developer lint action must use the appropriate preparation API. Use existing test-file/timeout request semantics for focused work. No shell reconstruction of tool flags, public export, self-package dependency, automatic postinstall or OMP launch is needed.

**KTD2 — policy-specific JS source filters (R5–R6).** Add `lint.javascript.exclude` and `typecheck.javascript.exclude`, both default `[]`, to their models/defaults/resolvers. Use project-relative glob matching that supports dot paths and the repository's existing matching library. Arrays replace defaults; malformed configuration is an explicit error. Reuse matching logic but keep lint and typing policies independent. Preserve the canonical ownership inventory: testing currently calls `collectLintScope` for ownership, not lint policy, and must not inherit a lint exclusion. Existing child-project, dependency, generated-state and symlink boundaries always apply.

Feed the effective filtered source selection through lint preparation, projections, check and fix, and through JS typecheck config graphs, projections, analysis freshness and referenced-project preparation. A policy change in either direction invalidates applicable receipts; do not replace metadata/output snapshots with a filtered source list. TypeScript can still follow imports into excluded files; verify that selected owned code does not import the repo's `.private` archives. Do not post-filter diagnostics to pretend a source was never checked.

**KTD3 — authored policy versus derived state (R5–R8).** Track `.justomp/config.json` using a narrow ignore exception; ignore all sibling runtime state and known root managed projection names. Keep root `tsconfig.json` for module/runtime context. Remove the old independent `biome.json` when scripts move to managed commands, and document editor selection of the generated Biome config. Use existing format exclusions to omit private archives and CE working artifacts while preserving the existing default dependency exclusions. Coverage source ownership includes actual `src/**` and `scripts/**` modules, excluding test fixtures and generated outputs because they are not product code. Keep substantive CLI and reporter logic covered. R7 is applied through managed config, not an alternate compiler invocation.

**KTD4 — import-safe executable modules (R9).** Separate callable command logic from direct-entry invocation. Guard invocation with Bun's `import.meta.main`; register signal handlers and assign exit state only for actual execution, cleaning up listeners when the command finishes. Apply this to the four source CLIs, cost script and new dispatcher; inventory any other selected module with top-level operational effects. Bun documents the direct-versus-imported distinction in its [entrypoint guide](https://bun.sh/guides/util/entrypoint). Excluding entire CLI modules would avoid the symptom while dropping owned coverage.

**KTD5 — behavior-preserving strictness refactor (R8, R11).** Apply safe lint fixes and formatting first, then address remaining own-code diagnostics by subsystem. Separate mechanical edits from logic-bearing extraction. Preserve runtime checks at untrusted boundaries even when current static types make them appear redundant; correct those boundary types where needed. Preserve promise/rejection and cancellation semantics when resolving `useAwait`, optional-property presence for exact optional typing, and public result contracts. Keep legitimately ignored failures explicit instead of concealing new errors. Biome's [complexity rule](https://biomejs.dev/linter/rules/no-excessive-cognitive-complexity/javascript/) has no autofix; reduce complexity by extracting coherent decisions, not by disabling the rule or scattering opaque wrappers.

**KTD6 — structured cost receipts (R2, R4, R10).** The repository dispatcher can persist a repository-internal JSON result for the cost harness before exiting. Extract the full unit result from the check's unit stage and the direct integration result. Preserve early gate failures even when no unit stage exists. Replace the old pass-through Bun JUnit flags and report scraping; managed test artifacts are cleaned up by the service. Do not add a public retention API. Keep fixture timing records, elapsed whole-gate time, cold/warm distinction, existing completeness validation and unit conversion. Version the report/workload identity because managed checks plus coverage differ from the historical shell chain.

**KTD7 — existing hooks after conformance (R3, R12).** Reuse `installPrecommit`, `installPrepush` and the shared installer. First establish conformance without installing hooks; install them at the final checkpoint. Normal setup subsequently performs preparation and installation without duplicating the full test gate. Preserve conflict, backup and idempotence behavior; if the second installer fails, report that the first may already be installed. Hook wrappers and absolute executable paths remain local under `.git`. Commit-message validation remains the existing `repo_commit` responsibility; two installed hooks do not imply terminal commit-msg validation.

**KTD8 — bounded evidence, truthful cost (R10–R11).** Follow `(pack: testing, test-evidence-and-cost.md)`: supplied-data unit tests for policy, selection, reporting and errors; a few real filesystem/process/CLI witnesses for wiring. Preserve existing native manager and tool handoffs. The warm complete-gate target remains 300 seconds, with at least 60% reduction only against a successful matching baseline. Keep historical records; do not call changed workloads matching. If no matching comparison exists or the budget is missed, report the measured residual costs and request an explicit decision rather than changing the threshold.

### Design and interfaces

Repository scripts → existing inspection/config/preparation → existing service APIs → existing adapters.

The `check` path delegates to the same pre-push pipeline as Git; unit results feed a durable repository receipt. The integration command delegates to the managed integration service. `test:cost` invokes each lane once and evaluates those receipts. Neither lane calls `test:cost`.

JS exclusions are a product configuration addition shared by OMP tools and repository callers. They do not introduce a new agent tool or privileged execution route. Existing file-protection and tool approval boundaries remain unchanged. The same config projections and failures are visible regardless of caller.

### Risks and dependencies

- **Large existing diagnostic volume:** safe fixes may modify files before reporting incomplete output. Review those effects; require complete final results rather than treating partial remediation as success.
- **Unknown coverage:** make imports safe before measuring. Add meaningful unit evidence for uncovered owned behavior; R8 forbids reducing the denominator to make the threshold pass.
- **Dependency declarations:** D1 accepts lost internal declaration validation, as explained by [TypeScript's skipLibCheck documentation](https://www.typescriptlang.org/tsconfig/skipLibCheck.html). Own typed use remains checked.
- **Timing:** managed coverage and extra gates change the workload. KTD8 handles comparison and acceptance; prior timing exceptions do not preapprove this run.
- **Runtime/tool versions:** use the repository's pinned Bun and managed installed tools for verification. Current upstream docs explain APIs but are not a test certificate for those pins.
- **Existing working changes:** preserve the preparation's `package.json`/`bun.lock` edits and generated files until the implementation establishes their ownership. Do not discard user work or commit machine-specific projections.

## Implementation Units

### U1. Add JS/TS policy exclusions

**Goal / requirements:** Implement R5–R6 and AE3 without altering test ownership.

**Files:** `src/config/lint/{model,resolve}.ts`, `src/config/lint/javascript/defaults.ts`, corresponding `src/config/typecheck/` files, `src/lint/{scope,fix,projection}.ts`, JS adapter/projection callers, `src/typecheck/scope.ts`, `src/typecheck/javascript/{config-graph,prepare-types}.ts`, `src/typecheck/freshness.ts`, relevant config and scope tests, `docs/lint.md`, `docs/typecheck.md` and default snapshots.

**Approach:** Follow KTD2. Trace all collector call sites before changing signatures. Introduce a shared pure matcher with explicit policy use; leave canonical testing inventory unfiltered. Include policy in existing hashes and preparation/freshness decisions.

**Test scenarios:** Missing fields flush `[]`; explicit arrays and `[]` survive; wrong types fail; dot paths match; child/dependency boundaries remain. Exclude-add and exclude-remove change selected files and projections. A lint-excluded owned file remains a coverage source. Assert projected source lists as data; retain one small JS native handoff demonstrating effective exclusion and included-source diagnostics.

**Verification:** Focused config/scope/projection units plus the existing scope integration witness; no Python/Go or package-manager expansion. **Dependencies:** none.

### U2. Make covered entrypoints import-safe

**Goal / requirements:** R9, AE4.

**Files:** `src/lint/cli.ts`, `src/typecheck/cli.ts`, `src/precommit/cli.ts`, `src/prepush/cli.ts`, `scripts/test-cost.ts`, relevant CLI units, new `tests/integration/development.test.ts` if no existing suitable boundary test.

**Approach:** KTD4; inspect all intended covered entrypoints. Keep argument parsing/output/cancellation contracts. Make substantive command functions testable without executing them at import.

**Test scenarios:** Pure argument/error/result behavior through supplied collaborators. One subprocess imports the operational modules without work, listeners, filesystem changes or exit mutation. Existing installed CLI smoke evidence proves actual launch remains functional; add only missing launch behavior.

**Verification:** Focused CLI units and import/launch witnesses. No full coverage run before this unit is complete. **Dependencies:** none.

### U3. Establish the repository's authored configuration

**Goal / requirements:** R5–R8.

**Files:** `.justomp/config.json`, `.gitignore`, `tsconfig.json` only if runtime context needs preservation, eventual removal of `biome.json` coordinated with U7.

**Approach:** KTD3. Flush using existing config behavior and apply the approved repo values. Keep `.private/**` exclusions independent for lint/typecheck and format. Define real source/test ownership explicitly. Keep unit coverage enabled at 70%; preserve integration defaults. Ignore projections and runtime state while tracking authored config. No generic product default change beyond U1's empty fields.

**Test scenarios:** Config resolves to approved values; missing attributes flush and supplied arrays survive. Source inventory contains owned modules and entrypoints, omits archives/fixtures/generated state, and is nonempty. A selected source must not import `.private` content. A fresh setup can regenerate projections rather than require absolute-path files in Git.

**Verification:** Config/scope evidence and inspection of tracked-versus-derived ownership. **Dependencies:** U1, U2 before any coverage execution.

### U4. Apply mechanical safe fixes and formatting

**Goal / requirements:** R8, R11.

**Files:** Owned `src/`, `scripts/`, `tests/` and supported authored text/config files selected by R5–R6.

**Approach:** Use existing managed safe lint-fix and project-format services. Review braces, type-only imports and other safe changes separately from logical refactors. Preserve fixture payload text that intentionally represents external projects. Do not execute unsafe fixes or suppress remaining findings.

**Test scenarios:** No new tests of Biome or Prettier rules. Existing focused behavioral tests cover touched code; any discovered actual behavior change gets a narrow regression before further editing.

**Verification:** Managed diagnostics distinguish remaining errors from truncation; format check agrees with project_format. **Dependencies:** U3.

### U5. Resolve strict typing and source complexity

**Goal / requirements:** R8 while preserving existing product flows.

**Files:** Affected `src/config`, `src/inspect`, `src/packaging`, `src/dependencies`, `src/lint`, `src/format`, `src/typecheck`, `src/testing`, `src/precommit`, `src/prepush`, protection/OMP modules and their existing focused tests, guided by current diagnostics rather than indiscriminate rewrites.

**Approach:** KTD5. Work module by module: inspect usages, establish the owned decisions, then extract cohesive helpers and fix exact optional values, async contracts, diagnostics and external-data checks. Retain public shapes and native command behavior. Keep complexity at 10. Remove empty blocks only after identifying intentional ignored failures and meaningful error propagation.

**Test scenarios:** For changed decisions, supply success, failure, incomplete, cancellation and optional-presence cases at existing unit boundaries. Keep existing real filesystem publication, process termination and adapter flows. Avoid one native test per complexity finding.

**Verification:** Each module's focused unit suite and affected boundary witness; final strict and lint completion happens in U9. **Dependencies:** U4. This is iterative by subsystem, not one unreviewable rewrite.

### U6. Bring tests and scripts into conformance and close owned coverage gaps

**Goal / requirements:** R8–R11.

**Files:** Affected `tests/unit`, `tests/integration`, `tests/fixtures`, `scripts/`; existing `tests/unit/testing/bun-import-all.test.ts` and coverage-related native witnesses as needed.

**Approach:** Apply KTD5 to helpers and test orchestration while preserving setup/cleanup isolation and assertions. After U2/U3, measure actual managed coverage. Fill gaps by testing Justomp-owned decisions with supplied collaborator responses. If a test is removed or narrowed, record its responsibility and retained/replacement evidence per the pack.

**Test scenarios:** Cover missing owned branches identified by measurement, including error behavior. Do not test compiler/linter rule correctness. Preserve one native unused-source/import-failure flow already covered by the Bun integration tests rather than reproducing it through every caller.

**Verification:** A complete unit result reaches 70% over the intended source inventory with no skipped tests or import side effects. This unit's measurement does not replace the final full gate after remaining changes. **Dependencies:** U5.

### U7. Route contributor commands through Justomp services

**Goal / requirements:** R1–R4, F1–F2.

**Files:** New `scripts/development.ts`, `package.json` scripts, new `tests/unit/development.test.ts`, `tests/integration/development.test.ts`, old `biome.json` removal.

**Approach:** KTD1 and KTD7. Expose setup, check, lint, lint-fix, format, typecheck, test and integration scripts. Preserve focused feature aliases by translating their intent into the managed selection/request contract; do not concatenate overlapping aliases. The complete integration script remains the one full traversal. No automatic hook installation from check/test actions. Provide repo-internal structured report output for U8. The dispatcher itself obeys U2.

**Test scenarios:** Correct root despite another cwd; missing/wrong root rejected; each action calls the intended service once; test_files and timeout mapping; unknown actions/options; completed failure, incomplete result and cancellation map to failure; early check failure persists its receipt. Verify setup conflicts and partial installation reporting through supplied installer results plus existing installation witnesses.

**Verification:** Focused dispatcher units and a minimal real entrypoint handoff. Existing service tests retain responsibility for service behavior. **Dependencies:** U1–U3; final script switch follows U4–U6 conformance.

### U8. Adapt the cost harness to managed results

**Goal / requirements:** R10–R11, AE5.

**Files:** `scripts/test-cost.ts`, `scripts/test-cost-report.ts`, `tests/unit/test-cost-report.test.ts`, `tests/integration/test-cost.test.ts`, cost documentation.

**Approach:** KTD6/KTD8. Check and integration each run once. Validate the structured receipts independently of exit status. Record workload identity and preserve old baselines; no public API change. Convert per-case milliseconds correctly and retain fixture/setup/cleanup measurements. Store reports outside the checked source inventory.

**Test scenarios:** Complete passing results; absent unit stage; early failed check; missing/inconsistent/nonfinite counts or durations; incomplete/failed/cancelled lane; skipped case; unavailable or failing coverage; missing file; mismatched workload baseline. Verify report persistence and exit behavior in one small subprocess flow.

**Verification:** Reporter unit permutations plus existing narrow cost-command integration; actual cost measurement belongs to U9. **Dependencies:** U7.

### U9. Verify adoption, install hooks and document the workflow

**Goal / requirements:** All requirements, F1–F5.

**Files:** `README.md`, `AGENTS.md`, `docs/precommit.md`, `docs/prepush.md`, relevant developer/config docs; installer integration tests only if needed. Hook files remain local.

**Approach:** Perform the final verification contract, then install through existing services. Document bootstrap, explicit setup, commands, editor config selection, targeted tests and config ownership. Describe commit-message validation accurately. Inspect final changes for accidental suppressions, scope shrinkage, tracked runtime files and generated absolute paths.

**Test scenarios:** Fresh-checkout regeneration, idempotent installation, conflict preservation and installed wrappers targeting current repo services. Use existing install tests; one self-repo installation is sufficient. No duplicate complete gate merely because hooks were just installed.

**Verification:** Record actual local conformance, coverage, complete test counts and timing; macOS and Linux entrypoint/hook regressions receive relevant existing boundary verification. Do not claim Linux execution if unavailable; report the missing evidence. **Dependencies:** U6–U8.

## Verification Contract

- During development use focused existing unit tests and boundary witnesses named by the active unit. Reuse the pack's supplied-response pattern; no rule catalogue or native matrix growth.
- The new `bun run check` must delegate to the actual managed pre-push gate and finish completely: lock consistency, format check, lint, strict typecheck, nonzero full unit suite and configured coverage at least 70%.
- `bun run test:integration` must execute the managed complete integration suite once. `bun run test:cost` composes that command and check once; it can supply the final combined evidence rather than rerunning both afterward.
- Final evidence contains effective root/source scope, passing counts, zero failures/skips, coverage, complete-result flags, toolchain, platform and whole-gate duration including setup/cleanup. Truncated output or absent reports are failures to establish completion.
- Preserve the 300-second warm target and matching-baseline policy in KTD8. If the new workload lacks a matching baseline, label the historical comparison non-comparable; do not report the 60% target as met. Request the user decision required by the pack for unresolved budget acceptance.
- Run relevant macOS/Linux entrypoint and hook boundary evidence using available environments; no Windows expansion. No release validation applies because this plan does not release a package.
- Hooks own subsequent routine checks; do not manually repeat a passing full gate for a commit or PR without new changes or unresolved concerns.

## Definition of Done

Every implementation unit has its stated evidence. Contributors can bootstrap and use the repo commands without starting OMP. Authored config is tracked and generated/runtime state is not. The managed full gate passes on owned source/tests with the explicit R6/R7 exceptions only; CLI imports are inert. Integration and cost reports are complete and any timing exception has an explicit user decision. Existing hooks are installed through their shared installer, documentation matches behavior, and the final code review finds no unresolved correctness issue. No CI, publishing, extra hook stage or unrelated runtime mechanism has been added.

## Appendix

### Evidence anchors

- `src/prepush/{service,pipeline,operations}.ts`: canonical full-check order and unit result stage.
- `src/config/load.ts`: missing-attribute flush and explicit-value preservation.
- `src/lint/scope.ts`, `src/typecheck/scope.ts`, `src/testing/scope.ts`: separate policy and ownership concerns.
- `src/typecheck/javascript/config-graph.ts`: generated explicit source lists; root tsconfig exclude alone cannot solve archive selection.
- `src/testing/javascript/{config,bun-import-all}.ts`: source imports performed by coverage.
- `src/testing/service.ts`: temporary artifact lifecycle and structured result return.
- `src/git-hooks/install.ts`: existing installer behavior.
- `compound-packs/testing/test-evidence-and-cost.md`: test responsibility and cost requirements.

The prior diagnostic reports are working evidence in `.private/self-managed/` and OS-temp files. They are not portable acceptance artifacts and do not substitute for U9 verification.
