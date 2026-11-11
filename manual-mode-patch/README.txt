Manual battle mode patch
========================
From your repo root:   node manual-mode-patch/apply.mjs
(or: node manual-mode-patch/apply.mjs /path/to/repo)

It edits js/ui/combatlog.js, js/game.js, js/ui/quests.js, js/ui/hall.js and appends CSS to style.css.
Every edit is checked first; if any anchor does not match, nothing is changed. Commit before running so you can diff.
tests/ contains the Node tests I ran (copy into the repo root and run: node manual_test.mjs).
