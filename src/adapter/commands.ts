import {
  executableSafetyIssue,
  literalArgumentSafetyIssue,
} from "../model/command-safety.js";
import type {
  AdapterCommandArgument,
  AdapterCommandTemplate,
  AdapterDefinition,
  PlatformVariant,
} from "./types.js";
import { AdapterLoadError } from "./types.js";

export function validateCommandSafety(
  definition: AdapterDefinition,
  sourcePath: string | null,
): void {
  for (const probe of definition.probes ?? []) {
    if (probe.kind === "command") {
      validateCommandVariant(probe.command, sourcePath, `probe ${probe.id}`);
    }
  }
  for (const action of definition.schemaVersion === 1
    ? (definition.actions ?? [])
    : []) {
    if (action.kind === "managed") {
      validateCommandVariant(action.command, sourcePath, `action ${action.id}`);
    } else {
      validateExecutable(
        action.runner,
        sourcePath,
        `action ${action.id}`,
        true,
      );
      validateArguments(action.arguments, sourcePath, `action ${action.id}`);
    }
  }
  for (const operation of definition.schemaVersion === 2
    ? (definition.lifecycleOperations ?? [])
    : []) {
    if (operation.invocation.kind === "direct") {
      validateCommandVariant(
        operation.invocation.command,
        sourcePath,
        `lifecycle operation ${operation.id}`,
      );
    } else {
      validateExecutable(
        operation.invocation.runner,
        sourcePath,
        `lifecycle operation ${operation.id}`,
        true,
      );
      validateArguments(
        operation.invocation.arguments,
        sourcePath,
        `lifecycle operation ${operation.id}`,
      );
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

export function isCommandCapable(definition: AdapterDefinition): boolean {
  return (
    (definition.schemaVersion === 1
      ? (definition.actions?.length ?? 0) > 0
      : (definition.lifecycleOperations?.length ?? 0) > 0) ||
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
  allowPackageRunner = false,
): void {
  const issue = executableSafetyIssue(executable, { allowPackageRunner });
  if (issue !== null) {
    unsafe(sourcePath, `${context} ${issue}`);
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
    const issue = literalArgumentSafetyIssue(argument.value);
    if (issue !== null) {
      unsafe(sourcePath, `${context} ${issue}`);
    }
  }
}

function variantValues<Value>(variant: PlatformVariant<Value>): Value[] {
  return [variant.default, variant.darwin, variant.linux, variant.win32].filter(
    (value): value is Value => value !== undefined,
  );
}

function unsafe(sourcePath: string | null, message: string): never {
  throw new AdapterLoadError("unsafe-command", message, sourcePath);
}
