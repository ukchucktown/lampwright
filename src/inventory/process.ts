import { spawn } from "node:child_process";

export interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export function runCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(executable, arguments_, {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      if (!settled) {
        settled = true;
        resolveResult({ exitCode: null, stdout });
      }
    });
    child.on("close", (exitCode) => {
      if (!settled) {
        settled = true;
        resolveResult({ exitCode, stdout });
      }
    });
  });
}
