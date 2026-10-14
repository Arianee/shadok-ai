import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { rowKind, LABEL_MAX } from "../context/ledger-skill/ledger-core.mjs";

/**
 * Server side of the shared ledger. Two jobs the `shadok-ledger` skill's own
 * core (context/ledger-skill/ledger-core.mjs) does NOT do:
 *
 *  1. Locate the PER-INSTANCE ledger file. The skill writes it, the server reads
 *     it and hands agents its path; both key it by the launch dir, like channels
 *     and crons. (The skill runs inside an agent whose cwd is a worktree, so it
 *     cannot derive the launch dir itself — the server passes SHADOK_LEDGER_FILE
 *     at spawn.)
 *  2. Build the DELTA block pushed ahead of each human prompt: the rows changed
 *     since this agent last saw the ledger, so sibling agents learn what was
 *     resolved/decided in near-real-time without having to `check`. The block is
 *     prepended to the submitted text (like the ⟦platform⟧ prompt-meta header)
 *     and stripped from the display on replay — the agent sees it, the chat
 *     doesn't. Because a delta is usually empty, most prompts carry nothing.
 */

export interface LedgerRow {
  id?: string;
  entity: string;
  status: string;
  /** `task` | `fact` | `decision` — absent on every row recorded before it
   *  existed, which `rowKind` reads rather than rewriting them. */
  kind?: string;
  note?: string;
  source?: string;
  /** When the row was last WRITTEN. */
  updatedAt?: number;
  /** When its claim was last CONFIRMED — the freshness, which an edit must not
   *  move. Absent on older rows; `ageDays` falls back to `updatedAt`. */
  verifiedAt?: number;
}

/** The per-instance ledger file, keyed by the launch dir (same encoding as
 *  channels/crons). Distinct launch dirs → distinct ledgers. */
export function ledgerFileFor(cwd: string): string {
  const enc = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".shadok-ai", "ledger", enc + ".json");
}

/** The legacy single-file ledger, before it was scoped per instance. */
export function legacyLedgerFile(): string {
  return path.join(os.homedir(), ".shadok-ai", "ledger.json");
}

