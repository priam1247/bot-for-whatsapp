# WhatsApp Service

A command-driven WhatsApp bot built on Baileys v7 with an integrated Past-Paper Vault, streaming media & movie/series downloader, 9 GB folder-quota disk guard and owner-managed linked numbers (`.pair` / `.remove`). **Each linked session responds only to prefixed commands sent by that same WhatsApp account (`fromMe`). Incoming messages, bare links and edited-message re-execution are ignored; there is no command cooldown.**

## Commands

```text
.movie <title> [year] [quality]        Download a movie (480/720/1080/2160) with title and quality selection
.series <title> s01e03 [quality]       Download one episode (supports titles like "9-1-1", "Full House")
.series <title> s01 1-6 [quality]      Download an episode range
.series <title> s01 full               Season pack (Drime link when oversized)
.dramabox <title|bookId> [episode]     Search DramaBox and get an episode as a video
.info <title> [series]                 Metadata + provider IDs + active catalogs
.providers / .moviestatus              Source circuit-breakers, queue depth, and disk usage
.paper <course-code> [module] [year]   Search & send past papers (capped per query; never re-sent to the same group within 5 days)
.paper browse [letter|code] [page]     Paginated course/module directory
.countpapers [course-code]             Count papers in the vault
.song <name-or-YouTube-URL>            Send one artist-titled MP3 document (Gronka)
.video <name-or-YouTube-URL>           Send the video (Gronka)
.mfind <name|music-link> [--video] [720]  Search catalogs, then deliver via external APIs
.embed <link> [--audio|--video] [720]  Resolve an embed/player link to its canonical URL
.tiktok <URL>  .instagram <URL>  .fb <URL>
.sticker (reply to media)              512x512 WebP sticker
.viewonce (reply to view-once media)   Unwrap view-once photo/video/audio (from the session owner)
.menu / .ping
```

Interactive title and quality choices use a tap selector or a prefixed numbered reply, such as `.1`, `.2` or `.cancel`. Poll votes and replies without the prefix are ignored.

`.dramabox <title|bookId> [episode]` searches DramaBox by name (reply `.1`, `.2`… to pick) or takes a book ID directly, then downloads the episode (default `1`) and sends it as a video, with a hint for the next episode. The old Keith resolver it used was deleted by its owner, which is why the command stopped working; it now uses the public Sansekai DramaBox API (`DRAMABOX_API_BASE` to override). Episodes stream internet → disk → WhatsApp and are never loaded into memory.

### Video sites and YouTube

`.song` and `.video` ask the Gronka API (`https://api.gronka.dev`) for one
finished file; `.fb`, `.tiktok` and `.instagram` do the same for public links
(carousels up to ten items). Like `.movie` and `.kk`, the bot then **downloads
the file to `./temp`, sends it to WhatsApp from disk, and deletes it as soon as
the send has finished** (also when the send fails). Disk space is reserved
while the file is on disk, and files use names `lib/cleanup.js` sweeps if the
process ever dies mid-job (`lib/downloads/stage.js`). Gronka is
the **only** source for these commands. If it fails, the user sees its
reason (deleted post, video too long, rate limit with seconds to wait) and
nothing else is tried; `.status` shows whether the service is up. Search phrases
for `.song` / `.video` use the first `yt-search` result. `.tiktok`, `.instagram` and `.fb` use Gronka too; there is no generic `.dl` command. Removed on request: `.x`,
`.reddit` and `.spotify`. Download only content you have permission to use.

### Music sources

`.mfind` accepts **track, album and playlist links** from Spotify, Deezer,
Apple Music, SoundCloud and YouTube Music; `.mfind <words>` searches the public
music catalogs. Use `.song` and `.video` for direct YouTube downloads:

| Source | What it provides | Credentials |
| --- | --- | --- |
| Deezer public API | search, tracks, albums, artists, playlists | none |
| iTunes Search / Lookup | Apple Music search, albums and songs | none |
| Spotify embed page | track / album / playlist metadata (first 100 rows, longer playlists best effort) | none |
| SoundCloud web API | search and link metadata (public client id) | none |
| Gronka API | the final audio/video file for a matching public YouTube upload | `GRONKA_API_KEY` |

