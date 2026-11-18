export type TuiColorMode = "truecolor" | "ansi256" | "ansi16" | "none";

export type TuiStyleRole =
  | "title"
  | "active"
  | "muted"
  | "border"
  | "focus"
  | "selected"
  | "success"
  | "info"
  | "warning"
  | "error"
  | "path";

/**
 * A color is `#rrggbb`, an ANSI color name such as `red` or `bright-blue`, an
 * ANSI index from `0` to `255`, or `default` for the terminal's own color.
 * Only a hexadecimal color bypasses the palette of the terminal theme.
 */
export interface TuiTextStyle {
  readonly foreground?: string;
  readonly background?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly reverse?: boolean;
}

export const TUI_STYLE_ROLES = [
  "title",
  "active",
  "muted",
  "border",
  "focus",
  "selected",
  "success",
  "info",
  "warning",
  "error",
  "path",
] as const satisfies readonly TuiStyleRole[];

/** A theme before the terminal's color capability is known. */
export interface TuiThemeDefinition {
  readonly name: string;
  readonly styles: Readonly<Record<TuiStyleRole, TuiTextStyle>>;
}

/** Semantic presentation data; no role paints the application background. */
export interface TuiTheme {
  readonly name: string;
  readonly mode: TuiColorMode;
  readonly styles: Readonly<Record<TuiStyleRole, TuiTextStyle>>;
}

