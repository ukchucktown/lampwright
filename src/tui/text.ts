export function wrapTerminalLine(
  value: string,
  width: number,
  breaks: "words" | "paths" = "paths",
): readonly string[] {
  if (width <= 0 || [...value].length <= width) return [value];
  // Leave room for at least one content cell on each continuation line.
  const indentation = (value.match(/^\s*/u)?.[0] ?? "").slice(0, width - 1);
  const result: string[] = [];
  let remaining = value;

  while ([...remaining].length > width) {
    const characters = [...remaining];
    const candidate = characters.slice(0, width).join("");
    const lastSpace = candidate.search(/\s+\S*$/u);
    const lastPathSeparator = Math.max(
      candidate.lastIndexOf("/") + 1,
      candidate.lastIndexOf("\\") + 1,
    );
    const minimumUsefulBreak = Math.max(
      indentation.length + 1,
      Math.floor(width / 2),
    );
    const preferredBreak = Math.max(lastSpace, lastPathSeparator);
    const cut =
      breaks === "words" && lastSpace > indentation.length
        ? lastSpace
        : preferredBreak >= minimumUsefulBreak
          ? preferredBreak
          : width;
    result.push(characters.slice(0, cut).join("").trimEnd());
    remaining = `${indentation}${characters.slice(cut).join("").trimStart()}`;
  }
  result.push(remaining);
  return result;
}
