import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const execFileAsync = promisify(execFile);
const createTestEnvironment = createIsolatedTestEnvironmentFixture();

describe("createIsolatedTestEnvironment", () => {
  it("isolates home, config, state, cache, and the current workspace", async () => {
    const environment = await createTestEnvironment();

    const script = `
      process.stdout.write(JSON.stringify({
        cwd: process.cwd(),
        home: process.env.HOME,
        userProfile: process.env.USERPROFILE,
        config: process.env.XDG_CONFIG_HOME,
        state: process.env.XDG_STATE_HOME,
        cache: process.env.XDG_CACHE_HOME,
        appData: process.env.APPDATA,
        localAppData: process.env.LOCALAPPDATA,
        temp: process.env.TEMP,
        tmp: process.env.TMP,
        tmpdir: process.env.TMPDIR
      }));
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--eval", script],
      {
        cwd: environment.workspace,
        env: environment.environmentVariables,
      },
    );

    expect(JSON.parse(stdout)).toEqual({
      cwd: environment.workspace,
      home: environment.home,
      userProfile: environment.home,
      config: environment.config,
      state: environment.state,
      cache: environment.cache,
      appData: environment.config,
      localAppData: environment.state,
      temp: environment.temporary,
      tmp: environment.temporary,
      tmpdir: environment.temporary,
    });

    for (const path of [
      environment.home,
      environment.workspace,
      environment.config,
      environment.state,
      environment.cache,
      environment.temporary,
    ]) {
      const pathFromRoot = relative(environment.root, path);
      expect(pathFromRoot).not.toBe("");
      expect(pathFromRoot).not.toBe("..");
      expect(pathFromRoot.startsWith(`..${sep}`)).toBe(false);
      expect(isAbsolute(pathFromRoot)).toBe(false);
    }
  });

  it("creates a fresh root for every test environment", async () => {
    const first = await createTestEnvironment();
    const second = await createTestEnvironment();

    expect(first.root).not.toBe(second.root);
  });

  it("does not pass unrelated host variables to child processes", async () => {
    const sentinelName = "SKILL_CLEANER_HOST_PATH_SENTINEL";
    process.env[sentinelName] = process.cwd();

    try {
      const environment = await createTestEnvironment();

      expect(environment.environmentVariables[sentinelName]).toBeUndefined();
    } finally {
      delete process.env[sentinelName];
    }
  });

  it("removes its temporary root when disposed", async () => {
    const environment = await createTestEnvironment();

    await environment.dispose();

    await expect(access(environment.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
