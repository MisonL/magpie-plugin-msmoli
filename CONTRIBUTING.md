# Contributing

Thanks for looking at this. Two things worth knowing before changing anything.

## The one rule

**`GET /api/v1/users/login/info` is also the check-in trigger.** ModelScope
grants the day's credits when it sees that endpoint called. It is therefore not
something the usage read may touch: magpie's menu bar asks for usage every few
minutes, and a usage read that reached it would turn into a check-in request
every few minutes.

The nickname is read there, once, during the check-in, and kept in memory. The
usage hook reads the balance and the ledger only. `test/plugin.test.mjs` asserts
this — the usage test fails if a usage read reaches the sign-in endpoint.

Keep it that way. If you need the account's name in the usage read, take it
from what the check-in already found.

## The second

**Never write the token anywhere.** It lives in magpie's `plugin-auth.json` and
nowhere else. The sign-in method declares neither `prompts` nor `authorize` on
purpose: a prompt's answer lands in `metadata` as well, which puts the same
token on disk twice (see `save()` in magpie's `host.js`).

The plugin writes two fields onto the sign-in it already has: the account's
nickname, as `accountId`, so magpie's card can name the account instead of
showing the end of the key; and, for an account on the international site,
`site`, so a restarted host does not pay a domestic 401 for a token it already
knows the home of. `client.auth.set` replaces the whole entry, so the write
starts from a **fresh read** — `getAuth` again at write time, capped by what is
left of the hook's budget — and adds only those fields; the token stays in
`key` alone. A read that fails or does not come back is a store whose freshest
state is unknown, and an unknown state is not written over: no write at all,
rather than the copy from the start of the hook. `test/plugin.test.mjs` pins
the shape: one write, the token appears once, fields the host already had
survive, and an edit made while the hook ran is not undone.

One window is left open by the host's contract: `auth.set` has no
compare-and-set, so an edit that lands *after* the fresh read returns and
*before* the write takes the store is overwritten by the write, which carries
the read's copy. Closing it needs a conditional write or a merged update from
magpie's side — another external re-read only makes the window narrower. The
practical exposure is a nickname or `site` field landing beside a key change
made in that same sub-second; it does not touch the token itself.

It reads one file to know when not to write: magpie keeps a user's own account
names in `providers.json`, keyed by the label the account had when it was
named, and the write-back changes that label. An account the user has named is
therefore left as it is — otherwise the alias would be left pointing at a label
nothing carries, and the user's name would vanish from the card. `aliasOf` in
`index.mjs` does the read; a test pins both halves (named → the nickname is
not written, unnamed → it is). The `site` field is not a name and is written
either way.

## The third

**Export no function except the plugin itself.** magpie's loader takes *every*
function a module exports as a plugin entry when `default` is a function (which
it is here): `servers()` in `host.js` walks `Object.values(mod)`, calls each one
with the plugin input, and reads the hooks off the answer. A helper exported
for a test therefore runs as a second plugin in every magpie the package is
installed into. Today it answers an object with no hooks and nothing happens,
but a throw from it is caught by the loader's per-plugin `try`/`catch`, which
marks the whole package as failed to load. Pure helpers live on `testables`, an
object, which the loader skips; `test/plugin.test.mjs` pins that list against
the same de-dup the loader uses.

## The sync CLI

`bin/sync.mjs` is the sync CLI the README documents (run it straight from
magpie's plugin folder, or `npx magpie-plugin-msmoli` from npm), which copies
an existing ModelScope key between the built-in preset (`providers.json`) and
this plugin's sign-in (`plugin-auth.json`). Its tests live in
`test/sync.test.mjs` and run with the rest of the suite.

Three invariants to keep when touching it:

- **It never writes a magpie file itself.** The reads are direct; every write
  goes through magpie's own CLI (`magpie plugin login`, `magpie provider key`,
  `magpie plugin logout`),
  which owns the locking, the `.bak` generations and the change events. A tool
  that edits `plugin-auth.json` behind a running magpie races it and misses
  those. magpie's CLI has no `--dir`, so a write always lands in the binary's
  own folder: `--dir` and `--magpie` naming different folders is refused
  before anything runs, or the tool would read one magpie and write another.
  Which folder "the binary's own" is follows magpie's own `appdir.go`
  (`Resolve`, `Beside`, `shared`, `installed`), not a guess: the executable's
  symlinks are followed first, a Mac app's folder is the one holding the
  `.app`, an AppImage's is the one holding the `.AppImage`, and a `data`
  folder in `/Applications`, `~/Applications`, the home folder, `Downloads`,
  `Desktop` or `Documents` is magpie's only when it holds magpie's files and the installed
  folder holds none (appdir's #989). A divergence here is not cosmetic: the
  tool reads a folder magpie does not write, and the write lands in the one
  it does.
- **The token never appears in output — success or failure.** Long tokens show
  magpie's own mask (first four, `…`, last four); anything under 12 characters
  shows its length instead, since there would be no middle left to hide. The
  same key in another spelling is still the key: case and full-width (`NFKC`)
  forms are folded before the comparison, and a key broken into short groups
  by spaces, line breaks or invisible characters is joined across them — in the
  plugin's card text and in the CLI's echoes alike. That join is one reading
  among three: the run reading (`maskSpaced` in `index.mjs`, `maskCut` in
  `bin/sync.mjs`) takes a key whose pieces all clear the word floors, the cut
  reading takes one whose front is itself cut (`sk-a nt-a pi03 …`), and the
  per-word pass takes everything else. A key written one character per word is
  the cut reading too, read only from a head of five or more consecutive
  pieces of one or two characters (asking after every short word made a body
  of them quadratic). The gaps a run is read across are one space, a no-break
  space, an ideographic space, a single line break, and a middot or a bullet
  (one or two in a row, at most one space either side) — the middot whenever a
  piece beside it is not a word (a key's front, a framed or key-shaped head,
  `NickName=[AK·IA·…`, `9f8e·7d6c·…`), and anywhere once the run has read a cut
  (so `ms-f·orei·gn01·…` is joined whole); a card's own `·` separators sit
  between words on both sides and stay prose. A run of single-character pieces
  is read across any of those gaps, and a piece standing behind a frame's
  punctuation is its first (`key=1·2·3·…`, `(AK·IA·…`), the frame kept as
  printed. The CLI's per-word pass reads framed digest pieces too
  (`123e4567-·e89b-…`). A vendor front
  that is itself cut in two (`xox b-1 234 …`) is read from the piece that
  starts it. Both card and CLI also have a caps pass for a vendor key written
  without its spaces (`AKIAIOSFODNN 7EXAMPLE`, `AKI AIO SFO …`), and a
  full-width hyphen (U+FF0D, which NFKC does not fold) is folded before the
  shape tests. Once a run has found a cut it is followed to 96 characters,
  so a 32-character digest cut to one middot per piece is covered whole; a
  run that has found nothing stops at 20 characters when it holds no digit
  and no mixed-case word (it can become no key), at 4×20 on one piece, and
  when it finds no key at all the next start is its end. The run readings
  stop at 32 KiB: past that only the per-word pass runs. Measured on
  32 KiB pages of one- and two-character words: the card costs 0.09–0.30 s
  (`"12 34 "`, `"x "`, `"0 "`, `"1·"`, `"A "`; before the numeral page was
  guarded it took 3–4 s of CPU on `"0 "` and 2.6 s on `"1 "`), the CLI
  0.2–0.8 s — all passes together — against a 25 s hook and a 120 s child
  (the CLI pays one more whole-text reading, and its per-word pass judges a
  numeral page with `isKey`); ordinary text of 32 KiB costs about 0.2 s (the
  card's readings ask `isKeyWord` of the growing run at every piece, and every
  arm of it needs a digit, a base64 symbol or a case mix: a body of one case
  with no numeral is skipped by that test alone — before it, 28,000 characters
  of `"x "` delayed a check-in by 36 s). A run that found nothing hands the
  scan on to the last word it read, unless it saw a digit or a front on the
  way (the CLI: before that, `"1A1 " × 8192` took 9 s and 32 KiB of `"A "`
  1.8 s; `"1A1 " × 8192` now measures 0.2 s on the card and 1.1–1.8 s in the
  CLI, and the CLI's own test bounds it at 4 s). The CLI's split reading reads
  to the same 32 KiB, and skips a head with no digit or letter within the 48
  pieces it reads on in one pre-pass:
  a key cut by a space on a long line is joined (`ghp_ 1234 AbCd …`), a page
  of one plain word is passed over. A sentence's word is no longer read as a
  cut's head — `check-in failed: …` and `Hello World Example 2026` were masked
  whole before — and a mask the CLI wrote is not joined across (`arg` is
  idempotent: `NickName=[ms-F…6789·abcdefABCDEF]` is left as it is). A mask
  the CLI wrote is opaque to every reading: a mask's head is a vendor front
  (`AKIA…XDKO/L3,`) and a body cut at the ellipsis is an ms- body.
  A vendor's span runs to the key's own end: a slash inside it is part of the
  key (`ms-AbCdEf12GhIjKl34/RgjNpwI` is masked whole, not to the first `/`),
  and so is a colon when both halves together read as one
  (`sk-2OHPYFCORWVX0:MR0MACVP0D7Z`) — a scheme and a time do not
  (`https://h:8080/x` and `12:30:45` stay as printed). A key cut into pieces
  by slashes with no front of its own is read by its pieces: three or more
  where one is 12+ characters of letters and digits with under a quarter of
  them vowels, or exactly two that both are (`9e2kd5vvkku3fiz9a1qbmx/
  tkx5y0cs2vrn4bpsktexha/kz353ed/8nq6rpz707`), and a path is not — its
  pieces are words (`SomeFolderName2024`, `typescript`) or carry their own
  separators (`report_2024_quarterly`, which dilutes the vowel share without
  being key material). `ms-` is in the front
  list itself, so a ModelScope key is read by its front like every other
  vendor's; behind that short front a 16+ run still needs a numeral or a
  capital, because a card joins words across a space to read a cut key and
  "ms-shortone" and "abcdefghijklmnop" on the next line are not one token.
  (`…K1jlMS-6…7`), so both were masked a second time — into a length
  (`（4 字符）`) or a shorter span. The frame a key's own `=` looked like is
  read the same way: material of eight or more characters in front of the
  frame is key material, and the key runs from behind the frame's
  punctuation through its own `=` (`--token=F5cYjKRtCxkl=K9m1+…`,
  `NickName=[AKIAiXYDw=v/tSw…`), and a one-letter piece before a slash is a
  key's front rather than the text's (`token: O/F46xsMfa-…`), while a letter
  before a path (`x /Users`) stays the text's. Two boundaries on that reading,
  both measured after it existed: the "=" has to be a frame's — a variable's
  name is key material too (`SESSIONID=AKIAI OSFODNN7EXAMPLE` went out whole
  when it was not) — and a word that is itself a key in any case is not read
  from behind a frame at all (`--token=…`, `NickName=[AKIA…`). The card reads a
  vendor front from the front to its end only when the front starts inside a
  larger word; a word that is the key from its first character is read whole by
  the word's own pass, which is what masks a key cut by a comma, a bar or a
  full-width stop. And a key whose front half sits on the left of a ":" is one
  key (`ZlibmV9ovZJYMm:pT3b7KKn…`), not a name and its value — only a ":" with
  two pieces of the key alphabet on both sides and a value of key material
  qualifies, so `token: ghp_…` and `Authorization: Bearer xoxb-…` keep their
  names.
  The card reads `NAME=value` the same way, and it had to learn to: the whole
  word was judged first, and a body behind "=" is not "letters and digits
  alone", which is what the card's randomish arm asks — so `key=<body>`,
  `token=[<body>]` and `NickName=[<body>]` went out whole while the CLI masked
  them. The name has to read as a name (two or more letters, no vendor front,
  not itself key material by the run reading with the case-mix arm off), the
  value has to be key-shaped on its own, and a flag's own dashes are the frame
  (`--bad=SK-ANT-…` masks the key, not the flag). No special case is needed for
  a colon: the whole word is judged before this reading, so a key's own
  `head:body` is masked whole and `id:<18 alphanumerics>` is a name and its
  value. `retry=true`, `code=ENOENT` and `id=1234567890` are left alone.
  The value is its leading key-alphabet run: a quote or a bracket round it is
  the frame's and a full stop, a comma or a second separator after it is the
  text's, so `key="<key>"` and `key=<key>.` are masked and keep their marks,
  and a doubled `=` (`key==<key>`) is the frame's too. A key whose own body
  carries a colon is the vendor span's: the span runs from its front over the
  key's own colons to its end (`AKIA…:…:…:…`), and the span is measured from
  the match's own index, not from the word's start, or a front inside a larger
  word (`key=sk-2OHP…:MR0M…`) takes the wrong tail and keeps the colon.
  Any change to these thresholds has to keep both suites
  green: both carry a table of cut shapes (one, three, four, six, eight,
  twelve characters, line breaks, no-break and ideographic spaces, middots)
  that must be masked, and ordinary sentences and paths that must not. The
  middot table covers, for four frames (bare, `NickName=[…]`, `(…)`, `key=….`),
  cuts of one to twelve characters of an AWS id, a 32-character digest, a
  ModelScope key, a ghp_ token, an sk-ant key and a UUID, by `·`, `•`, `∙`, `‧`,
  `・`, `··`, `· ` and ` · `, on the card and in the CLI alike (measured 2026-11-10:
  0 leaks over that matrix; before the round it leaked on every width). The threshold counts the key's
  letters and digits only, not the hyphens or spaces it was written in: a slice
  under `MIN_ECHO` (10) alphanumerics is left alone, and a span rule that also
  counted punctuation was tried and reverted — it masked "said: aaaa1111-b"
  (nine characters of a token) as if it were longer. Words that already carry
  a mask (`ms-a…5555`) are not judged again: NFKC folds the ellipsis to three
  dots, which read as key material. The CLI's cut reading also reads a mark a
  copy or a table put where the key's cut was — a full-width comma or full
  stop, a bracket, a dash, a bar between cells — as the cut it stands for, so
  `ms-aaaa1111-bbbb、-2222-…` is masked whole. Each mark becomes as many
  spaces as it has UTF-16 units, so the offsets still land on the user's
  characters and what is printed around the mask is what they wrote; the walk
  then judges the pieces by its own rules, which keeps a sentence's mark from
  becoming a cut. An ellipsis is read only where eight or more key characters
  follow it, so a mask already written and a person's abbreviation stay as
  they are. A key cut by a mark and a tab is one key too: a tab is a cut
  `CUT_RUN` joins, not a control character the value carries.
  The
  failure path scrubs a child command's output too: that is the path most
  likely to echo the key back. Every key a command touches is a secret, not
  just the one in its arguments — `--to-preset` replaces the preset's key, and
  a host saying what it replaced names a real credential (`also` on the
  command). A token is trimmed where it is read, so the mask, the scrub and
  the read-back all see the same string the plugin will. `test/sync.test.mjs`
  asserts no plan line contains a whole token, and that a failing command's
  stderr doesn't either.
- **It never signs the user into a second account by accident.** The host keys
  accounts by `accountId`, falling back to the token only when neither side has
  one: a plain api sign-in with the same token again is idempotent, but once a
  nickname has been written back the entry carries an `accountId`, and a
  second `login` with the same token can add `msmoli#xxxxxx`. `logout` signs
  out *all* accounts of the provider. So a differing token is refused unless
  `--force`, and `--force` is refused when more than one account exists. These
  are pinned by tests — don't loosen them without a reason a user would accept.

## Development

```bash
node --test                # the whole suite, no network
```

The suite is run four ways, and CI runs all of them; run each locally before a
release, because they catch different things:

```bash
npm test                                                # node --test
npm run test:clock                                      # Date.now() ticks a second per read (tools/ticking-clock.mjs)
MSMOLI_FAKE_NOW=1893456000000 node --test               # the whole clock shifted ~3 years
bun test                                                # the runtime magpie actually runs plugins on
```

`npm test` is the bare `node --test` above, not a fifth mode. The
`MSMOLI_FAKE_NOW=…` line is POSIX shell syntax; in PowerShell or cmd, set the
variable first (`$env:MSMOLI_FAKE_NOW='1893456000000'`, then `node --test`),
which is what CI does with an `env:` block.

The ticking-clock run makes a fixture that reads the clock twice (once to build,
once to expect) fail every time instead of one run in a thousand; the shifted
clock makes a fixture pinned to the calendar day it runs break. The bun run is
what closes the gap between the tests' Node and magpie's real runtime. CI also
runs macOS- and Windows-specific jobs — see `.github/workflows/test.yml`.

The tests stub `fetch`; nothing here talks to ModelScope. Fixtures follow the
clock, so they don't expire on a given day. The check-in window reads
`msmoli.json` from the folder magpie reports as `input.directory`; the suite
points `MAGPIE_MSMOLI_CONFIG` at a temp file so it never reads or writes a
real one.

Two rules for a test that touches process state:

- **Put the environment back.** `MAGPIE_MSMOLI_CONFIG` wins over
  `input.directory`, so a test that deletes it to read its own folder and does
  not restore it leaves every later test on the default 08:30–10:00 window —
  green in the afternoon, red in the morning. Use `withDirectory`, which
  restores it in a `finally`.
- **Skip out loud.** A test that returns early where the platform cannot run it
  reads as a pass. Call `t.skip(reason)` instead, so the reason shows in the
  run.

## Against the real API

If you change the request shapes, check them against a real account — the
endpoints are web APIs, not the documented OpenAPI, and they are not versioned:

```bash
printf 'ms-token\n' | magpie plugin login msmoli
magpie accounts checkin
magpie accounts | grep msmoli
```

## Publishing

### Versioning

The version in `package.json` is the one version: `npm version` writes it,
commits it and tags it (`v0.1.0`), and that tag is what the GitHub release and
the npm package are called. Do not edit the number by hand — a hand-edited
number and an untagged commit are how npm and the repo drift apart.

Semantic versioning, with the pre-1.0 reading the spec allows:

| Change | Bump | Example |
|---|---|---|
| bug fix, no behaviour change for existing users | patch | 0.1.0 → 0.1.1 |
| new provider, new option, new card field | minor | 0.1.0 → 0.2.0 |
| breaking change to the hooks, the config file or the provider id | minor, and said out loud in the release notes | 0.1.0 → 0.2.0 |

`0.x` means the hooks contract is still open to change; a breaking change
there takes the minor segment (that is what the spec says `0.x` minor is for),
not a 1.0. The first release that is safe to depend on without reading the
notes gets `1.0.0`. The provider id (`msmoli`) is the one identifier users'
sign-ins and aliases are filed under: changing it is a breaking change however
small the diff looks.

Release:

```bash
node --test                     # the suite, no network
npm pack --dry-run             # what goes in: module, sync CLI, README, licence, package.json
npm version <patch|minor> -m "v%s — <one line>"
git push origin main --tags
npm publish                     # prepublishOnly runs every mode again, and
                                # checks each one's own count: a mode that
                                # found no tests is not a green mode. Bun is
                                # optional here — skipped when it is not
                                # installed, and CI's bun job covers it
gh release create "v$(node -p 'require("./package.json").version')" \
  --title "v$(node -p 'require("./package.json").version')" --verify-tag --generate-notes
```

`--generate-notes` drafts the notes from the commits since the last tag; edit
them for anything a user would not read out of commit titles (a breaking
change, a config key that moved). `npm publish` after a `npm version` is the
only publish path: the tarball's `package.json` and the repo's tag must be the
same commit.

### The community market

Being on npm is not the same as being in magpie's Discover list. That list is
`registry.json` in magpie-community/plugins, and an entry is added by pull
request to that repo. Third-party packages can be listed (several are), and a
PR adding this one was opened — and declined.

**PR magpie-community/plugins#714 was closed on 2026-11-04.** The maintainer's
reason is policy, not code: ModelScope has no check-in endpoint, so the plugin
gets the daily grant by making the server count a website sign-in — a script
posing as the browser rather than a person pressing a button the official
client offers. ModelScope's user agreement forbids tools that interfere with
the service (4.1.2(1)) and point farming by plugin (4.1.2(5)), and lets the
platform freeze accounts or blacklist users for abuse (2.3.1 and the credit
rules). The market's own rule (plugins#230, #150) is that a one-request claim
triggered by an official button may be automated, but a reward that needs real
activity is not simulated. A ModelScope account is real-name verified and
often tied to Aliyun, so the downside for a user is larger than 250 expiring
credits.

**This project does not submit to the market and will not again** (decision of
2026-11-04, after the rejection above). The package stays on npm and anyone
can install it by name; it is simply not recommended from the registry. Do not
open a registry PR for it without that decision being revisited first — even if
ModelScope later publishes a check-in API, that would be a new decision, not a
correction to this one.

### What the package contains

`npm pack --dry-run` before a release if anything under `files` changed. It
lists the module, the sync CLI, the README, the licence and `package.json`,
and nothing else — no tests, no tooling, no config.

Once published, `magpie plugin add magpie-plugin-msmoli` installs it the way
every other plugin is installed, and `magpie plugin update` follows the
versions. It is not submitted to the community marketplace.

## Things that are deliberate

- **One provider, two sites, one body.** The card is `msmoli` and it serves
  both modelscope.cn and modelscope.ai; a token's site is a fact about the
  token, not a choice the user should have to make twice in two cards. Each
  account's site is found from the token itself by `siteRead`: the read goes to
  the domestic site first, and sends the token on whenever the site gives it
  nothing usable — a 401, a transport failure or timeout, a 5xx, a JSON 429, a
  body that is not JSON, or a parsed 4xx. A timeout is the link, not the site,
  so a remembered site that hangs no longer traps the account on it. The first
  usable answer wins. When neither site gives one, the report is ranked by
  what it says about the token, not by which site was asked first: a
  ModelScope-shaped 403 (the site knows the token and refused it by policy)
  first, then any other parsed 4xx, then a 429/5xx, then the transport error;
  only when every site refused the token with a 401 is it reported expired.
  A stale remembered site's 401 is not proof of that (every token meets a 401
  on the site it does not belong to), so it never outranks another site's
  answer. The result is cached per token (`sites`, the last 64,
  oldest evicted first), so polls do not re-probe.
  Everything that differs between the sites lives in a profile object —
  origin, the plan line, and the CN/INT-site word in the 401. Only
  `MsmoliPlugin` is exported: magpie's loader takes every exported function
  as its own provider, so exporting a helper would silently add a second
  card, which is why the guard test asserts the entry list by name; the
  profiles and the cache are reachable to tests through `testables`, an
  object the loader skips. Do not copy a hook for the second site: a fix
  landing in one copy and not the other is the failure this shape exists to
  prevent.
- **A separate `msmoli` provider, with no models.** Chat keeps using the
  `modelscope` preset with your API key. A plugin that served the provider
  inference routes through would take the whole chat path out of magpie when
  its usage window reads as used up.
- **`used` is not capped at 100.** magpie reads a value above 100 as overspent,
  which is what it is.
- **A body we do not understand fails; it never becomes a zero.** No `data`, a
  `data` that is a list, a balance with no `available_balance` or one that is
  not a number: each is a failure with its reason. Reading any of them as 0 is
  a definite answer that would be false, and `inactive` from an empty ledger
  settles the day. The same rule covers server text: a message or a grant's
  title is masked before it reaches the card or the log, and a nickname that is
  the token — or its front, after the cut to 40 — is not written back.
- **ModelScope's times are parsed as Beijing time.** They carry no zone, and
  `new Date()` would read them in the host's own zone.
- **An expiry the scan never read is not named at all.** The card's
  "到期时间可能更早" is a floor for a time it shows, so it is printed only
  when there is an expiry to be earlier than. A cut scan that read no
  `expire_at` row carries no `resetsAt` and no hint.
- **A 200 carrying `Code: 401` is the sign-in refused.** The login layer
  answers some refusals inside a 200 envelope. Only an explicit 401 code
  counts — a 200 whose words merely mention an expiry ("积分已过期") is the
  ledger talking, and signing the account out over it is wrong.
- **A key that is spelled like an address is said to be one.** A URL or a
  path pasted into the key field is refused as a key; the 401 message then
  leads with "填的像是地址或路径" so the user checks the field instead of
  their sign-in. The test is on the spelling alone (`scheme://`, `?%#&` or
  whitespace, a leading `/`), and not one character of the value is echoed.
  A real key (`SENDABLE`, printable ASCII) can carry none of the three.
- **A claimed day's answer includes what the touch granted.** The site grants
  nothing on a repeat sign-in, but a grant already on its way can be written
  between the baseline read and the touch, and `done` settles the day — the
  host does not ask again. So an ask that *touched* reads the ledger once more
  and reports the growth as this run's; an ask that did not touch (claimed and
  the name known) answers from the baseline alone. The extra read is the first
  ask's only, once per process.
- **A window with one bound means that minute.** `["09:00"]`, `"09:00"` and
  `"09:00-"` all read as 09:00 itself; a bound that is *there* and unreadable
  (`["09:00", "24:30"]`) is still a bad pair and falls back to the default, and
  two ends that meet are still refused (a width of zero is plan()'s modulo by
  zero).
- **`--status` exits with its verdict.** 0 when there is nothing to do, 1 when
  the plan would run or is refused — the same codes as a real run, so a script
  does not have to parse the text.
- **`mask` answers its own output unchanged.** Its two shapes — four
  characters, `…`, four characters, and `（N 字符）` — are returned as they
  stand. Masked a second time, "ms-1…5c6d" became "（9 字符）" and lost the
  ends. A key cannot spell either shape (keys are printable ASCII).
- **Not changed, on purpose.** Three boundary behaviours were reviewed and
  left as they are: a walk that crosses midnight between two page reads
  reports each read against the day it happened on (diffing both reads
  against one day failed a claim that landed); a ledger whose printed
  `total` contradicts its rows stops the walk incomplete rather than guess
  which number is right (the card says "账单未读完，数字偏低"); and every
  redirect is refused (`redirect: "error"`, the site's own included), at the
  price of a site that ever moves its API behind one — that reports as a
  transport failure — against never handing the token to another host.
- **Before the check-in window's moment, the hook answers `failed`.** magpie
  always re-asks `failed`; `done`/`inactive`/`ineligible` only get re-asked
  while the day is unproven (before noon Beijing, and only if no claim was
  seen), after which they settle the day. `failed` is therefore the reliable
  way for a plugin to say "ask me again later" — don't "fix" the pre-window
  answer to `inactive`, or a morning ask could settle the day before the
  window even opens. `test/plugin.test.mjs` pins both halves (nothing sent
  before the moment, a claim after it).
- **The window's target minute is derived, not stored.** It is a hash of the
  day and the account, so the 30-minute re-asks agree without a state file, and
  a host restart doesn't move it.
- **The window's end is capped at 23:00 (`LAST`).** magpie asks every 30
  minutes, so a target needs asks after it that still land on the same day. A
  target in the last half hour can wait on fewer of them, and if those fail
  the next ask is after midnight — when the day and the hashed target have
  both moved on — and the day's credits are lost. Capping at 23:00 leaves at
  least two asks for the latest targets. A window entirely past 23:00 falls
  back to the default. `test/plugin.test.mjs` pins the cap.
- **`failed` before the window costs something, and the docs should say so.**
  The card shows a red dot and magpie's own "check-in failed; tries again
  later" wording for the hours before the window (about a third of the day at
  the default), each such ask rewrites `plugin-checkin.json`, and
  `magpie accounts checkin` run before the window exits non-zero. That is the
  price of the only deferral an outcome offers.
- **The pre-window message leads with the claim time.** The host renders the
  message verbatim under the red dot, so it is the only text the user sees for
  those hours; the line (a claim time, then the half-hourly re-ask) puts the
  answer before the reason. The config path stays out — it repeated
  on every ask and ended up in users' screenshots — and lives in the README
  instead. Nothing in it is relative: the card keeps the line until the next
  ask, half an hour later, so a relative countdown is wrong for most of the
  time it is on screen.
  `test/plugin.test.mjs` reads the target back out of that line, so changing
  its shape means updating `targetFrom`.
