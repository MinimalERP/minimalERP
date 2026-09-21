# ADR-0010: Phase 3 command, keyboard and shell decisions

Status: accepted (2026-09-19)

## Context
Phase 3 built the layer every later screen stands on: the Command Registry, the keyboard system, the screen stack,
Universal Search (Go To) over commands, and the shell. Nothing here may need re-doing when vouchers and masters arrive.

## Decisions

1. **Everything you can do or go to is a Command; contextual behaviour is a NAME, not code.** `nav.down`,
   `nav.activate`, `field.next`, `app.back` are commands with no behaviour of their own. Whichever screen or overlay is active
   supplies it (`useCommandHandler`), and the keymap decides which key triggers it. Two paths exist on purpose:
   `dispatch` (a key: scope handlers first, innermost scope first, then the command's own `run`) and `run` (a menu entry,
   search result or button: just run it).

2. **One keyboard listener, and it leaves alone anything it does not handle.** `KeyboardManager` is a single capture-phase
   listener; a key is consumed (`preventDefault`) only if a command actually handled it, so typing, caret movement and
   unbound browser keys keep working. Letters/digits are read from `event.code` (layout- and Option/AltGr-safe). AltGr
   (reported as Ctrl+Alt on Windows) is treated as typing. Held keys repeat only for unmodified navigation keys; a repeat
   of anything else is swallowed without acting again (so a held F5 cannot reload). IME composition is left alone.
   Lint bans `onKeyDown`, `addEventListener('keydown')` and `keyCode` outside `packages/keyboard` and `apps/web/src/ui`.

3. **Scopes are ordered by layer, not mount order, and modality is established synchronously.** Children mount before
   parents, so `global < screen < region < overlay` is explicit. The Go To palette's modal scope is pushed by `UiState`
   the instant it opens, **not by the component effect that renders it** — found by the browser tests: a fast Alt+G then F8
   landed in the gap before the effect ran and opened a voucher underneath the palette.

4. **The keymap is data.** Bindings may be scoped (F8 = open Sales globally, switch type inside a voucher; Enter =
   "Change shortcut" in the shortcut editor, "Select" in a list); the most specific scope is tried first. User overrides
   *replace* a command's defaults and persist. Plain typing keys can never be shortcuts. The editor refuses a key another
   command already uses and names it. The status bar hints are derived from the same registry and keymap that drive
   behaviour, so they cannot drift from what the keys do.

5. **Search: one service, pluggable providers, ranked by relevance then frecency.** Scattered-letter matches count only as
   abbreviations (≤ 5 letters, starting at a word boundary); punctuation-only terms are ignored (so a title containing
   "&" is findable by its own name); transpositions cost one edit. Results are ranked by relevance with a bounded
   frecency lift (usage × recency, half-life two weeks) and a small pin bonus. Hits are commands+args, so an entity hit
   in a later phase is just another command invocation.
   **Search runs from the input handler, not an effect.** An effect fires after paint, so fast typing then Enter acted on
   the previous query's results (found by a browser test).

6. **Navigation is a screen stack with per-frame state.** Esc pops and lands on the same row. `pushForResult` is the
   groundwork for Alt+C (create a master from inside a voucher and return its id with the draft intact). The address
   mirrors the top screen using `replaceState` (Esc is "back"; no history clutter) and deep links open the screen with the
   Gateway beneath it.

7. **Not-yet-built features are real commands with honest placeholders.** `modules/roadmap.ts` declares every planned
   voucher, report, master and setting with its final id, title, keywords and — where the plan fixes one — shortcut, plus the
   phase that delivers it. They open a "planned — Phase N" screen. When a phase lands, its module registers the real command
   under the same id; the shell, Gateway, Go To and shortcut editor need no change and users' learned shortcuts do not move.

## Consequences
- A new module adds commands, bindings, menu entries and search providers through a manifest; the shell is untouched.
- Browser reality, stated plainly: F5/F6/F7/F4/F8/F9 and Alt+G/Alt+C are captured and consumed (verified via
  `defaultPrevented`); Ctrl+N/T/W and browser-chrome shortcuts cannot be. Automation drives keys through the page, so it
  cannot watch the browser's own reload — the tests assert the key was consumed instead. A PWA in standalone mode remains
  the mitigation for chrome shortcuts.
- Phase 4 adds entity search providers and the first form screens; forms use `FormNavigator`/`GridNavigator`, which are
  built and unit-tested here but not yet wired to a screen.
