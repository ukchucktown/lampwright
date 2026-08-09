import { access, link, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFileAdapterTrustStore } from "../src/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();

describe("local adapter trust state", () => {
  it("is read-only until an exact adapter hash is explicitly trusted", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const store = createFileAdapterTrustStore(stateRoot);
    const approval = {
      adapterId: "fixture.command",
      contentHash: "a".repeat(64),
    };
    const secondApproval = {
      adapterId: "fixture.other-command",
      contentHash: "b".repeat(64),
    };

    await expect(store.isTrusted(approval)).resolves.toBe(false);
    await expect(access(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await Promise.all([store.trust(approval), store.trust(secondApproval)]);
    await store.trust(approval);

    await expect(store.isTrusted(approval)).resolves.toBe(true);
    await expect(store.isTrusted(secondApproval)).resolves.toBe(true);
    await expect(
      store.isTrusted({ ...approval, contentHash: "d".repeat(64) }),
    ).resolves.toBe(false);
  });

  it("does not trust a decision file with another hard-link owner", async () => {
    const environment = await createTestEnvironment();
    const stateRoot = join(environment.state, "lampwright");
    const store = createFileAdapterTrustStore(stateRoot);
    const approval = {
      adapterId: "fixture.command",
      contentHash: "c".repeat(64),
    };
    await store.trust(approval);
    const directory = join(stateRoot, "trust", "v1", "adapters");
    const [decision] = await readdir(directory);
    if (decision === undefined)
      throw new Error("trust decision was not written");
    await link(
      join(directory, decision),
      join(environment.temporary, "linked-decision.json"),
    );

    await expect(store.isTrusted(approval)).resolves.toBe(false);
  });
});
