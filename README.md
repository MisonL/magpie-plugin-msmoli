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

## Purpose, responsibility, and risk

**What it is for.** A personal utility: it claims the daily 魔粒 grant of the
ModelScope (魔搭) account *you* sign in, and does nothing else. It is not an
official ModelScope product; it is not affiliated with ModelScope, Alibaba or
magpie, and it collects nothing about you — the token stays in magpie's own
`plugin-auth.json`, and every request goes to the site the account signed in
to.

**The risk you are taking.** ModelScope has no check-in endpoint. The daily
grant exists for a *real* website sign-in, and this plugin obtains it by
calling `login/info` once a day with the browser's session cookie — a script
posing as the browser, not a button the official client offers. ModelScope's
user agreement forbids plugins that interfere with the service (4.1.2(1)) and
"刷分" with third-party tools (4.1.2(5)), and lets the platform freeze a
user's benefits or blacklist them for abuse (2.3.1 and the 魔粒 rules). An
account is real-name verified and often tied to Aliyun, so what is at stake is
the account, not the 250 credits that expire the same day. No account has been
reported frozen for running this, and no one can promise one never will be —
whether the service's detection would ever notice is not something this
project can answer. Whether to run it is a decision about your own account.

**Responsibility.** You are responsible for complying with ModelScope's terms
when you use this. The software is provided under the MIT licence, without
warranty of any kind; the maintainer is not liable for a suspended or frozen
account, lost credits, or anything else that follows from running it. See
[LICENSE](LICENSE).

