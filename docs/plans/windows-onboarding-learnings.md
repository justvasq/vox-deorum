# Windows onboarding session: learnings and fixes

> Findings from the first end-to-end run of [`scripts/windows-onboarding.md`](../../scripts/windows-onboarding.md)
> on a Windows machine that already had Civilization V installed before Vox Deorum. Two real bugs were found
> and fixed, and the stack is now verified working end to end; a third issue recorded here as a blocker turned
> out not to be one. This is a record of what happened and why, not a design doc.

## Bug 1 (root-caused): a stale DLC-mode Vox Populi install shadows Vox Deorum's gamecore DLL

**Symptom:** `bridge-service` retries `DLLConnector` forever (`Could not connect to DLL: connect ENOENT
\.\pipe\tmp-app.vox-deorum-bridge`), even though Civilization V is genuinely running a modded game. Civs
assigned to agentic AI instead prompt the local player for orders, because the DLL's bridge channel never
came up to drive them. Downstream, `vox-agents` logs nothing but `Not connected to MCP server` and
`KnowledgeStore not initialized`.

**Root cause:** the machine had Vox Populi installed **twice**, and the wrong copy won.

```
Assets/DLC/Mod_VP_43Civ_EUI_5.0-alpha.03/          <- stock VP, "one-click DLC" install, ALWAYS active
    Mods/(1) Community Patch (v 146)/CvGameCore_Expansion2.dll

My Games/.../MODS/(1) Community Patch/
    CvGameCore_Expansion2.dll                       <- Vox Deorum's patched DLL, never loaded
```

Civ V loaded the DLC-folder gamecore. Its first line in `Logs/CustomMods.log` says so outright:

```
CvDllContext.cpp[247]: Community Patch v143 (PNM v51+) - Startup (Build Oct 26 2025 17:15:22)
CvDllContext.cpp[250]: Gamecore was built from git version Release-4.20.1 53a871a0a Dirty
```

Version strings extracted from each binary confirm which file that is:

| DLL | version strings | `IPC_CHANNEL` | `vox-deorum-bridge` |
|---|---|---|---|
| `Assets/DLC/Mod_VP_.../(1) Community Patch (v 146)/` | `Community Patch v143`, **`Release-4.20.1`** | absent | absent |
| `MODS/(1) Community Patch/` (deployed by Vox Deorum) | `Community Patch v149` | present | present |
| repo `civ5-dll/(1) Community Patch/` | `Community Patch v149`, `Release-5.2.7-0-gbb6b6c428` | present | present |

`Release-4.20.1` exists only in the DLC copy, so that is unambiguously the gamecore that ran. Stock VP has
no `IPC_CHANNEL` custom mod option and no `CvConnectionService`, therefore no named pipe is ever created and
`bridge-service` has nothing to connect to.

**This also explains, completely, the SQL mystery that consumed the first session.** The mod's
`UPDATE CustomModOptions SET Value = 1 WHERE Name = 'IPC_CHANNEL'` matched **zero rows** because the loaded
Community Patch was the stock one, whose `NewCustomModOptions.xml` has no such row to update. The SQL was
correct all along, and `SQL/VoxDeorum_Options.sql` was never being "silently skipped" by the merge engine.
Corroborating evidence that was present in the logs the whole time: `IPC_CHANNEL` never appears anywhere in
`CustomMods.log`'s option-cache dump, while every single `EVENTS_*` option does — the running DLL simply had
no such option in its table.

