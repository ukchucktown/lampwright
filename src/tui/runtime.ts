import process from "node:process";

import { TuiController } from "./controller.js";
import { createNodeTuiTerminal } from "./terminal.js";
import type {
  TuiDependencies,
  TuiOutcome,
  TuiState,
  TuiTerminal,
} from "./types.js";

export async function runTui(
  dependencies: TuiDependencies,
  terminal: TuiTerminal = createNodeTuiTerminal(),
  viewport = {
    rows: process.stdout.rows ?? 30,
    columns: process.stdout.columns ?? 100,
  },
): Promise<TuiOutcome> {
  const controller = new TuiController(dependencies, viewport);
  try {
    terminal.render(controller.state);
    await controller.start();
    terminal.render(controller.state);
    while (
      controller.state.screen !== "done" &&
      controller.state.screen !== "error"
    ) {
      await controller.dispatch(await terminal.readAction(controller.state));
      const nextState = controller.state as TuiState;
      if (nextState.screen !== "done") terminal.render(nextState);
      if (nextState.screen === "executing") {
        await controller.waitForExecution();
        terminal.render(controller.state);
      }
      if (nextState.screen === "trash-executing") {
        await controller.waitForTrashExecution();
        terminal.render(controller.state);
      }
      if (nextState.screen === "availability-executing") {
        await controller.waitForAvailabilityExecution();
        terminal.render(controller.state);
      }
    }
    if (controller.state.screen === "error")
      return { status: "failed", message: controller.state.message };
    if (controller.state.report === null)
      return { status: "cancelled", report: null };
    return { status: "completed", report: controller.state.report };
  } catch (error: unknown) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    terminal.close();
  }
}
