import { posix, win32 } from "node:path";

import type {
  AdapterCommandArgument,
  AdapterCommandTemplate,
  AdapterDefinitionV1,
  PlatformVariant,
} from "./types.js";
import { AdapterLoadError } from "./types.js";

const shells = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "csh",
  "csh.exe",
  "dash",
  "dash.exe",
  "fish",
  "fish.exe",
  "ksh",
  "ksh.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "sh.exe",
  "tcsh",
  "tcsh.exe",
  "zsh",
  "zsh.exe",
]);

const commandDispatchers = new Set([
  "busybox",
  "busybox.exe",
  "chroot",
  "chroot.exe",
  "doas",
  "doas.exe",
  "env",
  "env.exe",
  "nice",
  "nice.exe",
  "nohup",
  "nohup.exe",
  "runuser",
  "runuser.exe",
  "setsid",
  "setsid.exe",
  "sudo",
  "sudo.exe",
  "timeout",
  "timeout.exe",
  "xargs",
  "xargs.exe",
]);

const shellControlTokens = new Set([
  "&",
  "&&",
  "&>",
  ";",
  "<",
  "<<",
  "|",
  "||",
  ">",
  ">>",
  "2>",
  "2>>",
]);

const interpolationPattern =
  /`|\$\(|\$\{|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!/;

export function validateCommandSafety(
  definition: AdapterDefinitionV1,
  sourcePath: string | null,
): void {
  for (const probe of definition.probes ?? []) {
    if (probe.kind === "command") {
      validateCommandVariant(probe.command, sourcePath, `probe ${probe.id}`);
    }
  }
  for (const action of definition.actions ?? []) {
    if (action.kind === "managed") {
      validateCommandVariant(action.command, sourcePath, `action ${action.id}`);
    } else {
      for (const runner of variantValues(action.runner)) {
        validateExecutable(runner, sourcePath, `action ${action.id}`);
      }
      validateArguments(action.arguments, sourcePath, `action ${action.id}`);
    }
  }
  for (const verification of definition.verificationRules ?? []) {
    if (verification.kind === "command") {
      validateCommandVariant(
        verification.command,
        sourcePath,
        `verification ${verification.id}`,
      );
    }
  }
}

export function isCommandCapable(definition: AdapterDefinitionV1): boolean {
  return (
    (definition.actions?.length ?? 0) > 0 ||
    definition.probes?.some((probe) => probe.kind === "command") === true ||
    definition.verificationRules?.some(
      (verification) => verification.kind === "command",
    ) === true
  );
}

function validateCommandVariant(
  variant: PlatformVariant<AdapterCommandTemplate>,
  sourcePath: string | null,
  context: string,
): void {
  for (const command of variantValues(variant)) {
    validateExecutable(command.executable, sourcePath, context);
    validateArguments(command.arguments, sourcePath, context);
  }
}

function validateExecutable(
  executable: string,
  sourcePath: string | null,
  context: string,
): void {
  if (containsUnsafeCharacters(executable)) {
    unsafe(sourcePath, `${context} executable contains shell interpolation`);
  }
  if (
    !posix.isAbsolute(executable) &&
    !win32.isAbsolute(executable) &&
    /\s/.test(executable)
  ) {
    unsafe(sourcePath, `${context} executable is a shell command string`);
  }
  if (
    executable
      .split(/\s+/)
      .some((token) => shellControlTokens.has(token.trim()))
  ) {
    unsafe(sourcePath, `${context} executable contains a shell control token`);
  }

  const executableName = executable.replaceAll("\\", "/").split("/").at(-1);
  if (
    executableName !== undefined &&
    shells.has(executableName.toLowerCase())
  ) {
    unsafe(sourcePath, `${context} cannot invoke a shell executable`);
  }
  if (
    executableName !== undefined &&
    commandDispatchers.has(executableName.toLowerCase())
  ) {
    unsafe(sourcePath, `${context} cannot invoke a command dispatcher`);
  }
}

function validateArguments(
  arguments_: readonly AdapterCommandArgument[],
  sourcePath: string | null,
  context: string,
): void {
  for (const argument of arguments_) {
    if (argument.kind !== "literal") {
      continue;
    }
    if (containsUnsafeCharacters(argument.value)) {
      unsafe(sourcePath, `${context} argument contains shell interpolation`);
    }
    if (shellControlTokens.has(argument.value.trim())) {
      unsafe(sourcePath, `${context} argument is a shell control token`);
    }
  }
}

function containsUnsafeCharacters(value: string): boolean {
  return (
    value.includes("\0") ||
    /[\r\n]/.test(value) ||
    interpolationPattern.test(value)
  );
}

function variantValues<Value>(variant: PlatformVariant<Value>): Value[] {
  return [variant.default, variant.darwin, variant.linux, variant.win32].filter(
    (value): value is Value => value !== undefined,
  );
}

function unsafe(sourcePath: string | null, message: string): never {
  throw new AdapterLoadError("unsafe-command", message, sourcePath);
}
