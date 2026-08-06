# v0.1.0 implementation roadmap

The [MVP tracking issue](https://github.com/ukchucktown/skill-cleaner/issues/1) is the authoritative progress view. Each child issue contains its own outcome, scope, acceptance criteria, dependencies, and testing expectations.

## Foundation

1. [#2 Scaffold the TypeScript CLI and cross-platform quality gates](https://github.com/ukchucktown/skill-cleaner/issues/2)
2. [#3 Define the core inventory, identity, ownership, and result model](https://github.com/ukchucktown/skill-cleaner/issues/3)

After #3, these can proceed in parallel:

- [#4 Implement generic skill discovery, classification, and Git protection](https://github.com/ukchucktown/skill-cleaner/issues/4)
- [#5 Implement the versioned local JSONC adapter runtime](https://github.com/ukchucktown/skill-cleaner/issues/5)
- [#7 Implement cross-platform quarantine, restore, purge, and retention](https://github.com/ukchucktown/skill-cleaner/issues/7)

## Core removal flow

1. [#6 Implement the pure removal planner and dependency graph](https://github.com/ukchucktown/skill-cleaner/issues/6) after #3, #4, and #5
2. [#8 Implement managed execution, explicit fallback, audit, and verification](https://github.com/ukchucktown/skill-cleaner/issues/8) after #5, #6, and #7

## Parallel adapters and interfaces

After #8, the following issues can be assigned independently:

- [#9 Add the Vercel npx-skills adapter](https://github.com/ukchucktown/skill-cleaner/issues/9)
- [#10 Add the Claude Code plugin adapter](https://github.com/ukchucktown/skill-cleaner/issues/10)
- [#11 Add the Codex plugin adapter](https://github.com/ukchucktown/skill-cleaner/issues/11)
- [#12 Add the Gemini CLI skills and extensions adapter](https://github.com/ukchucktown/skill-cleaner/issues/12)
- [#13 Build the non-interactive CLI and stable JSON output](https://github.com/ukchucktown/skill-cleaner/issues/13)
- [#14 Build the fuzzy-search terminal UI](https://github.com/ukchucktown/skill-cleaner/issues/14)

## Hardening and release readiness

- [#15 Complete cross-platform end-to-end hardening and npm release readiness](https://github.com/ukchucktown/skill-cleaner/issues/15) after #9–#14

Issue #15 prepares a release but explicitly does not publish to npm or make the repository public without separate approval.
