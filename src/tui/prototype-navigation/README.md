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

To evaluate the same variants against the application's bounded, read-only
scan of your live Inventory, run the separately explicit command:

```console
npm run prototype:tui:real
```

Real mode builds the local executable, performs the same scan as
`skill-cleaner scan`, and projects its returned Inventory into Source Groups,
Plugins, and display-only navigation collections. It cannot request a Removal
Plan or call Execution. Paths remain inside the local terminal process.

Press `1`, `2`, or `3` to switch variants. Each frame exposes the complete
interaction state at the bottom so navigation and selection assumptions are
visible while evaluating the designs.
