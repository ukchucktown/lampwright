import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import { createInterface } from "node:readline/promises";

import { renderTui } from "./render.js";
import type { TuiAction, TuiState, TuiTerminal } from "./types.js";

type TerminalInput = NodeJS.ReadStream;
type TerminalOutput = NodeJS.WriteStream;

export function createNodeTuiTerminal(
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
): TuiTerminal {
  return input.isTTY && output.isTTY
    ? new RawTuiTerminal(input, output)
    : new LineTuiTerminal(input, output);
}

export function parseLineTuiAction(state: TuiState, line: string): TuiAction {
  const value = line.trim();
  if (state.screen === "browse") {
    if (value === "") return { kind: "select" };
    if (value === "up" || value === "k") return { kind: "move", delta: -1 };
    if (value === "down" || value === "j") return { kind: "move", delta: 1 };
    if (value === "expand" || value === "e") return { kind: "toggle-expand" };
    if (value === "select" || value === "open") return { kind: "select" };
    if (value === "clear") return { kind: "set-query", value: "" };
    if (value === "backspace") return { kind: "delete-query" };
    if (value === "quit" || value === "q") return { kind: "quit" };
    if (value.startsWith("search "))
      return { kind: "set-query", value: value.slice("search ".length) };
    if (value.startsWith("/"))
      return { kind: "set-query", value: value.slice(1) };
    return { kind: "set-query", value };
  }
  if (state.screen === "plan") {
    if (value === "yes" || value === "y") return { kind: "confirm" };
    if (value === "force" || value === "f") return { kind: "force" };
    if (value === "quit" || value === "q") return { kind: "quit" };
    if (value === "no" || value === "n" || value === "back")
      return { kind: "cancel" };
    return { kind: "noop" };
  }
  if (state.screen === "report") {
    if (value === "up" || value === "k") return { kind: "move", delta: -1 };
    if (value === "down" || value === "j") return { kind: "move", delta: 1 };
    if (value === "fallback" || value === "f") return { kind: "fallback" };
    if (value === "quit" || value === "q" || value === "done")
      return { kind: "quit" };
    return { kind: "noop" };
  }
  if (state.screen === "error") return { kind: "quit" };
  return { kind: "noop" };
}

class RawTuiTerminal implements TuiTerminal {
  private readonly pending: { readonly text: string; readonly key: Key }[] = [];
  private waiter:
    ((value: { readonly text: string; readonly key: Key }) => void) | null =
    null;
  private readonly onKeypress = (text: string, key: Key): void => {
    const waiter = this.waiter;
    if (waiter === null) this.pending.push({ text, key });
    else {
      this.waiter = null;
      waiter({ text, key });
    }
  };

  constructor(
    private readonly input: TerminalInput,
    private readonly output: TerminalOutput,
  ) {
    emitKeypressEvents(input);
    input.on("keypress", this.onKeypress);
    input.setRawMode(true);
    input.resume();
    output.write("\u001B[?25l");
  }

  render(state: TuiState): void {
    this.output.write(`\u001B[2J\u001B[H${renderTui(state)}`);
  }

  async readAction(state: TuiState): Promise<TuiAction> {
    const next =
      this.pending.shift() ??
      (await new Promise<{ readonly text: string; readonly key: Key }>(
        (resolve) => {
          this.waiter = resolve;
        },
      ));
    return keyAction(state, next.text, next.key);
  }

  close(): void {
    this.input.off("keypress", this.onKeypress);
    this.input.setRawMode(false);
    this.input.pause();
    this.output.write("\u001B[?25h\n");
  }
}

class LineTuiTerminal implements TuiTerminal {
  private readonly lines;

  constructor(
    input: TerminalInput,
    private readonly output: TerminalOutput,
  ) {
    this.lines = createInterface({ input, output, terminal: false });
  }

  render(state: TuiState): void {
    this.output.write(`${renderTui(state)}\n`);
  }

  async readAction(state: TuiState): Promise<TuiAction> {
    try {
      return parseLineTuiAction(state, await this.lines.question("> "));
    } catch {
      return { kind: "quit" };
    }
  }

  close(): void {
    this.lines.close();
  }
}

function keyAction(state: TuiState, text: string, key: Key): TuiAction {
  if (key.ctrl && key.name === "c") return { kind: "quit" };
  if (key.name === "up") return { kind: "move", delta: -1 };
  if (key.name === "down") return { kind: "move", delta: 1 };
  if (state.screen === "browse") {
    if (key.name === "escape") return { kind: "quit" };
    if (key.name === "return" || key.name === "enter")
      return { kind: "select" };
    if (key.name === "right" || key.name === "tab")
      return { kind: "toggle-expand" };
    if (key.name === "backspace") return { kind: "delete-query" };
    if (key.ctrl && key.name === "u") return { kind: "set-query", value: "" };
    if (!key.ctrl && !key.meta && text.length > 0)
      return { kind: "append-query", value: text };
    return { kind: "noop" };
  }
  if (state.screen === "plan") {
    if (key.name === "escape" || text === "n") return { kind: "cancel" };
    if (text === "y") return { kind: "confirm" };
    if (text === "f") return { kind: "force" };
    return { kind: "noop" };
  }
  if (state.screen === "report") {
    if (key.name === "escape" || text === "q") return { kind: "quit" };
    if (text === "f") return { kind: "fallback" };
    return { kind: "noop" };
  }
  if (state.screen === "error") return { kind: "quit" };
  return { kind: "noop" };
}
