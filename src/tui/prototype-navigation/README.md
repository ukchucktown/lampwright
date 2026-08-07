# PROTOTYPE — Source-group terminal navigation

Question: should the production terminal inventory use a Yazi-style
three-pane navigator, an fzf-first flat finder, or an expandable hybrid tree
to browse Source Groups while preserving explicit Installation selection?

This is disposable, read-only prototype code. It uses synthetic Inventory data
and cannot scan, plan, execute, or persist anything.

Run it with:

```console
npm run prototype:tui
```

Press `1`, `2`, or `3` to switch variants. Each frame exposes the complete
interaction state at the bottom so navigation and selection assumptions are
visible while evaluating the designs.
