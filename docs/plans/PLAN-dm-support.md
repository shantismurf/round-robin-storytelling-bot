# DM Support

Status: Deferred indefinitely 2026-09-22 — will not be built unless someone asks
Created: 2026-07-01
Last Updated: 2026-09-22

Extracted from TODO.md, where this lived as a fully detailed inline implementation plan.

## Why this idea existed — established 2026-09-22

The commands were already showing up in DMs, which is what had LeeAnn thinking about DM support
in the first place. It was not a missing feature so much as a promise the bot was making and
breaking: `deploy-commands.js` registers globally in production, nothing set `contexts`,
`setDMPermission` or `integration_types`, and Discord's default for a guild-install app offers
the commands in DMs with the bot. Every one of them then dead-ended on the guild guard.

Fixed in 3.5.5 by hiding them instead: `setContexts(InteractionContextType.Guild)` on all three
command builders, so the DM picker no longer offers something that cannot work.
`test/commandContexts.test.js` asserts the serialized payload stays guild-only.

That closes the bug. **This plan stays deferred on its own merits** — building real DM support
means resolving which guild a DM refers to, which is step 2 below and the genuinely hard part.

Note that step 1 below is now partly wrong: it says to add `setContexts([0, 1, 2])`. That was
written before the commands were guild-scoped, so building this would mean widening the contexts
again rather than adding them from nothing, and updating the test above.

---

**1. Discord app setup**
- Enable User Install scope in Discord Developer Portal
- In `deploy-commands.js`, add `setIntegrationTypes([0, 1])` and `setContexts([0, 1, 2])` to all applicable commands

**2. Guild resolution for DM context** — add `resolveGuildForDMUser(connection, client, userId)` to `utilities.js`
- 0 matching guilds → error; 1 → silently resolve; 2+ → show StringSelectMenu of server names
- Guild names sourced from `guildName` config key
- Must handle both regular and autocomplete interactions (no `interaction.guild` in DM context)

**3. Guild tag + name added to setup** — add **Server Tag** field to `storyadmin.js` `handleSetup` modal
- 1–4 chars, validated with `/^[\u0021-\u024F]{1,4}$/u` (printable ASCII/Latin, no spaces/emoji)
- Used to prefix story labels in DM context e.g. `[BBC] The Wandering Stars (#3)`
- `guildName` auto-populated silently from `interaction.guild.name` on every setup submission (no modal field)
- Add upserts for `guildTag` and `guildName` in `handleSetupModalSubmit`; follow existing pattern in `sync-config.js`

**5. DM guard clause removal** — replace early `if (!interaction.guild)` guards in `mystory.js` and `story.js` with guild resolution logic
- All `interaction.guild.id` → resolved `guildId` variable
- All `interaction.guild.name` in log calls → `interaction.guild?.name ?? 'DM'`

**6. Commands staying guild-only:** `storyadmin` (all subcommands), `story add`

**DM-related follow-ups (implement alongside or after DM support):**
- `story read` should be non-ephemeral in DM context
- Audit edit flow for `interaction.guild` references; apply guild-resolution pattern

**Suggested implementation order:**
1. `utilities.js` — `resolveGuildForDMUser` + shared autocomplete query helpers
2. `deploy-commands.js` — integration types, contexts, swap integer options to autocomplete string options
3. `storyadmin.js` — guild tag/name in setup modal and submit handler
4. `mystory.js` — remove guard, DM resolution, autocomplete handler, parse string story_id
5. `story.js` — same for applicable subcommands
7. `sync-config.js` / DB — new config key defaults for `guildName` and `guildTag`
