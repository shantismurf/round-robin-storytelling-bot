
# Round Robin Storybot — Hub Design Summary

Working doc capturing decisions and open questions from the Hub-phase design thinking. Intended to sit alongside `PLAN-hub-sharing.md` and be reconciled with it.

---

## Identity & Branding

- **Softening the AO3 resonance without abandoning it.** The robin-in-the-O stays; it's a round-robin pun and reads as collaborative storytelling more than AO3-specific. Shift the stylized A and 3 from AO3's red to a tree-branch treatment so the primary read becomes nature/storytelling/growth, with AO3 kinship as a wink rather than the whole brand.
- **"Display Name (ex: your AO3 username)"** replaces the current AO3-username prompt. Welcoming to non-AO3 writers (classrooms, TTRPG play-by-post, kids with friends) while preserving the feature for AO3 users who want attribution.
- **HTML export stays as-is.** Framed generically as "formatted HTML export" — useful for AO3 pasting and for anyone else publishing to a platform that accepts rich text.
- **Timing:** identity softening is easier *before* Hub launch than after. Hub server name, description, and welcome messaging will calcify expectations.

## Hub Architecture

- **Single all-ages Hub server**, purpose framed as *support for the bot*, not aggregation of content.
- **Age-gate the feed channels and `/story read`.** Everything else (announcements, help, feedback, general utility) stays accessible to all ages.
- **`/story list` on the Hub** lives in the age-gated area for simplicity — avoids adjudicating whether titles are all-ages appropriate.
- **Per-server feed channels** created at bot setup, admin-defined name, updatable by re-running `/storyadmin setup`.

## Consent Model

- **Three-layer opt-in:** admin opts server in at setup → story creator opts story in at creation → each participant consents at join.
- **Consent is to the creator's settings, full stop.** No per-participant toggles for name display; joining means accepting the creator's choices. Keeps the flow uncomplicated and avoids weird partial-attribution states in the story feed.
- **Username handling:** snapshot at time of joining (or user-defined text). Not retroactively updated. Lives in `story_writer`.
- **Admin opt-out mid-story:** stories in progress continue sharing until complete. Users should be clearly informed of this at the time admin-opt-out happens (or at story creation, as a known policy). Users who object can start a new unshared story.
- **User consent revocation:** channel renamed with `(inactive)` suffix, message posted explaining that stories can be removed on request by contacting Hub admin. Manual/escalation path only; automate later if volume warrants.

## Anti-Scraping Commitment

- Statement displayed at all consent moments (admin opt-in, story creation, participant join).
- Working version: "No AI training. No data sales. Scraper bots blocked where detectable. Discord members can still copy anything they can read."
- Back the claim up with a Hub ToS/rules post explicitly prohibiting scraping and AI training use of Hub content. Gives standing and signals seriousness.

## Reactions

- **Allowlist:** 👍 😍 🤣 😭 🫣 🔥. Any other reaction is removed by the bot.
- **Reaction summaries** posted back to source server. Positive-leaning set sidesteps the harassment-vector concern that a free-reaction system would create.

## Moderation

- Report flow for Hub posts (to be designed).
- Mechanism to remove individual mirrored entries without breaking the source story.
- Policy for source servers that themselves violate ToS (not just "their stories are edgy" — actual CSAM, harassment, etc.).
- Likely want a Hub moderator role separate from the bot dev role as volume grows.

## Staging Discipline

- Infrastructure already exists: separate bot application, separate token, third bot-hosting.net slot, separate MariaDB, env flag.
- **Gap to close: actually using it.** Root cause is friction, not discipline.
- **Seed script** is the key unblocker. One command, under 10 seconds, no required args, idempotent, prints a summary of what it created. Produces a useful baseline state (active stories, inactive, completed, multiple writers) so testing doesn't start from scratch.
- **Staging scope:** required for anything that writes across the server boundary (creation/entry/completion mirroring, reaction summaries, opt-out propagation, inactive-channel rename). Small non-Hub fixes can still go straight to prod.
- **Practices to adopt:**
  - Visible staging indicator on bot presence ("🚧 Staging" nickname or similar).
  - Env flag + Hub ID pairing validation at startup so staging can't accidentally point at prod Hub.
  - Seed command pinned somewhere impossible to miss (repo README top, personal Discord pin).
  - Three-line checklist on Hub-touching PRs/commits: seeded? happy path? one failure mode?

## Open Questions

- Exact wording of consent-moment anti-scraping statement (several drafts to choose from).
- Report flow UX on the Hub.
- Whether to canary-deploy Hub features via BBC first before enabling for all installed servers.
- Top.gg listing updates once Hub exists — how to describe the relationship.
- Data retention policy for mirrored entries (minimum necessary, documented retention window, working user-ID deletion flow — light-touch given this is a free hobby project, but worth having *something* documented).

## Parking Lot (Future Phases)

- **AO3-style tagging system:** tags, categories, fandoms, pairings, ratings.
- **Writer-suggested tags with creator approval** — fits the collaborative round-robin spirit nicely.
- Ratings explicitly *not* being used to gate Hub channels (uniform age-gating handles that). Ratings if implemented would be metadata/discoverability, not access control.

## Meta

- This doc lives alongside `PLAN-hub-sharing.md` — reconcile before treating either as authoritative.
- Personal scratchpad (half-formed thoughts, "ask Claude about X," emotional processing) belongs outside the repo. This doc is for considered design decisions only.