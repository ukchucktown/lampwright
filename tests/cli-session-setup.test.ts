import { describe, expect, it, vi } from "vitest";

import { formatCliOutput, runCli } from "../src/cli.js";
import {
  buildSessionSetupPlan,
  buildSessionSetupReport,
  buildSessionSetupSnapshot,
} from "../src/testing/index.js";
import { targetRef } from "../src/testing/session-setup-builders.js";
import { parseSessionSetupPublicValue } from "../src/session-setup/index.js";
import type {
  SessionSetupPlan,
  SessionSetupReport,
} from "../src/session-setup/types.js";

describe("Session setup CLI", () => {
  it("scans setup targets with an optional harness and workspace", async () => {
    const snapshot = buildSessionSetupSnapshot();
    const scanSessionSetup = vi.fn(async () => snapshot);
    const result = await runCli(
      [
        "scan",
        "--session-setup",
        "--harness",
        "codex",
        "--workspace",
        "/fixtures/workspace",
      ],
      { scanSessionSetup },
    );
    expect(result).toMatchObject({
      exitCode: 0,
      output: { kind: "session-setup-snapshot" },
    });
    expect(scanSessionSetup).toHaveBeenCalledWith({
      workspace: { path: "/fixtures/workspace" },
      harnessId: "codex",
    });
  });

  it("uses exact setup selectors and grants only the disclosed setup plan", async () => {
    const snapshot = buildSessionSetupSnapshot();
    const executeSessionSetup = vi.fn(
      async (
        _plan: SessionSetupPlan,
        _approvals: {
          readonly grants: readonly import("../src/session-setup/types.js").SetupApproval[];
        },
      ): Promise<SessionSetupReport> => {
        void _plan;
        void _approvals;
        return buildSessionSetupReport();
      },
    );
    const result = await runCli(
      ["disable", "setup:setup-target-1", "--harness", "codex", "--yes"],
      { scanSessionSetup: async () => snapshot, executeSessionSetup },
    );
    expect(result).toMatchObject({
      exitCode: 0,
      output: { kind: "session-setup-report", status: "succeeded" },
    });
    expect(executeSessionSetup.mock.calls[0]![0].intent).toMatchObject({
      harnessId: "codex",
      targets: [{ targetId: "setup-target-1" }],
    });
    expect(executeSessionSetup.mock.calls[0]![1].grants).toEqual([
      { kind: "confirmation", required: true },
      { kind: "scope-disclosure", scope: { kind: "user" }, required: true },
    ]);
  });

  it("supports Enable and a read-only dry run", async () => {
    const snapshot = buildSessionSetupSnapshot();
    const execute = vi.fn(
      async (
        _plan: SessionSetupPlan,
        _approvals: {
          readonly grants: readonly import("../src/session-setup/types.js").SetupApproval[];
        },
      ): Promise<SessionSetupReport> => {
        void _plan;
        void _approvals;
        return buildSessionSetupReport();
      },
    );
    const enabled = await runCli(
      ["enable", "setup:setup-target-1", "--harness", "codex", "--yes"],
      { scanSessionSetup: async () => snapshot, executeSessionSetup: execute },
    );
    expect(enabled.exitCode).toBe(0);
    expect(execute.mock.calls[0]![0].intent.action).toBe("enable");
    const dryRun = await runCli(
      ["disable", "setup:setup-target-1", "--harness", "codex", "--dry-run"],
      { scanSessionSetup: async () => snapshot, executeSessionSetup: execute },
    );
    expect(dryRun).toMatchObject({
      exitCode: 0,
      output: { kind: "session-setup-plan" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects mixed selectors and setup use in legacy verbs before scanning", async () => {
    const scanSessionSetup = vi.fn();
    for (const argv of [
      ["disable", "setup:one", "installation:two", "--harness", "codex"],
      ["remove", "setup:one"],
      ["update", "setup:one"],
      ["enable", "setup:one", "--harness", "codex", "--force"],
      ["enable", "setup:one", "--harness", "codex", "--harness", "codex"],
    ]) {
      const result = await runCli(argv, { scanSessionSetup });
      expect(result.exitCode).toBe(2);
    }
    expect(scanSessionSetup).not.toHaveBeenCalled();
  });

  it("rejects a cross-harness target before planning or execution", async () => {
    const baseline = buildSessionSetupSnapshot();
    const snapshot = {
      ...baseline,
      targets: [{ ...baseline.targets[0]!, harnessId: "claude-code" as const }],
    };
    const planSessionSetup = vi.fn();
    const executeSessionSetup = vi.fn();
    const result = await runCli(
      ["disable", "setup:setup-target-1", "--harness", "codex", "--yes"],
      {
        scanSessionSetup: async () => snapshot,
        planSessionSetup,
        executeSessionSetup,
      },
    );
    expect(result).toMatchObject({
      exitCode: 2,
      output: { kind: "session-setup-error", code: "invalid-usage" },
    });
    expect(planSessionSetup).not.toHaveBeenCalled();
    expect(executeSessionSetup).not.toHaveBeenCalled();
  });

  it("keeps missing IDs blocked and maps execution outcomes to stable exits", async () => {
    const snapshot = buildSessionSetupSnapshot();
    const missing = await runCli(
      ["disable", "setup:stale", "--harness", "codex", "--dry-run"],
      { scanSessionSetup: async () => snapshot },
    );
    expect(missing).toMatchObject({
      exitCode: 3,
      output: { kind: "session-setup-plan" },
    });
    for (const [status, exitCode] of [
      ["unchanged", 0],
      ["blocked", 3],
      ["partial", 1],
      ["failed", 1],
    ] as const) {
      const result = await runCli(
        ["disable", "setup:setup-target-1", "--harness", "codex", "--yes"],
        {
          scanSessionSetup: async () => snapshot,
          executeSessionSetup: async () =>
            buildSessionSetupReport({ status } as never),
        },
      );
      expect(result.exitCode).toBe(exitCode);
    }
  });

  it("renders setup source status, exact owner alternatives, and planner errors", async () => {
    const snapshot = buildSessionSetupSnapshot();
    const scan = formatCliOutput(
      {
        ...snapshot,
        sources: [
          {
            ...snapshot.sources[0]!,
            status: "unavailable",
            reason: "native configuration is absent",
          },
        ],
      },
      false,
    );
    expect(scan).toContain(
      "fixture-source: unavailable; native configuration is absent",
    );
    const target = snapshot.targets[0]!;
    const plan = buildSessionSetupPlan({
      blocks: [
        {
          kind: "owner-gate",
          target: targetRef(target),
          owner: targetRef(target),
        },
      ],
      errors: [{ kind: "planner", reason: "native evidence changed" }],
    });
    const human = formatCliOutput(plan, false);
    expect(human).toContain("setup:setup-target-1");
    expect(human).toContain("Planning error: planner; native evidence changed");
  });

  it("does not confirm or execute a plan with planner errors", async () => {
    const executeSessionSetup = vi.fn();
    const result = await runCli(
      ["disable", "setup:setup-target-1", "--harness", "codex", "--yes"],
      {
        scanSessionSetup: async () => buildSessionSetupSnapshot(),
        planSessionSetup: () =>
          buildSessionSetupPlan({
            errors: [{ kind: "planner", reason: "native evidence changed" }],
          }),
        executeSessionSetup,
      },
    );
    expect(result).toMatchObject({
      exitCode: 3,
      output: { kind: "session-setup-plan" },
    });
    expect(executeSessionSetup).not.toHaveBeenCalled();
  });

  it("publishes and parses setup confirmation and error envelopes", async () => {
    const snapshot = buildSessionSetupSnapshot();
    const result = await runCli(
      ["disable", "setup:setup-target-1", "--harness", "codex"],
      { scanSessionSetup: async () => snapshot },
    );
    expect(result.exitCode).toBe(3);
    expect(parseSessionSetupPublicValue(result.output).kind).toBe(
      "session-setup-confirmation-required",
    );
    expect(formatCliOutput(result.output, false)).toContain(
      "new session may be required",
    );
    const failed = await runCli(["scan", "--session-setup"], {
      scanSessionSetup: async () => {
        throw new Error("offline source failed");
      },
    });
    expect(failed).toMatchObject({
      exitCode: 1,
      output: { kind: "session-setup-error", code: "operational-error" },
    });
    expect(parseSessionSetupPublicValue(failed.output).kind).toBe(
      "session-setup-error",
    );
    const invalid = await runCli(["disable", "setup:one", "--harness"]);
    expect(invalid).toMatchObject({
      exitCode: 2,
      output: { kind: "session-setup-error", code: "invalid-usage" },
    });
    expect(parseSessionSetupPublicValue(invalid.output).kind).toBe(
      "session-setup-error",
    );
  });

  it("refuses production execution with injected setup dependencies", async () => {
    const result = await runCli(
      ["disable", "setup:setup-target-1", "--harness", "codex", "--yes"],
      { scanSessionSetup: async () => buildSessionSetupSnapshot() },
    );
    expect(result).toMatchObject({
      exitCode: 1,
      output: { kind: "session-setup-error", code: "operational-error" },
    });
  });

  it("returns a schema-valid failure when native setup execution fails", async () => {
    const result = await runCli(
      ["disable", "setup:setup-target-1", "--harness", "codex", "--yes"],
      {
        scanSessionSetup: async () => buildSessionSetupSnapshot(),
        executeSessionSetup: async () => {
          throw new Error("native configuration commit failed");
        },
      },
    );
    expect(result).toMatchObject({
      exitCode: 1,
      output: { kind: "session-setup-error", code: "operational-error" },
    });
    expect(parseSessionSetupPublicValue(result.output).kind).toBe(
      "session-setup-error",
    );
  });
});
