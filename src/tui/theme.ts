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

export interface TuiTextStyle {
  readonly foreground?: string;
  readonly background?: string;
  readonly bold?: boolean;
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
  if (style.foreground !== undefined)
    codes.push(...colorCode(style.foreground, theme.mode, false));
  if (style.background !== undefined)
    codes.push(...colorCode(style.background, theme.mode, true));
  return codes.length === 0
    ? value
    : `${String.fromCharCode(27)}[${codes.join(";")}m${value}${String.fromCharCode(27)}[0m`;
}

function colorCode(
  color: string,
  mode: Exclude<TuiColorMode, "none">,
  background: boolean,
): readonly number[] {
  const rgb = parseHex(color);
  if (mode === "truecolor")
    return [background ? 48 : 38, 2, rgb[0], rgb[1], rgb[2]];
  if (mode === "ansi256")
    return [background ? 48 : 38, 5, nearestColor(rgb, XTERM_256)];
  const index = nearestColor(rgb, ANSI_16);
  const base = index < 8 ? (background ? 40 : 30) : background ? 100 : 90;
  return [base + (index % 8)];
}

function parseHex(value: string): readonly [number, number, number] {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(value);
  if (match === null) throw new Error(`Invalid TUI theme color: ${value}`);
  return [
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
  ];
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
