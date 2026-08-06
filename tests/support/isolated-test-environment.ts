import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedTestEnvironment {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
  readonly config: string;
  readonly state: string;
  readonly cache: string;
  readonly temporary: string;
  readonly environmentVariables: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

const inheritedEnvironmentVariables = [
  "COMSPEC",
  "ComSpec",
  "LANG",
  "LC_ALL",
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
] as const;

function createSafeBaseEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const name of inheritedEnvironmentVariables) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }

  return environment;
}

export async function createIsolatedTestEnvironment(): Promise<IsolatedTestEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "skill-cleaner-test-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const config = join(root, "config");
  const state = join(root, "state");
  const cache = join(root, "cache");
  const temporary = join(root, "temporary");

  await Promise.all(
    [home, workspace, config, state, cache, temporary].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );

  return {
    root,
    home,
    workspace,
    config,
    state,
    cache,
    temporary,
    environmentVariables: {
      ...createSafeBaseEnvironment(),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      XDG_CACHE_HOME: cache,
      APPDATA: config,
      LOCALAPPDATA: state,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
    },
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}
