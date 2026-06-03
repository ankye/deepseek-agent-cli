# Tasks for fix-chat-tui-input-exit-usability

## 1) Add regression tests for raw command-bar handling
- [x] Create `src/apps/cli/test/chat-tui-workbench-interaction.test.ts` with focused cases:
  - [x] Slash opens command-bar on empty pending only.
  - [x] Typing in command-bar updates `commandBar.query` without prompt-side emission.
  - [x] Enter in unmatched command-bar query emits no pending prompt.
  - [x] Tab in command-bar navigates suggestion selection.
  - [x] Tab outside command-bar cycles focus panel.
  - [x] Interactive suggestion output submission remains bridge-driven.
  - [x] Ctrl+C in raw TUI prompt mode emits `/exit`.
  - [x] Initial screen advertises the input anchor and exit affordance.
  - [x] Real chat loop raw prompt typing has visible live feedback.
  - [x] Real chat loop command-bar filtering has visible live feedback.
  - [x] Full-screen command filtering repaints full frames instead of line-mode prompt fragments.
  - [x] Full-screen ordinary prompt typing is echoed inside the input box before Enter.
  - [x] Long mixed Chinese, English, and symbol input stays tail-visible and bounded.
  - [x] Hundreds of log-shaped lines with controls, ANSI escapes, emoji, paths, JSON, and symbols stay display-safe.
  - [x] Bracketed multiline paste remains one prompt and does not open slash command mode.
  - [x] Full-screen lifecycle enables and disables terminal bracketed paste mode.
  - [x] Full-screen raw typing avoids per-key clear-screen flicker.

## 2) Fix raw input local handling
- [x] Update `src/apps/cli/src/input/chat-input.ts` so local dispatch objects from TUI/command dispatch are treated as handled unless they carry `submitText`/`insertText`.
- [x] Keep existing behavior for normal string input chunks and non-raw line input.

## 3) Reconfirm dispatch semantics with command suggestions
- [x] Update/adjust command acceptance path in `src/apps/cli/src/commands/chat-raw-input.ts` if needed to preserve local bridge-only semantics after read-loop changes.

## 4) Improve workbench line rendering clarity
- [x] Update command/summary rendering in `src/apps/cli/src/commands/chat-tui-workbench-renderer.ts` to keep command preview text bounded and section headings explicit.
- [x] Update full-screen rendering so suggestions sit above a stable input box and internals stay low density.
- [x] Centralize input-frame rendering so line-mode and full-screen share the same input/suggestions model.
- [x] Pass raw prompt pending text into full-screen repaint frames so normal typing is visible.
- [x] Bound long raw input in the shared input-frame renderer using cursor-near tail truncation.
- [x] Sanitize control characters and ANSI escape bytes in input-frame display text.
- [x] Buffer bracketed multiline paste without submitting each pasted newline.
- [x] Change full-screen repaint to origin-only overwrite after the initial alternate-screen clear.

## 5) Run OpenSpec and consistency validation
- [x] Run `openspec validate --specs --strict` after test and task artifacts are present.
- [x] Verify no behavior regression in non-documented paths (tui off, non-raw input).
