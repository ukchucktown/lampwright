# Use additive name-regex search

The terminal inventory uses a temporary global search overlay instead of
shrinking every section in place. The overlay lists matching Skill names on the
left and previews category, ownership, exposure, description, and paths on the
right. Closing it restores the prior inventory position.

Search input is a case-insensitive regular expression applied only to Skill
names. Matching metadata fields with the same expression made anchors
misleading: `^c.*` matched unrelated Skills because many shared the
`claude-code` exposure. Invalid expressions and expressions that match empty
text are refused. Explicit field searches remain a separate design problem.

Search staging is additive. Space stages one removable result, Ctrl-A stages
all visible removable results, and Enter adds them to the inventory selection
before returning. Escape cancels without changing that selection. System Skills
remain visible and cannot be staged. This supersedes only the filtering
paragraph of ADR 0006; its protection and grouping decisions remain in force.
