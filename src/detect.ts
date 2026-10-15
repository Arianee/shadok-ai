/**
 * Detection of the "Claude is working" state from the rendered TUI screen.
 *
 * Kept free of any dependency so it can be unit-tested directly
 * (debug/detect.test.mjs) against captured screen fixtures.
 */

/**
 * Marker displayed by Claude Code TUIs while working. The genuine one always
 * sits in the status group, right after a "·" separator or an opening "(",
 * e.g. "(… · esc to interrupt)". Requiring that prefix means prose that merely
 * *mentions* the phrase — Claude explaining shadok-ai's own turn detection,
 * quoted or not — never reads as "working".
 */
const ESC_TO_INTERRUPT = /[·(]\s*esc to interrupt/i;

/**
 * Newer TUIs drop the "esc to interrupt" hint; the live spinner line is then
 * the only working signal: a glyph at column 0 followed by a status and an
 * "(<elapsed> · …)" group with the elapsed FIRST, e.g.
 *   ✽ Jitterbugging… (4m 26s · ↓ 7.1k tokens · …)
 * A finished turn renders past tense without parens ("✻ Baked for 8m 20s"),
 * and completion lines put the elapsed LAST ("(… · 5m 40s)"): no match.
 */
const SPINNER_STATUS =
  /^[^\s\w].{0,80}?\(\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·/m;

/** True when the screen indicates that Claude is currently working. */
export function screenShowsWork(screen: string): boolean {
  return ESC_TO_INTERRUPT.test(screen) || SPINNER_STATUS.test(screen);
}

/**
 * One step of the "is this turn over?" loop, shared by both pilots.
 *
 * A turn ends on an ABSENCE of change: the screen must stop showing work AND
 * stay byte-identical for `stableMs`. That is a proxy, and a deliberately
 * conservative one — a TUI can look calm for an instant between two tool calls,
 * and calling the turn there would cut it in half.
 *
 * `stableMs` is a parameter and not a constant because the bar is not always
 * the same. When the user pressed the interrupt key, the end state is not being
 * guessed at: we asked for it. The caller may then lower the window, and the
 * turn is released in a fraction of the time. What it may NOT do is excuse a
 * screen that still shows work — that check is here, above the window, so no
 * caller can shorten its way past it.
 *
 * Pure on purpose: the loop it replaces lived twice (both pilots) and could
 * only be exercised by spawning a real process.
 */
export function idleStep(
  screen: string,
  lastScreen: string,
  stableSince: number,
  now: number,
  stableMs: number,
): { done: boolean; stableSince: number; lastScreen: string } {
  if (screenShowsWork(screen) || screen !== lastScreen) {
    return { done: false, stableSince: 0, lastScreen: screen };
  }
  // 0 means "not stable yet": start the clock, but never settle on the spot —
  // one poll proves nothing about the next.
  const since = stableSince === 0 ? now : stableSince;
  return { done: now - since >= stableMs, stableSince: since, lastScreen };
}

/**
 * How long the SAME dialog must stay on screen before {@link settleStep} ends
 * the wait on it. Short — a dialog is not inferred from silence, it is read off
 * the screen — but not one poll: a half-painted dialog (question up, options
 * still arriving) would otherwise be read and published as a different one.
 */
export const DIALOG_HOLD_MS = 400;

/**
 * The OTHER way a turn can end: a dialog is on screen. Runs beside
 * {@link idleStep}, never instead of it.
 *
 * `idleStep` alone cannot see a dialog that carries a clock. Claude Code
 * (≥ 2.1.284) renders some permission prompts with "⚠ Claude Code will
 * automatically deny this request in 1:43…" — a countdown that repaints EVERY
 * SECOND and auto-denies at 0:00. Measured on a real pane: longest
 * byte-identical window 678 ms, against the 2000 ms the production wait
 * requires. So the wait never ended, nothing ever read the dialog, and after
 * 120 s the request was denied without the cockpit ever being asked.
 *
 * So identity, not bytes: `key` is the caller's name for the dialog it sees
 * (`null` = none). The step settles once the same non-null key has held for
 * `holdMs`, however much the rest of the screen moves. The countdown is in
 * neither the question nor the labels, so it never resets the hold — and no
 * upstream wording is matched to get there, so a spinner or a progress line in
 * a future dialog is covered the same way.
 *
 * The work check stays above everything, exactly as in `idleStep`: a screen
 * showing work is never a dialog to settle on, whatever the caller thinks.
 */
export function settleStep(
  screen: string,
  key: string | null,
  lastKey: string | null,
  since: number,
  now: number,
  holdMs: number,
): { done: boolean; since: number; lastKey: string | null } {
  if (key === null || screenShowsWork(screen)) return { done: false, since: 0, lastKey: null };
  // A different dialog (or the first sighting) restarts the hold — and never
  // settles on the spot, whatever `holdMs` says.
  if (key !== lastKey) return { done: false, since: now, lastKey: key };
  return { done: now - since >= holdMs, since, lastKey: key };
}

/**
 * True while the text we just typed is still sitting in the input box (the
 * last "❯ …" line). Used to confirm a submit: before Enter the probe is in the
 * box; once Enter is accepted the box clears, so `!inputHasProbe` means "sent".
 * This is robust to a fast turn scrolling the echo out of the transcript —
 * unlike looking for the probe anywhere on screen, which false-negatived and
 * dumped the whole screen as an error.
 */
export function inputHasProbe(screen: string, probe: string): boolean {
  const promptLines = screen.split("\n").filter((l) => l.trimStart().startsWith("❯"));
  const inputLine = promptLines[promptLines.length - 1] ?? "";
  return inputLine.includes(probe);
}

/**
 * The current content of the input box (the last "❯ …" line), without the "❯".
 * Submit detection keys off this being non-empty (something is typed/pasted)
 * then empty again (sent) — content-agnostic, so it also works when the TUI
 * collapses a big paste into a "[Pasted text +N lines]" placeholder (the
 * literal text isn't on screen to look for).
 */
export function inputText(screen: string): string {
  // The input box is the "❯ …" line, or in shell mode the "! …" line at column
  // 0 — where the TUI pads the prompt with a NON-BREAKING space (U+00A0), not a
  // regular one, so match `\s` (which includes it), never a literal " ". (The
  // "  ! for shell mode" hint is indented, so requiring the bang at column 0
  // excludes it.)
  let inputLine = "";
  for (const l of screen.split("\n")) {
    if (l.trimStart().startsWith("❯") || /^!\s/.test(l)) inputLine = l;
  }
  return inputLine.replace(/^\s*[❯!]\s*/, "").trim();
}

/**
 * Why a screen refused a prompt — named, when the shape is recognisable.
 *
 * `submit` reports "the text never appeared in the input box", which describes
 * the SYMPTOM and points at the input box, where there is nothing to find. Three
 * agents were once wedged on Claude Code's first-run screen — no input box at
 * all, every prompt echoed into a masked field — and that message sent the
 * investigation towards session startup, twice, before anyone looked at the
 * pane. Naming what is actually on screen turns hours into seconds.
 *
 * Returns null when nothing is recognised: a vague message beats a confident
 * wrong one.
 */
export function describeStuckScreen(screen: string): string | null {
  if (/Welcome to Claude Code/i.test(screen))
    return "the agent is sitting on Claude Code's first-run screen, so it never reached a prompt — its onboarding state (~/.claude.json) was missing when it started";
  // A masked field echoes every pasted character as an asterisk, so the text is
  // physically on screen yet unreadable — and unreadable is what breaks submit.
  if (/\*{20,}/.test(screen))
    return "the screen is a masked input field (long runs of asterisks), so the pasted text is never readable back";
  if (/^\s*❯\s*\d+\.\s+\S/m.test(screen))
    return "the agent is waiting on a question, not on a prompt — answer it first";
  return null;
}

/**
 * How long to wait before reading a session's screen again.
 *
 * The screen watcher used to run at a flat 300 ms for EVERY session, which put
 * the cadence one consumer needs — a human watching the engine room — on all of
 * them at once, forever. Since `screen()` is a synchronous `tmux capture-pane`,
 * the cost lands on the server's event loop and grows with the number of agents
 * that EXIST rather than with what anyone is looking at: measured at 6 ms a
 * capture, twenty-one idle agents blocked 42% of the loop and every HTTP
 * request queued behind it for a second or more.
 *
 * An idle agent's screen is byte-identical for hours (measured: ten out of ten
 * unchanged over 1.2 s), so the watcher can back off and lose nothing. Anything
 * that could move the screen resets the streak to zero.
 */
export interface BackgroundTasks {
  /** Shells the agent left running (a build, a watcher, a forgotten `sleep`). */
  shells: number;
  /** Monitors it armed. A `persistent` one never ends on its own. */
  monitors: number;
}

/**
 * What the pane says is still running, from the TUI's own footer.
 *
 * Claude Code lists both in one segment of its persistent hint line, and the
 * two share it, comma-separated — captured live:
 *
 *   ⏵⏵ auto mode on · 1 shell, 1 monitor · esc to interrupt · ← for agents
 *
 * That shape is why the rule is not "find a number before `shell`": the monitor
 * sits after a COMMA, so anchoring on a leading `·` sees the shell and misses
 * the monitor. The segment is matched WHOLE instead — split the footer on `·`
 * and accept a part only if it is entirely a comma-separated list of counts.
 * Being exact is also what keeps prose out, which is invariant 2's family: a
 * *quoted* "esc to interrupt" once wedged a session as busy, and an agent
 * describing its own work must never move an indicator.
 *
 * Only the footer REGION is read (the last few non-empty lines), never the
 * scrollback, where an older footer may still sit.
 *
 * Unlike the context gauge before invariant 24, this string is Claude Code's
 * own: verified with no `statusLine` configured, on 61 of 64 live panes.
 */
const FOOTER_LINES = 6;
const COUNT = /^(\d+)\s+(shell|monitor)s?$/;
export function backgroundTasks(screen: string): BackgroundTasks {
  const lines = screen.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  const out: BackgroundTasks = { shells: 0, monitors: 0 };
  for (const line of lines.slice(-FOOTER_LINES)) {
    for (const part of line.split("·")) {
      const items = part.trim().split(",").map((x) => x.trim());
      if (!items.length || !items.every((x) => COUNT.test(x))) continue;
      for (const item of items) {
        const m = COUNT.exec(item)!;
        if (m[2] === "shell") out.shells = Number(m[1]);
        else out.monitors = Number(m[1]);
      }
    }
  }
  return out;
}

export const SCREEN_FAST_MS = 300;
export const SCREEN_SLOW_MS = 2000;
/** Unchanged polls tolerated before backing off at all — a short burst of
 *  stillness is normal mid-turn and must not slow the mirror down. */
export const SCREEN_CALM_AFTER = 3;

export function nextScreenDelay(unchangedStreak: number, busy: boolean): number {
  // A running turn is watched closely: this is when the screen moves most, and
  // there is only ever a handful of busy sessions at once.
  if (busy) return SCREEN_FAST_MS;
  if (unchangedStreak < SCREEN_CALM_AFTER) return SCREEN_FAST_MS;
  const grown = SCREEN_FAST_MS * 2 ** (unchangedStreak - SCREEN_CALM_AFTER + 1);
  return Math.min(grown, SCREEN_SLOW_MS);
}

/** The option number the ❯ cursor is currently on in a single-select dialog. */
export function selectedOptionN(screen: string): number | null {
  for (const l of screen.split("\n")) {
    const m = l.match(/^\s*❯\s*(\d+)\.\s/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The slice of a pilot `moveToOption` needs: read the screen, press a key, and
 *  wait until the screen satisfies a predicate. Both PtyPilot and TmuxPilot match
 *  it; a fake one lets the overshoot regression be tested without a real TUI. */
export interface DialogPilot {
  screen(): string;
  press(key: "up" | "down"): void;
  waitFor(predicate: (screen: string) => boolean, opts?: { timeoutMs?: number }): Promise<string>;
}

/**
 * Moves the ❯ cursor onto option `n` — one press per step, WAITING for the
 * cursor to actually move before the next press. Returns whether it landed on n.
 *
 * The wait is the whole point. A fixed delay after each press overshot on the
 * tmux transport: its screen is a mirror refreshed on a ~300ms poll
 * (SCREEN_FAST_MS), so a 160ms read came back stale — the cursor still on the old
 * option — and the loop pressed down again and again, sailing past the target.
 * Single-select answers then landed on the LAST option, so the web form "did
 * nothing" and the question re-appeared. node-pty's screen is synchronous and hid
 * it entirely. `waitFor` polls until the move lands, which is correct on both.
 */
export async function moveToOption(pilot: DialogPilot, n: number): Promise<boolean> {
  let cur = selectedOptionN(pilot.screen());
  if (cur === null) return false; // unreadable cursor: the caller deals with it
  for (let i = 0; i < 16 && cur !== n; i++) {
    const from = cur;
    pilot.press(from < n ? "down" : "up");
    try {
      await pilot.waitFor(
        (s) => {
          const c = selectedOptionN(s);
          return c !== null && c !== from;
        },
        { timeoutMs: 2000 },
      );
    } catch {
      return false; // the cursor never moved — let the caller try the digit
    }
    cur = selectedOptionN(pilot.screen());
    if (cur === null) return false;
  }
  return cur === n;
}

/** The slice of a pilot `typeIntoBox` needs: read the screen, put text in the
 *  box, clear the box, and wait until the screen satisfies a predicate. Both
 *  PtyPilot and TmuxPilot match it; a fake one lets the doubled-prompt
 *  regression be tested without a real TUI. */
export interface TypingPilot {
  /** The screen as it is NOW — read before each paste, as the baseline. */
  screen(): string;
  /** Bracketed-paste the text into the input box — never submits it. */
  paste(text: string): void;
  /** Ctrl-U: clear whatever is in the input box. */
  clearInput(): void;
  waitFor(predicate: (screen: string) => boolean, opts?: { timeoutMs?: number }): Promise<string>;
}

export interface TypeOptions {
  attempts?: number;
  /** How long to wait for a paste to show up in the box. */
  appearMs?: number;
  /** How long to let an in-flight paste land before clearing. */
  settleMs?: number;
  /** How long to wait for the box to actually read empty after Ctrl-U. */
  clearMs?: number;
  /**
   * Injected context to put in the box BEFORE the message, as its OWN paste(s)
   * — not concatenated into it. See `typeIntoBox` for why that distinction is a
   * correctness one, and why SEVERAL of them buy room a single one cannot.
   */
  prelude?: string | string[];
}

/**
 * Puts `text` in the input box, retrying until it is actually there. Returns
 * whether it landed; the caller decides what a failure means.
 *
 * The retry is what makes it robust — the TUI flushes stdin received before its
 * keyboard handler is ready — and the RECOVERY between attempts is where it used
 * to go wrong. A slow first paste (a freshly respawned pane, a loaded machine)
 * can still be in flight when the appearance check times out: the old code sent
 * Ctrl-U immediately, so it cleared an EMPTY box, the paste landed a moment
 * later, and the next attempt pasted on top of it — leaving the partial text
 * PLUS the full text in the box, which is how a prompt came through doubled.
 * Nothing about that is visible afterwards: the transcript just shows one
 * mangled message.
 *
 * So the recovery does the two things the fast path cannot: it WAITS for any
 * in-flight paste to land before clearing, and it CONFIRMS the box reads empty
 * before pasting again. A box that will not clear is left to the next attempt
 * rather than pasted into blindly.
 *
 * "Landed" means the box DIFFERS from what it showed just before the paste, not
 * that it is non-empty: an empty box is not always blank. Before the first
 * prompt of a session, Claude Code (seen on 2.1.285) fills it with an example —
 * `❯ Try "refactor <filepath>"` — which `inputText` reads like typed text, so
 * "non-empty" was true before anything was pasted, and a paste the TUI dropped
 * was followed by Enter on a box holding nothing. The example also comes back
 * after a Ctrl-U, so "cleared" likewise means "back to that resting state".
 * Comparing with the state read just before is still content-agnostic (a
 * collapsed "[Pasted text +N lines]" differs from it as well as the text would)
 * and needs no list of hint strings, which would rot with the next release. The
 * baseline is re-read on every attempt, after the recovery has run, so a retry
 * that pastes the same text again is compared with the box it pastes into.
 *
 * It lives here, next to `idleStep` and `moveToOption`, for the reason those do:
 * it was written twice (node-pty and tmux), and could only be exercised by
 * spawning a real process.
 */
/** Upper bound on Ctrl-U presses for one recovery: a prompt is a handful of
 *  lines, and a box that still is not clear after this many is not going to be. */
const MAX_CLEARS = 40;
/** How long one press is given to show. Above the tmux mirror's fast poll
 *  (`SCREEN_FAST_MS`), or a press that worked would read as one that did not. */
const CLEAR_STEP_MS = 400;

export async function typeIntoBox(
  pilot: TypingPilot,
  text: string,
  { attempts = 6, appearMs = 2_000, settleMs = 400, clearMs = 1_000, prelude }: TypeOptions = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Only "" and the resting state count as an empty box; anything else the
    // box shows once we paste is our paste (whole, or collapsed).
    const before = inputText(pilot.screen());
    // N+1 pastes, and the LAST must be the message. Claude Code decides whether
    // a paste stays inline when it is the CURRENT one and leaves every earlier
    // one as it then became, so pasting separately is what puts the injected
    // context inside the `<pasted_content>` wrapper and leaves the user's words
    // outside it. The threshold (800 chars, 2 newlines) is applied PER PASTE,
    // which is why the prelude may be a LIST: measured on a live agent, eight
    // chunks and a message carried 1272 characters over nine lines with nothing
    // wrapped at all — a ceiling a single paste cannot reach by any formatting.
    // Waiting for each to land is load-bearing: fired back to back they reach
    // the pane as ONE paste event, which is exactly the single blob this exists
    // to stop being.
    for (const chunk of prelude ? (Array.isArray(prelude) ? prelude : [prelude]) : []) {
      if (!chunk) continue;
      const seen = pilot.screen();
      pilot.paste(chunk);
      try {
        // The SCREEN, not `inputText`: that helper reads the `❯` line alone, so
        // once a chunk has filled it every later one lands on a continuation
        // line and the box's visible text stops moving.
        await pilot.waitFor((s) => s !== seen, { timeoutMs: appearMs });
      } catch {
        // A chunk never showed. Fall through and paste the rest anyway: losing
        // the context is survivable, losing the message is not.
      }
    }
    // The SCREEN, not `inputText`: the box's visible text is read off its `❯`
    // line alone, so once a prelude has filled that line everything appended
    // after it lands on continuation lines and `inputText` stops moving. Waiting
    // on it then times out on a paste that arrived perfectly — which is exactly
    // what the first version of this did, on every prelude long enough to wrap.
    const afterPrelude = pilot.screen();
    pilot.paste(text);
    try {
      await pilot.waitFor((s) => {
        const now = inputText(s);
        if (now === "" || now === before) return false; // nothing in the box yet
        // With no prelude this is the original condition, unchanged.
        return !prelude || s !== afterPrelude;
      }, { timeoutMs: appearMs });
      return true;
    } catch {
      await delay(settleMs); // let a paste that is still in flight land
      const isClear = (s: string) => {
        const now = inputText(s);
        return now === "" || now === before;
      };
      // `before` (not `beforeText`) on purpose: a retry re-pastes the prelude,
      // so the box has to come back to what it was before EITHER paste.
      // Ctrl-U clears ONE line, not the box (seen on 2.1.296): a two-line paste
      // takes three presses — the last line, the newline, the first line. Two
      // presses left the first line behind and the next attempt pasted after it,
      // which is how a prompt arrived as its header twice and its text nowhere.
      // So press until the box reads clear. Progress cannot be read off the box:
      // `inputText` sees its FIRST line only, which stays put while the lines
      // under it go. The whole screen is what moves, so a run of presses that
      // leaves it untouched is a screen with nothing to clear — given up on, and
      // left to the next attempt rather than pasted into blindly.
      let stuck = 0;
      for (let press = 0; press < MAX_CLEARS && stuck < 3; press++) {
        const shown = pilot.screen();
        pilot.clearInput();
        try {
          await pilot.waitFor(isClear, { timeoutMs: Math.min(clearMs, CLEAR_STEP_MS) });
          break;
        } catch {
          stuck = pilot.screen() === shown ? stuck + 1 : 0;
        }
      }
    }
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
