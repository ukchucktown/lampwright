# PROTOTYPE — three-pane terminal navigation

Throwaway code. It scans read-only, renders, and lets you select. It cannot
plan, execute, quarantine, or persist anything.

## The question

Candidate B was chosen from three static frames rendered against a live
Inventory. A static frame cannot answer whether the _interaction_ works, and
interaction is what makes the current terminal UI unpleasant. This prototype
exists to settle four things by hand:

1. **Focus** — does a two-pane model with a passive detail strip feel right, or
   does the cursor get lost between sections and skills?
2. **Selection scope** — selection here is deliberately **global**: you can
   collect skills from several bundles and review them together. Is that what
   you want, or should selection be scoped to one bundle at a time?
3. **Search** — typing filters **everything** and sections keep their identity
   while their contents shrink. Is a global filter right, or should typing
   search only within the focused section?
4. **Unselectable sections** — System Skills are present but refuse selection.
   Is refusing correct, or should they be hidden until asked for?

## Run it

```console
npm run prototype:panes
```

Keys: `↑↓` move · `←→` switch pane · `PgUp`/`PgDn` page · `space` select · `S`
take the whole section · `ctrl-a` clear selection · `enter` review · `esc` back
· `ctrl-c` quit. Typing filters; backspace edits the query.

Resize: `shift-←` / `shift-→` moves the pane split, `shift-↑` / `shift-↓`
changes the detail height. The terminal can be resized freely and the frame
reflows.

## Layout

Key hints sit at the top, above the panes. Skill rows carry identity only —
name, path count, and a note when something is unusual (exposure departing from
the section's, protected, plugin-owned, spanning groups). Descriptions are too
long to read in a row, so they live in the detail pane below, word-wrapped.

The frame is a fixed grid, Yazi-style. Panes never grow to fit their contents:
each owns a viewport that scrolls under a stationary border, so the detail area
below never moves. Paging steps by exactly one viewport rather than jumping to
an edge, and the cursor keeps a one-row margin from the top and bottom before
the pane scrolls.

The bottom line prints the complete interaction state after every keystroke, so
assumptions about focus, indices, and selection are visible while you drive.

## Mouse

Click a section or a skill to focus it, click the `[ ]` box to toggle it, use
the wheel over either pane to scroll it, and drag the divider to resize the
split.

## Known rough edges — look for these

- **Typing does not move you to the matches.** Filter while focused on a
  section with few or no hits and you stay there, watching an empty pane, with
  the matches elsewhere in the list.
- **`S` on a section you have not entered** takes every skill in it. There is
  no confirmation and no undo beyond `ctrl-a`.
- **Selection is invisible once you leave a section.** The left pane shows
  `taken/total`, but nothing lists what is selected until you press enter.

## What survives

`model.mjs` is pure and portable: the reducer, the derived selectors, and the
selection rules. If the model is right it lifts into `src/tui` for #39.
`run.mjs` and `inventory.mjs` are the throwaway shell and die with the branch.