export interface TuiColorContext {
  readonly isTTY: boolean;
  readonly platform: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

const NIGHTFALL_STYLES: TuiTheme["styles"] = {
  title: { foreground: "#82d6d6", bold: true },
  active: { foreground: "#ffd266", bold: true },
  muted: { foreground: "#7f7f7f" },
  border: { foreground: "#2b2e48" },
  focus: { foreground: "#ffffff", background: "#484e5b", bold: true },
  selected: { foreground: "#ffd266", bold: true },
  success: { foreground: "#a9cfa4", bold: true },
  info: { foreground: "#89bcef" },
  warning: { foreground: "#ffd266" },
  error: { foreground: "#e2848d", bold: true },
  path: { foreground: "#82d6d6" },
};

/**
 * Follows the terminal: only palette colors, the default colors, and text
 * attributes, so the terminal theme decides how every role looks. It avoids
 * `bright-black`, which some terminal themes set to their background color.
 */
const TERMINAL_STYLES: TuiTheme["styles"] = {
  title: { foreground: "cyan", bold: true },
  active: { foreground: "yellow", bold: true },
  muted: { dim: true },
  border: { dim: true },
  focus: { bold: true, reverse: true },
  selected: { foreground: "yellow", bold: true },
  success: { foreground: "green", bold: true },
  info: { foreground: "blue" },
  warning: { foreground: "yellow" },
  error: { foreground: "red", bold: true },
  path: { foreground: "cyan" },
};

export const terminalThemeDefinition: TuiThemeDefinition = {
  name: "terminal",
  styles: TERMINAL_STYLES,
};

export const nightfallThemeDefinition: TuiThemeDefinition = {
  name: "nightfall",
  styles: NIGHTFALL_STYLES,
};

/** Built-in themes in picker order; the first is the default. */
export const builtInTuiThemes: readonly TuiThemeDefinition[] = [
  terminalThemeDefinition,
  nightfallThemeDefinition,
];

export const defaultTuiThemeName = terminalThemeDefinition.name;

/** Binds a theme to the color capability of one terminal. */
export function createTuiTheme(
  definition: TuiThemeDefinition,
  mode: TuiColorMode,
): TuiTheme {
  return { name: definition.name, mode, styles: definition.styles };
}

/** The default theme at the highest color capability. */
export const terminalTheme: TuiTheme = {
  name: "terminal",
  mode: "truecolor",
  styles: TERMINAL_STYLES,
};

export const nightfallTheme: TuiTheme = {
  name: "nightfall",
  mode: "truecolor",
  styles: NIGHTFALL_STYLES,
};

export const plainTuiTheme: TuiTheme = {
  name: "plain",
  mode: "none",
  styles: NIGHTFALL_STYLES,
};

export function createNightfallTheme(mode: TuiColorMode): TuiTheme {
  if (mode === "truecolor") return nightfallTheme;
  if (mode === "none") return plainTuiTheme;
  return { name: "nightfall", mode, styles: NIGHTFALL_STYLES };
}

/** Selects the strongest portable color mode without probing or spawning. */
export function detectTuiColorMode(context: TuiColorContext): TuiColorMode {
  const environment = context.environment;
  if (!context.isTTY || has(environment, "NO_COLOR")) return "none";
  if (environment.FORCE_COLOR === "0" || environment.TERM === "dumb")
    return "none";
  if (environment.FORCE_COLOR === "3") return "truecolor";
  if (environment.FORCE_COLOR === "2") return "ansi256";
  if (environment.FORCE_COLOR === "1") return "ansi16";

  const colorTerm = environment.COLORTERM?.toLocaleLowerCase("en-US") ?? "";
  if (colorTerm.includes("truecolor") || colorTerm.includes("24bit"))
    return "truecolor";
  const termProgram =
    environment.TERM_PROGRAM?.toLocaleLowerCase("en-US") ?? "";
  if (
    environment.WT_SESSION !== undefined ||
    termProgram === "ghostty" ||
    termProgram === "wezterm" ||
    termProgram === "iterm.app"
  )
    return "truecolor";

  const term = environment.TERM?.toLocaleLowerCase("en-US") ?? "";
  if (term.includes("truecolor") || term.includes("direct")) return "truecolor";
  if (term.includes("256color") || environment.ANSICON !== undefined)
    return "ansi256";
  if (context.platform === "win32" && environment.ConEmuANSI === "ON")
    return "ansi256";
  return "ansi16";
}

export function styleTui(
  theme: TuiTheme,
  role: TuiStyleRole,
  value: string,
): string {
  if (theme.mode === "none" || value === "") return value;
  const style = theme.styles[role];
  const codes: number[] = [];
  if (style.bold === true) codes.push(1);
  if (style.dim === true) codes.push(2);
  if (style.italic === true) codes.push(3);
  if (style.underline === true) codes.push(4);
  if (style.reverse === true) codes.push(7);
  if (style.foreground !== undefined)
    codes.push(...colorCode(style.foreground, theme.mode, false));
  if (style.background !== undefined)
    codes.push(...colorCode(style.background, theme.mode, true));
  return codes.length === 0
    ? value
    : `${String.fromCharCode(27)}[${codes.join(";")}m${value}${String.fromCharCode(27)}[0m`;
}

const ANSI_COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

type ParsedColor =
  | { readonly kind: "default" }
  | { readonly kind: "palette"; readonly index: number }
  | { readonly kind: "rgb"; readonly rgb: readonly [number, number, number] };

function parseColor(value: string): ParsedColor | null {
  const text = value.toLowerCase();
  if (text === "default") return { kind: "default" };
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/u.exec(text);
  if (hex !== null)
    return {
      kind: "rgb",
      rgb: [
        Number.parseInt(hex[1]!, 16),
        Number.parseInt(hex[2]!, 16),
        Number.parseInt(hex[3]!, 16),
      ],
    };
  if (/^(?:0|[1-9]\d{0,2})$/u.test(text)) {
    const index = Number(text);
    return index <= 255 ? { kind: "palette", index } : null;
  }
  const bright = text.startsWith("bright-");
  const name = ANSI_COLOR_NAMES.indexOf(
    (bright ? text.slice("bright-".length) : text) as never,
  );
  return name === -1
    ? null
    : { kind: "palette", index: name + (bright ? 8 : 0) };
}

/** Whether a value is a color that a theme may use. */
export function isTuiColor(value: string): boolean {
  return parseColor(value) !== null;
}

function colorCode(
  color: string,
  mode: Exclude<TuiColorMode, "none">,
  background: boolean,
): readonly number[] {
  const parsed = parseColor(color);
  if (parsed === null) throw new Error(`Invalid TUI theme color: ${color}`);
  if (parsed.kind === "default") return [background ? 49 : 39];
  if (parsed.kind === "rgb") {
    if (mode === "truecolor") return [background ? 48 : 38, 2, ...parsed.rgb];
    if (mode === "ansi256")
      return [background ? 48 : 38, 5, nearestColor(parsed.rgb, XTERM_256)];
    return basicColorCode(nearestColor(parsed.rgb, ANSI_16), background);
  }
  // A palette color keeps its index so the terminal theme chooses its look.
  if (parsed.index < 16) return basicColorCode(parsed.index, background);
  return mode === "ansi16"
    ? basicColorCode(
        nearestColor(XTERM_256[parsed.index]!, ANSI_16),
        background,
      )
    : [background ? 48 : 38, 5, parsed.index];
}

function basicColorCode(index: number, background: boolean): readonly number[] {
  const base = index < 8 ? (background ? 40 : 30) : background ? 100 : 90;
  return [base + (index % 8)];
}

const STYLE_ATTRIBUTES = [
  "bold",
  "dim",
  "italic",
  "underline",
  "reverse",
] as const;

export type TuiStyleParseResult =
  | { readonly ok: true; readonly style: TuiTextStyle }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses `<foreground> [on <background>] [attributes]`, where every part is
 * optional: `"bright-red"`, `"dim"`, `"white on #484e5b bold"`.
 */
export function parseTuiStyle(value: string): TuiStyleParseResult {
  const words = value
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");
  const style: {
    foreground?: string;
    background?: string;
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
    reverse?: boolean;
  } = {};
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!.toLowerCase();
    const attribute = STYLE_ATTRIBUTES.find((name) => name === word);
    if (attribute !== undefined) {
      if (style[attribute] === true)
        return { ok: false, reason: `"${word}" appears more than once` };
      style[attribute] = true;
      continue;
    }
    if (word === "on") {
      const background = words[index + 1]?.toLowerCase();
      if (background === undefined || !isTuiColor(background))
        return {
          ok: false,
          reason: `"on" needs a background color; found "${background ?? "nothing"}"`,
        };
      if (style.background !== undefined)
        return { ok: false, reason: "more than one background color" };
      style.background = background;
      index += 1;
      continue;
    }
    if (!isTuiColor(word))
      return {
        ok: false,
        reason: `"${word}" is not a color or an attribute`,
      };
    if (style.foreground !== undefined)
      return {
        ok: false,
        reason: `more than one foreground color; use "on" before a background`,
      };
    style.foreground = word;
  }
  return { ok: true, style };
}

function nearestColor(
  color: readonly [number, number, number],
  palette: readonly (readonly [number, number, number])[],
): number {
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  palette.forEach((candidate, index) => {
    const next =
      (color[0] - candidate[0]) ** 2 +
      (color[1] - candidate[1]) ** 2 +
      (color[2] - candidate[2]) ** 2;
    if (next < distance) {
      distance = next;
      nearest = index;
    }
  });
  return nearest;
}

function has(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(environment, key);
}

const ANSI_16: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
];

const XTERM_256: readonly (readonly [number, number, number])[] = [
  ...ANSI_16,
  ...Array.from({ length: 216 }, (_, index) => {
    const levels = [0, 95, 135, 175, 215, 255];
    const red = Math.floor(index / 36);
    const green = Math.floor((index % 36) / 6);
    const blue = index % 6;
    return [levels[red]!, levels[green]!, levels[blue]!] as const;
  }),
  ...Array.from({ length: 24 }, (_, index) => {
    const level = 8 + index * 10;
    return [level, level, level] as const;
  }),
];