**Not in the magpie market, and it will not be submitted.** magpie's community
market declined to list this package for exactly the reason above
([plugins#714](https://github.com/magpie-community/plugins/pull/714)), and the
project has decided not to submit it again. It stays installable by name from
npm.

## Install

Needs magpie itself (<https://usemagpie.ai>). On macOS, use `magpie --version` to check it's on PATH; if not, use the app's full path:
`/Applications/magpie.app/Contents/MacOS/magpie`.

### Install from npm

The package is on npm as `magpie-plugin-msmoli` (latest 0.1.0). Installs into
magpie's own plugin folder, and `magpie plugin update` follows the versions.

```bash
magpie plugin add magpie-plugin-msmoli
printf 'ms-your-token\n' | magpie plugin login msmoli
```

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
The sign-in is kept per provider id (`msmoli`) rather than per folder, so
switching between the two forms (or moving the clone) keeps the token — no
second login.

### International site (modelscope.ai)

The plugin now provides a second provider for the international site:
`msmoli-intl` (ModelScope 魔粒（国际版）). The same `ms-` token format, the same
daily grant rules, **but tokens are site-specific** — a token from `modelscope.cn`
answers 401 on `modelscope.ai`, and vice versa.

The sign-in and check-in work the same way:

```bash
printf 'ms-your-intl-token\n' | magpie plugin login msmoli-intl
```

The check-in window (`msmoli.json`) is shared between both providers — it is
a personal preference, not a per-site setting. To turn on the international
check-in, set `msmoli-intl` in your plugin-checkins instead of or alongside
`msmoli` (see "Turn the check-in on" below, substituting the provider id).

### Already have ModelScope set up in magpie? Sync that key to the plugin

If you added ModelScope earlier just for chat, its key is already in
`providers.json`. This package ships a small CLI that logs the same token into
the plugin, so you don't have to find it again.

It syncs the domestic site only, because the built-in preset it reads is the
`modelscope.cn` one. The international site has no preset; sign `msmoli-intl`
in by hand (`magpie plugin login msmoli-intl`).

Installed from GitHub, magpie keeps its own copy in its plugin folder:

```bash
node ~/.config/magpie/plugins/node_modules/magpie-plugin-msmoli/bin/sync.mjs --status      # see both sides
node ~/.config/magpie/plugins/node_modules/magpie-plugin-msmoli/bin/sync.mjs --to-plugin   # sync
```

Installed from a clone, run the file in the clone — magpie references that
folder and copies nothing (`./bin/sync.mjs`; on Windows or WSL, where the
file may not carry an executable bit, run it as `node bin/sync.mjs`). Portable
installs keep the same layout under their `data` folder; if detection misses,
`--dir <magpie's config folder>` and `--magpie <path to the magpie binary>` say
where things are: for a portable install that is its `data` folder, not the
folder the executable sits in. `--magpie` takes a path, absolute or relative —
a bare `magpie` is refused, because that one is resolved through `PATH` and the
first `magpie` on it would be handed the token. `npx magpie-plugin-msmoli` runs
the CLI from npm (published as 0.1.0) — npm 12 blocks `npx github:…` by
default, so don't start from that.

`--dir` says where to *read*; magpie's CLI has no such flag, so a write always
lands in the binary's own folder. Given both and they disagree, the tool stops
before writing anything rather than reading one magpie and writing another.
"Disagree" means the folders are different places, not that the strings differ:
a shell completes a directory with a trailing slash, `/private/tmp` and `/tmp`
are one folder on a Mac, and `data/.` is `data` — each names the binary's own
folder and is allowed.

It reads magpie's config but never writes it: the writes are magpie's own
(`magpie plugin login`, `magpie plugin logout`, `magpie provider key`), and the
token is masked in everything it prints, failures included. When the plugin
already uses the same key it changes nothing; when the two keys differ it
refuses, because a second `login` would add a second account — pass `--force`
to replace a single existing account. `--to-preset` goes the other way (needs
`--force`: that key is what chat uses). If more than one provider could be the
built-in side (say, a relay of the same host), the tool refuses to guess and
`--from <id>` picks one; `--dry-run` prints the commands without running them.
A value flag given twice (`--dir a --dir b`) is refused, not silently last-wins,
and `--dir=<folder>` is read as well. `--from` and a stray argument are echoed
back masked when the value looks like a key — a token pasted into the wrong
position is never printed whole, whatever its shape. That covers the shapes
`ms-…` does not: a GitHub or Slack token, an AWS secret (which carries `/`), a
UUID, a hex digest, a base64 body — long, or short enough that only its trailing
`=` (or a `+` beside a case mix) gives it away. The judgement runs
word by word,
so a key with a space or a newline pasted onto it — the shape a copy out of a
terminal or a chat window leaves — or quoted inside a line is still the key it
is. A word that is one key is masked whole, ends and all, including one split with
separators — a hex digest with dashes, a key written as `AbCdEfGh.IjKlMnOp…` —
and an AWS secret, whose two parts of 12+ characters with mixed case mark it. An
invisible character dropped inside a key (a zero-width space or `\x01`, the
shape a copy out of a chat window leaves) does not save it either: the
control/format characters sitting between key-alphabet characters are removed
before masking, so the two halves are rejoined into the one key they are —
each half alone falls under the length floor and would have leaked. A
word that starts like a path (`/`, `~`, `.`, a drive letter, a UNC root) keeps
its shape, and only the key-like run inside it is masked, so `--dir
/tmp/ghp_16C7…` still names the folder it read; a key pasted in *behind* a path
prefix (`~/keys/sk-ant-…`) reads as part of that path, which is what keeping a
path's shape costs. The folder is reported
the same way on every line that names it, and magpie's own output goes through
the same door — a key of another provider in the child's error message is
masked there too, not only the `ms-` shape. A provider id and an account name
are read out of magpie's own files and go through the same door: a key pasted
into either field is masked on every line the tool names it.

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
so nothing else needs configuring. For the international provider
(`msmoli-intl`), the token comes from <https://modelscope.ai/my/myaccesstoken>
instead — the two sites' tokens do not interchange.

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

A `claimed` needs a grant the ledger did not already show around the touch. If
the touch went through and the ledger still shows nothing, the plugin asks
magpie to look again half an hour later (`until`), once — from Beijing noon on
magpie would otherwise settle `inactive` for the day, and a grant written a few
seconds late was recorded as "the account may not be in the campaign". Before
noon magpie's own provisional re-ask (every 30 minutes) already covers it.

Four outcomes follow:

| Outcome | Meaning |
|---|---|
| `done` | already claimed today, with the day's total |
| `claimed` | this run claimed it, with the amount — a grant the ledger did not already show, so a row that was there before the touch is never counted as this run's |
| `inactive` | the sign-in went through but nothing was granted (from noon on, asked once more in 30 minutes before it stands for the day) |
| `failed` | nothing was claimed — including "not yet time", explained below |

The endpoints it uses, all on `modelscope.cn` with `Cookie: m_session_id=ms-…`
(a browser UA and a `Referer` are enough — no CSRF token):

| Purpose | Path |
|---|---|
| Sign-in / check-in trigger | `GET /api/v1/users/login/info` |
| Balance | `GET /openapi/v1/magicubes/balance` |
| Ledger | `GET /openapi/v1/magicubes/transactions?page=1&page_size=50` |

`type` in the ledger has been seen as `EARN` and `SPEND_CONFIRM`; there is
also an `EXPIRE`, which this plugin ignores. Rows are aggregated per day, type,
`rule_key` and `model_tier` — a day's spending shows one row per model tier it
used — with a `count` on each, and the list is sorted newest first. The ordering
is what makes the single page of 50 enough: today's rows come before any older
one. Measured on a live account that is 3–7 rows a day, so a page reaches back
about a fortnight rather than 50 days; what the read would not survive is a
single day with more than 50 rows. Asking for a larger page does not help —
the server answers `page_size=200` with 50.

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
capped there: the host does not ask at the target's minute — its own look runs
every 30 minutes on a phase of its own, so the first ask past a target can come
up to half an hour late, and the retry after a failure half an hour after that.
A target needs both to still land on the same day. Capping at 23:00 leaves any
target that room; later would leave some with one ask, or none. A window that sits entirely past 23:00 falls back to the
default window too, since there would be nowhere left to put the target. The
file is read on every ask, so a change takes effect without restarting
magpie.

How it fits magpie's schedule: magpie asks once when the Beijing day turns,
then every 30 minutes — always after a `failed`, and also after a
`done`/`inactive`/`ineligible` it hasn't seen a claim for yet, up to noon
Beijing (a provisional answer: the vendor's day may not have turned; from noon
on the plugin's own `until` buys the same re-ask when the ledger lagged). So
before the window's moment the plugin answers `failed` with the time it will
run, and sends **no request at all**. `failed` is still the one outcome that
guarantees a re-ask; the others only get one while the day is unproven.

What that costs, since a plugin has no other way to defer: until the claim
actually runs the account card shows a red dot and magpie's own "check-in
failed; magpie tries again later" wording, each of those asks rewrites
magpie's `plugin-checkin.json`, and `magpie accounts checkin` run in that
period exits non-zero. Turning the window off removes all three.

How long that is depends on when magpie next asks, not on the target alone.
Measured on a real day: the target was 09:01, magpie asked at 09:00:57 (three
seconds early, so `failed`), and the claim landed on the next ask at 09:31 —
about 9.5 hours from midnight, rather than the 8.5 the window's 08:30 start
alone suggests. That is also why the card names the cadence instead of a
countdown: the host keeps the line until its next ask, half an hour later, so
"约 8 分钟后" would be wrong for most of the time it is on screen.

### Upstream

magpie gives a plugin no timer, no clock, and no say in when it is called:
`auth.checkin(getAuth, info)` returns an outcome and the host decides when
to ask again. Everything above is worked around within that contract, and
the awkward parts (proving "not yet" as a failure, whole-day granularity for
the account card) want a line in
[this issue](https://github.com/yetone/magpie/issues/3245) proposing timers and
`recheck` for plugins.

Two consequences worth knowing, both from the same missing timer: a window's
target is only reached by the host's own asks, so one that falls while the
machine is asleep is claimed on the next ask after it wakes (the day is lost
only if that happens past midnight); and the plugin cannot retry on its own
between asks — the window's cap (above) is what buys the retry.

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

The preset's empty card has one consequence worth knowing. ModelScope's
inference API has no balance endpoint, so magpie cannot see that the key's 魔粒
are gone; the gateway learns it from the vendor's own `429 insufficient balance`
and then rests the key for 30 minutes. Until then each request spends one failed
try on it first. The balance is on the account, and `modelscope.cn` does answer
it, so the preset can be told: in its editor, Balance URL
`https://modelscope.cn/openapi/v1/magicubes/balance` and Balance field
`data.available_balance` (the same token answers it — `magpie quota modelscope`
then reads a number instead of `no balance endpoint known for it`).

The one real overlap to know about: **both rows cost nothing extra**, but if you
remove the plugin's sign-in, chat is unaffected, and if you remove the preset,
the check-in keeps working. They fail independently.

If you sign in the international site as well, that adds one more row,
`msmoli-intl` (ModelScope 魔粒（国际版）). It has every property in the table
above — no models, its own card, its own check-in — and fails independently of
both the preset and the domestic plugin row.

## Privacy

`login/info` responds with `Email` and `GitlabAccessToken` among other fields.
This plugin reads `NickName` / `Name` and nothing else; the rest is dropped as
soon as the response is parsed. The token lives only in magpie's own
`plugin-auth.json` — the plugin never writes it anywhere, never logs it, never
sends it anywhere but the site the account was signed in for (`modelscope.cn`
for `msmoli`, `modelscope.ai` for `msmoli-intl`).

The one thing it writes is that nickname, as `accountId` on the sign-in it
already has, so magpie's card can name the account. It goes through the host's
own `client.auth.set`, which replaces the sign-in entry — so the plugin hands
back what the host gave it, with the name added, and the token is still
stored once.

It also reads `providers.json`, magpie's own list of providers, for one thing:
whether you already named this account yourself. If you have, it writes
nothing — your name stays, and the nickname is not put over it.

## Scope and limits

**ModelScope's terms and the risks of running this are stated above, in
[Purpose, responsibility, and risk](#purpose-responsibility-and-risk).**

- One account's own daily grant, idempotent: a check-in reads the ledger, touches
the sign-in endpoint, and reads the ledger again — three requests. A day already
claimed (a retry, a later ask) answers `done` in two; a touch the ledger has not
caught up with reads it once more, four. Once a day.
Asks that arrive before the window open send nothing at all.
The usage read makes two requests and never touches the sign-in endpoint, so the
menu bar's polling cannot turn into check-ins.
- Every request gives up after 8 seconds, and a response body is read to at most
256 KiB; neither can hold the host or grow without bound. The timeout covers the
body as well as the request: a proxy that stops mid-reply is cut at the same
8 seconds, and says so rather than passing the runtime's own word for it
through (`terminated` on Node, a sentence about `verbose: true` on Bun). A whole
check-in gives up after 25 seconds and a whole usage read after 18, because
magpie runs every provider's check-ins under one two-minute budget and asks
accounts one at a time — a hook cut short answers `failed`, which the host
retries in half an hour, and that retry reads the ledger before claiming, so
nothing is lost.
- **A body it does not understand fails; it never reads as zero.** No `data`, a
`data` that is a list rather than an object, a balance with no
`available_balance` or one that is not a number — each is a failure with the
reason, because "0 魔粒可用" is a definite answer that would be false. The same
goes for the server's own text: a message or a grant's title carrying a key —
this account's token, or one of another vendor's, which this plugin never held
and therefore cannot compare against — has it masked before the text reaches
the card or magpie's log. What counts as a key there is the same rule `--from`
uses, so a ledger title or a server message of ordinary words is untouched.
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
| `failed` with HTTP 401 | the token was revoked, or it belongs to the other site — `modelscope.cn` and `modelscope.ai` do not share tokens. The card names which site refused (国内站 / 国际站). Make a new token on that site and sign in again |
| `failed` with HTTP 403 | ModelScope's risk control refused the request; the token is fine. It retries in 30 minutes |
| Before the window the card reads failed, with a line naming the claim time: `09:56 后自动领取（magpie 每半小时问一次，无需操作）` | expected — the card leads with when it will claim; see "When it claims" above |
| Always `inactive` | the sign-in works but nothing shows in today's ledger: the account may not be eligible, or the grant hasn't been written yet (a claim made elsewhere shows as `done`). Before Beijing noon magpie asks again every 30 minutes; from noon on the plugin asks once more itself, half an hour later ("半小时后再核对一次"), and only the second `inactive` stands for the day |
| Chat through the `modelscope` preset answers `429 insufficient balance` in the Routing log | the account's daily 250 魔粒 are spent — a flagship call costs 2, so ~125 calls run the day dry and the vendor refuses the rest. Not this plugin: it registers no models. If you want magpie to *see* the balance on the preset's card too, give the preset the same reading — Balance URL `https://modelscope.cn/openapi/v1/magicubes/balance`, Balance field `data.available_balance` in its editor (the same token answers it; read `1.50` on 2026-10-28). Whether the gateway then holds a drained key before spending a request on it is not verified — the safe path is still the 429's own 30-minute rest |
| Two accounts of one ModelScope nickname, and only one of them checks in | magpie before 2026-10-20 kept a plugin's check-in per display name rather than per sign-in, so namesakes collapsed into one. Update magpie: the fix landed upstream on 2026-10-20 (magpie-community/plugins#254) |
| Edits to this plugin do nothing | path plugins are referenced in place; restart magpie |
| Installed both ways by accident, and `magpie plugin list` says `msmoli` is "served by" one of them | that is magpie keeping two copies of one provider id. Remove one: `magpie plugin rm github:MisonL/magpie-plugin-msmoli` or `magpie plugin rm <path>`. magpie files your alias with the package it was set against, so removing a copy can take the display name with it — it comes back if you add that package again, or you set the alias once more |

## License

MIT
