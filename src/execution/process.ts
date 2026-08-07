import { spawn } from "node:child_process";

import type {
  ExecutionProcessRequest,
  ExecutionProcessResult,
  ExecutionProcessRunner,
} from "./types.js";

export const systemExecutionProcessRunner: ExecutionProcessRunner = {
  run(request: ExecutionProcessRequest): Promise<ExecutionProcessResult> {
    return new Promise((resolve) => {
      const child = spawn(
        request.command.executable,
        request.command.arguments,
        {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.environment === undefined
            ? {}
            : { env: { ...process.env, ...request.environment } }),
        },
      );
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          resolve({
            exitCode: null,
            stdout,
            stderr: `${stderr}${error.message}`,
          });
        }
      });
      child.on("close", (exitCode) => {
        if (!settled) {
          settled = true;
          resolve({ exitCode, stdout, stderr });
        }
      });
    });
  },
};
