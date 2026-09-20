interface DependencyAction {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

/** Select actions whose prerequisites have all produced a result. */
export function selectReadyDependencyActions<T extends DependencyAction>(
  actions: readonly T[],
  remaining: ReadonlySet<string>,
  completed: ReadonlySet<string>,
  limit: number,
): T[] {
  const ready: T[] = [];
  for (const action of actions) {
    if (
      ready.length >= limit ||
      !remaining.has(action.id) ||
      !action.dependsOn.every((id) => completed.has(id))
    )
      continue;
    ready.push(action);
  }
  return ready;
}
