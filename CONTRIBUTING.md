# Contributing

Thanks for looking at this. Two things worth knowing before changing anything.

## The one rule

**`GET /api/v1/users/login/info` is also the check-in trigger.** ModelScope
grants the day's 魔粒 when it sees that endpoint called. It is therefore not
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

## Development

```bash
node --test                # the whole suite, no network
```

The tests stub `fetch`; nothing here talks to ModelScope. Fixtures follow the
clock, so they don't expire on a given day. The check-in window reads
`msmoli.json` from the folder magpie reports as `input.directory`; the suite
points `MAGPIE_MSMOLI_CONFIG` at a temp file so it never reads or writes a
real one.

## Against the real API

If you change the request shapes, check them against a real account — the
endpoints are web APIs, not the documented OpenAPI, and they are not versioned:

```bash
printf 'ms-token\n' | magpie plugin login msmoli
magpie accounts checkin
magpie accounts | grep msmoli
```

## Things that are deliberate

- **A separate `msmoli` provider, with no models.** Chat keeps using the
  `modelscope` preset with your API key. A plugin that served the provider
  inference routes through would take the whole chat path out of magpie when
  its usage window reads as used up.
- **`used` is not capped at 100.** magpie reads a value above 100 as overspent,
  which is what it is.
- **ModelScope's times are parsed as Beijing time.** They carry no zone, and
  `new Date()` would read them in the host's own zone.
- **Before the check-in window's moment, the hook answers `failed`.** magpie
  retries `failed` and settles on every other outcome, so that is the only way
  a plugin can say "ask me again later". Don't "fix" it to `inactive`: the day
  would then be over without the credits ever being claimed. `test/plugin.test.mjs`
  pins both halves (nothing sent before the moment, a claim after it).
- **The window's target minute is derived, not stored.** It is a hash of the
  day and the account, so the 30-minute re-asks agree without a state file, and
  a host restart doesn't move it.
- **The window's end is capped at 23:30 (`LAST`).** magpie asks again 30
  minutes after a failure. A target in the day's last half hour can therefore
  have no ask left on its own day — the next one is after midnight, when both
  the host's day and the hashed target have moved on — and the day's credits
  are lost. `test/plugin.test.mjs` pins the cap.
- **`failed` before the window costs something, and the docs should say so.**
  The card shows a red dot and magpie's own "check-in failed; tries again
  later" wording for the hours before the window (about a third of the day at
  the default), each such ask rewrites `plugin-checkin.json`, and
  `magpie accounts checkin` run before the window exits non-zero. That is the
  price of the only deferral an outcome offers.
