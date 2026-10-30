---
title: Test Justomp's responsibilities at the cheapest sufficient boundary
applies_when:
  - planning, adding, moving, or reviewing tests for a feature or bug fix
  - changing native tool fixtures, package-manager matrices, or validation commands
  - investigating slow test suites or proposing CI test coverage
tags: [tests, integration, native-tools, performance]
---

First identify the behavior Justomp owns. Its policy, configuration projection, command construction, project selection, installation orchestration, state publication and result reporting need tests. Third-party compiler rules, language semantics, linter rules and solver guarantees belong to their upstream projects. Delete tests of those upstream responsibilities; do not move their catalogues to units or keep a representative manager to run them.

Pure parsing, configuration transformation, selection, validation and result composition belong in unit tests, including happy paths and error variations. Supply metadata and process results directly. A test fixture must not start Python, build archives, install tools or scan a real repository merely to test one of these decisions. Assert the rule settings Justomp generates as data; do not run a compiler to demonstrate each setting's semantics.

Integration tests prove Justomp's flows across real boundaries: discover a project, prepare its tools, publish its configuration, invoke the selected executable, and report the result and effects. Real filesystem publication, symlink containment, watchers, queues coupled to processes, child-process termination, host lifecycle and installed-package loading remain integration tests even when they finish in milliseconds. A promise-only queue decision belongs in units.

Use a minimal successful and failing source witness to prove a diagnostic handoff. Additional cases need a distinct Justomp responsibility, such as selecting tests or a workspace member, forwarding an option, preserving metadata, cancellation or reporting partial installation effects. An installed executable or a real file alone does not justify an integration test. Before installing a tool for an error case, ask whether supplying the same ProcessResult to our code proves the assertion. If so, use a unit test. Never generate thousands of diagnostics to exercise result classification or truncation.

Retain an actual dependency install/lock handoff for each supported manager. Do not multiply that matrix by every lint/typecheck tool and error case: test the outer adapter's exact-version and group requests as units, retaining real executable/config handoffs for distinct layouts such as node_modules, PnP and custom pnpm paths. Do not enumerate upstream rules through API, CLI, OMP or a package-manager matrix. Fold normalization and small input variants into existing lifecycles when the flow remains readable; test our normalization permutations in units.

For each removed or narrowed case, record its responsibility. An upstream-only case needs no replacement. For Justomp-owned behavior, name the replacement unit and any retained integration handoff. Keep a small real witness for process termination, filesystem publication and executable resolution. Test result accounting, diagnostic ownership and failure permutations with supplied boundary responses; these do not each require a fresh native installation. When moving a test, remove unnecessary native and filesystem setup rather than only changing its directory. Test counts and unit/integration ratios are not success criteria.

A flow does not have to traverse every dependency in every test. Use supplied process outputs, file snapshots and adapter results to exercise the real orchestration code. Mock collaborators, never the function whose behavior the test claims to prove. A freshness/error/selection branch needs a native run only when its correctness depends on that native boundary. Packaging tests prove installed exports/resources/entrypoints; host tests prove registration/approval/session wiring. Neither should repeat the full tool-install and diagnostic matrix already covered below.

Reuse immutable package downloads or archive bytes. Keep mutable manifests, locks, project roots, generated outputs, receipts, registries, watchers and processes isolated. Do not copy a prepared .venv, PnP loader or readiness receipt to pretend a fresh project was prepared. A cache miss runs the same required proof; setup failure fails visibly.

Measure the complete required gate once per comparison: check plus a single traversal of all integration tests. Feature aliases are focused development tools and overlap; do not concatenate them into the gate. Compare successful complete runs with the same toolchain and concurrency. Report cold and warm package caches separately, including fixture setup and cleanup. No skips, retries, nightly-only moves, weakened checks or added workers to disguise cost. Do not change production behavior to remove an inconvenient test obligation.

The current optimization target is a warm complete gate of at most 300 seconds and at least 60% reduction against its successful matching baseline. If either target cannot be met with retained owned coverage, report residual costs and ask for the budget/scope decision. Never silently change the target. New expensive tests must bring their measured setup cost, owned flow and boundary rationale to review.

This pack is guidance, not runtime enforcement. CE planning and full review consume matching rules; lite/focused reviews may not. Root AGENTS.md points direct work to this same rule, and the cost command exposes measured regressions. Keep incident history in a verified ce-compound learning linked here, rather than duplicating this policy.
