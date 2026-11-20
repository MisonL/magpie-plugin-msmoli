// Every test mode this repository runs, in the order CI runs them, so a
// publish from a machine that never saw CI cannot skip one. `npm test` alone
// leaves the ticking clock, the shifted clock and Bun unexercised; each has
// caught a real regression in this project's history.
//
// A mode's exit code is not the whole story. A runner that finds no tests (a
// test file deleted, a `test/` path renamed, a glob that stopped matching)
// exits 0 with a summary of zero, and this gate reported "every mode passed"
// for a suite that had not run: the release went out on nothing. So each
// mode's own summary is read and a floor is enforced, and the two clock modes
// have to report one more test than the plain run — the extra test is the
// mode's own proof that its shim is in effect (test/plugin.test.mjs adds it
// only under that mode). A shim that went inert leaves the counts equal and
// fails here instead of passing as a green mode that tested the plain clock.
//
// Bun is the runtime magpie actually runs plugins on. It is skipped only when
// the binary is missing, and the skip is printed loudly — never silently.

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

// Today's suite is 793 tests (the plain run); the floor leaves room for a
// legitimate consolidation while still catching a whole file that vanished.
// (Keep this number current: a stale one reads as a suite that shrank. It sat
// at 600 while the comment said 726, so about 160 tests could have gone
// missing — most of one test file — with the gate still green.)
const MIN_TESTS = 700

// The count floor alone does not catch one file going missing: sync.test.mjs is
// ~314 tests and style.test.mjs is 7, so dropping either still clears 700, and
// the runner reports a green mode for what is left. (Measured: with
// test/style.test.mjs deleted the gate printed "every mode passed".) The three
// files are named here so a publish cannot go out with one of them gone.
const FILES = ["test/plugin.test.mjs", "test/sync.test.mjs", "test/style.test.mjs"]

// Present is not the same as intact: a file truncated by a bad merge to its
// first test still clears the global floor. Measured on the 768-test suite,
// with test/style.test.mjs trimmed from 7 tests to 1 the gate printed "every
// mode passed" at 762 — the line-ending, trailing-whitespace and indentation
// checks had silently gone, and the publish went out on a suite missing a
// file's worth of guards. So each file is also run on its own and held to a
// floor of its own. The numbers are today's counts (472 / 314 / 7) less room
// for a legitimate consolidation; keep them current the way MIN_TESTS is.
const PER_FILE = [
  { file: "test/plugin.test.mjs", min: 430 },
  { file: "test/sync.test.mjs", min: 280 },
  { file: "test/style.test.mjs", min: 5 },
]

const missing = FILES.filter((f) => !existsSync(f))
if (missing.length) {
  process.stdout.write(`FAILED: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing; the suite would run short and still pass its floor.\n`)
  process.exit(1)
}

const modes = [
  { name: "node --test", cmd: "node", args: ["--test"] },
  {
    name: "node --import ./tools/ticking-clock.mjs --test",
    cmd: "node",
    args: ["--import", "./tools/ticking-clock.mjs", "--test"],
    // the mode's own probe test must run: it is the only test that is not in
    // the plain run, and its absence is how an inert shim would hide. Its NAME
    // is what proves it — a count one higher is satisfied by any extra test a
    // stray file in the folder contributes (a decoy *.test.mjs beside the
    // suite was measured passing the gate with the shim inert).
    probe: "the ticking clock shim is in effect for test files",
    expectsExtraTest: true,
  },
  {
    name: "node --test (shifted clock)",
    cmd: "node",
    args: ["--test"],
    env: { MSMOLI_FAKE_NOW: "1893456000000" },
    probe: "the shifted clock is in effect for this run",
    expectsExtraTest: true,
  },
  { name: "bun test", cmd: "bun", args: ["test"], optional: true },
]

