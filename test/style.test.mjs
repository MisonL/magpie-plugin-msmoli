// The formatting rules from .editorconfig, pinned so they can't drift back.
//
// .editorconfig states the style — LF, no trailing whitespace, a final newline,
// two-space indentation — but nothing enforces it: a file saved by an editor
// with the wrong settings, or a pasted block with a stray tab or a trailing
// space, slips through and only shows up as diff noise on the next change. CI
// runs this with the rest of the suite, on every platform, so a checkout with
// core.autocrlf=true is caught here too (a CR creeping back in is the one that
// also breaks bin/sync.mjs's shebang, see .gitattributes).
//
// Only the rules that are unambiguous from the tree itself are checked. Markdown
// is exempt from the trailing-whitespace rule (.editorconfig says so, and two
// spaces before a newline is a hard break there), and the check is line-based,
// not a parser, so it stays cheap and gives a line number a reader can open.
//
// The files are discovered from the tree rather than listed. A hardcoded list
// has two failures this file is meant to catch: a new file is quietly outside
// the rules, and the list is easy to write without the file that carries it
// (this one was missing from its own list). Walking the tree means a file is
// covered the moment it lands.

import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const root = join(here, "..")

const walk = (dir, ext, out = []) => {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(rel, ext, out)
    else if (entry.name.endsWith(ext)) out.push(rel)
  }
  return out
}

const JS = walk("", ".mjs")
const MD = walk("", ".md")

const read = (rel) => readFileSync(join(root, rel), "utf8")

const sortedFiles = (files) => [...files].sort()

test("the tree walk finds the files it is meant to guard", () => {
  // A discovery list that comes back empty or truncated makes every check
  // below pass without looking at anything — the same "denominator is zero,
  // call it ok" failure the runtime probes guard against. Pin the floor and
  // the files that must be in it, including this one.
  assert.ok(JS.length >= 6, `the walk found only ${JS.length} .mjs files`)
  for (const rel of ["index.mjs", "bin/sync.mjs", "test/style.test.mjs"]) {
    assert.ok(JS.includes(rel), `the walk missed ${rel}`)
  }
  assert.ok(MD.length >= 3, `the walk found only ${MD.length} .md files`)
  assert.ok(MD.includes("README.md") && MD.includes("CONTRIBUTING.md"), "the walk missed a markdown file")
})

test("every JS file is LF, with no CR anywhere", () => {
  for (const rel of sortedFiles(JS)) {
    const text = read(rel)
    const cr = text.indexOf("\r")
    assert.equal(cr, -1, `${rel} has a CR at byte ${cr} (line ${text.slice(0, cr).split("\n").length}); the repo is LF-only`)
  }
})

test("every JS file ends with a single newline", () => {
  for (const rel of sortedFiles(JS)) {
    const text = read(rel)
    assert.ok(text.endsWith("\n"), `${rel} does not end with a newline`)
    assert.ok(!text.endsWith("\n\n"), `${rel} ends with more than one newline`)
  }
})

test("no JS file has trailing whitespace on a line", () => {
  for (const rel of sortedFiles(JS)) {
    const lines = read(rel).split("\n")
    lines.forEach((line, i) => {
      assert.ok(!/[ \t]+$/.test(line), `${rel}:${i + 1} has trailing whitespace`)
    })
  }
})

test("no JS file indents with a tab", () => {
  for (const rel of sortedFiles(JS)) {
    const lines = read(rel).split("\n")
    lines.forEach((line, i) => {
      assert.ok(!/^\t/.test(line), `${rel}:${i + 1} indents with a tab; the style is spaces`)
    })
  }
})

test("every indented JS line is a multiple of two spaces", () => {
  // The floor is the style .editorconfig declares. A line that opens with an
  // odd number of spaces is a mis-indent an editor made, not a deliberate
  // alignment (continuations still land on an even column).
  for (const rel of sortedFiles(JS)) {
    const lines = read(rel).split("\n")
    lines.forEach((line, i) => {
      const m = /^( +)/.exec(line)
      if (!m) return
      assert.equal(m[1].length % 2, 0, `${rel}:${i + 1} indents by ${m[1].length} spaces, not a multiple of two`)
    })
  }
})

test("the markdown files are LF and end with one newline", () => {
  for (const rel of sortedFiles(MD)) {
    const text = read(rel)
    assert.equal(text.indexOf("\r"), -1, `${rel} has a CR; the repo is LF-only`)
    assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), `${rel} must end with exactly one newline`)
  }
})
