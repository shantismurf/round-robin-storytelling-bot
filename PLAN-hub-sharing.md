# Plan: Hub Server Sharing + Consent + Announcement System

## Context

The bot runs on multiple Discord guilds. The owner wants a central "hub" Discord server for bot support and development announcements that also mirrors story activity from participating guilds — giving the hub a vibrant, community-facing feed showcasing stories across all installations. 

This requires an opt-in toggle at the guild level during the /storyadmin setup workflow, per-story opt-out (if guild ensbled) at story creation and manage, explicit writer consent at join (with reassurance regarding no AI scraping), and an option to follow the hub announcement channel in their story feed, or the channel of their choice.

A broadcast mechanism to inform current users of the hub launch, or critical info and new versions, to be used only for critical bot updates may be needed for those who don't follow.

Writers' creative work is involved, so consent and transparency are the top concerns. The hub is a **public Discord server** — semantically equivalent to posting an unrestricted work on AO3 (public but lower-profile, unlikely for scrapers to access compared to the Archive). This framing should appear in consent language.

---

## Decisions Made

- **Writer consent**: Blocking acknowledgement — writer clicks "I understand this work will be shared on the Round Robin Storybot Hub" before the Join button appears (when story is hub-shared). Covers consent without stifling participation.
- **Story default**: Opt-in by default (new stories on opted-in guilds are shared unless story creator opts out).
- **Broadcast timing**: At launch — send the broadcast and enable hub sharing simultaneously, asking for user feedback and participation. Include thank you to the first few users of the bot and encourage collaboration on its development.

---

## Content Concerns - Decision Needed

User stories may contain explicit content. Should the Hub server be restricted to 18+, or should there be a rating system (trusting users to self-police)?  Is there another approach that would minimize user burden and handle mature content in an responsible manner.

We could add a mandatory Rating on stories, following the AO3 convention. Stories Not Rated, Mature or Explicit would be posted to the hub in an age restricted channel for the guild. General and Teen stories would post to a SFW channel for the guild.

---edit bookmark---




## Architecture Overview

### Config Keys

| Key | Stored at | Set by | Notes |
|---|---|---|---|
| `cfgHubGuildId` | `guild_id = 1` (sample_config.sql) | Bot owner (DB/script) | Hub Discord server ID; empty = hub disabled |
| `cfgHubEnabled` | `guild_id = 1` | Bot owner | Master on/off switch |
| `cfgHubFeedChannelId` | Per-guild | Bot owner via `/storyadmin hubsetup` | That guild's channel on the hub server |
| `cfgShareToHub` | Per-guild | Guild admin via `/storyadmin hubenable` | `'true'`/`'false'` opt-in flag |

Add `cfgHubFeedChannelId` and `cfgShareToHub` to the **protected keys** list in `sync-config.js` (alongside existing `cfgStoryFeedChannelId`, `cfgMediaChannelId`, `cfgAdminRoleName`).

Add `hubOwnerId` to `config.example.json` — the Discord user ID allowed to run hub management commands.

### Story Table

Add `share_to_hub TINYINT(1) NOT NULL DEFAULT 1` to story table.
- `1` = share (if guild is opted in)
- `0` = opted out for this story specifically

### New Files

- `hub.js` — hub guard + posting helper
- `broadcast.js` — CLI script to post announcements to all configured guild feed channels

---

## Implementation Phases

### Phase 1: Schema & Config Foundation

**`db/init.sql`** — Add to `story` table CREATE:
```sql
share_to_hub TINYINT(1) NOT NULL DEFAULT 1,
```
After `allow_joins`.

