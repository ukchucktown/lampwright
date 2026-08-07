export type WindowsReparseKind = "junction" | "symbolic-link";

const junctionTag = "0xa0000003";
const symbolicLinkTag = "0xa000000c";

export function parseWindowsReparseKind(
  output: string,
): WindowsReparseKind | null {
  for (const line of output.split(/\r?\n/u)) {
    const field = /^[^:\r\n]+:\s*(0x[a-f\d]+)\s*$/iu.exec(line);
    const tag = field?.[1]?.toLowerCase();
    if (tag === junctionTag) {
      return "junction";
    }
    if (tag === symbolicLinkTag) {
      return "symbolic-link";
    }
  }
  return null;
}
