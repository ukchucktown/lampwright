import {
  lstat,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  builtInTuiThemes,
  createThemePreferences,
  createTuiTheme,
  lampwrightConfigDirectory,
  nightfallThemeDefinition,
  parseThemeDocument,
  parseTuiStyle,
  renderTui,
  runTui,
  styleTui,
  terminalThemeDefinition,
  TuiController,
  TUI_STYLE_ROLES,
  withThemeSelection,
  type TuiAction,
  type TuiColorMode,
  type TuiDependencies,
  type TuiState,
  type TuiThemeChoice,
  type TuiThemeDefinition,
} from "../src/index.js";
import { parseTuiLaunch, resolveStartTheme } from "../src/cli.js";
import { buildInventory } from "../src/testing/index.js";
import { createIsolatedTestEnvironmentFixture } from "./support/isolated-test-environment-fixture.js";

const createTestEnvironment = createIsolatedTestEnvironmentFixture();
const escape = String.fromCharCode(27);

function codes(
  style: string,
  mode: TuiColorMode,
  role: (typeof TUI_STYLE_ROLES)[number] = "title",
): string {
  const parsed = parseTuiStyle(style);
  if (!parsed.ok) throw new Error(parsed.reason);
  const theme = createTuiTheme(
    {
      name: "fixture",
      styles: { ...terminalThemeDefinition.styles, [role]: parsed.style },
    },
    mode,
  );
  return styleTui(theme, role, "x")
    .replace(`${escape}[`, "")
    .replace(`mx${escape}[0m`, "");
}

describe("theme style strings", () => {
  it.each([
    ["bright-red", { foreground: "bright-red" }],
    ["#82D6D6 bold", { foreground: "#82d6d6", bold: true }],
    ["200", { foreground: "200" }],
    ["default reverse", { foreground: "default", reverse: true }],
    ["dim", { dim: true }],
    ["on blue", { background: "blue" }],
    [
      "white on #484e5b bold italic underline",
      {
        foreground: "white",
        background: "#484e5b",
        bold: true,
        italic: true,
        underline: true,
      },
    ],
    ["", {}],
  ])("parses %j", (value, style) => {
    expect(parseTuiStyle(value)).toEqual({ ok: true, style });
  });

  it.each([
    ["blurple", "not a color or an attribute"],
    ["#12345", "not a color or an attribute"],
    ["256", "not a color or an attribute"],
    ["red green", "more than one foreground color"],
    ["red on", "needs a background color"],
    ["red on bold", "needs a background color"],
    ["on red on blue", "more than one background color"],
    ["bold bold", "appears more than once"],
  ])("rejects %j", (value, reason) => {
    const parsed = parseTuiStyle(value);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.reason).toContain(reason);
  });
});

describe("theme color output", () => {
  it("keeps palette colors on the palette of the terminal in every mode", () => {
    for (const mode of ["truecolor", "ansi256", "ansi16"] as const) {
      expect(codes("red", mode)).toBe("31");
      expect(codes("bright-blue on yellow", mode)).toBe("94;43");
      expect(codes("default on default", mode)).toBe("39;49");
      expect(codes("bold dim italic underline reverse", mode)).toBe(
        "1;2;3;4;7",
      );
    }
    expect(codes("200", "truecolor")).toBe("38;5;200");
    expect(codes("200", "ansi256")).toBe("38;5;200");
    expect(codes("200", "ansi16")).toMatch(/^(?:3[0-7]|9[0-7])$/u);
  });

  it("sends a hexadecimal color at the capability of the terminal", () => {
    expect(codes("#82d6d6", "truecolor")).toBe("38;2;130;214;214");
    expect(codes("#82d6d6", "ansi256")).toMatch(/^38;5;\d+$/u);
    expect(codes("#82d6d6", "ansi16")).toMatch(/^(?:3[0-7]|9[0-7])$/u);
    expect(codes("on #484e5b", "truecolor")).toBe("48;2;72;78;91");
  });

  it("emits no 24-bit and no 256-color code for the terminal theme", () => {
    const theme = createTuiTheme(terminalThemeDefinition, "truecolor");
    for (const role of TUI_STYLE_ROLES) {
      const styled = styleTui(theme, role, "x");
      expect(styled).not.toContain("38;2;");
      expect(styled).not.toContain("48;2;");
      expect(styled).not.toContain("38;5;");
      expect(styled).not.toContain("48;5;");
      expect(styled).toContain(`${escape}[`);
    }
  });

  it("lists the terminal theme first and keeps Nightfall as a built-in", () => {
    expect(builtInTuiThemes.map((theme) => theme.name)).toEqual([
      "terminal",
      "nightfall",
    ]);
    expect(
      styleTui(
        createTuiTheme(nightfallThemeDefinition, "truecolor"),
        "title",
        "x",
      ),
    ).toContain("38;2;130;214;214");
    expect(
      styleTui(createTuiTheme(nightfallThemeDefinition, "none"), "title", "x"),
    ).toBe("x");
  });
});

