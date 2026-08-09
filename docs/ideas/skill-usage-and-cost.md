# Track Skill usage and cost

| Field         | Value      |
| ------------- | ---------- |
| Status        | Seed       |
| Last reviewed | 2026-08-09 |
| GitHub issue  | None       |

This document preserves an unapproved product idea and its current design
recommendations. It does not authorize telemetry, persistent state, harness
configuration changes, or implementation. Promote it to a bounded GitHub issue
and reconcile the accepted behavior with `docs/spec.md`, `CONTEXT.md`, and the
module design before changing code.

## Problem

Lampwright can show which Skills are installed, exposed, disabled, or removed,
but it cannot answer:

- Which Skills are actually used?
- When was an Installation last observed in use?
- Which Harness Exposure was used?
- How much context does each enabled Skill consume before activation?
- How many tokens does loading a Skill add?
- Which Skills have no observed use and may be good disable candidates?

The goal is to support informed availability decisions without presenting
heuristic evidence as proof that a Skill is unused.

## Desired outcome

Provide local, cross-harness reporting for:

- observed activations, distinct sessions, and last-observed time;
- the Harness Exposure associated with each observation;
- recurring exposure cost from model-visible names and descriptions;
- activation cost from full Skill instructions and loaded resources;
- associated turn usage when the harness reports it; and
- evidence source and confidence for every usage claim.

The TUI and CLI could eventually sort or filter by uses, last observed,
exposure tokens, and activation tokens. Presentation should say **no usage
evidence observed**, not **unused**, when no trustworthy event exists.

## Measurement model

"Skill cost" is not one number. Keep these measurements separate:

| Measurement     | Meaning                                                                                  | Expected accuracy                                                               |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Exposure cost   | Name, description, and locator advertised to a model while a Harness Exposure is enabled | Deterministic when the harness rendering contract is known; otherwise estimated |
| Activation cost | Full `SKILL.md` instructions added when the Skill is invoked                             | Deterministic when activation is observed and the injected content is known     |
| Resource cost   | Additional reference content loaded while applying the Skill                             | Exact only when successful reads and their content are observable               |
| Turn usage      | Input, cached input, output, and reasoning tokens reported for the associated turn       | Exact when reported by the harness or provider                                  |
| Attributed cost | The portion of a complete turn caused by one Skill                                       | Inherently approximate and must be labeled as associated rather than caused     |

Start with token measurements. Monetary cost is defensible only when a run uses
known API pricing and distinguishes cached input. Subscription-backed harnesses
usually expose activity or limits rather than a marginal dollar cost per turn.

## Recommendation: layered observability

There is no shared skill-usage API across agent harnesses. Use three layers,
ordered by confidence.

### 1. Static cost analysis

Calculate exposure and activation footprints directly from live Inventory and
the harness rendering contract. This requires no transcript audit and can work
before runtime tracking is enabled.

Static analysis should:

- measure each Harness Exposure independently;
- use the harness's tokenizer or documented approximation where available;
- distinguish name-and-description exposure from full Skill activation;
- account for harness aliases and metadata added around a Skill; and
- retain raw token footprint separately from any cached-input estimate.

### 2. Harness-native instrumentation

Prefer supported events, hooks, plugins, or structured client protocols. A
native adapter can observe explicit activation, successful tool execution, and
reported token usage without repeatedly interpreting old transcripts.

Candidate support confirmed during initial research:

- **Codex**: App Server turns can carry an explicit `skill` input item and emit
  thread token-usage updates. `codex exec --json` reports turn-level input,
  cached-input, output, and reasoning tokens. This is high-confidence only for
  sessions Lampwright controls or is configured to observe.
- **Claude Code**: Skill descriptions are normally visible before activation
  and full instructions load when a Skill is used. Lifecycle and tool hooks can
  send structured local events for successful and failed operations.
- **Gemini CLI**: Hooks expose session, timestamp, tool, transcript, model, and
  token-usage metadata suitable for a native collector.
- **OpenCode**: Plugins can inspect model context, provider request/response,
  and tool execution. Its current V2 plugin interface is beta and needs version
  compatibility handling.

Native tracking should be optional, previewable, and reversible because it may
change harness configuration. A future command shape might be:

