# Production Hosting — bot-hosting.net (Pterodactyl)

This bot's live deployment runs on a Pterodactyl-managed container at
bot-hosting.net. See `CLAUDE.md` for the access constraints (no manual
console, no local/staging environment — every change ships by pushing to
`main` and restarting).

## Startup command

This is the container's startup command (Pterodactyl egg), run fresh on
every restart:

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

Step by step:
1. `git pull` — pulls the latest `main` into `/home/container`, a persistent
   directory that is never re-cloned fresh between restarts.
2. Optionally installs/uninstalls extra packages named in the
   `NODE_PACKAGES` / `UNNODE_PACKAGES` startup variables (unused by this project).
3. `npm install` — installs/updates dependencies from `package.json`.
4. Runs `START_BASH_FILE` if set, otherwise runs `node index.js`
   (`BOT_JS_FILE`) directly. This project doesn't set `START_BASH_FILE`,
   so `index.js` runs directly, which in turn fires `deploy.js` (schema
   migrations, config sync, command registration, hub post sync) before
   the bot connects to Discord — see `CLAUDE.md`'s **Startup** bullet.

## Known quirk: `git pull` sometimes aborts on `package-lock.json`

Step 3 above (`npm install`, not `npm ci`) runs in the same persistent
directory every restart, and can rewrite `package-lock.json` on its own —
even with no `package.json` changes — whenever npm resolves something
differently (a new compatible package version on the registry, or a
different npm version after the host updates Node). That rewrite leaves
`package-lock.json` locally modified and uncommitted.

If the *next* restart's `git pull` (step 1) also needs to update
`package-lock.json` (e.g. a real dependency change pushed to `main`), git
refuses to overwrite the local modification and aborts:

```
error: Your local changes to the following files would be overwritten by merge:
        package-lock.json
Please commit your changes to stash them before you merge.
Aborting
```

Nothing is actually wrong with the file's contents — deleting it and
restarting works because it clears the local modification blocking the
merge, and `npm install` regenerates it from `package.json` on the next
boot. This is unpredictable because it depends on registry timing and the
host's own npm version, neither of which this project controls.

## Node.js version

See `CLAUDE.md`'s **Host** bullet — the host tracks current Node.js
releases rather than pinning to one version.
