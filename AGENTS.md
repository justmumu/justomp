# Development

Use the Bun scripts in package.json. `bun run check` checks types, formatting,
lint and unit tests; `bun run test:integration` runs all real integration
boundaries. Feature aliases are for focused work and overlap: do not combine
them as the full gate.

Before adding or reviewing tests, read
[the test evidence and cost rule](compound-packs/testing/test-evidence-and-cost.md).
Every expensive integration test needs a real-boundary justification and a
measured setup cost. Pure decision/error permutations belong in units; preserve
real filesystem, process and native-tool proofs. Name replacement evidence
before removing a test. This rule also applies during direct work and CE's
lite/focused review paths, which do not automatically load packs.

Private execution notes belong in `.private/`. Compound Engineering artifacts
belong in `.compound-engineering/artifacts/`. Never publish without the user's
approval for that publication.