**`database-setup.js`** — Add migration block (same pattern as existing migrations):
```js
// Migration: add share_to_hub column to story table
const [hubCols] = await connection.execute(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'story' AND COLUMN_NAME = 'share_to_hub'`);
if (hubCols.length === 0) {
  await connection.execute(`ALTER TABLE story ADD COLUMN share_to_hub TINYINT(1) NOT NULL DEFAULT 1`);
}
```

**`db/sample_config.sql`** — Add new section:
```sql
-- Hub Server Configuration
('cfgHubGuildId', '', 'en', 1),
('cfgHubEnabled', 'false', 'en', 1),
-- Hub announcement text templates (posted to hub feed channel, not guild feed channel)
('txtHubJoinAnnouncement', '🎭 **[guild_name] · [story_title]:** [joiner_name] joined!', 'en', 1),
('txtHubCreationAnnouncement', '# 📚 New Story on **[guild_name]**: "[story_title]"\n-# [mode] Mode · [order] Order · [turn_length]h Turns · [writers] Writers', 'en', 1),
('txtHubActivationAnnouncement', '🎬 **[guild_name] · [story_title]** is now active! **[first_writer]** starts.', 'en', 1),
('txtHubTurnStart', '✍️ **[guild_name] · [story_title]:** [writer_name]\'s turn! Ends [turn_end_date].', 'en', 1),
('txtHubClosedAnnouncement', '🎉 **[guild_name]** — **[story_title]** complete! [turn_count] turns · ~[word_count] words · [writer_count] writers', 'en', 1),
-- Writer consent notice shown before join when story is hub-shared
('txtHubConsentNotice', '📡 **This story''s activity is shared to the StoryBot hub server** — a public Discord server.\n\nYour Discord display name will appear in turn announcements (joins, turn starts, story completion). Story content itself is not mirrored, only announcements.\n\n-# This is similar to posting an unrestricted work on AO3: publicly visible but not intentionally made available to AI training services. The hub is a Discord server with no special API access.\n\n-# The story creator can opt this story out via /story manage.', 'en', 1),
-- Notice shown in story creation embed when guild is opted into hub sharing
('txtHubCreateNotice', '-# 📡 Hub sharing is active for this server. Story activity (joins, turns, completion) will be mirrored to the hub. Opt individual stories out after creation via /story manage.', 'en', 1),
```

**`sync-config.js`** — Extend protected keys filter:
```js
config_key NOT IN ('cfgStoryFeedChannelId','cfgMediaChannelId','cfgAdminRoleName','cfgHubFeedChannelId','cfgShareToHub')
```

**`config.example.json`** — Add:
```json
"hubOwnerId": "YOUR_DISCORD_USER_ID"
```

---

### Phase 2: Hub Infrastructure (`hub.js`)

New file: `hub.js`

```js
import { getConfigValue, log } from './utilities.js';

export async function shouldPostToHub(connection, guildId, storyShareToHub) {
  if (!storyShareToHub) return false;
  const [hubEnabled, hubGuildId, shareToHub, hubChannelId] = await Promise.all([
    getConfigValue(connection, 'cfgHubEnabled', 1),
    getConfigValue(connection, 'cfgHubGuildId', 1),
    getConfigValue(connection, 'cfgShareToHub', guildId),
    getConfigValue(connection, 'cfgHubFeedChannelId', guildId),
  ]);
  return hubEnabled === 'true' && hubGuildId && shareToHub === 'true' && hubChannelId;
}

