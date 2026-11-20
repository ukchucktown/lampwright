import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { parse as parseToml } from "@iarna/toml";

import {
  builtInTuiThemes,
  parseTuiStyle,
  TUI_STYLE_ROLES,
  type TuiStyleRole,
  type TuiTextStyle,
  type TuiThemeDefinition,
} from "../tui/theme.js";

/** One row of the theme picker. A choice with a problem cannot be applied. */
export interface ThemeChoice {
  readonly name: string;
  readonly source: "built-in" | "custom";
  /** The theme file, for a custom theme. */
  readonly path: string | null;
  readonly theme: TuiThemeDefinition | null;
  readonly problem: string | null;
}

/**
 * Theme files and the saved theme selection.
 *
 * Reading never writes. Only `select` creates or changes a file, and only the
 * `theme` value of the configuration file.
 */
export interface ThemePreferences {
  list(): Promise<readonly ThemeChoice[]>;
  selected(): Promise<string | null>;
  select(name: string): Promise<void>;
}

export interface ThemePreferencesOptions {
  /** The Lampwright configuration directory; see `lampwrightConfigDirectory`. */
  readonly configDirectory: string;
}

const maximumThemeFileBytes = 64 * 1024;
const themeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Where Lampwright keeps `config.toml` and the `themes` directory. */
export function lampwrightConfigDirectory(input: {
  readonly homeDirectory: string;
  readonly platform: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): string {
  const configured = input.environment.XDG_CONFIG_HOME;
  if (configured !== undefined && configured.trim() !== "")
    return join(configured, "lampwright");
  const appData = input.environment.APPDATA;
  if (input.platform === "win32" && appData !== undefined && appData !== "")
    return join(appData, "lampwright");
  return join(input.homeDirectory, ".config", "lampwright");
}

export function createThemePreferences(
  options: ThemePreferencesOptions,
): ThemePreferences {
  const configPath = join(options.configDirectory, "config.toml");
  const themesDirectory = join(options.configDirectory, "themes");
  return {
    async list() {
      const builtIn = builtInTuiThemes.map((theme): ThemeChoice => ({
        name: theme.name,
        source: "built-in",
        path: null,
        theme,
        problem: null,
      }));
      const files = (await readdir(themesDirectory).catch(() => []))
        .filter((file) => file.toLowerCase().endsWith(".toml"))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const taken = new Set(builtIn.map((choice) => choice.name.toLowerCase()));
      const custom: ThemeChoice[] = [];
      for (const file of files) {
        const path = join(themesDirectory, file);
        const fallbackName = basename(file).slice(0, -".toml".length);
        const text = await readThemeFile(path);
        const parsed =
          typeof text === "string"
            ? parseThemeDocument(text, fallbackName)
            : { ok: false as const, name: fallbackName, reason: text.reason };
        const duplicate = taken.has(parsed.name.toLowerCase());
        taken.add(parsed.name.toLowerCase());
        custom.push({
          // A second theme with a taken name stays listed under its file name.
          name: duplicate ? file : parsed.name,
          source: "custom",
          path,
          theme: parsed.ok && !duplicate ? parsed.theme : null,
          problem: duplicate
            ? `the name "${parsed.name}" is already used by another theme`
            : parsed.ok
              ? null
              : parsed.reason,
        });
      }
      return [...builtIn, ...custom];
    },
    async selected() {
      const text = await readFile(configPath, "utf8").catch(() => null);
      if (text === null) return null;
      try {
        const theme = (parseToml(text) as Record<string, unknown>).theme;
        return typeof theme === "string" && theme !== "" ? theme : null;
      } catch {
        return null;
      }
    },
    async select(name) {
      if (!themeNamePattern.test(name))
        throw new Error(`"${name}" is not a valid theme name`);
      await mkdir(options.configDirectory, { recursive: true });
      const existing = await readFile(configPath, "utf8").catch(() => "");
      const next = withThemeSelection(existing, name);
      const stats = await lstat(configPath).catch(() => null);
      // Write through a link so a configuration file that the user keeps
      // elsewhere stays where it is.
      if (stats?.isSymbolicLink() === true) {
        await writeFile(configPath, next, "utf8");
        return;
      }
      const temporary = `${configPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, next, { encoding: "utf8", flag: "wx" });
        await rename(temporary, configPath);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

async function readThemeFile(
  path: string,
): Promise<string | { readonly reason: string }> {
  const stats = await stat(path).catch(() => null);
  if (stats === null || !stats.isFile())
    return { reason: "the theme file is not a readable file" };
  if (stats.size > maximumThemeFileBytes)
    return { reason: "the theme file is larger than 64 KB" };
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await readFile(path),
    );
  } catch {
    return { reason: "the theme file is not readable UTF-8 text" };
  }
}

export type ThemeDocumentResult =
  | {
      readonly ok: true;
      readonly name: string;
      readonly theme: TuiThemeDefinition;
    }
  | { readonly ok: false; readonly name: string; readonly reason: string };

/** Parses one TOML theme file. `fallbackName` names a file with no `name`. */
export function parseThemeDocument(
  text: string,
  fallbackName: string,
): ThemeDocumentResult {
  const fail = (reason: string, name = fallbackName): ThemeDocumentResult => ({
    ok: false,
    name,
    reason,
  });
  let document: Record<string, unknown>;
  try {
    document = parseToml(text) as Record<string, unknown>;
  } catch (error: unknown) {
    const line =
      typeof error === "object" && error !== null && "line" in error
        ? ` at line ${String(Number(error.line) + 1)}`
        : "";
    return fail(`the file is not valid TOML${line}`);
  }
  const nameValue = document.name ?? fallbackName;
  if (typeof nameValue !== "string" || !themeNamePattern.test(nameValue))
    return fail(
      "the name must use letters, digits, dots, hyphens, and underscores",
    );
  const name = nameValue;
  const unknownKey = Object.keys(document).find(
    (key) => !["name", "extends", "styles"].includes(key),
  );
  if (unknownKey !== undefined)
    return fail(`"${unknownKey}" is not a theme setting`, name);
  const baseName = document.extends ?? builtInTuiThemes[0]!.name;
  const base = builtInTuiThemes.find((theme) => theme.name === baseName);
  if (base === undefined)
    return fail(
      `extends must name a built-in theme: ${builtInTuiThemes.map((theme) => theme.name).join(" or ")}`,
      name,
    );
  const styles = document.styles ?? {};
  if (typeof styles !== "object" || styles === null || Array.isArray(styles))
    return fail("styles must be a table", name);
  const resolved: Record<TuiStyleRole, TuiTextStyle> = { ...base.styles };
  for (const [role, value] of Object.entries(styles)) {
    if (!TUI_STYLE_ROLES.includes(role as TuiStyleRole))
      return fail(
        `"${role}" is not a style role; the roles are ${TUI_STYLE_ROLES.join(", ")}`,
        name,
      );
    if (typeof value !== "string")
      return fail(`the style of "${role}" must be a string`, name);
    const style = parseTuiStyle(value);
    if (!style.ok) return fail(`${role}: ${style.reason}`, name);
    resolved[role as TuiStyleRole] = style.style;
  }
  return { ok: true, name, theme: { name, styles: resolved } };
}

/**
 * Sets the top-level `theme` value and keeps every other line, including
 * comments and tables, exactly as the user wrote it.
 */
export function withThemeSelection(text: string, name: string): string {
  const line = `theme = ${JSON.stringify(name)}`;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/u);
  const firstTable = lines.findIndex((value) => /^\s*\[/u.test(value));
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable;
  const existing = lines.findIndex(
    (value, index) => index < topLevelEnd && /^\s*theme\s*=/u.test(value),
  );
  if (existing !== -1) lines[existing] = line;
  else lines.unshift(line);
  const joined = lines.join(newline);
  return joined.endsWith(newline) ? joined : `${joined}${newline}`;
}
