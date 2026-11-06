# Coding standards

## Native configuration and readiness

Reconcile only fields owned by Justomp in native tool configurations. Preserve unrelated project settings and comments; reject ambiguous or dynamic configuration with its path rather than executing it or silently replacing it.

Keep configuration readiness separate from tool installation state. Invalid configuration-ownership metadata makes configuration stale; it must not discard a valid installation or trigger an unrelated tool upgrade.

Sources: [PR #3](https://github.com/justmumu/justomp/pull/3), [ownership reconciliation](https://github.com/justmumu/justomp/commit/c24a75e).

## Checkout-independent exclusions

Preserve canonical relative directory exclusions as directory patterns rather than expanding them into ignored files found on the current machine. Shared native configuration must remain stable when those local files are absent in a clean checkout.

Source: [clean-checkout exclusion fix](https://github.com/justmumu/justomp/commit/b449988).

## Test boundaries and concurrent fixtures

Choose test boundaries by the behavior Justomp owns. Apply the [test evidence and cost rule](compound-packs/testing/test-evidence-and-cost.md) for the distinction between pure decisions and real filesystem, process and native-tool handoffs, replacement evidence, and integration setup costs.

When a test deliberately invalidates readiness, stop background fixture watchers that could repair the state before the assertion. Preserve the stale-state rejection and concurrency assertions rather than relaxing them to accommodate that race.

Sources: [testing pack](compound-packs/testing/test-evidence-and-cost.md), [watcher-race fix](https://github.com/justmumu/justomp/commit/76ee544).

## Maintaining this file

Add a defect class only when supported by a fixed review finding, a fix commit, a cleanup across the codebase, or a documented solution, and no automated check already enforces it. State the condition without volatile numbers or symbol names and link its evidence. Update or retire a rule when new evidence changes its justification or an automated check takes over. Keep commands, setup and working procedures in AGENTS.md rather than here.
