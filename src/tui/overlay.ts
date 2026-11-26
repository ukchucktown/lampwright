import type { TuiViewport } from "./types.js";

const border = 1;
export const modalInset = "  ";
const headerRows = 2;
const contentOffset = border + modalInset.length;
const backdropMargin = 1;

/** Leave a visible column of backdrop on either side, and the terminal's wrap column free. */
export function modalContentWidth(
  viewport: TuiViewport,
  preferred: number,
): number {
  return Math.max(
    0,
    Math.min(
      preferred,
      viewport.columns - 1 - 2 * (backdropMargin + contentOffset),
    ),
  );
}

/** Coordinates are zero-based. Pointer input converts to terminal coordinates at its boundary. */
export function modalFrame(
  viewport: TuiViewport,
  contentWidth: number,
  bodyRows: number,
) {
  const columns = viewport.columns - 1;
  const rows = viewport.rows - 1;
  const width = contentWidth + 2 * contentOffset;
  const minimumHeight = bodyRows + 2 * border;
  // Padding must not cover either Inventory header row or displace a body row.
  const verticalInset = minimumHeight + 2 <= rows - headerRows ? 1 : 0;
  const height = minimumHeight + 2 * verticalInset;
  if (
    viewport.columns < 24 ||
    viewport.rows < 7 ||
    contentWidth <= 0 ||
    width + 2 * backdropMargin > columns ||
    height > rows
  )
    return null;
  const left = Math.floor((columns - width) / 2);
  const top = Math.min(
    rows - height,
    Math.max(headerRows, Math.floor((rows - height) / 2)),
  );
  return {
    left,
    top,
    clearsHeader: top >= headerRows,
    width,
    height,
    verticalInset,
    contentLeft: left + contentOffset,
    contentTop: top + border + verticalInset,
  };
}