function readRows(file: string): LedgerRow[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

/** A short id: 4 hex chars, not already taken. The ledger is tiny per instance,
 *  so 16 bits is ample; a durable, quotable handle for update-by-id. */
export function mintLedgerId(taken: ReadonlySet<string>): string {
  for (let i = 0; i < 1000; i++) {
    const id = crypto.randomBytes(2).toString("hex");
    if (!taken.has(id)) return id;
  }
  // Astronomically unlikely for a table this size; widen rather than loop forever.
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Make sure THIS instance has its own ledger file, and that every row carries an
 * id (the durable handle). Called at boot. Seeds the scoped file from the legacy
 * single-file ledger the first time (so nothing already recorded is lost), then
 * backfills any id-less rows. Idempotent and best-effort — a failure here must
 * never break the boot.
 */
export function ensureLedgerFile(cwd: string): void {
  try {
    const file = ledgerFileFor(cwd);
    let rows: LedgerRow[];
    if (fs.existsSync(file)) {
      rows = readRows(file);
    } else {
      // Seed from the legacy global ledger if present (COPY, not move — a second
      // instance on the same machine seeds its own from the same source, then
      // the two diverge, which is the point of per-instance).
      rows = fs.existsSync(legacyLedgerFile()) ? readRows(legacyLedgerFile()) : [];
    }
    const taken = new Set(rows.map((r) => r.id).filter((x): x is string => !!x));
    let changed = !fs.existsSync(file);
    for (const r of rows) {
      if (!r.id) {
        r.id = mintLedgerId(taken);
        taken.add(r.id);
        changed = true;
      }
    }
    if (changed) writeRows(file, rows);
  } catch {
    /* boot must not depend on the ledger */
  }
}

function writeRows(file: string, rows: LedgerRow[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read the rows of a ledger file (empty on any error). */
export function loadLedger(file: string): LedgerRow[] {
  return readRows(file);
}

/** The rows changed since `watermark`, newest-first, capped at `cap`. `total` is
 *  the full count of changed rows (may exceed `rows.length` when capped). */
export function deltaSince(
  rows: LedgerRow[],
  watermark: number,
  cap: number,
): { rows: LedgerRow[]; total: number } {
  const changed = rows
    .filter((r) => (r.updatedAt ?? 0) > watermark)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { rows: changed.slice(0, cap), total: changed.length };
}

const LEDGER_HEAD = "⟦ledger · ";
/* ------------------------------------------------------------------ *
 * The block is ONE LINE, and that is a correctness requirement, not a style.
 *
 * `pilot.submit` puts the text into the TUI as a bracketed PASTE, and Claude
 * Code collapses a paste past a threshold into a `<pasted_content>` wrapper —
 * which its own system prompt tells the model is material the user pasted from
 * somewhere else, to be acted on only where the user's own message asks. With a
 * multi-line block the human's message is INSIDE that wrapper, so it stops being
 * an instruction. Measured end to end: an agent answered "your last message
 * contained only pasted text, with no request of your own alongside it… I
 * haven't acted on that line", and refused a direct order.
 *
 * Both thresholds measured against a live agent and confirmed on 486 real human
 * prompts from this machine's transcripts:
 *
 *   lines  1–3 → 0 of 324 wrapped        chars  430 on one line → not wrapped
 *   lines  4+  → ~30% of 162 wrapped     chars  910 on one line → wrapped
 *
 * The old multi-line block spent 2+ lines and put EVERY non-empty delta over
 * the cliff: 85 real prompts, 24% of those carrying a block, had the human's
 * message neutralised this way.
 *
 * Since #261 the block travels as its OWN paste, so it is judged ALONE — and
 * the rule it is judged by is the binary's own, read out of it rather than
 * bisected: `body.length <= 800 && newlines <= 2` (`var xK=800`). Two things
 * follow, and they move the budget.
 *
 *   - The cliff for the block is 800, not the 430 measured when it still had
 *     to share a prompt with the user's message. That measurement was of the
 *     WHOLE prompt and does not bound this paste.
 *   - Two newlines means the prelude may carry a SECOND line. The delta keeps
 *     one and leaves the other free; nothing here should spend it by accident.
 *
 * So the block stays one line out of thrift and headroom, no longer out of
 * correctness — and its budget is now set by what the reader needs (see
 * `ROWS_TARGET`) rather than by how little it dares to spend.
 * ------------------------------------------------------------------ */

/** Marks what follows the row, inline: "and here is what happened". */
const CONT_MARK = "↳";
/** Historical multi-line blocks, still replayed out of old transcripts. */
const CONT_LINE = /^\s*↳ /;
/**
 * How much of a note reaches the block. 120 cut the first sentence of a real
 * `decision` row at 126 characters — "aucune action directe déclenchée par…",
 * whose missing complement ("par un mail") carried the whole decision, so what
 * was left could be read as its opposite. 19% of this table's notes were cut at
 * 120, 13% at 160. It stops at 160 rather than going further because a headline
 * is only ever served WHOLE (see `formatLedgerBlock`): a larger cap does not buy
 * better headlines, it buys fewer of them — the long ones stop fitting the room
 * left after the labels and are dropped entirely.
 */
const HEADLINE_MAX = 160;
/** Below this, a sentence boundary is not believed — see `headline`. */
const HEADLINE_MIN = 24;
/**
 * How many rows the block tries to NAME. This, not a character count, is what
 * the reader needs ("there are nine, here is who they are"), and it is the one
 * quantity that does not change from one instance's table to another's: the
 * character cost of three rows does, which is why the budget is expressed in
 * rows and only BOUNDED in characters. A table whose labels are short pays less
 * for the same information; one whose labels are long pays more, up to the
 * ceiling — the cost adapts, the payload stays constant.
 */
const ROWS_TARGET = 3;
/**
 * The block's character bound. Claude Code keeps a paste inline only below 800
 * characters AND 2 newlines (`xK` in the binary; the prelude is the block plus
 * one newline), and since the block travels as its OWN paste it is judged alone
 * — so the old 320, calibrated when it had to share a prompt with the user's
 * message, is no longer where the cliff is. 560 leaves the second line of the
 * paste free and a wide margin under 800.
 */
const BLOCK_MAX = 560;
/**
 * Hard stop for the rendered line, defensive only: one pathological row must not
 * be able to push the block past the paste rule, which would collapse it into
 * `<pasted_content>` — survivable since #261 (the block is wrapped alone and the
 * message stays an instruction) but it would still cost the delta its voice.
 */
const LINE_CEILING = 700;

/**
 * The one line of the note that says WHAT happened, DERIVED rather than asked
 * for. The block used to carry `[id] entity — status` and nothing else, so the
 * entity *label* was the whole payload — and a label written as a topic name
 * ("report regeneration, 15 test accounts") cannot say what changed about it.
 * That is how work finished on the 9th was still believed pending on the 12th.
 *
 * Derived, because the alternative — a mandatory `--headline` — asks every agent
 * for writing discipline (which nothing enforces) and covers none of the rows
 * already recorded. The note's first sentence needs neither.
 */
export function headline(note: string | undefined, max: number = HEADLINE_MAX): string {
  const flat = String(note ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // A period ends a sentence only when whitespace follows it: this table is full
  // of "claude-code-2.1.285" and "PR#259 / v0.13.4", and splitting on a bare dot
  // would cut every one of them in half. And a boundary that would leave almost
  // nothing is not one — "e.g. the nightly job" is one sentence, not "e.g.".
  let first = flat;
  const bound = /[.!?](?=\s)/g;
  for (let m = bound.exec(flat); m; m = bound.exec(flat)) {
    if (m.index + 1 >= HEADLINE_MIN) {
      first = flat.slice(0, m.index + 1);
      break;
    }
  }
  first = first.trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  // Break on a word unless that would throw away most of the line.
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/** `• [id] entity — status (source)` — the part of a row the reader cannot
 *  reconstruct from anywhere else. The label is capped at render time, never in
 *  the table: `check` and `list` still print it whole, and the `[id]` stays the
 *  handle to quote (see `LABEL_MAX`). */
function bareRow(r: LedgerRow): string {
  const handle = r.id ? `[${r.id}] ` : "";
  const src = r.source ? ` (${r.source})` : "";
  // A `fact` has no lifecycle and a `decision` is not a phase of one, so the
  // reader must not take their status for a position in open → resolved.
  // `task` is the default and nearly the whole table: tagging it would be noise.
  const kind = rowKind(r);
  const tag = kind === "task" ? "" : ` · ${kind}`;
  const label =
    r.entity.length > LABEL_MAX ? r.entity.slice(0, LABEL_MAX - 1).trimEnd() + "…" : r.entity;
  return ` • ${handle}${label} — ${r.status}${tag}${src}`;
}

/**
 * What stands for the rows the budget could not name. It carries their IDS: an
 * id is the handle `record --id` takes and `check` resolves, so a reader that
 * recognises one can act on it, while `+8 more` leaves it with all of them or
 * none. The count and the list are kept HONEST apart, because the delta is
 * capped (`LEDGER_PUSH_CAP`) and `total` can exceed the rows we were handed —
 * announcing `+8 : <7 ids>` would quietly lose one.
 */
function overflowMark(rows: LedgerRow[], shown: number, total: number): string {
  const missing = total - shown;
  if (missing <= 0) return "";
  const ids = rows.slice(shown).map((r) => r.id).filter(Boolean);
  const tail = " — run: ledger list)";
  if (!ids.length) return ` • (+${missing} more${tail}`;
  if (ids.length === missing) return ` • (+${missing} : ${ids.join(" ")}${tail}`;
  return ` • (+${missing} more, ${ids.length} newest: ${ids.join(" ")}${tail}`;
}

/**
 * The delta block the agent sees ahead of a prompt. English (it is written into
 * the transcript — repo side). ONE line: per row `• [id] entity — status
 * (source)`, the kind when it is not the default `task`, and `↳ <headline>` for
 * what actually happened.
 *
 * Labels are served BEFORE any headline, and that order is the whole of it. The
 * first version appended row i's headline before testing whether row i+1 fitted,
 * so the first row's detail outbid the second row's existence — measured on this
 * table, a delta of 2, 5, 7 or 9 rows named exactly ONE of them every time, at
 * any size, while 52 characters of the budget went unspent. `ledger list` gives
 * the reader the notes in one call; nothing gives them back a row they were
 * never told existed.
 */
export function formatLedgerBlock(rows: LedgerRow[], total: number): string {
  const head = `${LEDGER_HEAD}${total} update${total === 1 ? "" : "s"}⟧`;
  const bare = rows.map(bareRow);
  // 1. How many rows can be named — the overflow mark is part of the bill, so a
  //    row is only taken when what stands for the rest still fits beside it.
  let shown = 0;
  let len = head.length;
  for (let i = 0; i < bare.length && shown < ROWS_TARGET; i++) {
    const mark = overflowMark(rows, i + 1, total).length;
    // Always carry at least one row: a block that announces a delta and names
    // nothing is worse than a long line.
    if (shown > 0 && len + bare[i].length + mark > BLOCK_MAX) break;
    len += bare[i].length;
    shown++;
  }
  const mark = overflowMark(rows, shown, total);
  // 2. Headlines go in the room that is left, first row first — and only WHOLE:
  //    a sentence cut by whatever happened to remain is the defect HEADLINE_MAX
  //    already exists to bound, and it can invert the meaning it loses.
  let line = head;
  let used = len + mark.length;
  for (let i = 0; i < shown; i++) {
    line += bare[i];
    const h = headline(rows[i].note);
    if (h && used + h.length + 3 <= BLOCK_MAX) {
      line += ` ${CONT_MARK} ${h}`;
      used += h.length + 3;
    }
  }
  line += mark;
  return line.length > LINE_CEILING ? line.slice(0, LINE_CEILING - 1) + "…" : line;
}

/** Prepend the block as its own leading line. Idempotent.
 *
 *  NOT how the block reaches a live agent any more — it goes in as a separate
 *  PASTE (`pilot.submit(text, prelude)`), which is what keeps the user's message
 *  out of the `<pasted_content>` wrapper. Kept because it is the exact shape of
 *  every transcript written before that change, which `stripLedgerBlock` must go
 *  on understanding and which the tests build from. */
export function markLedgerBlock(text: string, block: string): string {
  if (hasLedgerBlock(text)) return text;
  return `${block}\n${text}`;
}

/** Does this text open with a pushed ledger block?
 *
 *  `⟧` CLOSES the header, it no longer ENDS the line: a one-line block continues
 *  with its rows after it. Testing `endsWith` here was the first thing the
 *  one-line format broke, and it fails open — detection returns false, nothing
 *  is stripped, and the whole block is shown to the user in the chat. The old
 *  multi-line shape satisfies this test too, so replayed transcripts are
 *  unaffected. */
export function hasLedgerBlock(text: string): boolean {
  if (typeof text !== "string") return false;
  const first = text.split("\n", 1)[0];
  return first.startsWith(LEDGER_HEAD) && first.includes("⟧");
}

/** Remove a leading ledger block, leaving whatever came after (the ⟦platform⟧
 *  header and the user's message). A plain message is returned untouched.
 *
 *  The block is one line now, so that is usually all this drops — but it must
 *  keep understanding the HISTORICAL multi-line shape (header, `• ` bullets,
 *  indented `↳` headlines), because `loadHistory` replays transcripts written
 *  before the format changed and a block it fails to strip is a block the user
 *  reads in the chat. */
export function stripLedgerBlock(text: string): string {
  if (!hasLedgerBlock(text)) return text;
  const lines = text.split("\n");
  let i = 1; // drop the header line
  while (i < lines.length && (lines[i].startsWith("• ") || CONT_LINE.test(lines[i]))) i++;
  // …and the blank lines it leaves behind. The block now travels as its OWN
  // paste, so the transcript holds `</pasted_content>` and a blank line between
  // it and the ⟦platform⟧ header; `userPromptText` peels the tags but not the
  // gap. A leading blank line is not cosmetic here — `parsePromptMeta` reads the
  // FIRST line, so it would stop recognising the header, losing the sender and
  // leaving `⟦web · … · admin⟧` visible in the chat.
  return lines.slice(i).join("\n").replace(/^\n+/, "");
}

/* ------------------------------------------------------------------ *
 * The per-agent watermark: "what had this agent already seen?"
 *
 * It used to live only in memory, on the `Live`, anchored to the attach
 * instant. A `Live` is rebuilt on every server restart — i.e. on every
 * auto-update — and again whenever a dormant channel is woken, so the
 * watermark jumped to "now" and the next delta came back EMPTY. Measured on a
 * real instance: of the pushes that were due, roughly two in three never
 * arrived, and the misses clustered exactly on merge times — a merge publishes,
 * the instance updates, every watermark resets, and the very burst of ledger
 * activity that merge produced is what gets swallowed.
 *
 * So it is written down, next to the table it tracks and keyed the same way.
 * An agent with no record is NEW and still anchors to now (no history flood);
 * an agent that has one gets its backlog, bounded by the push cap.
 * ------------------------------------------------------------------ */

/** Where this instance stores its agents' ledger watermarks. Beside the table,
 *  same launch-dir encoding, distinct name — writing one must never clobber the
 *  other. */
export function ledgerSeenFileFor(cwd: string): string {
  const enc = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".shadok-ai", "ledger", enc + "-seen.json");
}

function readSeenMap(file: string): Record<string, number> {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j)) if (typeof v === "number" && isFinite(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * The moment this agent last saw the ledger, or `undefined` if it never has.
 * The two are DIFFERENT answers and the caller acts on the difference: no
 * record means a fresh agent, which anchors to now rather than replaying the
 * whole table (0 would do exactly that).
 */
export function seenFor(file: string, sessionId: string): number | undefined {
  const v = readSeenMap(file)[sessionId];
  return typeof v === "number" ? v : undefined;
}

/**
 * Keep the map bounded: drop agents that no longer exist (`keep` is the live
 * channel list), never drop the one being written — a spawn can race its own
 * channel upsert, and losing that entry would re-anchor it to now — and cap the
 * rest newest-first as a backstop when there is no list to compare against.
 * Pure.
 */
export function pruneSeen(
  map: Record<string, number>,
  keep: ReadonlySet<string> | undefined,
  current: string,
  cap: number,
): Record<string, number> {
  const kept = Object.entries(map).filter(([id]) => id === current || !keep || keep.has(id));
  kept.sort((a, b) => (a[0] === current ? -1 : b[0] === current ? 1 : b[1] - a[1]));
  return Object.fromEntries(kept.slice(0, cap));
}

/** Highest number of agent watermarks kept. Well above any plausible channel
 *  count; only a missing channel list can ever make it bite. */
const SEEN_CAP = 200;

/**
 * Write this agent's watermark. Best-effort and atomic: a lost write costs a
 * duplicated block on the next prompt, never a swallowed one, so it must never
 * be able to break a turn.
 */
export function recordSeen(
  file: string,
  sessionId: string,
  at: number,
  keep?: ReadonlySet<string>,
): void {
  try {
    const map = readSeenMap(file);
    map[sessionId] = at;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(pruneSeen(map, keep, sessionId, SEEN_CAP), null, 2), {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
  } catch {
    /* a turn must never fail over a watermark */
  }
}
