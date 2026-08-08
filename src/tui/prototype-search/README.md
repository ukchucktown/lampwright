# PROTOTYPE — global Skill search overlay

Throwaway, synthetic-data-only terminal code for issue #45. It cannot scan,
plan, remove, quarantine, persist, or invoke an Owner.

## The question

When a user has many Skills, should global search retain a category pane, move
category/source into the selected Skill's preview, or behave as a minimal quick
picker? The prototype also tests the higher-risk interaction hidden inside that
layout choice: what should Enter select?

Three structurally different variants are switchable live:

- **A — Categories + matches:** category counts on the left, matching Skill
  names on the right, and a full-width preview below. Enter from the result list
  adds every visible removable match to the existing selection and returns to
  the main view. This is the preferred layout and the prototype default.
- **B — Results + preview:** a flat Skill result list beside a large preview.
  Category/source, description, Owner, and exposure live in the preview. Space
  stages individual results; Enter applies the staged selection and returns.
- **C — Quick picker:** full-width Skill results with a compact preview below.
  Enter selects only the highlighted Skill and returns.

## Run it

```console
npm run prototype:search
```

The prototype opens directly in search. Type to filter; use Up/Down to move,
Backspace to edit, Escape to clear/close, `/` to reopen search from the main
view, and Ctrl-C to quit. In variant A, Left/Right switches category/result
focus. In variant B, Space stages one match and Ctrl-A stages every visible
match. Use `[` and `]` to cycle variants at any time.

The bottom two lines always show the variant switcher and complete relevant
state. Search is name-first; category/source can also match, while descriptions
are deliberately preview-only so ordinary prose does not flood the results.

## Validated direction

Search is an additive workflow. A user can search, press Enter to add the
matching Skills and return to the main pane, continue selecting there, then
press `/` to run another search. A later search never replaces Skills selected
by an earlier search or directly in the main pane.

## What should survive

Only the validated interaction and information hierarchy. This branch is the
primary source for the comparison; none of its implementation should be merged
directly into production.