`.mfind` resolves a pasted music-service link to `artist - title` and its
duration, then searches for a matching public YouTube upload. If no catalog
upload matches, it searches YouTube by title and artist. The resolved media is
sent from the external provider URL. Albums and playlists show the existing
numbered picker, capped at ten tracks. The `.song` and `.video` commands do not
resolve music-catalog links.

`.mfind` and `.embed` deliver through the same Gronka service, so they need
`GRONKA_API_KEY` too. Provider availability remains external and can change
independently of this repository.

### Social media downloads

`.fb` and `.instagram` / `.ig` use Gronka only (see above). Private or restricted
posts may not resolve; the user is told why.

Streaming services are used for metadata only: nothing is downloaded from
them directly and **no DRM is circumvented**. Only download content you have the rights to.

`.mfind` defaults to MP3. Use `.mfind <name|link> --video [720]` (or
`--quality 720`) for a music video, `--first` / a leading `!` to skip the
picker, and `--audio` to force MP3. `.song` and `.video` take no audio-mode or quality flags.

Optional tuning for catalog requests: `MUSIC_REQUEST_TIMEOUT_MS`,
`MUSIC_SEARCH_TIMEOUT_MS` and `MUSIC_MAX_DURATION_DRIFT`.

### Embed / player links

Share sheets and "copy embed" buttons often give a *player* URL rather than
the normal link. The catalog commands (`.mfind` and `.embed`) normalise these
to a shared URL before resolving metadata, so pasting supported forms works:

| Provider | Embed / player URL | Canonical link |
| --- | --- | --- |
| Spotify | `open.spotify.com/embed/{track\|album\|playlist\|show}/{id}` | `open.spotify.com/{kind}/{id}` |
| Deezer | `widget.deezer.com/widget/{theme}/{kind}/{id}` | `deezer.com/{kind}/{id}` |
| SoundCloud | `w.soundcloud.com/player/?url=<encoded>` | the `url=` parameter |
| YouTube | `youtube-nocookie.com/embed/{id}` or `?videoseries&list=` | `youtube.com/watch?v=` / `playlist?list=` |
| Vimeo / TikTok | `player.vimeo.com/video/{id}`, `tiktok.com/player/v1/{id}` | `vimeo.com/{id}` / the player URL |

The same registry covers Anchor.fm, Buzzsprout, SimpleCast, Zencastr, Bluesky,
Threads, Mastodon, X/Twitter, CodePen, GitHub Gist, StackBlitz, Slides, Relive,
Guild and a generic fallback. `.embed <link>` prints the provider, kind, ID,
canonical URL, embed URL and iframe attributes; `.embed --list` lists all of
them. `.embed <link> --audio` / `--video 720` delivers catalog media directly;
`.mfind` handles music catalog links. `.song` and `.video` do not normalize non-YouTube music-service links.

