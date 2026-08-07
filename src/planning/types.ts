import type { RemovalPlanIntent, RemovalPlanMode } from "../model/types.js";

export type RemovalMode = RemovalPlanMode;
export type RemovalIntent = RemovalPlanIntent;

export type PlanningErrorCode =
  "invalid-intent" | "target-not-found" | "no-targets" | "overlapping-targets";

export class PlanningError extends Error {
  readonly code: PlanningErrorCode;

  constructor(code: PlanningErrorCode, message: string) {
    super(message);
    this.name = "PlanningError";
    this.code = code;
  }
}
