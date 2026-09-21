# v0.1.0 implementation roadmap

The [MVP tracking issue](https://github.com/ukchucktown/lampwright/issues/1) is the authoritative progress view. Each child issue contains its own outcome, scope, acceptance criteria, dependencies, and testing expectations.

## Foundation

1. [#2 Scaffold the TypeScript CLI and cross-platform quality gates](https://github.com/ukchucktown/lampwright/issues/2)
2. [#3 Define the core inventory, identity, ownership, and result model](https://github.com/ukchucktown/lampwright/issues/3)

After #3, these can proceed in parallel:

- [#4 Implement generic skill discovery, classification, and Git protection](https://github.com/ukchucktown/lampwright/issues/4)
- [#5 Implement the versioned local JSONC adapter runtime](https://github.com/ukchucktown/lampwright/issues/5)
- [#7 Implement cross-platform quarantine, restore, purge, and retention](https://github.com/ukchucktown/lampwright/issues/7)

## Core removal flow

1. [#6 Implement the pure removal planner and dependency graph](https://github.com/ukchucktown/lampwright/issues/6) after #3, #4, and #5
2. [#8 Implement managed execution, explicit fallback, audit, and verification](https://github.com/ukchucktown/lampwright/issues/8) after #5, #6, and #7

## Parallel adapters and interfaces

After #8, the following issues can be assigned independently:

- [#9 Add the Vercel npx-skills adapter](https://github.com/ukchucktown/lampwright/issues/9)
- [#10 Add the Claude Code plugin adapter](https://github.com/ukchucktown/lampwright/issues/10)
- [#11 Add the Codex plugin adapter](https://github.com/ukchucktown/lampwright/issues/11)
- [#12 Add the Gemini CLI skills and extensions adapter](https://github.com/ukchucktown/lampwright/issues/12)
- [#13 Build the non-interactive CLI and stable JSON output](https://github.com/ukchucktown/lampwright/issues/13)
- [#14 Build the fuzzy-search terminal UI](https://github.com/ukchucktown/lampwright/issues/14)

## Hardening and release readiness

- [#15 Complete cross-platform end-to-end hardening and npm release readiness](https://github.com/ukchucktown/lampwright/issues/15) after #9–#14

Issue #15 prepares a release but explicitly does not publish to npm or make the repository public without separate approval.

## Post-MVP lifecycle refinement

- [#70 Epic: add reversible Skill disable and enable workflows](https://github.com/ukchucktown/lampwright/issues/70)
  1. [#71 Add non-expiring Disabled Storage for suspended Skills](https://github.com/ukchucktown/lampwright/issues/71) and [#72 Materialize per-harness Skill availability in Inventory](https://github.com/ukchucktown/lampwright/issues/72) can proceed in parallel.
  2. [#73 Plan and execute reversible Skill availability changes](https://github.com/ukchucktown/lampwright/issues/73) follows both foundations.
  3. [#74 Add Disabled Skill management to the TUI](https://github.com/ukchucktown/lampwright/issues/74) and [#75 Add disable and enable workflows to the CLI](https://github.com/ukchucktown/lampwright/issues/75) can proceed in parallel after #73.
  4. [#76 Harden reversible Skill availability across platforms](https://github.com/ukchucktown/lampwright/issues/76) closes the feature.
  5. [#77 Suspend complete Manager-owned Skill artifact sets](https://github.com/ukchucktown/lampwright/issues/77) extends Suspended Disable after the original interfaces and hardening are complete.
  6. [#91 Add native disable and enable for complete Plugin boundaries](https://github.com/ukchucktown/lampwright/issues/91) extends the same Availability interfaces without allowing individual Plugin-owned Skill control or Disabled Storage fallback.

## Targeted owner-managed Update

- [#100 Epic: targeted Owner-managed Update lifecycle](https://github.com/ukchucktown/lampwright/issues/100)
  1. [#101 Owner-managed Update specification and delivery plan](https://github.com/ukchucktown/lampwright/issues/101) defines the accepted behavior and safety rules.
  2. [#102 Adapter v2 lifecycle-operation schema](https://github.com/ukchucktown/lampwright/issues/102) depends on #101.
  3. [#103 Planner-ready Update evidence in Inventory](https://github.com/ukchucktown/lampwright/issues/103) depends on #102.
  4. [#104 Targeted Update Planning and Execution interfaces](https://github.com/ukchucktown/lampwright/issues/104) depends on #103.
  5. [#105 Vercel Manager-owned Skill Update](https://github.com/ukchucktown/lampwright/issues/105) depends on #104 and proves the first vertical slice.
  6. [#106 Stable targeted Update command and JSON output](https://github.com/ukchucktown/lampwright/issues/106) and [#107 Targeted Update review in the terminal UI](https://github.com/ukchucktown/lampwright/issues/107) depend on #105 and can proceed in parallel.
  7. [#108 Cross-platform hardening for targeted Update](https://github.com/ukchucktown/lampwright/issues/108) depends on #106 and #107.
  8. [#109 Claude Code Plugin Managed Update](https://github.com/ukchucktown/lampwright/issues/109) and [#110 Gemini extension Managed Update](https://github.com/ukchucktown/lampwright/issues/110) depend on #108 and can proceed in parallel.

## Update acceptance follow-up

1. [#121 Specify Update outcome clarity and TUI response time](https://github.com/ukchucktown/lampwright/issues/121) defines the accepted corrections after Update acceptance testing.
2. [#122 Report successful mixed Update outcomes](https://github.com/ukchucktown/lampwright/issues/122), [#123 bound Git-protection process count](https://github.com/ukchucktown/lampwright/issues/123), and [#124 retain the Update hint in narrow TUI headers](https://github.com/ukchucktown/lampwright/issues/124) depend on #121 and can proceed independently.

## Pre-session availability

[#148 Session setup across coding harnesses](https://github.com/ukchucktown/lampwright/issues/148) replaces the obsolete MCP integration effort in #135–#147. The [Session setup contract](./session-setup.md), [native source profiles](./session-setup-controls.md), and [ADR 0015](./adr/0015-scope-session-setup-to-native-availability.md) define the implemented increment. The [operator guide](./session-setup-guide.md) and [acceptance record](./session-setup-acceptance.md) describe its use and evidence.

1. [#149 Session setup contracts and native source profiles](https://github.com/ukchucktown/lampwright/issues/149) defines the new types, schema, source fixtures, and reuse boundaries after this design is in the implementation base.
2. [#150 Scoped native availability planning and execution](https://github.com/ukchucktown/lampwright/issues/150) depends on #149.
3. [#151 Codex Session setup discovery and availability controls](https://github.com/ukchucktown/lampwright/issues/151) depends on #150.
4. [#152 Session setup CLI selection and versioned JSON](https://github.com/ukchucktown/lampwright/issues/152) depends on #151.
5. [#153 Session setup area in the existing terminal UI](https://github.com/ukchucktown/lampwright/issues/153) depends on #152 and delivers the first complete Codex journey.
6. [#154 Claude Code Session setup adapter](https://github.com/ukchucktown/lampwright/issues/154) depends on #153.
7. [#155 Gemini CLI Session setup adapter](https://github.com/ukchucktown/lampwright/issues/155) depends on #154.
8. [#156 Cross-platform Session setup acceptance and operator guidance](https://github.com/ukchucktown/lampwright/issues/156) depends on #153–#155 and closes the increment.

The sequence keeps one implementation issue active at a time. It adds native Enable and Disable controls in a separate Session setup area and preserves the current Skills & plugins lifecycle views. It does not authorize permanent MCP deletion, account disconnection, publication, or a release.
