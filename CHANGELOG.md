# Changelog

## [0.2.1] - 2026-11-06

<!-- justomp:release:0.2.1:start -->

### Refactoring

- **lint:** establish owned native tool infrastructure (U1) 0315cb4
- **lint:** run lint and format with owned tools adb888d

### Documentation

- **lint:** document release-owned toolchain boundaries (U6) da0464f

### Maintenance

- configure engineering workflows and document project standards 61c65e1

<!-- justomp:release:0.2.1:end -->

## [0.2.0] - 2026-11-05

<!-- justomp:release:0.2.0:start -->

### Features

- add npm and pnpm dependency adapters bcaa6a1
- add opt-in native fixes to project lint 3b5c192
- add shared project lint and typecheck workflows 083cde7
- add stable project IDs and JavaScript workspace ownership 96dc03a
- add watcher-assisted project inspection for OMP ca21942
- add Yarn and Bun dependency adapters fe7c8ed
- define dependency requests and preserve declaration provenance 6c758cb
- **dependencies:** add native consistency checks to sync 4d4850f
- expose verified native dependency tools in OMP a665659
- format owned project files through shared formatter policy fa0f85e
- manage Go modules and report shared resolution effects 08eeda1
- manage Python dependencies through native uv operations d29b546
- protect managed files in general OMP tools 211768a
- **release:** define repository release policy and tool contracts a920050
- **release:** prepare repository versions, changelogs and tags 6ed5fad
- run project integration tests through shared native runners c13772d
- run project unit tests with native runners and coverage e125fe7
- run repository checks before commits through trusted tools 2515d7a
- serialize and supervise native dependency operations c1c5042
- verify repository checks before pushes a32eed1

### Fixes

- align managed tools to latest on project discovery 960ec14
- **ci:** exclude generated Biome config from format checks 1c25b29
- **ci:** give native pnpm lifecycles their established timeout 3c5cd6e
- **ci:** isolate stale typecheck readiness from watcher repair 76ee544
- **lint:** keep native exclusions stable across clean checkouts b449988

### Refactoring

- **config:** track native configuration field ownership c24a75e
- **config:** use standard native tool configurations af43060
- develop Justomp with its own managed checks 8c206a1
- **lint:** replace managed ESLint with Biome 2775e50
- **lint:** use release-pinned Justomp-owned Ruff and Biome without adding project lint dependencies; preserve legacy declarations and native configuration ownership
- prepare repository for managed development checks 60fb563

### Documentation

- record approved dependency tools implementation plan 771ffe9
- record approved project test implementation plan 28a932b

### Tests

- **lint:** expect stable directory exclusions in scope flow 124f6bd

### CI

- validate pull requests on Linux and macOS aa7bc80

<!-- justomp:release:0.2.0:end -->
