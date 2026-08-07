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
): Promise<TuiOutcome> {
  const controller = new TuiController(dependencies);
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
