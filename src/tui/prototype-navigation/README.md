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
Plugins, and display-only installation-root collections. Non-Installation
source/cache findings and evidence-backed runtime/System defaults are hidden.
It cannot request a Removal Plan or call Execution. Paths remain inside the
local terminal process.

The live evaluation exposed an upstream gap: existing standalone Claude Skills
are not yet included by Inventory. That work is tracked separately in
[issue #34](https://github.com/ukchucktown/skill-cleaner/issues/34); the
prototype does not fabricate Claude records or scan paths in presentation code.

Press `1`, `2`, or `3` to switch variants. Each frame exposes the complete
interaction state at the bottom so navigation and selection assumptions are
visible while evaluating the designs. Use arrows or `j`/`k` to scroll,
Page Up/Page Down and Home/End for larger jumps, Shift-Left/Shift-Right to resize
the preview pane, and F2 to hide or restore the preview. Resizing the terminal
also reflows every pane.
