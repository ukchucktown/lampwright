export interface BuiltInAdapterSource {
  readonly name: string;
  readonly content: string;
}

// Ecosystem definitions are added by issues #9-#12. Keeping the source list
// private prevents callers from marking arbitrary local content as built-in.
export const builtInAdapterSources: readonly BuiltInAdapterSource[] = [];
