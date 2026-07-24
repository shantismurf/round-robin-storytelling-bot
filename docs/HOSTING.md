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
