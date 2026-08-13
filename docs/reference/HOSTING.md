# Production Hosting — bot-hosting.net (Pterodactyl)

## Access

- No shell/console access — the Pterodactyl panel's Console tab only shows
  the container's stdout, it does not accept commands.
- No local/staging environment. Every change ships by pushing to `main`
  and restarting the bot from the panel.
- **Restart** (re-runs the startup command below against the existing
  container filesystem) is the normal deploy action, used every time.
  **Reinstall** (wipes and reprovisions the container) takes several
  minutes and is only used if something is broken badly enough to need it.
- A git push does **not** trigger a restart by itself — the panel restart
  has to be triggered manually after pushing.

## Startup command

Runs on every restart:

```bash
if [[ -d .git ]] && [[ ${AUTO_UPDATE} == "1" ]]; then git pull; fi;
if [[ ! -z ${NODE_PACKAGES} ]]; then /usr/local/bin/npm install ${NODE_PACKAGES}; fi;
if [[ ! -z ${UNNODE_PACKAGES} ]]; then /usr/local/bin/npm uninstall ${UNNODE_PACKAGES}; fi;
if [ -f /home/container/package.json ]; then /usr/local/bin/npm install; fi;
if [[ ! -z "${START_BASH_FILE}" ]]; then
  bash ${START_BASH_FILE};
else
  /usr/local/bin/node /home/container/${BOT_JS_FILE};
fi;
```

In order: pull `main` into the persistent `/home/container` directory (not
a fresh clone), run `npm install`, then run `node index.js`
(`START_BASH_FILE` is unset for this project). `index.js` fires
`deploy.js` — schema migrations, config sync, command registration, hub
post sync — before connecting to Discord; see `CLAUDE.md`'s **Startup**
bullet.

## Fixed quirk: package-lock.json

`npm install` (step 3, running every restart in the same persistent
directory) could rewrite `package-lock.json` on its own, even with no
`package.json` change, leaving it locally modified. The next restart's
`git pull` would then refuse to overwrite that local change and abort with
`error: Your local changes to the following files would be overwritten by
merge: package-lock.json`.

Fixed by removing `package-lock.json` from git tracking (`.gitignore`) —
`npm install` now regenerates it locally every restart with nothing for
`git pull` to conflict with.

## config.json

Not in git (`.gitignore`). It lives directly in the container's files on
the host and is not touched by `git pull`. A local backup copy is kept
outside the repo in case it needs to be re-uploaded.

## Database

Provided by bot-hosting.net, on the same network as the bot container
(host may be Cloudflare-fronted, unconfirmed). Credentials are viewable in
the same Pterodactyl interface as the bot — only copy-to-clipboard or
password-cycle are available, no other access.

### Known quirk: DB outage from disk-full crash, no uptime visibility

Confirmed 2026-08-13 (host support): the legacy DB node's disk filled up,
which crashed MariaDB and left it down for hours. Timeline from the
2026-08-13 incident (all times local, matching Discord's rendering):

1. **10:10 PM** — a single ECONNREFUSED blip on the job runner poll, the
   first sign of trouble. Recovered on its own within the minute.
2. **3:40 AM** — degraded-but-alive: a `doFinalizeEntry` transaction
   commits fine (entry saved, current turn ended), but the immediately
   following `NextTurn` call fails on a MariaDB disk-full error surfacing
   through the driver, e.g. `NextTurn failed: Error: Disk got full writing
   '.(temporary)' (Errcode: 28 "No space left on device")` — the server
   rejecting a temp-file write, not a bot-side disk issue. Net effect: the
   story's entry is safely recorded, but the story is left with **no
   active turn** (see recovery note below).
3. **~4:03 AM** — a different story's entry finalizes and advances
   cleanly — the DB was still partially functional at this point, not yet
   fully down.
4. **6:22 AM onward** — mysqld goes fully down; every query now fails with
   `connect ECONNREFUSED <ip>:3306`, logged every tick by the job runner
   poll (`job-runner.js`, 60s interval). This isn't a single dead
   connection needing a code-level reconnect — `utilities.js`'s
   `DB.connect()` uses `mysql.createPool`, so the pool is dialing fresh
   sockets each time and getting refused because nothing is listening on
   that port. No self-recovery; needed host support to bring the node
   back up.

**Gotcha when cross-referencing console output against Discord:** the
console's `formattedDate()` prefix is UTC (`toISOString()`-derived), but
Discord renders its own message timestamps in local time. A console line
timestamped e.g. `08:40:25` is the *same moment* as `3:40 AM` in the
`#logs` channel (5-hour offset, at least during EDT) — don't assume a
console timestamp that looks like "now" is recent; convert it first.

**Recovery for a story left with no active turn:** open that story's
`/story manage` panel and use the turn-actions "Next" button — it
explicitly handles the no-active-turn case (`_manageTurnActions.js`,
`handleTurnActionSelectMenu`) and starts the selected writer's turn
immediately, no waiting on any background job.

The host pulled the community-made uptime monitor that used to show
legacy-node up/down status, so there's currently no passive way to see
this happening — it only surfaces via the `ECONNREFUSED` log spam in
`#logs`. No shell/console access to check disk usage directly; confirm
with host support or the panel.