// the runner's own summary, whichever one wrote it: Node 24's reporter prints
// "ℹ pass 676", Node 18 and 22 print the TAP form "# pass 676", and Bun prints
// " 676 pass". Node 18 is the engine floor in package.json, so a summary this
// could not read was a gate that passed on a count it never had.
// The LAST summary line, not the first: a stray test file beside the suite is
// collected by `node --test` too, and anything it prints — even a line that
// looks like the runner's own "ℹ pass 999" — arrives before the runner's
// summary. Reading the first match let that line stand in for the count
// (measured: a decoy *.test.mjs printing the summary cleared the floor).
const passedOf = (out) => {
  const matches = [
    ...[...out.matchAll(/^ℹ pass (\d+)$/gm)].map((m) => m[1]),
    ...[...out.matchAll(/^# pass (\d+)$/gm)].map((m) => m[1]),
    ...[...out.matchAll(/^\s*(\d+) pass$/gm)].map((m) => m[1]),
  ]
  return Number(matches.at(-1) ?? NaN)
}
// and a zero-fail line beside it: exit 0 is the runner's word, but a summary
// that names a failure is the gate's own evidence either way
const failedOf = (out) =>
  Number([...out.matchAll(/^\s*(?:ℹ |# )?fail (\d+)$/gm)].at(-1)?.[1] ?? 0)

let failed = false
let plain = null
for (const m of modes) {
  process.stdout.write(`\n$ ${[m.cmd, ...m.args].join(" ")}${m.env ? "  (env " + Object.keys(m.env).join(",") + ")" : ""}\n`)
  const r = spawnSync(m.cmd, m.args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(m.env ?? {}) },
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  process.stdout.write(out)
  if (r.error?.code === "ENOENT" && m.optional) {
    process.stdout.write(`SKIPPED: ${m.name}: ${m.cmd} is not installed; CI covers this mode.\n`)
    continue
  }
  if (r.error) {
    process.stdout.write(`FAILED: ${m.name}: ${r.error.message}\n`)
    failed = true
    continue
  }
  if (r.status !== 0) {
    process.stdout.write(`FAILED: ${m.name} exited ${r.status}\n`)
    failed = true
    continue
  }
  // exit 0 is not enough: a run that found nothing is not a green suite
  const passed = passedOf(out)
  if (failedOf(out) > 0) {
    process.stdout.write(`FAILED: ${m.name}: the summary names ${failedOf(out)} failing tests.\n`)
    failed = true
    continue
  }
  if (!Number.isFinite(passed) || passed < MIN_TESTS) {
    process.stdout.write(`FAILED: ${m.name}: the summary reports ${Number.isFinite(passed) ? `${passed} passing tests` : "no test count"}, below the ${MIN_TESTS} floor; the suite did not run.\n`)
    failed = true
    continue
  }
  if (plain === null) plain = passed
  if (m.expectsExtraTest && passed <= plain) {
    process.stdout.write(`FAILED: ${m.name}: ${passed} tests, no more than the plain run's ${plain}; the mode's own probe did not run, so its clock shim may be inert.\n`)
    failed = true
  }
  // the count is a weak proof on its own: a stray *.test.mjs in the folder is
  // collected by `node --test` and clears the "+1" without the probe running.
  // The probe test's own name has to appear in this mode's output.
  if (m.probe && !out.includes(m.probe)) {
    process.stdout.write(`FAILED: ${m.name}: the mode's probe test ${JSON.stringify(m.probe)} did not run; its clock shim may be inert.\n`)
    failed = true
  }
}

// Each file, alone: a file that is there but truncated still clears the global
// floor, and the runner's summary does not say which file a count came from.
// The three files are independent (none imports another), so running one is
// the same suite CI runs for it, and the count is the file's own.
for (const { file, min } of PER_FILE) {
  process.stdout.write(`\n$ node --test ${file}\n`)
  const r = spawnSync("node", ["--test", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
  if (r.error) {
    process.stdout.write(`FAILED: ${file}: ${r.error.message}\n`)
    failed = true
    continue
  }
  const passed = passedOf(out)
  if (failedOf(out) > 0) {
    process.stdout.write(`FAILED: ${file}: the summary names ${failedOf(out)} failing tests.\n`)
    failed = true
    continue
  }
  if (r.status !== 0) {
    process.stdout.write(out)
    process.stdout.write(`FAILED: ${file} exited ${r.status}\n`)
    failed = true
    continue
  }
  if (!Number.isFinite(passed) || passed < min) {
    process.stdout.write(`FAILED: ${file}: ${Number.isFinite(passed) ? `${passed} passing tests` : "no test count"}, below its own floor of ${min}; the file is there but short.\n`)
    failed = true
    continue
  }
  process.stdout.write(`${file}: ${passed} tests, floor ${min}.\n`)
}

if (failed) {
  process.stdout.write("\nprepublish: at least one mode failed; nothing was published.\n")
  process.exit(1)
}
process.stdout.write("\nprepublish: every mode passed.\n")
