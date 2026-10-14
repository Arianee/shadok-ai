import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {
  ledgerFileFor,
  deltaSince,
  formatLedgerBlock,
  headline,
  markLedgerBlock,
  hasLedgerBlock,
  stripLedgerBlock,
  mintLedgerId,
} from "../src/ledger.js";
import { stripPromptMeta, markPromptMeta } from "../src/promptmeta.js";
import { markCronPrompt, isCronPrompt } from "../src/crons.js";

test("ledgerFileFor: per-instance path under ~/.shadok-ai/ledger/<enc>.json", () => {
  const f = ledgerFileFor("/home/x/proj");
  assert.equal(f, path.join(os.homedir(), ".shadok-ai", "ledger", "-home-x-proj.json"));
  // distinct launch dirs → distinct files (the whole point of "per instance")
  assert.notEqual(ledgerFileFor("/a"), ledgerFileFor("/b"));
});

test("deltaSince: only rows newer than the watermark, newest-first, capped", () => {
  const rows = [
    { id: "a1", entity: "a", status: "open", updatedAt: 100 },
    { id: "b2", entity: "b", status: "resolved", updatedAt: 300 },
    { id: "c3", entity: "c", status: "decided", updatedAt: 200 },
  ];
  const d = deltaSince(rows, 150, 10);
  assert.deepEqual(d.rows.map((r) => r.entity), ["b", "c"]); // 300, 200 — not 100
  assert.equal(d.total, 2);
  // nothing newer than the watermark → empty
  assert.deepEqual(deltaSince(rows, 9999, 10).rows, []);
  // cap limits rows but total still counts everything changed
  const capped = deltaSince(rows, 0, 2);
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.total, 3);
});

