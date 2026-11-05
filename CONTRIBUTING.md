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
starts from the auth the host handed over and adds only those fields — the
token stays in `key` alone. `test/plugin.test.mjs` pins the shape: one write,
the token appears once, and fields the host already had survive.

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
  goes through magpie's own CLI (`magpie plugin login`, `magpie provider key`),
  which owns the locking, the `.bak` generations and the change events. A tool
  that edits `plugin-auth.json` behind a running magpie races it and misses
  those. magpie's CLI has no `--dir`, so a write always lands in the binary's
  own folder: `--dir` and `--magpie` naming different folders is refused
  before anything runs, or the tool would read one magpie and write another.
  Which folder "the binary's own" is follows magpie's own `appdir.go`
  (`Resolve`, `Beside`, `shared`, `installed`), not a guess: the executable's
  symlinks are followed first, a Mac app's folder is the one holding the
  `.app`, an AppImage's is the one holding the `.AppImage`, and a `data`
  folder in `/Applications`, the home folder, `Downloads`, `Desktop` or
  `Documents` is magpie's only when it holds magpie's files and the installed
  folder holds none (appdir's #989). A divergence here is not cosmetic: the
  tool reads a folder magpie does not write, and the write lands in the one
  it does.
- **The token never appears in output — success or failure.** Long tokens show
  magpie's own mask (first four, `…`, last four); anything under 12 characters
  shows its length instead, since there would be no middle left to hide. The
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
npm version patch -m "v%s — <one line>"
git push origin main --tags
npm publish                     # prepublishOnly runs the suite again
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
  account's site is found from the token itself by `siteRead`: the read goes
  to the domestic site first, and only a 401 sends it to the international
  one; a transport failure is not an answer about the token either, so it
  moves on and is what the card reports when both sites fail. The result is
  cached per token (`sites`, bounded), so polls do not re-probe.
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