```text
lampwright tracking enable
lampwright tracking status
lampwright tracking disable
lampwright usage
```

The command names and workflow remain open design questions.

### 3. Structured-log fallback

Use harness-specific log readers for historical backfill and for harnesses that
do not expose runtime events. Treat free-text matching as the weakest evidence.

Log readers should improve on the reviewed `agent-scripts` skill cleaner by:

- filtering individual events by timestamp rather than relying on file
  modification time;
- processing the newest relevant records before enforcing byte limits;
- recognizing each harness's structured schema explicitly;
- verifying successful Skill loads or reads instead of counting any path
  mention;
- resolving evidence to an Installation and Harness Exposure rather than a
  shared name;
- retaining last-observed time and distinct-session counts; and
- reporting skipped, malformed, unsupported, and truncated sources.

The reviewed proof of concept is useful background:
[steipete/agent-scripts skill-cleaner](https://github.com/steipete/agent-scripts/tree/main/skills/skill-cleaner).

## Proposed domain seam

If accepted, add a Usage module rather than teaching Inventory or presentation
modules to inspect harness history. Inventory remains live and disposable; Usage
owns observations and aggregation.

One possible internal shape is:

```ts
type SkillUsageEvent = {
  observedAt: string;
  harnessId: string;
  installationId: string;
  exposureId: string;
  sessionId?: string;
  turnId?: string;
  evidence:
    | "explicit-invocation"
    | "native-activation"
    | "successful-skill-read"
    | "user-mention";
  confidence: "exact" | "strong" | "heuristic";
  activationTokens?: number;
  turnUsage?: {
    inputTokens: number;
    cachedInputTokens?: number;
    outputTokens: number;
    reasoningTokens?: number;
  };
};
```

This shape is illustrative, not an accepted public model. Before adoption,
decide whether an event should reference current Inventory identifiers, durable
fingerprints, or a separate snapshot identity that remains meaningful after an
Installation changes.

## Privacy and state recommendations

Tracking should be explicitly enabled. Read-only Inventory, TUI browse, and dry
run behavior must continue to create no persistent state.

When enabled:

- keep observations local under Lampwright's canonical state root;
- store normalized identity, harness, timestamp, counts, token measurements,
  evidence type, and confidence;
- avoid storing prompts, responses, tool output, search queries, arbitrary
  command arguments, or unrelated local paths;
- disclose every harness configuration file Lampwright proposes to change;
- make hook or plugin installation reversible through the owning harness's
  supported configuration mechanism; and
- provide configurable retention and explicit deletion of collected usage
  state.

The current canonical state root is `$XDG_STATE_HOME/lampwright` when the value
is absolute, otherwise `~/.local/state/lampwright` on macOS and Linux. Windows
uses `%LOCALAPPDATA%\\lampwright`, then `%APPDATA%\\lampwright`, with the existing
documented fallback. The final storage layout remains undecided.

## Suggested delivery sequence

1. Define user-facing measurements and confidence language.
2. Prototype static exposure and activation cost against representative
   harnesses.
3. Define a private Usage adapter interface and normalized observation value.
4. Prototype one native event adapter and one structured-log fallback adapter.
5. Validate identity across duplicated names, links, shared Installations, and
   multi-harness exposures.
6. Decide storage, retention, privacy, and reversible hook-management behavior.
7. Add CLI JSON contracts and human output.
8. Add TUI usage summaries, sorting, and filtering only after collection
   semantics are stable.

## Open questions

- Which harnesses belong in the first supported set?
- Is native tracking installed globally, per workspace, or either?
- Can each harness expose automatic activation as reliably as explicit
  invocation?
- What durable identity should connect historical observations to disposable
  Inventory?
- How should usage survive an Installation move, disable, enable, or managed
  reinstall?
- Should the default retention period be finite, and what should it be?
- Should cost reporting stop at tokens for the first version?
- How should cached input be allocated when several Skills are exposed?
- Should associated turn usage appear when multiple Skills are active?
- How should unsupported or partially observed harnesses appear in the TUI?

## Research references

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex non-interactive JSON events](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code feature loading](https://code.claude.com/docs/en/features-overview)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Gemini CLI hooks](https://geminicli.com/docs/hooks/reference/)
- [OpenCode plugins](https://opencode.ai/v2/docs/build/plugins)
