# Changelogs

Two tiers, different readers, different rules.

| | `INTERNAL.md` | `public/` |
|---|---|---|
| Reader | you, and any future session | server admins and writers on the Hub |
| Scope | everything, including the boring and the removed | the interesting half, edited to fit one Discord message |
| Rule | comprehensive; **Removed entries must say why** | readable; completeness is not the goal |
| Source of truth | this repo | this repo, but the post as actually sent is archived here verbatim |

## `INTERNAL.md`

The comprehensive backend record, newest version first. This is what answers *"what happened
to that command, and why?"* six months later — the question that prompted this whole directory
on 2026-09-22, when `/storyadmin skip`/`close`/`pause` turned out to have been consolidated
into `/story manage` with nothing recording it.

Every version gets **Added / Changed / Removed / Fixed**, and the **Removed** section carries
the reason, not just the fact. A rename is a Removed plus an Added, not a Changed — future-you
will search for the old name.

Entries before v3.2.1 are reconstructed from the Hub posts in `public/`, so they inherit that
editing and are not comprehensive. Entries from v3.2.1 on are reconstructed from git. This is
marked per version; do not silently smooth the difference away.

## `public/`

One file per Hub announcement, named `YYYY-MM-DD-<versions>.md`, holding the post **exactly as
sent**. These are primary sources — corrections go in `INTERNAL.md`, never into the quoted post.

They are also the reference for voice and shape. The house format, stable across every post so
far: a title with the version range, the month as a subheading, then `💫 New Features` split
into `🌟 Major Additions` and `✨ Minor Additions`, then `🛠️ Improvements`, then `🐛 Bug Fixes`,
with each item as a blockquoted bullet whose lead phrase is bolded.

## Workflow

`CLAUDE.md` already requires sign-off before any version bump. Attach the changelog to that
moment rather than treating it as separate work:

1. Propose the version bump and its `INTERNAL.md` entry together.
2. On approval, both land in the same commit as the change itself.
3. When enough has accumulated to be worth announcing, draft the Hub post *from* `INTERNAL.md`
   — the summarising is the only new writing.
4. Save the post as sent into `public/`, then send it.

Step 3 is the one that used to stall, because it meant reconstructing months of work from
memory. With `INTERNAL.md` maintained, it is an editing job rather than an archaeology job.

A version does not need a Hub post. Most will not get one.
