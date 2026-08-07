import { describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  lstat: vi.fn(),
  open: vi.fn(),
}));

vi.mock("node:fs/promises", () => filesystem);

import { verifyRecordAbsent } from "../src/execution/records.js";
import type {
  RemovalActionId,
  VerificationCheckId,
} from "../src/model/types.js";

describe("record cleanup filesystem races", () => {
  it("rechecks the path after opening instead of following a swapped link", async () => {
    const regularFile = {
      dev: 1,
      ino: 2,
      nlink: 1,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    const replacementLink = {
      ...regularFile,
      isFile: () => false,
      isSymbolicLink: () => true,
    };
    const readFile = vi.fn();
    const close = vi.fn(async () => undefined);
    filesystem.lstat
      .mockResolvedValueOnce(regularFile)
      .mockResolvedValueOnce(replacementLink);
    filesystem.open.mockResolvedValueOnce({
      stat: vi.fn(async () => regularFile),
      readFile,
      close,
    });

    await expect(
      verifyRecordAbsent({
        id: "race-check" as VerificationCheckId,
        kind: "record-absent",
        actionId: "record-action" as RemovalActionId,
        path: "/fixtures/manager.json",
        format: "json",
        recordPointer: "/skills/remove",
        expectedRecordHash: null,
      }),
    ).rejects.toThrow(/changed before it could be read/);
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
