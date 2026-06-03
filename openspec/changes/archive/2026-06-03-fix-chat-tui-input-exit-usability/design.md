# Design: Fix Chat TUI input and workbench interaction defects

## Objective
Fix raw-input command-bar dispatch, local command acceptance, and area rendering clarity so users can operate `chat` TUI without accidental model prompts and with predictable panel behavior.

## Context
The existing interactive TUI path routes terminal bytes through `readCliChatPrompts` and `dispatchRawInputToTui` before deciding whether to emit a prompt text. For command-bar modes, local key events currently return typed action results that are not explicitly recognized as handled by the line-input loop, which can leak event text into the pending prompt.

This leads to three observed behaviors:
- typed characters can be injected into `pending` while focus is in command-bar,
- Enter after unmatched query can emit raw pending text, and
- command-bar interactions are visually noisy in compact summaries due unbounded summary lines.

## Proposed Fixes
1. Update local raw input handling so any `dispatchChatTui` result is treated as locally handled unless it explicitly produces `insertText` / `submitText`.
2. Keep command-bar acceptance as local-only bridge behavior and avoid prompt emission unless the bridge returns explicit `submitText`.
3. Keep panel semantics consistent:
   - `Tab`/`Shift+Tab` in command-bar: suggestion navigation,
   - `Tab`/`Shift+Tab` outside command-bar: panel focus cycle.
4. Improve line-mode rendering summaries to keep section boundaries explicit and command suggestion previews bounded.

## Rationale
- This keeps model text submission behavior deterministic and matches the spec requirement that command-bar editing stays local.
- A bounded command preview and clearer section labels reduce overload in the interactive line profile.

## Risks
- Changing prompt-loop handling changes behavior for any custom local dispatch implementation that relied on raw event text being returned as fallback. Such integrations are expected to pass only through explicit `insertText` / `submitText` outcomes.

## Acceptance Signals
- Command-mode printable input must not emit pending prompt text by default.
- Unmatched Enter in command-bar must remain local and not submit model input.
- Tab behavior must be panel-aware.
- Line renderer output remains bounded and deterministic with clear region labels.
