// PROTOTYPE: pure navigation state for comparing three terminal UI structures.

export const variants = [
  { key: "A", name: "Three-pane navigator" },
  { key: "B", name: "Fzf-first finder" },
  { key: "C", name: "Expandable source tree" },
];

export const groups = [
  {
    id: "source:skills:acme-toolkit:user",
    name: "acme/toolkit",
    kind: "Source Group",
    owner: "Vercel skills",
    source: "github:acme/toolkit",
    scope: "user",
    evidence: "manager + source + scope",
    removalBoundary: false,
    skills: [
      skill(
        "review",
        "Review changes against repository standards",
        "managed",
        "/Users/me/.agents/skills/review",
      ),
      skill(
        "testing",
        "Generate and maintain focused tests",
        "managed",
        "/Users/me/.agents/skills/testing",
      ),
      skill(
        "release",
        "Prepare auditable release candidates",
        "managed",
        "/Users/me/.agents/skills/release",
      ),
      skill(
        "docs",
        "Keep product documentation synchronized",
        "managed",
        "/Users/me/.agents/skills/docs",
      ),
    ],
  },
  {
    id: "plugin:superpowers",
    name: "superpowers@2.4.0",
    kind: "Plugin",
    owner: "Claude Code",
    source: "marketplace:superpowers",
    scope: "user",
    evidence: "declared Plugin boundary",
    removalBoundary: true,
    skills: [
      skill(
        "brainstorming",
        "Explore requirements before implementation",
        "plugin-owned",
        "/Users/me/.claude/plugins/superpowers/skills/brainstorming",
      ),
      skill(
        "debugging",
        "Systematically isolate hard failures",
        "plugin-owned",
        "/Users/me/.claude/plugins/superpowers/skills/debugging",
      ),
      skill(
        "verification",
        "Verify evidence before completion",
        "plugin-owned",
        "/Users/me/.claude/plugins/superpowers/skills/verification",
      ),
    ],
  },
  {
    id: "source:gemini:agent-lab:workspace",
    name: "agent-lab/workflows",
    kind: "Source Group",
    owner: "Gemini CLI",
    source: "git:agent-lab/workflows",
    scope: "workspace",
    evidence: "manager + source + scope",
    removalBoundary: false,
    skills: [
      skill(
        "triage",
        "Triage incoming engineering work",
        "managed",
        "/work/acme/.gemini/skills/triage",
      ),
      skill(
        "migration",
        "Plan and execute dependency migrations",
        "Git protected",
        "/work/acme/.gemini/skills/migration",
        ["git-protected"],
      ),
    ],
  },
  {
    id: "collection:standalone:user",
    name: "Standalone skills",
    kind: "Navigation collection",
    owner: "Filesystem",
    source: "no shared source evidence",
    scope: "user",
    evidence: "display-only collection",
    removalBoundary: false,
    skills: [
      skill(
        "notes",
        "Capture implementation notes",
        "quarantine",
        "/Users/me/.codex/skills/notes",
      ),
      skill(
        "commit-helper",
        "Draft conventional commit messages",
        "quarantine",
        "/Users/me/.agents/skills/commit-helper",
      ),
      skill(
        "legacy-audit",
        "Legacy audit workflow",
        "broken",
        "/Users/me/.agents/skills/legacy-audit",
        ["broken-link"],
      ),
    ],
  },
];

export function createState(variant = "A") {
  return {
    variant,
    focus: variant === "A" ? "groups" : "results",
    groupIndex: 0,
    itemIndex: 0,
    rowIndex: 0,
    query: "",
    searchActive: variant === "B",
    selectedIds: [],
    expandedGroupIds: groups.map((group) => group.id),
    previewVisible: true,
    previewPercent: 38,
    reviewOpen: false,
    notice: "",
  };
}

