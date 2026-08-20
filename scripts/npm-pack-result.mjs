export function normalizeNpmPackResult(value, expectedPackageName) {
  let packs;
  if (Array.isArray(value)) {
    packs = value;
  } else if (isRecord(value)) {
    const entries = Object.entries(value);
    if (
      entries.length !== 1 ||
      entries[0][0] !== expectedPackageName ||
      !isRecord(entries[0][1])
    )
      throw new Error("npm pack returned an unexpected result");
    packs = [entries[0][1]];
  } else {
    throw new Error("npm pack returned an unexpected result");
  }

  if (
    packs.length !== 1 ||
    !isRecord(packs[0]) ||
    packs[0].name !== expectedPackageName
  )
    throw new Error("npm pack returned an unexpected result");
  return packs[0];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
