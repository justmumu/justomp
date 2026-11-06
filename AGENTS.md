# Development

Use the Bun scripts in `package.json`. Bootstrap with `bun install --frozen-lockfile` and `bun run setup`. Run `bun run check` for managed validation, `bun run check:unit` or `bun run check:integration` for a focused lane, and `bun run test:cost` for both lanes with cost reporting. Feature test aliases overlap; do not combine them into a full gate. Do not repeat a passing full gate without new changes or an unresolved failure.

`.justomp/config.json` owns repository policy; preparation updates managed fields in tracked native tool configs. Keep runtime receipts and reports ignored. Preserve `.private/**`, the `skipLibCheck` exception, shared rules, and the 70% unit coverage threshold.

Read [CODING_STANDARDS.md](CODING_STANDARDS.md) before writing or reviewing code; update it when a change establishes or retires a coding rule.
Read [REVIEW.md](REVIEW.md) before reviewing code; update it when a change establishes or retires a review-policy rule.

Before adding or reviewing tests, read [the test evidence and cost rule](compound-packs/testing/test-evidence-and-cost.md). Every expensive integration test needs a real-boundary justification and a measured setup cost. Pure decision/error permutations belong in units; preserve real filesystem, process and native-tool proofs. Name replacement evidence before removing a test. This rule also applies during direct work and CE's lite/focused review paths, which do not automatically load packs.

Private execution notes belong in `.private/`. Compound Engineering artifacts belong in `.compound-engineering/artifacts/`. Never publish without the user's approval for that publication.

`.compound-engineering/artifacts/solutions/` holds documented solutions to past problems, organized by category with YAML frontmatter (`module`, `tags`, `problem_type`), relevant when implementing or debugging a documented area.

After a solved, verified problem, offer once to invoke the `ce-compound` skill at the completion checkpoint only when the work produced durable project reasoning that is not readily recoverable from the final code, tests, types, comments, or existing documentation, and losing it would plausibly cause recurrence, material risk, or substantial rediscovery. Apply this counterfactual: if the learning document disappeared, would a future engineer reading the final implementation still be likely to repeat the mistake or redo substantial investigation? If not, do not offer. Completion, effort, and diff size alone are not enough. Offer at the checkpoint so a qualifying learning can ship in the PR that produced it, and only where the repository treats captured learnings as tracked, committed knowledge.

Write every report, summary, or handoff to the user through the `ce-noslop` skill. This applies when you are the top-level agent writing to the user, not when you are a subagent reporting to its caller. Do not apply it to code, config, verbatim quotes, or text the user asked to post as written.