export function reduce(state, action) {
  if (action.type === "variant") {
    return {
      ...createState(action.variant),
      selectedIds: state.selectedIds,
      notice: `Switched to variant ${action.variant}`,
    };
  }
  if (action.type === "search")
    return clamp({
      ...state,
      searchActive: true,
      reviewOpen: false,
      notice: "",
    });
  if (action.type === "append-query")
    return clamp({
      ...state,
      searchActive: true,
      query: `${state.query}${action.value}`,
      rowIndex: 0,
      itemIndex: 0,
      reviewOpen: false,
      notice: "",
    });
  if (action.type === "delete-query")
    return clamp({
      ...state,
      query: Array.from(state.query).slice(0, -1).join(""),
      rowIndex: 0,
      itemIndex: 0,
      notice: "",
    });
  if (action.type === "clear-query")
    return clamp({ ...state, query: "", rowIndex: 0, itemIndex: 0 });
  if (action.type === "resize-preview")
    return {
      ...state,
      previewVisible: true,
      previewPercent: Math.min(
        60,
        Math.max(20, state.previewPercent + action.delta),
      ),
      notice: "",
    };
  if (action.type === "toggle-preview")
    return { ...state, previewVisible: !state.previewVisible, notice: "" };
  if (action.type === "escape") {
    if (state.reviewOpen) return { ...state, reviewOpen: false };
    if (state.query !== "")
      return clamp({ ...state, query: "", rowIndex: 0, itemIndex: 0 });
    if (state.searchActive && state.variant !== "B")
      return { ...state, searchActive: false, focus: "groups" };
    if (state.variant === "A" && state.focus === "skills")
      return { ...state, focus: "groups" };
    return state;
  }
  if (action.type === "move")
    return { ...move(state, action.delta), notice: "" };
  if (action.type === "jump")
    return { ...jump(state, action.edge), notice: "" };
  if (action.type === "left") {
    if (state.variant === "A" && !state.searchActive)
      return { ...state, focus: "groups", reviewOpen: false };
    return state;
  }
  if (action.type === "right") {
    if (state.variant === "A" && !state.searchActive)
      return { ...state, focus: "skills", reviewOpen: false };
    if (state.variant === "C") return toggleExpanded(state);
    return state;
  }
  if (action.type === "toggle-expanded") return toggleExpanded(state);
  if (action.type === "toggle-selected") {
    const current = currentSkill(state);
    if (current === null)
      return {
        ...state,
        notice:
          "Source Groups navigate; select an Installation inside the group.",
      };
    const selectedIds = state.selectedIds.includes(current.id)
      ? state.selectedIds.filter((id) => id !== current.id)
      : [...state.selectedIds, current.id];
    return { ...state, selectedIds, notice: "", reviewOpen: false };
  }
  if (action.type === "accept") {
    const current = currentSkill(state);
    const selectedIds =
      state.selectedIds.length > 0
        ? state.selectedIds
        : current === null
          ? []
          : [current.id];
    return selectedIds.length === 0
      ? { ...state, notice: "Choose an Installation before reviewing a plan." }
      : { ...state, selectedIds, reviewOpen: true, notice: "" };
  }
  return state;
}

export function fuzzyResults(state) {
  const values = groups.flatMap((group) =>
    group.skills.map((item) => ({ group, skill: item })),
  );
  if (state.query.trim() === "") return values;
  return values
    .map((value, index) => ({
      ...value,
      index,
      score: score(
        state.query,
        [
          value.skill.name,
          value.skill.description,
          value.skill.status,
          value.skill.path,
          value.group.name,
          value.group.kind,
          value.group.owner,
          value.group.source,
          value.group.scope,
          ...value.skill.tags,
        ].join(" "),
      ),
    }))
    .filter((value) => value.score >= 0)
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
}

export function treeRows(state) {
  const query = state.query.trim();
  return groups.flatMap((group) => {
    const matchingSkills = group.skills.filter((item) =>
      query === ""
        ? true
        : score(
            query,
            `${group.name} ${group.owner} ${group.source} ${item.name} ${item.description}`,
          ) >= 0,
    );
    if (query !== "" && matchingSkills.length === 0) return [];
    const header = { kind: "group", group };
    return state.expandedGroupIds.includes(group.id)
      ? [
          header,
          ...matchingSkills.map((item) => ({
            kind: "skill",
            group,
            skill: item,
          })),
        ]
      : [header];
  });
}

export function currentSkill(state) {
  if (state.searchActive || state.variant === "B")
    return fuzzyResults(state)[state.rowIndex]?.skill ?? null;
  if (state.variant === "A") {
    if (state.focus !== "skills") return null;
    return groups[state.groupIndex]?.skills[state.itemIndex] ?? null;
  }
  const row = treeRows(state)[state.rowIndex];
  return row?.kind === "skill" ? row.skill : null;
}

export function currentGroup(state) {
  if (state.searchActive || state.variant === "B")
    return fuzzyResults(state)[state.rowIndex]?.group ?? groups[0];
  if (state.variant === "A") return groups[state.groupIndex] ?? groups[0];
  return treeRows(state)[state.rowIndex]?.group ?? groups[0];
}