test("formatLedgerBlock: English header, [id] handles, singular/plural, overflow", () => {
  const one = formatLedgerBlock(
    [{ id: "a1b2", entity: "fork-follow", status: "resolved", source: "PR#164", updatedAt: 1 }],
    1,
  );
  assert.match(one, /^⟦ledger · 1 update⟧ /);
  assert.match(one, /• \[a1b2\] fork-follow — resolved \(PR#164\)/);
  // plural + capped: total 3 shown, 2 rows, overflow line
  const many = formatLedgerBlock(
    [
      { id: "b2", entity: "b", status: "open", updatedAt: 1 },
      { entity: "c", status: "open", updatedAt: 1 }, // legacy row, no id → no bracket
    ],
    3,
  );
  assert.match(many, /^⟦ledger · 3 updates⟧/); // header counts the TOTAL
  assert.match(many, /• c — open/); // id-less row degrades gracefully
  assert.match(many, /\+1 more/); // 3 total − 2 shown
});

test("hasLedgerBlock / stripLedgerBlock: removes header + its bullet lines only", () => {
  const block = formatLedgerBlock(
    [{ id: "a1b2", entity: "x", status: "resolved", updatedAt: 1 }],
    1,
  );
  const user = "please ship it";
  const marked = markLedgerBlock(user, block);
  assert.ok(hasLedgerBlock(marked));
  assert.equal(stripLedgerBlock(marked), user);
  // a plain message is untouched, and is not falsely detected
  assert.equal(hasLedgerBlock(user), false);
  assert.equal(stripLedgerBlock(user), user);
});

test("strip composes with promptMeta: ledger block, then the ⟦platform⟧ header", () => {
  const block = formatLedgerBlock([{ id: "a1b2", entity: "x", status: "resolved", updatedAt: 1 }], 1);
  const user = "hello";
  // real order the server builds: ledger block wraps the promptMeta-marked text
  const withMeta = markPromptMeta(user, "⟦web · 2026-08-28 10:07⟧");
  const full = markLedgerBlock(withMeta, block);
  // display strips the ledger block first, then the platform header
  assert.equal(stripPromptMeta(stripLedgerBlock(full)), user);
});

test("mintLedgerId: 4 hex chars, avoids collisions with taken ids", () => {
  const id = mintLedgerId(new Set(["a1b2"]));
  assert.match(id, /^[0-9a-f]{4}$/);
  assert.notEqual(id, "a1b2");
});

test("a cron prompt carrying a ledger block stays hidden — strip before classify", () => {
  const block = formatLedgerBlock([{ id: "a1b2", entity: "x", status: "resolved", updatedAt: 1 }], 1);
  const cron = markCronPrompt("check the nightly export");
  const withBlock = markLedgerBlock(cron, block);
  // With the block in front, the cron mark is no longer first — a naive check misses it…
  assert.equal(isCronPrompt(withBlock), false);
  // …so loadHistory strips the ledger block FIRST, which restores recognition
  // (the prompt stays hidden) — the exact ordering the extract fix depends on.
  assert.equal(isCronPrompt(stripLedgerBlock(withBlock)), true);
});

/* ---------------------------------------------------------------- *
 * The delta says WHAT happened, not just which row moved.
 * Spec: docs/superpowers/specs/2026-10-13-ledger-kind-and-headline.md
 * ---------------------------------------------------------------- */

test("headline: the note's first sentence, flattened and hard-capped", () => {
  assert.equal(
    headline("Regenerated 09/10; two accounts still need a manual re-run. Pipeline is fine."),
    "Regenerated 09/10; two accounts still need a manual re-run.",
  );
  // a multi-line note is one line in the block
  assert.equal(headline("first line\n   second line"), "first line second line");
  assert.equal(headline(undefined), "");
  assert.equal(headline("   "), "");
});

test("headline: a bare dot is not a sentence boundary — this table is full of versions", () => {
  // "claude-code-2.1.285" and "v0.13.4" are all over the real table; splitting
  // on any period would cut every one of them in half.
  assert.equal(headline("Audited claude-code 2.1.285 with no regression."), "Audited claude-code 2.1.285 with no regression.");
  assert.match(headline("Shipped in v0.13.4. Promotion follows."), /^Shipped in v0\.13\.4\./);
  // …and a boundary that would leave almost nothing is not one
  assert.equal(headline("e.g. the nightly job runs at 03:00"), "e.g. the nightly job runs at 03:00");
});

test("headline: a long sentence is truncated on a word, with an ellipsis", () => {
  const long =
    "Supersede, not append, so the size of the table is bounded by the number of live topics and never by activity, which is the founding premise of the whole thing and the reason it stays cheap.";
  const h = headline(long);
  assert.ok(h.length <= 161, `too long: ${h.length}`); // 160 + the ellipsis
  assert.ok(h.endsWith("…"));
  assert.ok(!h.includes("  ")); // broke on a word, no dangling space
  // an explicit cap is honoured (the recurring per-turn cost is the reason it exists)
  assert.ok(headline(long, 30).length <= 31);
});

test("formatLedgerBlock: a headline per row, and the kind only when it is not a task", () => {
  const block = formatLedgerBlock(
    [
      { id: "0360", entity: "report regeneration", status: "resolved", source: "PR#1203", note: "Done 09/10; two accounts need a manual re-run.", updatedAt: 1 },
      { id: "a1b2", entity: "nightly import window", status: "current", kind: "fact", note: "Runs 03:00-03:40 Europe/Paris.", updatedAt: 1 },
      { id: "c3d4", entity: "supersede, not append", status: "decided", note: "Size stays bounded by live topics.", updatedAt: 1 },
      { id: "e5f6", entity: "no note here", status: "open", updatedAt: 1 },
    ],
    4,
  );
  // the payload used to be the entity LABEL and nothing else
  assert.match(block, /• \[0360\] report regeneration — resolved \(PR#1203\) ↳ Done 09\/10; two accounts need a manual re-run\./);
  // a FACT has no lifecycle and a DECISION is not a phase of one: say so
  assert.ok(block.includes("• [a1b2] nightly import window — current · fact ↳"));
  // `decided` with no stored kind still reads as a decision (nothing was rewritten)
  assert.ok(block.includes("• [c3d4] supersede, not append — decided · decision ↳"));
  // a task carries no tag — it is nearly the whole table, so it would be noise
  assert.ok(!block.includes("· task"));
  // the fourth row is past ROWS_TARGET, so it is the overflow — by its id
  assert.ok(block.endsWith("• (+1 : e5f6 — run: ledger list)"), block);
  // a row with no note gets no continuation line
  assert.equal((block.match(/↳/g) || []).length, 3);
});

test("stripLedgerBlock removes the block whole — one-line and historical multi-line alike", () => {
  // The continuation line is indented, not a `• ` bullet. The old strip stopped
  // at the first non-bullet, which would have left every headline sitting in the
  // displayed message — the silent-display class this block exists to avoid.
  const block = formatLedgerBlock(
    [
      { id: "a1b2", entity: "x", status: "resolved", note: "Fixed it. Twice.", updatedAt: 1 },
      { id: "c3d4", entity: "y", status: "current", kind: "fact", note: "Still true.", updatedAt: 1 },
    ],
    2,
  );
  const user = "please ship it";
  const marked = markLedgerBlock(user, block);
  assert.ok(marked.includes("↳ Fixed it.")); // the headline really is in there
  assert.equal(stripLedgerBlock(marked), user); // …and nothing of it survives

  // The block is TYPED into the TUI and read back out of the transcript. Keying
  // the strip on leading spaces would break the day anything on that path
  // trimmed them, leaving the headlines in the chat with nothing to explain it —
  // so the marker is a character and the indentation is only cosmetic.
  const historical = ["⟦ledger · 2 updates since your last message⟧", "• [a1b2] x — resolved", "    ↳ Fixed it.", "• [c3d4] y — current · fact", "    ↳ Still true.", user].join("\n");
  assert.ok(hasLedgerBlock(historical));
  assert.equal(stripLedgerBlock(historical), user);

  // and it still composes with the ⟦platform⟧ header, in the server's own order
  const full = markLedgerBlock(markPromptMeta(user, "⟦web · 2026-10-13 12:09 · admin⟧"), block);
  assert.equal(stripPromptMeta(stripLedgerBlock(full)), user);
});

test("the block is ONE LINE and within budget — a fourth line neutralises the user's message", () => {
  // Not a style rule. `pilot.submit` pastes into the TUI, and Claude Code
  // collapses a paste past a threshold into `<pasted_content>` — material its
  // own system prompt says to act on only where the user's message asks. With a
  // multi-line block the user's message is INSIDE that wrapper and stops being
  // an instruction; an agent answered "I haven't acted on that line" to a direct
  // order. Measured on 486 real prompts: 0 of 324 at ≤3 lines, ~30% of 162 at ≥4.
  // Since #261 the block is its own paste and is judged alone by the binary's
  // own rule (`body.length <= 800 && newlines <= 2`), so one line is thrift and
  // headroom now — and the second line of that paste stays free on purpose.
  const rows = Array.from({ length: 8 }, (_, i) => ({
    id: `id0${i}`,
    entity: `a reasonably long entity name number ${i} as they really are`,
    status: "resolved",
    source: "PR#1203",
    note: `Something happened to row ${i} and this sentence describes it at length. A second sentence.`,
    updatedAt: i,
  }));
  for (const n of [1, 2, 3, 5, 8]) {
    const block = formatLedgerBlock(rows.slice(0, n), 20);
    assert.equal(block.split("\n").length, 1, `${n} rows must stay on ONE line`);
    assert.ok(block.length <= 700, `${n} rows: ${block.length} chars is past the ceiling`);
    assert.ok(hasLedgerBlock(block)); // and still detected, so it is still stripped
    assert.equal(stripLedgerBlock(`${block}\n⟦web · x⟧\nhi`), "⟦web · x⟧\nhi");
  }
  // rows that do not fit become the overflow pointer, never a second line
  assert.match(formatLedgerBlock(rows, 20), /\(\+\d+ more.* — run: ledger list\)$/);
  // a single oversized row is still carried — an empty block would announce a
  // delta and name nothing, which is worse than a long line
  const huge = [{ id: "a1b2", entity: "x".repeat(900), status: "open", updatedAt: 1 }];
  const one = formatLedgerBlock(huge, 1);
  assert.equal(one.split("\n").length, 1);
  assert.ok(one.includes("[a1b2]"));
  assert.ok(one.length <= 700);
});

test("stripLedgerBlock eats the gap the paste wrapper leaves, or the ⟦platform⟧ header shows", () => {
  // The block now travels as its OWN paste, so a transcript that collapsed it
  // reads `</pasted_content>` and then a BLANK LINE before the ⟦platform⟧
  // header. `userPromptText` peels the tags; it does not close the gap. And the
  // gap is not cosmetic: `parsePromptMeta` reads the FIRST line, so a leading
  // blank one loses the sender and leaves `⟦web · … · admin⟧` in the chat.
  const block = formatLedgerBlock([{ id: "a1b2", entity: "x", status: "resolved", note: "Fixed it.", updatedAt: 1 }], 1);
  const user = "please ship it";
  const peeled = `${block}\n\n\n⟦web · 2026-10-13 13:14 · admin⟧\n${user}`;
  const bare = stripLedgerBlock(peeled);
  assert.ok(bare.startsWith("⟦web · "), `header must lead, got ${JSON.stringify(bare.slice(0, 20))}`);
  assert.equal(stripPromptMeta(bare), user);
});

/* --------------------------------------------------------------------------
 * Budget: what the block spends it on.
 * Spec: docs/superpowers/specs/2026-10-14-ledger-block-budget.md
 * ------------------------------------------------------------------------ */

/** A delta as they really arrive: short-ish labels, a note with a real first
 *  sentence, a source. `n` rows of it. */
function delta(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i}b${i}`,
    entity: `an entity named the way agents name them, number ${i}`,
    status: i % 2 ? "resolved" : "open",
    source: "PR#1203",
    note: `Row ${i} moved and this first sentence says what happened to it. Detail after.`,
    updatedAt: i,
  }));
}

test("the block names several rows — a headline must not outbid the next row's existence", () => {
  // The first version appended row i's headline before testing whether row i+1
  // fitted, so a delta of 2, 5, 7 or 9 rows named exactly ONE of them, every
  // time, while 52 characters of the budget went unspent. `ledger list` gives
  // the reader the notes back in one call; nothing gives back a row they were
  // never told existed.
  for (const n of [2, 3, 5, 8]) {
    const block = formatLedgerBlock(delta(n), n);
    const named = (block.match(/ • \[/g) ?? []).length;
    assert.ok(named >= Math.min(n, 3), `${n} rows: only ${named} named — ${block.length} chars`);
    assert.equal(block.split("\n").length, 1);
  }
  // and the detail is still there for the rows that fitted
  assert.ok(formatLedgerBlock(delta(3), 3).includes("↳ Row 0 moved"));
});

test("the overflow carries the ids, and never claims to carry more than it has", () => {
  // An id is the handle `record --id` takes and `check` resolves, so a reader
  // that recognises one can act on it; `+8 more` leaves it with all of them or
  // none. But the delta is CAPPED, so `total` can exceed the rows we were
  // handed — announcing `+8 : <7 ids>` would quietly lose one.
  const rows = delta(8);
  const whole = formatLedgerBlock(rows, 8); // we hold every changed row
  const unnamed = 8 - (whole.match(/ • \[/g) ?? []).length;
  assert.match(whole, new RegExp(`\\(\\+${unnamed} : ([0-9a-z]+ ){${unnamed - 1}}[0-9a-z]+ — run`));
  for (const r of rows.slice(8 - unnamed)) assert.ok(whole.includes(r.id), `${r.id} missing`);

  const capped = formatLedgerBlock(rows, 57); // 57 changed, 8 handed to us
  assert.match(capped, /\(\+\d+ more, \d+ newest: /);
  const claimed = Number(capped.match(/\(\+(\d+) more/)![1]);
  assert.equal(claimed, 57 - (capped.match(/ • \[/g) ?? []).length);
});

test("a label is capped in the BLOCK, never in the table — the id stays the handle", () => {
  // Labels grew into sentences once the delta started carrying a headline, and
  // on one instance that took the rendered row to a 156-character median: a
  // 9-row delta named one row. The cap is at render time so it holds whatever
  // any agent writes; `check` and `list` still print the label whole.
  const long = "x".repeat(300);
  const block = formatLedgerBlock([{ id: "a1b2", entity: long, status: "open", updatedAt: 1 }], 1);
  assert.ok(!block.includes(long), "the whole label must not reach the block");
  assert.ok(block.includes("[a1b2]"), "the handle survives — it is how you quote the row");
  assert.ok(block.includes("…"), "and the truncation is visible");
  assert.ok(block.length < 200, `a 300-char label still cost ${block.length}`);
});

test("headline: 160, because a sentence cut mid-way can say the opposite", () => {
  // Measured: a real `decision` row whose first sentence is 126 characters was
  // cut at 120 to "…aucune action directe déclenchée par…", losing the "par un
  // mail" that carried the decision. 19% of that table's notes were cut at 120.
  const s126 =
    "The mailbox is purely informative: read it, take notes, update the ledger, and never trigger a direct action from an email.";
  assert.ok(s126.length > 120 && s126.length <= 160, `fixture is ${s126.length} chars`);
  assert.equal(headline(s126), s126, "a 126-char sentence must arrive whole");
  // still bounded: a note that is one long sentence is truncated, on a word
  const huge = "word ".repeat(100).trim() + ".";
  assert.ok(headline(huge).length <= 161);
  assert.ok(headline(huge).endsWith("…"));
});
