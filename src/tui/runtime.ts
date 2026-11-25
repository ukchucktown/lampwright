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
  // The controller owns which theme applies; the terminal owns how to draw it.
  const draw = (state: TuiState): void => {
    const theme = controller.theme;
    if (theme !== null) terminal.setTheme?.(theme);
    terminal.render(state);
  };
  try {
    draw(controller.state);
    await controller.start();
    draw(controller.state);
    while (
      controller.state.screen !== "done" &&
      controller.state.screen !== "error"
    ) {
      await controller.dispatch(await terminal.readAction(controller.state));
      const nextState = controller.state as TuiState;
      if (nextState.screen !== "done") draw(nextState);
      if (nextState.screen === "executing") {
        await controller.waitForExecution();
        draw(controller.state);
      }
      if (nextState.screen === "trash-executing") {
        await controller.waitForTrashExecution();
        draw(controller.state);
      }
      if (nextState.screen === "availability-executing") {
        await controller.waitForAvailabilityExecution();
        draw(controller.state);
      }
      if (nextState.screen === "add-agent" && nextState.executing) {
        await controller.waitForAddAgentExecution();
        draw(controller.state);
      }
      if (nextState.screen === "update-executing") {
        await controller.waitForUpdateExecution();
        draw(controller.state);
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