export function stateSummary(state) {
  const group = currentGroup(state);
  const item = currentSkill(state);
  return {
    variant: state.variant,
    mode: state.reviewOpen ? "review" : state.searchActive ? "fuzzy" : "browse",
    focus: state.focus,
    group: group?.name ?? null,
    cursor: item?.name ?? group?.name ?? null,
    query: state.query,
    selected: state.selectedIds.map(skillNameForId),
    expanded: groups
      .filter((candidate) => state.expandedGroupIds.includes(candidate.id))
      .map((candidate) => candidate.name),
    preview: state.previewVisible ? `${state.previewPercent}%` : "hidden",
  };
}

function move(state, delta) {
  if (state.searchActive || state.variant === "B") {
    const length = fuzzyResults(state).length;
    return {
      ...state,
      rowIndex: wrap(state.rowIndex, length, delta),
      reviewOpen: false,
    };
  }
  if (state.variant === "A") {
    if (state.focus === "groups")
      return {
        ...state,
        groupIndex: wrap(state.groupIndex, groups.length, delta),
        itemIndex: 0,
        reviewOpen: false,
      };
    const length = groups[state.groupIndex]?.skills.length ?? 0;
    return {
      ...state,
      itemIndex: wrap(state.itemIndex, length, delta),
      reviewOpen: false,
    };
  }
  return {
    ...state,
    rowIndex: wrap(state.rowIndex, treeRows(state).length, delta),
    reviewOpen: false,
  };
}

function jump(state, edge) {
  const indexFor = (length) =>
    edge === "first" || length === 0 ? 0 : length - 1;
  if (state.searchActive || state.variant === "B")
    return { ...state, rowIndex: indexFor(fuzzyResults(state).length) };
  if (state.variant === "A") {
    if (state.focus === "groups") {
      const groupIndex = indexFor(groups.length);
      return { ...state, groupIndex, itemIndex: 0 };
    }
    return {
      ...state,
      itemIndex: indexFor(groups[state.groupIndex]?.skills.length ?? 0),
    };
  }
  return { ...state, rowIndex: indexFor(treeRows(state).length) };
}

function toggleExpanded(state) {
  if (state.variant !== "C" || state.searchActive) return state;
  const row = treeRows(state)[state.rowIndex];
  if (row?.kind !== "group") return state;
  const expandedGroupIds = state.expandedGroupIds.includes(row.group.id)
    ? state.expandedGroupIds.filter((id) => id !== row.group.id)
    : [...state.expandedGroupIds, row.group.id];
  return clamp({ ...state, expandedGroupIds });
}

function clamp(state) {
  if (state.searchActive || state.variant === "B")
    return {
      ...state,
      rowIndex: clampIndex(state.rowIndex, fuzzyResults(state).length),
    };
  if (state.variant === "A") {
    const groupIndex = clampIndex(state.groupIndex, groups.length);
    return {
      ...state,
      groupIndex,
      itemIndex: clampIndex(
        state.itemIndex,
        groups[groupIndex]?.skills.length ?? 0,
      ),
    };
  }
  return {
    ...state,
    rowIndex: clampIndex(state.rowIndex, treeRows(state).length),
  };
}

function score(needleValue, haystackValue) {
  const needle = normalize(needleValue);
  const haystack = normalize(haystackValue);
  if (needle === "") return 0;
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return 1_000 - exact;
  let needleIndex = 0;
  let first = -1;
  let last = -1;
  for (
    let index = 0;
    index < haystack.length && needleIndex < needle.length;
    index += 1
  ) {
    if (haystack[index] !== needle[needleIndex]) continue;
    if (first < 0) first = index;
    last = index;
    needleIndex += 1;
  }
  return needleIndex === needle.length ? 500 - (last - first) - first : -1;
}

function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en-US");
}

function wrap(index, length, delta) {
  return length === 0 ? 0 : (index + delta + length) % length;
}

function clampIndex(index, length) {
  return length === 0 ? 0 : Math.min(Math.max(index, 0), length - 1);
}

function skill(name, description, status, path, tags = []) {
  return {
    id: `installation:${name}:${path}`,
    name,
    description,
    status,
    path,
    tags,
  };
}

function skillNameForId(id) {
  return (
    groups.flatMap((group) => group.skills).find((item) => item.id === id)
      ?.name ?? id
  );
}