The URL shapes, iframe defaults (`loading="lazy"`, `allow`, heights) and the
term-by-term fuzzy search scoring come from
[spences10/sveltekit-embed](https://github.com/spences10/sveltekit-embed)
(MIT, Scott Spence). That project renders browser iframes in SvelteKit; this
bot uses only the public link data — WhatsApp cannot display an iframe and no
Svelte code is included here.


## How the bot runs (receptionist + workers)

- **Receptionist** (`index.js`): stays connected to WhatsApp, reads commands, checks permissions, replies. It stays small.
- **Workers** (`lib/workers`): heavy commands (`.movie`, `.series`, `.kk`, TikTok/social, `.song`, `.video`, `.embed`, `.mfind`, `.dramabox`) run in a separate process started on demand. It exits when the job (and any open numbered list) is done and gives its memory back. If it crashes or runs out of memory, only that request fails — the bot stays online. `WORKER_MAX` (default 2) limits parallel workers, `WORKER_MAX_HEAP_MB` caps each one, `WORKERS=off` runs everything in one process for debugging.
- **Big files** go internet → disk → WhatsApp as a stream; memory stays flat for 2 MB or 2 GB files.
- **Storage**: bot data and the WhatsApp login keys live in one SQLite file, `database/bot.sqlite` (built into Node 22). Existing `database/*.json` files and `session/` key files are imported automatically on first start and kept as `*.migrated` / `session/.migrated-to-sqlite/` — nothing is deleted. Back up `database/bot.sqlite` (plus `jobs.sqlite`) to keep everything.

Owner/admin commands (hidden from non-owners in `.menu` and error hints):
`.status` (alias `.update`), `.restart`, `.on`, `.off`, `.allow`, `.disallow`, `.listusers`, and `.refreshpapers`.

## Bot folder layout

```text
zafar-bot/
├── index.js              Boot only: sessions, reload hooks
├── config.js             Configuration from environment variables
│
├── gateway/              Frozen core. Owns sockets, routing and access. No feature logic.
│   ├── handler.js        parse -> guards -> command -> timeout + circuit breaker
│   ├── guards.js         sender-only, approved-only, one-socket-per-message
│   ├── ctx.js            the helper bag every command receives (reply, status, isOwner)
│   ├── registry.js       loads commands/<folder>, isolates failures, on/off + breaker state
│   ├── sessions/         linked-number sessions, reconnect, startup/shutdown
│   ├── users/            approved list (access), member command policy, usage counters
│
├── commands/             ONE FOLDER PER COMMAND (a folder may export several related triggers)
│   ├── ping/ menu/ info/ sticker/ viewonce/ providers/ paper/
│   ├── song/ video/ embed/ mfind/ dramabox/
│   ├── movie/ series/
│   ├── social/           .tiktok .instagram(.ig) .fb (all Gronka)
│   └── users/ botmanage/ toggle/                     (owner only)
│
├── lib/                  Shared, stable infrastructure
│   ├── youtube/ downloads/ music/ movies/ (media code used by several commands)
│   └── logger, jsonStore, tempManager, jobQueue, selections, telemetry, ...
│
├── scripts/              Installation and offline regression tests
├── database/ session/ temp/    created at runtime, never in Git
├── package.json          Baileys is pinned to an exact version (no ^)
├── .env.example          Configuration template (no real secrets)
└── Procfile              Start command for compatible hosts
```

### Groups

* **Papers are never repeated in a group.** `.paper` remembers what it sent to
  each group for 5 days (`PAPER_DEDUPE_DAYS`, 1 to 30). The memory belongs to the
  group, not to an account: if two approved users share a group, the second one
  asking for a paper the first already got is told it was sent, and nothing is
  sent again. Two people asking at the same moment trigger one send. A different
  group has its own memory, and a private chat keeps its own per account. The
  owner is held to the same rule in a group and can resend with
  `.paper <code> <module> --force`.
* **Lightweight:** the memory is one small JSON file, `database/paper_log.json`,
  written once per batch and pruned of anything older than the window.
* Only the approved sender is answered, and replies are quoted to their message
  (see below).

### Who the bot answers

* The bot answers **only approved accounts**, and only when the command is sent
  **by that account itself**. Nobody else can trigger it, in a DM or a group.
* In a group with several approved users, every linked socket sees every
  message, but only the sender's own socket passes `gateway/guards.js`, and a
  message is claimed by exactly one socket. Replies are quoted to the sender's
  message, so there are no duplicate or crossed replies.
* Approval is managed with `.allow`, `.disallow` and `.listusers`. The owner manages everyone; an approved linked number manages only the people it allowed itself, and those people are answered in groups by that number only.

### Fixing one command without touching the others

1. `.status` shows every command folder as ✅ ok, ❌ broken (with the reason) or
   ⛔ switched off (owner or circuit breaker).
2. Edit only that command's folder.
3. `.restart <command>` reloads just that folder. Nothing else restarts.
4. `.off <command>` / `.on <command>` switches a single command off or on. Three
   crashes within ten minutes switch a command off automatically; `.on <command>`
   brings it back. Bare `.on` / `.off` still switch the whole bot.
5. Run `npm run test:structure` before deploying: it verifies the layout, command
   isolation, guards and the circuit breaker.

Rules: a command never imports another command; only the owner-only folders
`users/`, `botmanage/` and `toggle/` may use `gateway/`; shared code lives in
`lib/`. There are no hidden fallbacks added by the gateway: a failing command
fails visibly in `.status` and in its log.

## Gronka API (YouTube audio/video, Facebook, Instagram)

Put your key in `.env` (on Termux: `echo 'GRONKA_API_KEY=gk_...' >> .env`) and
restart. With a key set, `.song`, `.video`, `.fb` and `.instagram` ask
`https://api.gronka.dev` for one finished file (`split:false`, so no separate
video and audio parts) and send it by link. Gronka is then the **only** source
for those four commands: if it fails, the user sees its message (for example a
deleted post, a too-long video, or a rate limit with the seconds to wait) and
nothing else is tried. Without a key these commands answer that downloads are not set up. A bad key shows up as "the owner needs to check GRONKA_API_KEY", and the
key is never written to logs or chat. Quota: 50 downloads per 10 minutes per key.

## Console output

Every command is printed with who ran it, where, and how it ended:

```text
21:08:41.120  INFO   commands  .song ← 265991111111 (DM) calm down rema
21:08:44.902  INFO   commands  .song ✓ 3.8s
21:09:10.455  WARN   commands  .fb ✗ 1.2s (CONTENT_GONE)
```

Routine WhatsApp reconnects (status 408, 428, 515) are not logged, because the
session stays linked and reconnects within seconds. If the connection drops 5 or
more times in 10 minutes you get one `WARN ... connection is unstable` line, which
points at the host's network. Set `LOG_LEVEL=debug` to see every reconnect.

## Quick start

From the repository root, use Node.js **22.13 or newer** (Node 22 LTS is
recommended; CI uses Node 22). Older runtimes do not provide all the features
needed by the installed Baileys/jsdom dependencies and background jobs:

```bash
cd "Whatsapp bot"
cp .env.example .env   # configure privately, or use your host's startup variables
npm ci
npm run selftest       # offline preflight checks; no WhatsApp connection
npm run test:media     # offline YouTube, social, DramaBox, installer, and shortcut tests
npm run test:jobs      # offline background-job tests
npm run test:sessions  # offline pairing, permissions, and delivery tests
npm start
```

Offline tests use temporary source fixtures and synthetic data; they do not copy
or modify the bot's `.env`, sessions, or runtime database. They still use the
installed dependencies and can consume CPU and disk, so a separate checkout is
recommended for testing rather than competing with a running bot. The optional
real HLS smoke test also downloads a binary from GitHub.

The entry point uses this folder as its working directory, including when it is
started from another directory. Do not commit or share `.env` or session files.

For the past-paper vault, a Drime `401` means the service rejected authentication;
check `DRIME_API_TOKEN` and `DRIME_BASE_URL` in private host settings, then use
owner-only `.refreshpapers` to retry. A `403` instead calls for checking folder,
workspace and token permissions. Never paste the token into chat or support logs.
A saved vault snapshot can be stale while refresh is failing.

For HLS streams, N_m3u8DL-RE or ffmpeg is recommended. The pure-Node fallback
handles completed, supported playlists only; it refuses separate audio,
byte-range/changing-map streams and oversized playlists or segments rather than
sending incomplete or corrupt media. Its limits are 4 MiB per playlist and
32 MiB per segment.

## Linking additional WhatsApp accounts

The owner links and removes numbers straight from WhatsApp. There is no dashboard and no approval step.

```
.pair 265991234567     → the bot replies with a linking code
.remove 265991234567   → logs that number out and deletes it
```

On the phone of the number being linked: WhatsApp → Linked devices → Link a device → Link with phone number instead, then enter the code (it is valid for about a minute; send `.pair` again for a new one). The owner gets a message in their own chat when the number finishes linking.

A linked number **stays connected until you send `.remove`**: it reconnects after every drop, comes back after every restart, and is never paused, expired or retired by anything except `.remove`. Only WhatsApp itself can end it (for example if that person removes the device from their phone, or their phone stays offline for about two weeks). When that happens the owner gets a message and the number shows as `logged_out` in `.status`; send `.pair <number>` to link it again.

Each additional account has independent credentials under `<SESSION_NAME>/linked/` (login keys live in `database/bot.sqlite`). Keep the session directory and the database on persistent, private storage and back them up before moving servers. A linked number whose saved login is missing or damaged is reported to the owner and its data is left untouched; it is never replaced with a blank login. By default up to 20 additional accounts can be linked (`MAX_LINKED_ACCOUNTS`, maximum 100). Temporary pairing codes are sensitive; do not share them or post unredacted logs.

Each session accepts commands only from its own WhatsApp account; owner/admin commands still require the configured owner or administrator identity (`.pair` and `.remove` are owner-only, never available to a linked number). `OWNER_NUMBER` and `ADMIN_NUMBERS` are set privately for your installation. There are no built-in numbers: the bot refuses to start when `OWNER_NUMBER` is empty, and admins exist only if you list them.

### Roles and who answers whom

| Role | Who | `.allow` / `.disallow` |
|---|---|---|
| **Owner** | the main pairing number (primary session) | yes, everyone |
| **Linked number** | a secondary number paired under the owner | yes, only its own users |
| **Allowed user** | a number allowed by one specific session (its **Parent**) | no |

- Owner and linked numbers act from their own account, in groups and DMs.
- An allowed user is answered **only in groups**, only with the prefix, and **only by their Parent**. In a DM they get no reply from anyone.
- No session ever answers another session's users. If the Parent is offline or paused, its users get no reply from anyone (not the owner, not another linked number) until it is back.
- A user with no recorded Parent belongs to the owner's session.
- One chat message is claimed by one socket, so several linked numbers in one group never double-reply.
- The rules live in one place: `gateway/guards.js` (`decide()`); tests are the `roles:` cases in `scripts/test-structure.js`.

### Keeping linked numbers connected

- The console logs a numeric disconnect status and retry delay (never session contents). Routine drops (408, 428, 515…) stay quiet unless they pile up.
- The owner's `.status` has an **ACCOUNTS** section with each number's state, when it last heard a message, how many times it reconnected and the last disconnect code.
- A connection that looks open but has been quiet for 30 minutes gets one real round trip to WhatsApp. A healthy idle account passes; a dead one is reconnected automatically.
- Every minute the bot checks that no account is offline without a reconnect pending, and restarts any that are.
- **Scheduled refresh:** every 8 hours (`recycleMs`, `0` to disable, jittered) one old connection at a time is closed and reopened, but only while nothing is downloading or queued.
- **`.heal` (owner only):** checks every account now, reconnects the ones that are down or do not answer WhatsApp, and lists the result per number. `.heal all` reconnects every account except the one sending the command (use `.restart` for that one).
- `.allow` users live in `database/allowed.json`, written only by `.allow` / `.disallow`. Removing a linked number does not delete the users it allowed; they are answered again if the same number is linked again.

If a custom `SESSION_NAME` is used, keep that whole directory out of Git and
backups/logs shared with others. The default `session/` and common Baileys key
files are ignored, but a custom directory can contain additional private files.

No inbound Botkeep port is needed. Repository CI does not upload or restart
the service.

Members' command switches are controlled under **WhatsApp → Commands**. The
service enforces canonical commands, their aliases, and outstanding selections;
the owner can still test. A switch remains **awaiting service sync** until the
running bot acknowledges it. Already-running work is not forcibly cancelled.

## Disk Budget & Concurrency (10 GB Panel Plan)

Shared container panels often report the entire host node's free space via `statfs`. The service protects against `ENOSPC` crashes with two layers (`lib/diskSpace.js` + `lib/diskGuard.js`):

1. **Bot-Folder Quota (`DISK_BUDGET_MB=9000`)**: Tracks actual bytes inside the bot directory (including `session/`, `database/`, `node_modules/`, and `temp/`) plus **per-job byte reservations** so concurrent downloads can never over-commit a 10 GB plan.
2. **Comparison Logging & Status**: Startup, periodic warnings, and `.status` print both `bot folder: X / 9000 MB` and `host statfs free: Y MB` so operators can compare against the panel's disk meter.
3. **Concurrency & Temporary Files**:
   - Commands start concurrently instead of waiting in media lanes. Requests can be rejected immediately if available memory or reserved disk is too low.
   - Bot-generated media is deleted after WhatsApp accepts it. The boot/periodic sweeper removes recognizable abandoned job files but preserves sessions, databases, held transfers and unrelated files. An undelivered legacy background job retains its file for retry.
   - Movie sources do not need debrid account tokens. Direct torrents require `TORRENT_DIRECT=true` and a working optional `webtorrent` install; other sources work without it.

## Deploying to a server

Confirm the new provider allows WhatsApp bots and the required outbound traffic.
For a panel that uses the server root as the application directory, upload the
**contents** of `Whatsapp bot/` (including `.npmrc` and `.env.example`) to that
root, set your private environment values, install dependencies with `npm ci`,
and start with `npm start` (or `node --expose-gc index.js`). The panel root then
is the bot's working directory. Do not upload other projects (`scribd/`) to the bot server unless you intend to run them there.

If the host instead clones the whole repository, set its working/root directory
to `Whatsapp bot` or use `cd "Whatsapp bot" && npm start`. On platforms that
honor a `Procfile`, point the project root to that folder so it finds the bot's
`Procfile` and package files.

### One Botkeep server

Run only one WhatsApp service using these sessions. Never start a second copy
(another panel, an old deployment, a local test run) with the same session and
database: two processes using one login make WhatsApp disconnect it
(status 440 in the log) and can end with the device being logged out. The bot's
`.restart` reloads code and reconnects locally. Stop any older process before
starting this one and preserve its `.env`, session and database.

### Existing sessions and data

The reorganization does not copy files from a remote server. If moving an existing
bot installation, stop it and securely back up and transfer its `.env`,
`session/`, `database/` (including JSON and SQLite files), and any needed
`secrets/` or `cookies/` to the bot's new working directory. Preserve the originals
until the new installation has been verified. These files are private; never
commit them or post them in support tickets. For a fresh installation, configure
its own environment and pair again instead. Completed downloads awaiting delivery
are recorded with absolute paths. To resume those jobs after a move, preserve the
job database and their media files at the same absolute paths; otherwise request
the affected downloads again. Other temporary files need not be moved.

### Repository checks

GitHub Actions runs validation only. It does not upload files, restart the bot,
or alter the Botkeep deployment. Update the server manually or by the owner's
existing Botkeep deployment process, taking care to preserve private state.

## Scribd

The separate Scribd service is documented in [`scribd/README.md`](../scribd/README.md); the bot does not
start it.

## License

MIT

## Migration notes (from the flat `utils/` layout)

| Old | New |
|---|---|
| `handler.js` | `gateway/handler.js` (+ `gateway/ctx.js`, `gateway/guards.js`) |
| `utils/commandLoader.js` | `gateway/registry.js` (folder isolation, breaker, on/off, reload) |
| `utils/sessionManager, reconnect, serviceStartup` | `gateway/sessions/` |
| `utils/accessControl` | `gateway/users/` |
| `commands/{admin,general,media}/x.js` | `commands/x/index.js` (one folder each) |
| `commands/media/shortcuts.js` + `providerSearch` + `socialMedia` | `commands/social/` |
| `utils/paperSearch` / `xjxDramaBox` | private to `commands/paper`, `commands/dramabox` |
| `utils/youtubeSearch` | `lib/youtube/search.js` |
| `utils/xjxMedia` (Gronka) | `lib/downloads/` |
| `utils/musicSources/` | `lib/music/` |
| `utils/movieEngine, movieHost`, `engine/` | `lib/movies/` (`.movie` and `.series` share a length check in `lib/movies/length.js` instead of importing each other) |
| other `utils/*`, `database.js` | `lib/` |

Behaviour is unchanged: the same 104 command names and aliases, the same data
files under `database/`. Removed: `utils/allowlistSync.js` (unused), the two
opt-in live probes and the python extractor test (not part of the offline suite).
Added: the guards, the registry (breaker, per-command on/off and reload) and
`scripts/test-structure.js`.

Known limits, stated plainly:

* Torrent downloads run in a **separate child process** with its own memory cap
  (`TORRENT_WORKER_MB`, default 384) and a hard kill (`TORRENT_HARD_TIMEOUT_MS`),
  so WebTorrent never loads into the bot. Everything else (ffmpeg) is
  already an external process, but commands themselves run in the bot process
  because they need the live WhatsApp socket. Isolation for those is per-folder
  load, per-command error handling, a timeout (`timeoutMs`, default 30 min) and
  the breaker; a command that blocks the event loop synchronously can still
  stall the bot.
* The movie/series engine registers exactly these 11 providers: moviebox,
  vidsrc, vaplayer (streams) and yts, torrentio, eztv, nyaa, knaben,
  solidtorrents, torrentscsv, apibay (torrents). The three DDL providers and the
  mirror pool they used were removed.
* Downloads for `.song`, `.video`, `.mfind`, `.embed`, `.tiktok`, `.fb` and `.instagram` have no fallback: Gronka is the only source.
* Data stays in `database/` (not per-command folders) so existing deployments
  keep their whitelist, paper snapshot and counters.
* Run `node scripts/check-live.js` (with `GRONKA_API_KEY` and optional
  `CHECK_YT_URL`, `CHECK_FB_URL`, `CHECK_IG_URL`) to see which sources work
  before users find out.
