import { homedir } from "node:os";
import { posix, win32 } from "node:path";

// This persisted application identifier predates the Lampwright product name.
// Changing it would hide existing Trash, Disabled Storage, trust, and audit data.
const LOCAL_STATE_DIRECTORY = "skill-cleaner";

export interface LocalStateEnvironment {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly variables: Readonly<NodeJS.ProcessEnv>;
  readonly override?: string;
}

export class LocalStatePathError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`local state path must be absolute: ${path}`);
    this.name = "LocalStatePathError";
    this.path = path;
  }
}

export function defaultLocalStateRoot(
  environment: LocalStateEnvironment = {
    platform: process.platform,
    homeDirectory: homedir(),
    variables: process.env,
  },
): string {
  if (environment.override !== undefined) {
    return requireAbsolute(environment.override, environment.platform);
  }
  const path = environment.platform === "win32" ? win32 : posix;
  const home = requireAbsolute(environment.homeDirectory, environment.platform);
  switch (environment.platform) {
    case "win32":
      return path.join(
        firstAbsolute(
          environment.platform,
          environment.variables.LOCALAPPDATA,
          environment.variables.APPDATA,
        ) ?? path.join(home, "AppData", "Local"),
        LOCAL_STATE_DIRECTORY,
      );
    case "darwin":
      return path.join(
        home,
        "Library",
        "Application Support",
        LOCAL_STATE_DIRECTORY,
      );
    default:
      return path.join(
        firstAbsolute(
          environment.platform,
          environment.variables.XDG_STATE_HOME,
        ) ?? path.join(home, ".local", "state"),
        LOCAL_STATE_DIRECTORY,
      );
  }
}

function firstAbsolute(
  platform: NodeJS.Platform,
  ...values: readonly (string | undefined)[]
): string | undefined {
  const path = platform === "win32" ? win32 : posix;
  return values.find((value) => value !== undefined && path.isAbsolute(value));
}

function requireAbsolute(value: string, platform: NodeJS.Platform): string {
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(value)) {
    throw new LocalStatePathError(value);
  }
  return path.resolve(value);
}
