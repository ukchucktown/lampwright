import { posix, win32 } from "node:path";

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

export function executableSafetyIssue(executable: string): string | null {
  if (containsUnsafeCharacters(executable)) {
    return "executable contains shell interpolation";
  }
  if (
    !posix.isAbsolute(executable) &&
    !win32.isAbsolute(executable) &&
    /\s/.test(executable)
  ) {
    return "executable is a shell command string";
  }
  if (
    executable
      .split(/\s+/)
      .some((token) => shellControlTokens.has(token.trim()))
  ) {
    return "executable contains a shell control token";
  }

  const executableName = executable.replaceAll("\\", "/").split("/").at(-1);
  if (
    executableName !== undefined &&
    shells.has(executableName.toLowerCase())
  ) {
    return "cannot invoke a shell executable";
  }
  if (
    executableName !== undefined &&
    commandDispatchers.has(executableName.toLowerCase())
  ) {
    return "cannot invoke a command dispatcher";
  }
  return null;
}

export function literalArgumentSafetyIssue(value: string): string | null {
  if (containsUnsafeCharacters(value)) {
    return "argument contains shell interpolation";
  }
  return resolvedArgumentSafetyIssue(value);
}

export function resolvedArgumentSafetyIssue(value: string): string | null {
  if (value.includes("\0") || /[\r\n]/.test(value)) {
    return "argument contains an unsafe control character";
  }
  return shellControlTokens.has(value.trim())
    ? "argument is a shell control token"
    : null;
}

function containsUnsafeCharacters(value: string): boolean {
  return (
    value.includes("\0") ||
    /[\r\n]/.test(value) ||
    interpolationPattern.test(value)
  );
}
