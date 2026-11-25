import type { TuiViewport } from "./types.js";

/** Zero-based position shared by the drawing and pointer paths. */
export function overlayPosition(
  viewport: TuiViewport,
  width: number,
  height: number,
  firstRow = 1,
) {
  const usable = Math.max(0, viewport.columns - 1);
  const rows = Math.max(0, viewport.rows - 1);
  if (width + 2 > usable || height > rows) return null;
  return {
    left: Math.floor((usable - width) / 2),
    top: Math.min(
      rows - height,
      Math.max(firstRow, Math.floor((rows - height) / 2)),
    ),
  };
}
