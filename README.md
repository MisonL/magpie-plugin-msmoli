# magpie-plugin-msmoli

A [magpie](https://github.com/yetone/magpie) plugin that claims ModelScope's
(魔搭) daily **魔粒** credits for you — one check-in a day instead of opening the
site — and shows the balance and today's spend on the account's usage card.

## What 魔粒 is

ModelScope's API-Inference is free, paid in 魔粒:

| Grant | Amount | Expires |
|---|---|---|
| Sign-in, per day | 200 | 24 hours |
| Aliyun account bound, per day | 50 | 24 hours |
| Email / profile / homepage completed | 50 each | 90 days, once |

Daily grants are **24 hours only**. They do not accumulate: what you don't
spend today is gone. A flagship model costs 2 魔粒 per call (mainstream 1,
lightweight 0.5), so the daily 250 is roughly 125 calls.

## Install

Needs magpie itself (<https://usemagpie.ai>). On macOS, use `magpie --version` to check it's on PATH; if not, use the app's full path:
`/Applications/Magpie.app/Contents/MacOS/magpie`.

### Install via GitHub URL (no clone, auto-updates)

This installs into magpie's own plugin folder (`~/.config/magpie/plugins` for a regular install, or `data/plugins` for the portable version), so it updates with `magpie plugin update`.

```bash
magpie plugin add github:MisonL/magpie-plugin-msmoli
printf 'ms-your-token\n' | magpie plugin login msmoli
```

The token is stored in `plugin-auth.json`; one login works regardless of the form you used to install.

### Install from a clone

Keeps your own copy, which is what you want if you plan to change it. magpie
references the folder where it lies rather than copying it, so it loads only
while that folder is there, and an update means pulling and adding it again.

```bash
git clone https://github.com/MisonL/magpie-plugin-msmoli.git
cd magpie-plugin-msmoli
magpie plugin add "$PWD"
printf 'ms-your-token\n' | magpie plugin login msmoli
```

Either form ends the same way: a `msmoli` row under Settings → Usage → Plugins.
The sign-in is kept per package name rather than per folder, so switching
between the two forms (or moving the clone) keeps the token — no second login.

Turn the check-in on: Settings → Usage → Plugins → the `msmoli` row, or in
`settings.json` (in magpie's own folder, `~/.config/magpie` for an installed
magpie):

```json
{
  "pluginCheckins": {
    "msmoli": true
  }
}
```

The token comes from <https://modelscope.cn/my/myaccesstoken>. The same `ms-`
token is both the inference `Authorization: Bearer` and the web session cookie,
so nothing else needs configuring.

From then on magpie claims it once a Beijing day per signed-in account, retries
later that day if it fails, and reports the outcome on the account's usage card:

```
● msmoli  API key …a1b2 · 魔搭社区  魔粒 1% (今日用 2 / 领 250 · 余额 249.5) ↻14h24m tomorrow 09:31  249.5 魔粒可用 left
```

## How the check-in works

ModelScope publishes no check-in endpoint. What it does have is a side effect:
`GET /api/v1/users/login/info` counts as a sign-in, and the first one of the
day grants `daily_active` 200 and `aliyun_bindlogin` 50. Repeat it the same day
and nothing more is granted.

A hook that just calls it can't tell "claimed now" from "claimed hours ago", so
this one reads the day's ledger around it:

1. read today's `EARN` records — is `daily_active` there?
2. touch `login/info`
3. read the ledger again

Three outcomes follow:

| Outcome | Meaning |
|---|---|
| `done` | already claimed today, with the day's total |
| `claimed` | this run claimed it, with the amount |
| `inactive` | the sign-in went through but nothing was granted |
| `failed` | nothing was claimed — including "not yet time", explained below |

The endpoints it uses, all on `modelscope.cn` with `Cookie: m_session_id=ms-…`
(a browser UA and a `Referer` are enough — no CSRF token):

| Purpose | Path |
|---|---|
| Sign-in / check-in trigger | `GET /api/v1/users/login/info` |
| Balance | `GET /openapi/v1/magicubes/balance` |
| Ledger | `GET /openapi/v1/magicubes/transactions?page=1&page_size=50` |

`type` in the ledger is one of `EARN`, `SPEND_CONFIRM`, `EXPIRE`.

### When it claims: the check-in window

The claim is held back until a time of day, by default somewhere in
**08:30–10:00 Beijing time** — an account's own minute in that window,
picked from a hash of the day and the account, so it doesn't move between
the host's retries. It makes the traffic look like a person opening the
site in the morning rather than at the stroke of midnight.

Waiting costs nothing: daily grants **expire 24 hours after they land**
(a grant at 15:35 expires at 15:35 the next day), so claiming at 9am leaves
the credits good until 9am tomorrow.

Set it in `msmoli.json` in magpie's own folder (`~/.config/magpie` for an
installed magpie, the data folder for a portable one):

```json
{ "checkinWindow": ["08:30", "10:00"] }
```

One string works the same way: `{ "checkinWindow": "08:30-10:00" }`.

`false` turns the window off (claim whenever magpie asks); so does `"off"`.
An unusable value — `08:30`–`08:00`, a date that isn't a clock time — falls
back to the default rather than never claiming. An end past **23:00** is
capped there: magpie asks again half an hour after a failure, and a target
needs an ask *after* it on the same day. A target at 23:29 gets exactly one
ask, at 23:30 — if that one fails, the day's credits are gone with it.
Capping at 23:00 leaves the target's own ask and a retry. A window that sits
entirely past 23:00 falls back to the default window too, since there would
be nowhere left to put the target. The file is read on every ask, so a change
takes effect without restarting magpie.

How it fits magpie's schedule: magpie asks once when the Beijing day turns
and re-asks every 30 minutes **after a failure** — `failed` is the only
outcome it retries; everything else settles the day. So before the window's
moment the plugin answers `failed` with the time it will run, and sends
**no request at all**.

What that costs, since a plugin has no other way to defer: until the claim
actually runs the account card shows a red dot and magpie's own "check-in
failed; magpie tries again later" wording, each of those asks rewrites
magpie's `plugin-checkin.json`, and `magpie accounts checkin` run in that
period exits non-zero. Turning the window off removes all three.

How long that is depends on when magpie next asks, not on the target alone.
Measured on a real day: the target was 09:01, magpie asked at 09:00:57 (three
seconds early, so `failed`), and the claim landed on the next ask at 09:31 —
about 9.5 hours of red dot, not the 8.5 the window alone suggests.

### Upstream

magpie gives a plugin no timer, no clock, and no say in when it is called:
`auth.checkin(getAuth, info)` returns an outcome and the host decides when
to ask again. Everything above is worked around within that contract, and
the awkward parts (proving "not yet" as a failure, whole-day granularity for
the account card) want a line in
[this issue](https://github.com/yetone/magpie/issues/3245) proposing timers and
`recheck` for plugins.

Two consequences worth knowing, both from the same missing timer: a window's
target can only be reached by the host's own 30-minute asks, so an ask missed
while the machine is asleep costs that day; and the plugin cannot retry on its
own between asks — the window's cap (above) is what buys the retry.

### More than one account

The plugin is written per account, not per token. magpie keeps each signed-in
token under its own key — the first as `msmoli`, later ones as `msmoli#xxxxxx`
— and asks the check-in once per account, handing each its own token through
`getAuth`. So with two tokens:

- each account gets **its own target minute** that day (the hash is over the
  day and that account's token), so the two normally claim at different
  minutes — a collision is possible, but only costs both a shared minute;
- each account's check-in is recorded, retried and shown separately in
  `plugin-checkin.json` and on the card;
- the name read at check-in is cached per token, so one account's nickname
  never appears on another's row.

Add a second one the same way, then pick which to use:

```bash
printf 'ms-the-second-token\n' | magpie plugin login msmoli
magpie accounts            # both rows, each with its own 魔粒 window
```

The card names an account by the name ModelScope gives it. An api-type
sign-in has no such name, so the check-in writes the nickname back: the same
sign-in entry, the token still stored once, now with `accountId` beside it.

It happens on the first check-in that actually runs in the host process, so a
fresh install shows `API key …a1b2` until then. An account whose check-in is
already settled for the day is not asked again — magpie reuses the record — so
the name appears with the next day's check-in rather than on upgrade.

If you would rather choose the name yourself, magpie's own alias wins over it:

```bash
magpie accounts alias msmoli "API key …a1b2" my-main
```

The second word is the account as the card shows it *now*: before the first
check-in that is the key's tail, afterwards the ModelScope nickname. An account
you have named is left alone — the check-in won't write its nickname over your
alias — so either label works, and the alias outranks the nickname from then on.

And the daily grant belongs to the ModelScope account, not to the key: the
claim is idempotent server-side per account per day, so a second token for the
same ModelScope user gets `done` rather than another 250.

## Why its own provider, with no models

The plugin registers `msmoli` rather than the built-in `modelscope` preset, for
two reasons:

1. magpie namespaces a plugin id that collides with a preset into
   `<id>-plugin`, so a plugin that named itself `modelscope` would not be the
   same provider anyway — it would only sit next to the preset and invite people
   to take one for the other.
2. **Safety.** magpie's gateway passes over an account whose usage window reads
   as used up. If a check-in plugin served the provider that inference actually
   routes through, reporting 100% would take the whole chat path out of magpie.

So chat keeps using the `modelscope` preset with your API key in
`providers.json`, and this plugin only carries the sign-in its check-in runs as.

### Two ModelScope rows, and why that is fine

The providers page then shows two: `ModelScope` (the preset, with your models)
and `ModelScope 魔粒` (this plugin, with none). They are separate providers that
happen to share one token, and they do not fight:

| | `modelscope` preset | `msmoli` (this plugin) |
|---|---|---|
| Serves chat models | yes | no — `magpie models` never lists it |
| Its usage card | none (the preset has no balance endpoint) | 魔粒 balance and today's spend |
| Check-in | not built in for ModelScope | this plugin, once a day |
| Reachable by the gateway | yes | no, so a card reading 100% cannot route around it |

The token being in both places is how magpie is built: a preset keeps its key
in `providers.json`, a plugin keeps its sign-in in `plugin-auth.json`. Entering
the same `ms-` token in both is expected. Nothing reads the plugin's usage card
to decide where chat goes — that is the point of the separate id.

The one real overlap to know about: **both rows cost nothing extra**, but if you
remove the plugin's sign-in, chat is unaffected, and if you remove the preset,
the check-in keeps working. They fail independently.

## Privacy

`login/info` responds with `Email` and `GitlabAccessToken` among other fields.
This plugin reads `NickName` / `Name` and nothing else; the rest is dropped as
soon as the response is parsed. The token lives only in magpie's own
`plugin-auth.json` — the plugin never writes it anywhere, never logs it, never
sends it anywhere but `modelscope.cn`.

The one thing it writes is that nickname, as `accountId` on the sign-in it
already has, so magpie's card can name the account. It goes through the host's
own `client.auth.set`, which replaces the sign-in entry — so the plugin hands
back what the host gave it, with the name added, and the token is still
stored once.

It also reads `providers.json`, magpie's own list of providers, for one thing:
whether you already named this account yourself. If you have, it writes
nothing — your name stays, and the nickname is not put over it.

## Scope and limits

- One account's own daily grant, idempotent: a check-in reads the ledger, touches
the sign-in endpoint, and reads the ledger again — three requests, four when the
grant is late and the ledger is read a second time to confirm. Once a day.
Asks that arrive before the window open send nothing at all.
The usage read makes two requests and never touches the sign-in endpoint, so the
menu bar's polling cannot turn into check-ins.
- Every request gives up after 8 seconds, and a response body is read to at most
256 KiB; neither can hold the host or grow without bound. A whole check-in
gives up after 25 seconds and a whole usage read after 18, because magpie runs
every provider's check-ins under one two-minute budget and asks accounts one
at a time — a hook cut short answers `failed`, which the host retries in half
an hour, and that retry reads the ledger before claiming, so nothing is lost.
- `MAGPIE_MSMOLI_CONFIG` overrides the config file's path. It exists so the test
  suite never touches a real file; it works in production too.
- The other 170 魔粒 a day come from liking 10 items (20), posting AIGC works
  (100) and AIGC models (50). None of those have an API, and automating them
  means driving the web UI, so this plugin does not touch them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `not signed in` | `printf 'ms-token\n' \| magpie plugin login msmoli` |
| No 魔粒 window on the card, or no check-in | restart magpie (the plugin host caches) |
| `failed` with HTTP 401 | the token was revoked — make a new one and sign in again |
| `failed` with HTTP 403 | ModelScope's risk control refused the request; the token is fine. It retries in 30 minutes |
| Card says `签到失败 · 未到签到时段` before the window | expected — see "When it claims" above |
| Always `inactive` | the sign-in works but nothing is granted: the account isn't eligible, or another client already claimed it today |
| Edits to this plugin do nothing | path plugins are referenced in place; restart magpie |

## License

MIT
