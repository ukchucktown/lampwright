import { describe, expect, it, vi } from "vitest";

import { formatCliOutput, runCli } from "../src/cli.js";
import {
  buildSessionSetupReport,
  buildSessionSetupSnapshot,
} from "../src/testing/index.js";
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

  it("rejects mixed selectors and setup use in legacy verbs before scanning", async () => {
    const scanSessionSetup = vi.fn();
    for (const argv of [
      ["disable", "setup:one", "installation:two", "--harness", "codex"],
      ["remove", "setup:one"],
      ["update", "setup:one"],
      ["enable", "setup:one", "--harness", "codex", "--force"],
    ]) {
      const result = await runCli(argv, { scanSessionSetup });
      expect(result.exitCode).toBe(2);
    }
    expect(scanSessionSetup).not.toHaveBeenCalled();
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
  });
});