export async function postToHubChannel(client, connection, guildId, message, options = {}) {
  try {
    const hubGuildId = await getConfigValue(connection, 'cfgHubGuildId', 1);
    const hubChannelId = await getConfigValue(connection, 'cfgHubFeedChannelId', guildId);
    if (!hubGuildId || !hubChannelId) return;
    const hubGuild = await client.guilds.fetch(hubGuildId);
    const hubChannel = await hubGuild.channels.fetch(hubChannelId);
    if (!hubChannel) return;
    await hubChannel.send({ content: message, ...options });
  } catch (err) {
    log(`Hub post failed for guild ${guildId}: ${err}`, { show: true });
  }
}
```

Key: `postToHubChannel` is **fire-and-forget** — hub failures never block guild operations.

---

### Phase 3: Admin Commands (`commands/storyadmin.js`)

Add two subcommands:

**`/storyadmin hubsetup`** — Bot owner only (`interaction.user.id === config.hubOwnerId`)
- Options: `guild_id` (string), `hub_channel_id` (string)
- Writes `cfgHubFeedChannelId` for the specified guild_id
- Verifies channel exists via `client.guilds.fetch(hubGuildId).channels.fetch(hubChannelId)`
- Logs to `admin_action_log` as `'hub_setup'`

**`/storyadmin hubenable`** — Guild admin (`checkIsAdmin`)
- Toggles `cfgShareToHub` between `'true'` / `'false'` for the guild
- Shows current status + explicit summary: *"Story activity (joins, turn announcements, completions) will be mirrored to the hub server, a public Discord server. Writers' Discord display names appear in those posts. Story content is not mirrored."*
- Requires confirmation button
- Logs to `admin_action_log` as `'hub_optin'` or `'hub_optout'`

After adding: run `node deploy-commands.js` to register.

---

### Phase 4: Writer Consent Flow

**`story/join.js` — join confirmation step:**

When `cfgShareToHub === 'true'` and `story.share_to_hub === 1`:
1. Show the `txtHubConsentNotice` text as an embed field in the join confirmation embed
2. Replace the normal single Join button with a **two-button flow**:
   - Button 1: `story_join_hub_ack` — "📡 I understand — Join Story"
   - Button 2: `story_join_cancel` — "Cancel"
3. The existing join confirmation handler fires only when `story_join_hub_ack` is clicked
4. When hub is not active (guild not opted in, or story opted out), the existing flow is unchanged

**`story/add.js` — Story creation embed:**

When `cfgShareToHub === 'true'`, append `txtHubCreateNotice` as a subtext line in the creation confirmation embed. No extra click required here — guild admin consent covers creation.

**`story/manage.js` — Hub sharing toggle:**

- Add `share_to_hub` to the SELECT in `handleManage`
- Add to manage state: `shareToHub: story.share_to_hub`
- Add button to Row 3 (before Save/Cancel): `story_manage_toggle_hub` — "📡 Hub: On" / "📡 Hub: Off" — only shown if `cfgShareToHub === 'true'`
- Include `share_to_hub = state.shareToHub` in the UPDATE on save
- Add embed field: `{ name: '📡 Hub Sharing', value: state.shareToHub ? 'Shared to hub' : 'Opted out', inline: true }` — shown only when guild is opted in

---

### Phase 5: Hub Posting in Announcements (`announcements.js`)

Add `client` as an optional last parameter to each existing announcement function (default `null` for backwards compat):

```js
export async function postStoryFeedJoinAnnouncement(connection, storyId, interaction, storyTitle, client = null)
```

After each existing guild-channel post, add:
```js
if (client && await shouldPostToHub(connection, guildId, story.share_to_hub)) {
  const hubMsg = replaceTemplateVariables(await getConfigValue(connection, 'txtHubJoinAnnouncement', guildId), {
    guild_name: interaction.guild.name,
    story_title: storyTitle,
    joiner_name: joinerName,
  });
  await postToHubChannel(client, connection, guildId, hubMsg);
}
```

Same pattern for: `postStoryFeedCreationAnnouncement`, `postStoryFeedActivationAnnouncement`, `postStoryFeedClosedAnnouncement`.

For closed: include ao3_URL in hub message if set.

**New function: `postHubTurnAnnouncement`**
```js
export async function postHubTurnAnnouncement(connection, client, guildId, guildName, storyId, storyTitle, storyShareToHub, writerName, turnEndTimestamp)
```
Called from `storybot.js` in NextTurn and quick mode handlers.

Callers of existing announcement functions pass `interaction.client` as the new last argument.

---

### Phase 6: `ao3_URL` Surfacing

The `ao3_URL` column already exists on the `story` table. Three places to surface it:

**`story/manage.js`:**
- Add `ao3_URL` to the SELECT
- Add button to Row 3: `story_manage_set_ao3url` — "📖 Set AO3 URL"
- Opens modal with single text input; on save, UPDATE `ao3_URL`
- Add embed field: `{ name: '📖 AO3 URL', value: state.ao3Url || '*Not set*', inline: false }` (show when closed or URL is set)
- Row 3 becomes: [Set AO3 URL] [Hub toggle] [Save] [Cancel] — 4 buttons, within limit

**`announcements.js` — `postStoryFeedClosedAnnouncement`:**
- Accept `ao3Url = null` as 8th parameter
- Append `\n📖 **Read on AO3:** ${ao3Url}` to the announcement if set
- Hub post also includes the AO3 link

**`storybot.js` — `updateStoryStatusMessage`:**
- Add `ao3_URL` to the SELECT
- Add embed field `{ name: '📖 AO3 Link', value: story.ao3_URL, inline: false }` if set

---

### Phase 7: `broadcast.js` (CLI script)

New file: `broadcast.js`

```
node broadcast.js "Your message"          # Send to all configured guild feed channels
node broadcast.js --dry-run               # List guilds without sending
```

Logic:
1. Load `config.json`, connect to DB, create Discord client
2. Query: `SELECT DISTINCT guild_id, config_value AS feedChannelId FROM config WHERE config_key = 'cfgStoryFeedChannelId' AND guild_id != 1`
3. For each guild: fetch guild → fetch channel → send message with header `📢 **Announcement from the Round Robin StoryBot team:**\n\n[message]`
4. Log success/failure per guild; print summary
5. Graceful logout + exit

**Launch message template** (to use at hub launch):
```
📡 **Hub Server Sharing is now live for Round Robin StoryBot!**

