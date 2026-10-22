# magpie-plugin-msmoli

A [magpie](https://github.com/yetone/magpie) plugin that claims ModelScope's
(魔搭) daily **魔粒** credits for you — one request a day instead of opening the
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

```bash
git clone https://github.com/<you>/magpie-plugin-msmoli.git
cd magpie-plugin-msmoli
magpie plugin add "$PWD"
printf 'ms-your-token\n' | magpie plugin login msmoli
```

Then turn the check-in on in `~/.config/magpie/settings.json`:

```json
"pluginCheckins": {
  "msmoli": true
}
```

The token comes from <https://modelscope.cn/my/myaccesstoken>. The same `ms-`
token is both the inference `Authorization: Bearer` and the web session cookie,
so nothing else needs configuring.

From then on magpie claims it once a Beijing day per signed-in account, retries
later that day if it fails, and reports the outcome on the account's usage card:

```
● msmoli  API key …a1b2 · 魔搭社区  魔粒 1% (今日用 2 / 领 250 · 余额 249.5)
  ↻14h24m tomorrow 00:00  249.5 魔粒可用 left
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

The endpoints it uses, all on `modelscope.cn` with `Cookie: m_session_id=ms-…`
(a browser UA and a `Referer` are enough — no CSRF token):

| Purpose | Path |
|---|---|
| Sign-in / check-in trigger | `GET /api/v1/users/login/info` |
| Balance | `GET /openapi/v1/magicubes/balance` |
| Ledger | `GET /openapi/v1/magicubes/transactions?page=1&page_size=50` |

`type` in the ledger is one of `EARN`, `SPEND_CONFIRM`, `EXPIRE`.

## Why its own provider, with no models

The plugin registers `msmoli` rather than taking over the built-in `modelscope`
preset, for three reasons:

1. A plugin's `config` hook writes `config.provider[id]`; taking over
   `modelscope` would overwrite the preset's model list and name.
2. magpie namespaces a plugin id that collides with a preset into
   `<id>-plugin`, so it would no longer be the same provider anyway.
3. **Safety.** magpie's gateway passes over an account whose usage window reads
   as used up. If a check-in plugin served the provider that inference actually
   routes through, reporting 100% would take the whole chat path out of magpie.

So chat keeps using the `modelscope` preset with your API key in
`providers.json`, and this plugin only carries the sign-in its check-in runs as.

## Privacy

`login/info` responds with `Email` and `GitlabAccessToken` among other fields.
This plugin reads `NickName` / `Name` and nothing else; the rest is dropped as
soon as the response is parsed. The token lives only in magpie's own
`plugin-auth.json` — the plugin never writes it anywhere, never logs it, never
sends it anywhere but `modelscope.cn`.

## Scope and limits

- One account's own daily grant, idempotent: a check-in reads the ledger, touches
the sign-in endpoint, and reads the ledger again (three requests, once a day).
The usage read makes two requests and never touches the sign-in endpoint, so the
menu bar's polling cannot turn into check-ins.
- The other 170 魔粒 a day come from liking 10 items (20), posting AIGC works
  (100) and AIGC models (50). None of those have an API, and automating them
  means driving the web UI, so this plugin does not touch them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `not signed in` | `printf 'ms-token\n' \| magpie plugin login msmoli` |
| No 魔粒 window on the card, or no check-in | restart magpie (the plugin host caches) |
| `failed` with HTTP 401 | the token was revoked — make a new one and sign in again |
| Always `inactive` | the sign-in works but nothing is granted: the account isn't eligible, or another client already claimed it today |
| Edits to this plugin do nothing | path plugins are referenced in place; restart magpie |

## License

MIT