describe("theme files", () => {
  it("reads one line for each role and takes the other roles from the base", () => {
    const parsed = parseThemeDocument(
      [
        "# my theme",
        'name = "ocean"',
        'extends = "nightfall"',
        "",
        "[styles]",
        'title = "#3399ff bold"',
        'focus = "white on 24 bold"',
        'muted = "dim"',
      ].join("\n"),
      "file-name",
    );
    expect(parsed).toMatchObject({ ok: true, name: "ocean" });
    if (!parsed.ok) return;
    expect(parsed.theme.styles.title).toEqual({
      foreground: "#3399ff",
      bold: true,
    });
    expect(parsed.theme.styles.focus).toEqual({
      foreground: "white",
      background: "24",
      bold: true,
    });
    expect(parsed.theme.styles.error).toEqual(
      nightfallThemeDefinition.styles.error,
    );
  });

  it("names a theme after its file and extends the terminal theme by default", () => {
    const parsed = parseThemeDocument('[styles]\nerror = "magenta"\n', "mine");
    expect(parsed).toMatchObject({ ok: true, name: "mine" });
    if (!parsed.ok) return;
    expect(parsed.theme.styles.error).toEqual({ foreground: "magenta" });
    expect(parsed.theme.styles.title).toEqual(
      terminalThemeDefinition.styles.title,
    );
  });

  it.each([
    ["[styles\n", "not valid TOML"],
    ['name = "bad name"\n', "the name must use"],
    ['colors = "x"\n', '"colors" is not a theme setting'],
    ['extends = "solarized"\n', "extends must name a built-in theme"],
    ['styles = "x"\n', "styles must be a table"],
    ['[styles]\nheading = "red"\n', '"heading" is not a style role'],
    ["[styles]\ntitle = 3\n", 'the style of "title" must be a string'],
    ['[styles]\ntitle = "blurple"\n', 'title: "blurple" is not a color'],
  ])("reports the reason for %j", (text, reason) => {
    const parsed = parseThemeDocument(text, "fixture");
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.reason).toContain(reason);
  });
});

