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

## Post-MVP lifecycle refinement

- [#70 Epic: add reversible Skill disable and enable workflows](https://github.com/ukchucktown/skill-cleaner/issues/70)
  1. [#71 Add non-expiring Disabled Storage for suspended Skills](https://github.com/ukchucktown/skill-cleaner/issues/71) and [#72 Materialize per-harness Skill availability in Inventory](https://github.com/ukchucktown/skill-cleaner/issues/72) can proceed in parallel.
  2. [#73 Plan and execute reversible Skill availability changes](https://github.com/ukchucktown/skill-cleaner/issues/73) follows both foundations.
  3. [#74 Add Disabled Skill management to the TUI](https://github.com/ukchucktown/skill-cleaner/issues/74) and [#75 Add disable and enable workflows to the CLI](https://github.com/ukchucktown/skill-cleaner/issues/75) can proceed in parallel after #73.
  4. [#76 Harden reversible Skill availability across platforms](https://github.com/ukchucktown/skill-cleaner/issues/76) closes the feature.
  5. [#77 Suspend complete Manager-owned Skill artifact sets](https://github.com/ukchucktown/skill-cleaner/issues/77) extends Suspended Disable after the original interfaces and hardening are complete.