Stories from participating servers will have their activity (joins, turn starts, completions) showcased on the StoryBot hub server.

**What this means for writers:**
• Your Discord display name may appear in hub announcements for stories you're part of
• Story content is NOT mirrored — only activity announcements
• This is similar to posting a public work on AO3: visible to anyone on the hub server, but not intentionally provided to AI services
• Story creators can opt individual stories out via `/story manage`

Server admins can enable or disable hub sharing via `/storyadmin hubenable`.
```

---

## Critical Files

| File | Change |
|---|---|
| `db/init.sql` | Add `share_to_hub` column to story table |
| `database-setup.js` | Migration for `share_to_hub` |
| `db/sample_config.sql` | New hub config keys and text templates |
| `sync-config.js` | Extend protected keys list |
| `config.example.json` | Add `hubOwnerId` |
| `hub.js` | New file — `shouldPostToHub`, `postToHubChannel` |
| `broadcast.js` | New file — CLI broadcast script |
| `commands/storyadmin.js` | Add `hubsetup` and `hubenable` subcommands |
| `announcements.js` | Hub mirror posts + `ao3_URL` in close announcement |
| `storybot.js` | Call `postHubTurnAnnouncement`; ao3_URL in status embed |
| `story/join.js` | Hub consent acknowledgement button flow |
| `story/add.js` | Hub create notice |
| `story/manage.js` | Hub toggle button + ao3_URL button/modal |

## Recommended Build Order

1. Schema + config (init.sql, database-setup.js, sample_config.sql, sync-config.js, config.example.json)
2. `hub.js` (infrastructure, no visible changes)
3. Admin commands (`hubsetup`, `hubenable`) + deploy-commands
4. `ao3_URL` surfacing in manage + status embed (low-risk, additive)
5. Writer consent flow in join.js + add.js + manage.js
6. Hub posting wired into announcements.js + storybot.js
7. `broadcast.js`
8. Configure hub server in production → run broadcast → enable per guild

## Verification

- Run `node database-setup.js` on a dev DB — confirm `share_to_hub` column appears
- Run `npm run sync-config` — confirm new hub keys appear, protected keys unchanged
- `/storyadmin hubsetup` — verify channel fetch succeeds, config row written
- `/storyadmin hubenable` — verify `cfgShareToHub` toggles, action logged
- Join a hub-enabled story — verify consent notice appears, two-button flow shown
- Post a turn — verify hub channel receives announcement, guild feed unaffected
- Simulate hub channel unreachable — verify guild feed still posts normally
- `node broadcast.js --dry-run` — verify all configured guilds listed
- `node broadcast.js "test"` — verify message appears in each feed channel
