# Windows onboarding session: learnings and fixes

> Findings from the first end-to-end run of [`scripts/windows-onboarding.md`](../../scripts/windows-onboarding.md)
> on a Windows machine that already had Civilization V installed before Vox Deorum. Two real bugs were found
> and fixed; one real gap remains open. This is a record of what happened and why, not a design doc.

## Bug 1 (fixed): the bridge never connects on a fresh install

**Symptom:** `bridge-service` retries `DLLConnector` forever (`Could not connect to DLL: connect ENOENT
\\.\pipe\tmp-app.vox-deorum-bridge`), even though Civilization V is genuinely running a modded game. Civs
assigned to agentic AI instead prompt the local player for orders, because the DLL's bridge channel never
came up to drive them.

**Root cause, confirmed mechanically, not guessed:**

- [`CvGame::init()`](../../civ5-dll/CvGameCoreDLL_Expansion2/CvGame.cpp#L1098-L1101) only starts
  `CvConnectionService::Setup()` (the named-pipe server) when the `IPC_CHANNEL` custom mod option is `1`.
- That option is set by [`SQL/VoxDeorum_Options.sql`](../../civ5-mod/SQL/VoxDeorum_Options.sql) inside the
  "Vox Deorum" mod's `OnModActivated` actions.
- Querying Civ V's own live SQLite caches (`%DOCUMENTS%\My Games\Sid Meier's Civilization 5\cache\
  Civ5CoreDatabase.db` and `Civ5ModsDatabase.db`, readable with `better-sqlite3` from this repo's own
  `node_modules`) showed: Community Patch, Vox Populi, EUI, and Vox Deorum all report
  `Installed/Enabled/Activated = 1`; `BALANCE_VP` and every `EVENTS_*` option from Community Patch's own
  `NewCustomModOptions.xml` merge correctly; **but `IPC_CHANNEL` never exists as a row at all**, and
  `FLAVOR_MOBILIZATION` (a plain `INSERT INTO Flavors` in the *same* SQL file) is also always missing.
- Executing `VoxDeorum_Options.sql`'s exact text directly against a copy of the merged database (via
  `better-sqlite3`) applies cleanly — the SQL itself is correct. Yet Civ V's own merge of that exact file
  never takes effect, while its sibling file `Text/VoxDeorum_Text.sql` (same mod, same `OnModActivated`
  list, same file type, INSERTs that also touch existing rows) merges correctly every launch, confirmed by
  querying `TXT_KEY_SPECIFIC_DIPLO_STRING_1` etc. out of `Localization-Merged.db`.
- Ruled out along the way: mod-folder naming (`(1b)` vs the now-current `(5) Vox Deorum` in the `.modinfo`
  `<Name>`, changed in commit `22208470`) — cosmetic only, GUID-based activation works regardless. MD5
  mismatch — declared and actual hashes matched exactly. BOM/encoding — file has none, matching its working
  sibling. Reordering `SQL/VoxDeorum_Options.sql` to run *last* instead of *first* in `OnModActivated` — no
  effect; `IPC_CHANNEL` and `FLAVOR_MOBILIZATION` were still absent after a full clean relaunch (which also
  rules out "only fails on the very first-ever activation," since the merged database is rebuilt from
  scratch every launch, confirmed by its mtime).

**The actual mechanism by which Civ V silently drops this one file's statements is still unknown.** Root-causing
further would need a debugger attached to the running DLL (`civ5-dll/docs/building.md` covers building a debug
DLL), which is out of scope for this machine per its onboarding notes (no C++ toolchain, build-and-play only).

**Status: still broken. Two fix attempts tonight, both empirically failed — do not trust either without
re-verifying from scratch.**

1. *Attempt 1:* reordered `SQL/VoxDeorum_Options.sql` to run last instead of first in `OnModActivated`.
   Tested with a full clean shutdown + relaunch. Result: `IPC_CHANNEL` and `FLAVOR_MOBILIZATION` were still
   completely absent from the freshly-rebuilt database. No effect.
2. *Attempt 2:* moved `VoxDeorum_Options.sql`'s three statements (`IPC_CHANNEL`, `EVENTS_%`,
   `FLAVOR_MOBILIZATION`) into `Text/VoxDeorum_Text.sql` instead — the file independently proven to merge
   reliably every launch (its own `TXT_KEY_SPECIFIC_DIPLO_STRING_*` rows always appear) — and dropped
   `SQL/VoxDeorum_Options.sql` from `OnModActivated` entirely. Recomputed its MD5 by hand (no `python` on
   this machine to run `update_md5.py` — used `Get-FileHash -Algorithm MD5` instead) and redeployed both
   changed files directly into the live `MODS\(1b) Vox Deorum\` folder. Tested with a full clean shutdown +
   relaunch, including clicking through the leader-intro screen. **Result: bridge still never connected**
   (`bridge-service/logs/combined.log` still spinning past reconnection attempt 50+; no `connection.log` /
   `connection-pipe.log` ever appeared in Civ V's own `Logs` folder). So even a statement that lives inside
   a file *proven* to merge doesn't reliably take effect — which undercuts the "this one file gets skipped"
   framing above. The mechanism is genuinely not understood yet.

Both changes are still committed (see `civ5-mod/VoxDeorum.modinfo` and `civ5-mod/Text/VoxDeorum_Text.sql`)
because they're harmless and represent real, verified-negative diagnostic progress worth keeping as a
starting point — **but the bridge connection bug is UNRESOLVED as of this writing.** Tomorrow's
investigation should probably start from: why would a statement in a file that provably merges its *other*
statements successfully still fail to apply just these three? That points away from "this file gets
skipped" and toward something about the statements themselves under Civ V's actual merge engine (as opposed
to a raw `sqlite3`/`better-sqlite3` exec, which was only ever tested against a static copy of the database,
not Civ V's live merge process) — e.g. table lock timing, a transaction scope difference, or the specific
`UPDATE ... LIKE` / `INSERT INTO Flavors` shapes hitting something the simpler `INSERT OR REPLACE INTO
Language_en_US` statements next to them don't. Getting a debugger attached to the live DLL
(`civ5-dll/docs/building.md`) is probably the fastest real path forward, even though that's a heavier
workflow than this machine is normally set up for.

## Bug 2 (fixed, confirmed working): ~3 minute intro video plays on every launch

**Root cause:** [`scripts/install.cmd`](../../scripts/install.cmd) only copies its `configs/UserSettings.ini`
template (which sets `SkipIntroVideo = 1`) into the game's settings folder **if no file is already there**.
A machine with Civilization V installed before Vox Deorum already has a `UserSettings.ini` with
`SkipIntroVideo = 0`, so the template is silently skipped and the Firaxis/2K studio intro plays in full on
every single launch.

**Fix:** `install.cmd` now force-patches just that one key into whatever `UserSettings.ini` ends up in place
afterward, whether freshly copied or pre-existing, leaving every other setting alone. Confirmed working on
this machine after the fix.

## Open gap: unattended/headless launches still need one manual click

Every new game shows Civilization V's own leader-introduction screen ("Begin Your Journey") before turn 1,
and nothing in the codebase dismisses it — searched all of `civ5-mod`, `civ5-dll`'s open-source layer, and
`vox-agents` for `FirstLook` / `Begin Your Journey` / similar and found zero references. This is fine for an
interactive human session (one click, once per game) but is a **hard blocker for unattended/scale training
runs** — nobody is present to click it, so no game ever starts.

This is very likely a closed-source base-game screen, not something in any mod layer this project controls
directly. Candidate directions, not yet investigated:

1. Civ V's `-Automation` launch mode (already used by `StartGame.template.lua`) is used elsewhere in the
   Civ V modding/QA community for unattended playtesting; there may be an existing `Automation.*` Lua flag
   or `AppOptions.txt` setting that suppresses first-look/advisor popups globally.
2. Once the bridge connects, `CvConnectionService` may come up early enough in `CvGame::init()` to dismiss
   this screen via a remote command, the same way it'll eventually drive in-game decisions — needs
   verification of the actual init/render ordering.
3. Simulated input (a scripted click) is the blunt fallback if neither pans out.

Not fixed in this session — flagged here for real design/implementation work.

## Incidental findings, useful for future automation work

- **Each service exposes a graceful shutdown endpoint**, discoverable without prior knowledge: each of
  `bridge-service`, `mcp-server`, and `vox-agents` writes its shutdown URL to a per-run token file under
  `%TEMP%\vox-deorum-{bridge,mcp,vox}-<pid>.shutdown` on startup (see each service's own log for "Wrote
  shutdown URL to..."). `POST`ing to that URL cleanly stops the service. Useful when the console window
  that would normally handle `Q`/`K` is unavailable (frozen, or simply not present on a headless VM).
- **Civ V's own SQLite caches are directly queryable** for diagnosing mod/database issues, using this repo's
  own `better-sqlite3` dependency (no separate `sqlite3` CLI or Python needed) — see
  `%DOCUMENTS%\My Games\Sid Meier's Civilization 5\cache\*.db` and `Logs\*.log`
  (`connection.log` / `connection-pipe.log` specifically confirm whether `CvConnectionService::Setup()` ever
  ran, by their mere existence).
- **The dashboard's Setup wizard is not the only way to start a game.** It's a thin layer over a JSON
  `StrategistSessionConfig` POSTed to vox-agents' HTTP API (see
  [`docs/developers/vox-agents/overview.md#models-and-configuration`](../developers/vox-agents/overview.md)).
  A training pipeline driving games at scale should script that API/config directly rather than the browser
  UI — this sidesteps the wizard's "Play the game yourself" default (see below) entirely, but not the
  leader-intro click above.
- **The wizard's default role is "Play the game yourself,"** not "Watch AI self-play" — it reserves one
  seat for a human player unless explicitly switched. Easy to miss on a first pass, and was the first (wrong)
  theory investigated for the "AI civ asks for my input" symptom before the real bridge bug was found.
