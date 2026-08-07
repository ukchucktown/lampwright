import { spawn } from "node:child_process";

import type {
  InventoryCommandResult,
  InventoryCommandRunner,
} from "./types.js";

export const systemCommandRunner: InventoryCommandRunner = {
  run(command): Promise<InventoryCommandResult> {
    return new Promise((resolveResult) => {
      const child = spawn(command.executable, command.arguments, {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        ...(command.environment === undefined
          ? {}
          : { env: { ...process.env, ...command.environment } }),
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
  },
};