**Why the installer never caught it:** [`scripts/install.cmd`](../../scripts/install.cmd#L246-L290) writes only
`Assets\DLC\VPUI` and `Assets\DLC\UI_bc1`. It does not look for — or warn about — a pre-existing DLC-mode VP
install sitting beside them. This is the *same class of bug as Bug 2 below*: a machine that had Civ V and VP
before Vox Deorum keeps its old state, and the installer silently works around it instead of over it.

**Fix:** move `Assets/DLC/Mod_VP_<...>/` out of `Assets/DLC/` entirely (renaming in place is not enough —
Civ V scans every subfolder of `Assets/DLC`). Then clear `cache/Civ5CoreDatabase.db`,
`cache/Civ5ModsDatabase.db`, `cache/Civ5DebugDatabase.db` and `cache/Localization-Merged.db` so the mod
database is rebuilt, and re-enable the four mods from the Mods menu.

Note that a DLC-mode VP bundle typically also carries **43 Civs CP, Squads, InGame Editor+ and Quick Turns**,
which the `MODS\` stack does not. Removing it loses those. The repo ships
`civ5-dll/(3b) 43 Civs Community Patch` if 43-civ support is wanted back.

**Retracted:** the two changes made during the first session — relocating `VoxDeorum_Options.sql`'s
statements into `Text/VoxDeorum_Text.sql`, and dropping `SQL/VoxDeorum_Options.sql` from `OnModActivated` —
were chasing a phantom and have been reverted to `upstream/main`. Do not re-apply them. Likewise, the
"table lock timing / transaction scope / merge engine" theories recorded in the first session were wrong,
**Verified fixed, end to end (2026-09-03).** After moving the DLC bundle out, clearing the four mod/merged
caches, and relaunching via `-Automation`: the bridge logged `Connected to DLL successfully`, then carried
live Lua round-trips returning the full player roster from the running game. `mcp-server` and `vox-agents`
came up on 4000 and 5555, a strategist session reached `state: running`, and `simple-strategist` completed
an agent execution that wrote `set-flavors` and `set-policy` back into the DLL. Zero auth errors anywhere.

*A caveat on how to verify.* The obvious check — reading `Logs/CustomMods.log` for `IPC_CHANNEL = 1` — is
unreliable: that file was **not written at all** on the successful run, though it had been on earlier failing
ones. Do not treat its absence as failure. The load-bearing check is the named pipe itself: `CvGame.cpp:1098`
calls `CvConnectionService::Setup()` only inside `if (MOD_IPC_CHANNEL)`, so **the pipe accepting traffic is
proof that the option is 1 and the v149 DLL is loaded.** `connection.log` / `connection-pipe.log` likewise
never appeared on the good run. Check `bridge-service/logs/combined.log` for `Connected to DLL successfully`
instead of hunting for game-side log files.

## Bug 2 (fixed, confirmed working): ~3 minute intro video plays on every launch

**Root cause:** [`scripts/install.cmd`](../../scripts/install.cmd) only copies its `configs/UserSettings.ini`
template (which sets `SkipIntroVideo = 1`) into the game's settings folder **if no file is already there**.
A machine with Civilization V installed before Vox Deorum already has a `UserSettings.ini` with
`SkipIntroVideo = 0`, so the template is silently skipped and the Firaxis/2K studio intro plays in full on
every single launch.

**Fix:** `install.cmd` now force-patches just that one key into whatever `UserSettings.ini` ends up in place
afterward, whether freshly copied or pre-existing, leaving every other setting alone. Confirmed working on
this machine after the fix.

## Closed: the leader-intro click was never a blocker

The previous session recorded Civ V's "Begin Your Journey" leader-introduction screen as a **hard blocker for
unattended runs**. It is not, and it never was — that conclusion was drawn from a session where nothing worked
because of Bug 1, so *every* symptom looked like a blocker.

On the verified run the bridge connected at 18:37:14 and the agent was making decisions minutes later,
with nobody clicking anything. Candidate direction #2 from the old list was right: `CvConnectionService`
comes up inside `CvGame::init()`, well before that screen matters to the pipe.

Nothing in the launch path needs simulated input. `-Automation` handles the whole sequence:
[`StartGame.template.lua`](../../vox-agents/scripts/StartGame.template.lua) enables the mods itself via
`Modding.EnableMod` + `Modding.ActivateEnabledMods`, then starts the game with `Automation.SetGameCoreInit`
and `Events.SerialEventStartGame(0)`. **Mods never need enabling by hand in the Mods menu** — a claim made
and then disproven during this session. Clearing `Civ5ModsDatabase.db` is safe for the same reason: the
automation re-enables from scratch every launch.

## How to actually watch a game, and see why the AI did what it did

Two config knobs, both in the [strategist session config](../developers/vox-agents/strategist.md):

**`production`** decides whether the game is watchable at all (see
[media.md](../developers/vox-agents/media.md)):

| Mode | Animations | View | OBS |
| --- | --- | --- | --- |
| `none` (default) | off | stays in strategic view for speed | no |
| `test` | on | normal view | no |
| `livestream` / `recording` | on | normal view | yes |

The default `none` is why a plain run looks like nothing is happening. **`production: "test"` is the
watch-it-on-screen mode.**

**`llmPlayers`** decides who the LLM drives. Two traps here:

1. **Every seat must be listed.** `computePlayerCount` is `Math.max(...playerIds) + 1`
   ([`strategist-session.ts:1012`](../../vox-agents/src/strategist/strategist-session.ts#L1012)), so a config
   of `{"1": {...}}` generates a **2-player game**, not an 8-player one with a single LLM civ. Seats the LLM
   should not drive get `"strategist": "none-strategist"` — a no-op agent whose `displayName` is literally
   "Vox Populi AI", i.e. the stock VP AI plays that civ normally.
2. In `wait` mode the count is not computed at all (the session binds to the running game), so a short config
   appears to work there and then silently misbehaves in `start` mode.

A ready-made config for "one LLM civ, seven VP AI civs, watchable" is written to
`vox-agents/configs/watch-one-llm.json` on this machine. Note that `vox-agents/.gitignore` excludes
`configs/**/*.json`, so session configs are local-only and this one will not travel with the repo —
reproduced here in full:

```json
{
  "name": "watch-one-llm",
  "type": "strategist",
  "autoPlay": true,
  "production": "test",
  "repetition": 1,
  "llmPlayers": {
    "0": { "strategist": "none-strategist" },
    "1": {
      "strategist": "simple-strategist",
      "pacing": { "everyTurns": 1, "interruption": "importantEvents" },
      "llms": { "default": "claude-code/sonnet" }
    },
    "2": { "strategist": "none-strategist" },
    "3": { "strategist": "none-strategist" },
    "4": { "strategist": "none-strategist" },
    "5": { "strategist": "none-strategist" },
    "6": { "strategist": "none-strategist" },
    "7": { "strategist": "none-strategist" }
  }
}
```

`pacing.everyTurns` is `1` so there is a decision to watch every turn; raise it (the shipped sample uses `5`)
to cut token spend. Start it from the dashboard's Session view, or `POST /api/session/start` with
`{"gameMode": "start", "config": { ... }}`.

**Seeing the reasoning** — the dashboard at `http://localhost:5555` is the surface
([ui.md](../developers/vox-agents/ui.md), [observability.md](../developers/vox-agents/observability.md)):

- **Telemetry** is the primary one. Every agent run is OpenTelemetry-traced into one SQLite DB per context
  (`telemetry/{folder}/{gameID}-player-{playerID}.db`). Each turn opens a `strategist.turn.{N}` span; step
  spans hold **the exact system prompt, messages, and model per step**, and `mcp-tool.{name}` child spans
  hold each tool's inputs and outputs. Watchable live while the game runs, not just afterward.
- **Logs** streams the Winston log over SSE, filterable by source and level.
- **Chat** opens a [telepathist](../developers/vox-agents/telepathist.md) against a finished telemetry DB and
  lets you *ask* why a turn went the way it did; `get-conversation-log` reconstructs the full exchange.
- The [oracle](../developers/vox-agents/oracle.md) replays a recorded turn with a modified prompt, for
  "would it have attacked if the briefing had said X?"

Two watch-mode gaps worth knowing:

- **The JFD AI Observer mod is not installed on this machine.** The generated automation script requests GUID
  `970aae10-1004-4c8a-af2d-8d601de5ec02` and Civ V prints `WARNING: AI Observer (JFD) not found!` and carries
  on. It is a third-party mod supplying observer overlays; the game is watchable without it.
- **Without a `human-strategist` seat the camera auto-switches** to whichever civ just acted. The pinning
  mechanism (`Game.SetObserverUIOverridePlayer`, see
  [`human-control/01-launcher.md`](../plans/human-control/01-launcher.md)) is currently wired only to the
  human-control path, so a pure spectator config cannot yet pin the view to the LLM's civ.

## Operational notes for driving this stack by hand

- **Service start order and ports:** `bridge-service` (5000) → `mcp-server` (4000) → `vox-agents` (5555).
  Run the built output directly — `node dist/index.js` in each — rather than `npm start`, which rebuilds first.
- **Launching the game without the wrapper.** [`launch-civ5.cmd`](../../vox-agents/scripts/launch-civ5.cmd)
  does four things: resolve Steam from the registry, `mkdir Assets/Automation`, copy the Lua script there, and
  run `CivilizationV.exe "-Automation <script>"`. Replicating those directly is fine and sometimes necessary —
  **Git Bash mangles `cmd /c` into `cmd C:\`**, which silently opens an interactive shell and exits 0. That
  looks exactly like success in a log. `MSYS_NO_PATHCONV=1` with `//c` does not fix it either.
- **`CivilizationV.exe` re-parents itself**, so the launching process exits almost immediately while the real
  game process appears seconds later under a different PID. Wait on the process name, not the launcher's exit.
- **`deploy.bat` requires Python** (for `update_md5.py`), which this machine does not have. Copying
  `civ5-mod/*` into `MODS\(1b) Vox Deorum\` by hand works, provided the modinfo MD5s already match.
- **Stale MD5s are normal.** Seven UI/Lua entries in `VoxDeorum.modinfo` do not match their files on
  `upstream/main` itself. Civ V does not enforce them for manually-installed mods. Do not chase these.
- **Graceful shutdown:** each service writes its shutdown URL to
  `%TEMP%\vox-deorum-{bridge,mcp,vox}-<pid>.shutdown`; `POST` to it. Stop the session first with
  `POST http://localhost:5555/api/session/stop`.

## Incidental findings, useful for future automation work

- **Each service exposes a graceful shutdown endpoint**, discoverable without prior knowledge: each of
  `bridge-service`, `mcp-server`, and `vox-agents` writes its shutdown URL to a per-run token file under
  `%TEMP%\vox-deorum-{bridge,mcp,vox}-<pid>.shutdown` on startup (see each service's own log for "Wrote
  shutdown URL to..."). `POST`ing to that URL cleanly stops the service. Useful when the console window
  that would normally handle `Q`/`K` is unavailable (frozen, or simply not present on a headless VM).
- **Civ V's own SQLite caches are directly queryable** for diagnosing mod/database issues, using this repo's
  own `better-sqlite3` dependency (no separate `sqlite3` CLI or Python needed) — see
  `%DOCUMENTS%\My Games\Sid Meier's Civilization 5\cache\*.db` and `Logs\*.log`
  **Correction:** an earlier version of this bullet claimed `connection.log` / `connection-pipe.log` confirm
  whether `CvConnectionService::Setup()` ran, by their mere existence. They do not — neither file appeared on
  the verified-working run of 2026-09-03. Use `bridge-service/logs/combined.log` instead.
- **The dashboard's Setup wizard is not the only way to start a game.** It's a thin layer over a JSON
  `StrategistSessionConfig` POSTed to vox-agents' HTTP API (see
  [`docs/developers/vox-agents/overview.md#models-and-configuration`](../developers/vox-agents/overview.md)).
  A training pipeline driving games at scale should script that API/config directly rather than the browser
  UI — this sidesteps the wizard's "Play the game yourself" default (see below) entirely. (This bullet used
  to also cite the leader-intro click as an obstacle; it is not one — see the section above.)
- **The wizard's default role is "Play the game yourself,"** not "Watch AI self-play" — it reserves one
  seat for a human player unless explicitly switched. Easy to miss on a first pass, and was the first (wrong)
  theory investigated for the "AI civ asks for my input" symptom before the real bridge bug was found.