describe("theme preferences", () => {
  async function fixture() {
    const environment = await createTestEnvironment();
    const configDirectory = join(environment.temporary, "config", "lampwright");
    return {
      environment,
      configDirectory,
      themes: join(configDirectory, "themes"),
      config: join(configDirectory, "config.toml"),
      preferences: createThemePreferences({ configDirectory }),
    };
  }

  it("lists built-in and custom themes without creating a file", async () => {
    const { configDirectory, preferences, themes } = await fixture();
    expect((await preferences.list()).map((choice) => choice.name)).toEqual([
      "terminal",
      "nightfall",
    ]);
    expect(await preferences.selected()).toBeNull();
    await expect(lstat(configDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await mkdir(themes, { recursive: true });
    await writeFile(join(themes, "ocean.toml"), '[styles]\ntitle = "blue"\n');
    await writeFile(join(themes, "broken.toml"), '[styles]\ntitle = "x"\n');
    // Files load in name order, so the first file that claims a name keeps it.
    await writeFile(join(themes, "copy.toml"), 'name = "ocean"\n');
    await writeFile(join(themes, "shadow.toml"), 'name = "Terminal"\n');
    await writeFile(join(themes, "notes.txt"), "not a theme");
    await mkdir(join(themes, "folder.toml"));

    const choices = await preferences.list();
    expect(
      choices.map((choice) => [
        choice.name,
        choice.source,
        choice.theme !== null,
        choice.problem,
      ]),
    ).toEqual([
      ["terminal", "built-in", true, null],
      ["nightfall", "built-in", true, null],
      ["broken", "custom", false, 'title: "x" is not a color or an attribute'],
      ["ocean", "custom", true, null],
      ["folder", "custom", false, "the theme file is not a readable file"],
      [
        "ocean.toml",
        "custom",
        false,
        'the name "ocean" is already used by another theme',
      ],
      [
        "shadow.toml",
        "custom",
        false,
        'the name "Terminal" is already used by another theme',
      ],
    ]);
    expect(await readdir(configDirectory)).toEqual(["themes"]);
  });

  it("saves the selection and keeps the other lines of the configuration", async () => {
    const { config, configDirectory, preferences } = await fixture();
    await preferences.select("nightfall");
    expect(await readFile(config, "utf8")).toBe('theme = "nightfall"\n');
    expect(await preferences.selected()).toBe("nightfall");
    expect(await readdir(configDirectory)).toEqual(["config.toml"]);

    await writeFile(
      config,
      '# my settings\r\ntheme = "nightfall" # old\r\nother = 1\r\n\r\n[section]\r\ntheme = "inner"\r\n',
    );
    await preferences.select("ocean");
    expect(await readFile(config, "utf8")).toBe(
      '# my settings\r\ntheme = "ocean"\r\nother = 1\r\n\r\n[section]\r\ntheme = "inner"\r\n',
    );
    expect(await preferences.selected()).toBe("ocean");
    await expect(preferences.select("../escape")).rejects.toThrow(
      "not a valid theme name",
    );
  });

  it("adds the selection above the first table and reads a damaged file as no selection", async () => {
    expect(withThemeSelection("[section]\nvalue = 1\n", "ocean")).toBe(
      'theme = "ocean"\n[section]\nvalue = 1\n',
    );
    expect(withThemeSelection("", "ocean")).toBe('theme = "ocean"\n');
    const { config, configDirectory, preferences } = await fixture();
    await mkdir(configDirectory, { recursive: true });
    await writeFile(config, "theme = [broken\n");
    expect(await preferences.selected()).toBeNull();
    await writeFile(config, "theme = 3\n");
    expect(await preferences.selected()).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "writes through a linked configuration file",
    async () => {
      const { config, configDirectory, environment, preferences } =
        await fixture();
      const target = join(environment.temporary, "dotfiles-config.toml");
      await writeFile(target, "other = 1\n");
      await mkdir(configDirectory, { recursive: true });
      await symlink(target, config);

      await preferences.select("nightfall");

      expect((await lstat(config)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toBe(
        'theme = "nightfall"\nother = 1\n',
      );
    },
  );

  it("resolves the configuration directory for each platform", () => {
    const home = join("/", "home", "user");
    expect(
      lampwrightConfigDirectory({
        homeDirectory: home,
        platform: "linux",
        environment: {},
      }),
    ).toBe(join(home, ".config", "lampwright"));
    expect(
      lampwrightConfigDirectory({
        homeDirectory: home,
        platform: "darwin",
        environment: { XDG_CONFIG_HOME: join("/", "xdg") },
      }),
    ).toBe(join("/", "xdg", "lampwright"));
    expect(
      lampwrightConfigDirectory({
        homeDirectory: home,
        platform: "win32",
        environment: { APPDATA: join("/", "appdata") },
      }),
    ).toBe(join("/", "appdata", "lampwright"));
    expect(
      lampwrightConfigDirectory({
        homeDirectory: home,
        platform: "linux",
        environment: { APPDATA: join("/", "appdata"), XDG_CONFIG_HOME: " " },
      }),
    ).toBe(join(home, ".config", "lampwright"));
  });
});

const ocean: TuiThemeDefinition = {
  name: "ocean",
  styles: {
    ...terminalThemeDefinition.styles,
    title: { foreground: "#3399ff" },
  },
};
const choices: readonly TuiThemeChoice[] = [
  ...builtInTuiThemes.map((theme): TuiThemeChoice => ({
    name: theme.name,
    source: "built-in",
    path: null,
    theme,
    problem: null,
  })),
  {
    name: "broken",
    source: "custom",
    path: "/themes/broken.toml",
    theme: null,
    problem: 'title: "x" is not a color or an attribute',
  },
  {
    name: "ocean",
    source: "custom",
    path: "/themes/ocean.toml",
    theme: ocean,
    problem: null,
  },
];

describe("start theme selection", () => {
  const preferences = (selected: string | null) => ({
    list: async () => choices,
    selected: async () => selected,
  });

  it("opens the terminal UI for no arguments or one theme option", () => {
    expect(parseTuiLaunch([])).toEqual({ theme: null });
    expect(parseTuiLaunch(["--theme", "ocean"])).toEqual({ theme: "ocean" });
    expect(parseTuiLaunch(["--theme=ocean"])).toEqual({ theme: "ocean" });
    expect(parseTuiLaunch(["--theme"])).toBeNull();
    expect(parseTuiLaunch(["--theme="])).toBeNull();
    expect(parseTuiLaunch(["scan"])).toBeNull();
    expect(parseTuiLaunch(["scan", "--theme", "ocean"])).toBeNull();
  });

  it("uses the option, then the environment, then the saved selection, then the default", async () => {
    const resolve = async (
      option: string | null,
      environmentName: string | undefined,
      selected: string | null,
    ) => {
      const result = await resolveStartTheme({
        option,
        environmentName,
        preferences: preferences(selected),
      });
      return result.ok ? [result.theme.name, result.notice] : result.message;
    };
    expect(await resolve("ocean", "nightfall", "nightfall")).toEqual([
      "ocean",
      null,
    ]);
    expect(await resolve(null, "nightfall", "ocean")).toEqual([
      "nightfall",
      null,
    ]);
    expect(await resolve(null, undefined, "ocean")).toEqual(["ocean", null]);
    expect(await resolve(null, "  ", "ocean")).toEqual(["ocean", null]);
    expect(await resolve(null, undefined, null)).toEqual(["terminal", null]);
  });

  it("refuses an unknown option and replaces a stale preference with the default", async () => {
    const unknown = await resolveStartTheme({
      option: "missing",
      environmentName: undefined,
      preferences: preferences(null),
    });
    expect(unknown).toEqual({
      ok: false,
      message:
        'unknown theme "missing". Available themes: terminal, nightfall, ocean',
    });
    const invalid = await resolveStartTheme({
      option: "broken",
      environmentName: undefined,
      preferences: preferences(null),
    });
    expect(invalid).toMatchObject({
      ok: false,
      message: expect.stringContaining('theme "broken" cannot be used'),
    });
    expect(
      await resolveStartTheme({
        option: null,
        environmentName: undefined,
        preferences: preferences("deleted"),
      }),
    ).toEqual({
      ok: true,
      theme: terminalThemeDefinition,
      notice:
        'The saved theme "deleted" is not available. Lampwright uses "terminal".',
    });
    expect(
      await resolveStartTheme({
        option: null,
        environmentName: "broken",
        preferences: preferences("ocean"),
      }),
    ).toMatchObject({
      ok: true,
      theme: terminalThemeDefinition,
      notice: expect.stringContaining("LAMPWRIGHT_THEME"),
    });
  });
});

describe("theme picker", () => {
  function controllerWith(
    select: (name: string) => Promise<void> = async () => undefined,
    notice: string | null = null,
  ) {
    const selectSpy = vi.fn(select);
    const dependencies: TuiDependencies = {
      scan: async () => buildInventory(),
      plan: () => {
        throw new Error("planning is not part of this test");
      },
      execute: async () => {
        throw new Error("execution is not part of this test");
      },
      themes: {
        current: terminalThemeDefinition,
        notice,
        list: async () => choices,
        select: selectSpy,
      },
    };
    return { controller: new TuiController(dependencies), selectSpy };
  }

  it("previews while the user moves and restores the theme on cancel", async () => {
    const { controller, selectSpy } = controllerWith();
    await controller.start();
    expect(controller.theme?.name).toBe("terminal");

    await controller.dispatch({ kind: "open-theme-picker" });
    expect(controller.state).toMatchObject({ screen: "theme", index: 0 });
    await controller.dispatch({ kind: "move", delta: 1 });
    expect(controller.theme?.name).toBe("nightfall");
    await controller.dispatch({ kind: "move", delta: 1 });
    // A theme with a problem keeps the applied theme on screen.
    expect(controller.theme?.name).toBe("terminal");
    await controller.dispatch({ kind: "move", delta: 99 });
    expect(controller.theme?.name).toBe("ocean");
    await controller.dispatch({ kind: "move", delta: -99 });
    expect(controller.state).toMatchObject({ index: 0 });

    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "cancel" });
    expect(controller.state.screen).toBe("browse");
    expect(controller.theme?.name).toBe("terminal");
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("saves only a confirmed theme and opens the picker on it next time", async () => {
    const { controller, selectSpy } = controllerWith();
    await controller.start();
    await controller.dispatch({ kind: "open-theme-picker" });
    await controller.dispatch({ kind: "move", delta: 3 });
    await controller.dispatch({ kind: "select" });

    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).toHaveBeenCalledWith("ocean");
    expect(controller.theme?.name).toBe("ocean");
    expect(controller.state).toMatchObject({
      screen: "browse",
      model: { notice: 'Theme "ocean" saved.' },
    });
    await controller.dispatch({ kind: "open-theme-picker" });
    expect(controller.state).toMatchObject({ screen: "theme", index: 3 });
  });

  it("refuses a theme with a problem and writes nothing", async () => {
    const { controller, selectSpy } = controllerWith();
    await controller.start();
    await controller.dispatch({ kind: "open-theme-picker" });
    await controller.dispatch({ kind: "move", delta: 2 });
    await controller.dispatch({ kind: "select" });

    expect(controller.state).toMatchObject({
      screen: "theme",
      notice: expect.stringContaining('"broken" cannot be used'),
    });
    expect(selectSpy).not.toHaveBeenCalled();
    const rendered = renderTui(
      controller.state,
      createTuiTheme(terminalThemeDefinition, "none"),
    );
    expect(rendered).toContain("› broken (custom) — not usable");
    expect(rendered).toContain("Custom theme: /themes/broken.toml");
    expect(rendered).toContain("ocean (custom)");
    expect(rendered).toContain("enter use and save");
  });

  it("applies a theme for the session when the save fails", async () => {
    const { controller } = controllerWith(async () => {
      throw new Error("read-only file system");
    });
    await controller.start();
    await controller.dispatch({ kind: "open-theme-picker" });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "select" });

    expect(controller.theme?.name).toBe("nightfall");
    expect(controller.state).toMatchObject({
      screen: "browse",
      model: {
        notice: expect.stringContaining("read-only file system"),
      },
    });
  });

  it("shows the start notice and does not save during a scan or a browse", async () => {
    const { controller, selectSpy } = controllerWith(
      undefined,
      'The saved theme "deleted" is not available.',
    );
    await controller.start();
    expect(controller.state).toMatchObject({
      screen: "browse",
      model: { notice: 'The saved theme "deleted" is not available.' },
    });
    await controller.dispatch({ kind: "move", delta: 1 });
    await controller.dispatch({ kind: "focus", pane: "entries" });
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("reports that themes are unavailable when the host supplies none", async () => {
    const controller = new TuiController({
      scan: async () => buildInventory(),
      plan: () => {
        throw new Error("planning is not part of this test");
      },
      execute: async () => {
        throw new Error("execution is not part of this test");
      },
    });
    await controller.start();
    expect(controller.theme).toBeNull();
    await controller.dispatch({ kind: "open-theme-picker" });
    expect(controller.state).toMatchObject({
      screen: "browse",
      model: { notice: "Themes are unavailable in this host." },
    });
  });

  it("gives the terminal the start theme and each preview before it draws", async () => {
    const { controller: _unused, selectSpy } = controllerWith();
    void _unused;
    const actions: TuiAction[] = [
      { kind: "open-theme-picker" },
      { kind: "move", delta: -1 },
      { kind: "cancel" },
      { kind: "quit" },
    ];
    const drawn: (readonly [string, TuiState["screen"]])[] = [];
    let theme = "none";
    await runTui(
      {
        scan: async () => buildInventory(),
        plan: () => {
          throw new Error("planning is not part of this test");
        },
        execute: async () => {
          throw new Error("execution is not part of this test");
        },
        themes: {
          current: nightfallThemeDefinition,
          list: async () => choices,
          select: selectSpy,
        },
      },
      {
        setTheme: (next) => {
          theme = next.name;
        },
        render: (state) => drawn.push([theme, state.screen]),
        readAction: async () => actions.shift() ?? { kind: "quit" },
        close: () => undefined,
      },
      { rows: 24, columns: 100 },
    );

    expect(drawn).toEqual([
      ["nightfall", "loading"],
      ["nightfall", "browse"],
      ["nightfall", "theme"],
      ["terminal", "theme"],
      ["nightfall", "browse"],
    ]);
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
