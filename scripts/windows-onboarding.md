# Windows Setup Instructions for Claude Code

Paste this whole file as your first message to a new Claude Code session in VSCode on
this Windows machine.

## Context

- User: Justin Vasquez, GitHub username `justvasq`, email `justvasq19@gmail.com`.
- This Windows machine (Lenovo Legion, RTX card) is a **build-and-play target, not a
  writing environment**. All code is written on a separate MacBook Pro. This machine
  exists to: pull code the user already pushed from the Mac, build it, and run the
  real game against it, so the user can playtest work in progress. Never edit source
  files here unless the user explicitly asks; this session's job is pulling,
  building, and launching.
- A GitHub fork already exists at `https://github.com/justvasq/vox-deorum`, forked
  from the canonical `https://github.com/vox-deorum/vox-deorum`. Clone the fork, not
  upstream, and not `https://github.com/CIVITAS-John/vox-deorum` (an old upstream
  URL that appears in `scripts/bootstrap.cmd`; ignore that script entirely, it's for
  bootstrapping a tagged release from nothing, not for this workflow).
- Vox Deorum is Civilization V with AI-controlled civilizations driven by an LLM,
  built on Community Patch + Vox Populi. **The DLL is not built from source here and
  is not pulled via Git LFS.** `scripts\download-dll.cmd` fetches a prebuilt DLL and
  its `.pdb` from a GitHub release of `CIVITAS-John/vox-populi`, pinned by tag and
  commit in `scripts\dll-release-info.txt` (currently VP `5.2.7`, commit `adb9065`,
  matching the `civ5-dll` submodule's pinned commit). This also answers a version
  question from earlier: whatever Vox Populi build is already on this machine is
  very likely not `5.2.7`, and the install step below replaces it either way, so
  don't spend time checking the existing version first. Nothing here requires the
  C++ toolchain unless the user explicitly asks to modify the C++ gamecore.
- The `civ5-dll` submodule is still required even though the DLL binary itself is
  downloaded rather than compiled: the submodule checkout also contains the actual
  Vox Populi mod source folders (`civ5-dll\(1) Community Patch`,
  `civ5-dll\(2) Vox Populi`, `civ5-dll\(3a) VP - EUI Compatibility Files`, plus
  `civ5-dll\VPUI` and `civ5-dll\UI_bc1`) that `scripts\install.cmd` copies into the
  game's MODS and DLC folders. Skipping `--recursive` on the clone leaves nothing
  for that step to copy.

## Step 1: Confirm what's already installed

```powershell
git --version
node -v
npm -v
gh --version
git lfs version
```

Report what's missing before installing anything.

## Step 2: Install missing tooling

Prefer `winget` unless the user has Chocolatey or Scoop already, in which case ask.

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id GitHub.cli -e
```

Notes:
- Install the **LTS** Node package (currently the 22.x line), not "Current."
  A newer Node (24+) fails to build this repo's native `better-sqlite3` dependency;
  this was confirmed already on the Mac side of this project.
- Python is not needed for this workflow (only for building the DLL from source,
  which this machine won't do).
- Open a **new** terminal after installing so PATH updates apply.

```powershell
git lfs install
```

## Step 3: Authenticate GitHub CLI

Needs the user interactively:

```powershell
gh auth login
```

Choose: GitHub.com -> HTTPS -> Login with a web browser. Confirm with
`gh auth status` before continuing.

## Step 4: Clone the fork

Ask where to check it out if not obvious (e.g. `C:\dev\vox-deorum`), then:

```powershell
git clone --recursive https://github.com/justvasq/vox-deorum.git
cd vox-deorum
git remote add upstream https://github.com/vox-deorum/vox-deorum.git
git remote set-url upstream --push no_push
git config user.email "justvasq19@gmail.com"
git config user.name "justvasq"
```

`--recursive` also clones the `civ5-dll` submodule (over 1 GB, full Community Patch
history). It can take several minutes and may need a retry if the connection drops:

```powershell
git submodule update --init --recursive
```

## Step 5: First-time install

Run the repo's own first-run script rather than improvising the steps by hand. From
the repo root, in a terminal with Administrator rights if possible (it can fall back
to a portable Node install without them, but prefers a real one):

```powershell
scripts\install.cmd
```

In order, it: downloads the pinned prebuilt DLL via `download-dll.cmd`; installs
Steam if missing and locates the Civ V install; copies the Community Patch, Vox
Populi, Vox Deorum, and EUI compatibility mod folders (from the `civ5-dll`
submodule and `civ5-mod`) into the game's `MODS` directory, always overwriting
whatever was already installed there; copies the VPUI and UI_bc1 UI mods into the
game's DLC folder; installs Node 22 if it's somehow still missing; runs `npm
install` from the repo root; builds `mcp-server` specifically; and creates
`vox-agents/.env` from `.env.default` if it doesn't already exist, opening it in
Notepad when freshly created so a provider key can be added right away.

It does **not** build `bridge-service` or `vox-agents`, and it does not touch
`vox-agents/ui`. Finish the rest by hand:

```powershell
cd vox-agents\ui
npm install
cd ..\..
npm run build:all
```

## Step 6: Configure a provider

Edit `vox-agents/.env` (created in Step 5) and set credentials for whichever LLM
provider the user wants. If they're signed into the Claude Code app on this machine,
Claude Code needs no key. Otherwise add an API key for the chosen provider. See
`docs/players/configuration.md` in the repo for the full list.

Also check `vox-agents/configs/` for a starter player/strategist config to copy, per
`docs/developers/setup.md`.

## Step 7: Launch and play

```powershell
scripts\vox-deorum.cmd
```

This brings up the bridge, MCP server, and vox-agents in order, then launches Civ V
with the mods enabled. Press Q (or K, which also kills the game) to stop, following
the confirmation prompt.

Each service is launched with its own `start` (build-then-run) or `start:dist`
(run the existing build) script, chosen by whether that service's `src/index.ts`
is present, not by whether a build already exists. Since this is a source checkout,
`src/` is always present, so all three run `npm run start`, which builds fresh on
every launch before running. That means a stale `npm run build:all` never gets
silently launched here, but it also means launch is slower than a pure "run" would
be; that's expected, not a bug.

## The ongoing loop: pulling updates from the Mac

This is the routine every time the user has pushed new work from the MacBook and
wants to try it here. **Do NOT use `scripts\manual-update.cmd` for this.** It runs,
in order: `cleanup-data.cmd` (permanently deletes every recorded game database
under `mcp-server/data` and all agent telemetry under `vox-agents/telemetry`, since
a fresh machine won't have the `recycle` tool that would otherwise send them to the
Recycle Bin instead), `cleanup-logs.cmd`, `git checkout main --force` (**discards
any uncommitted local state** and force-switches to `main`), `git pull`,
`git submodule update`, then `install.cmd`. Any one of those alone could be what
the user wants some day, but running all of them together as the routine pull step
would silently erase session recordings and telemetry on every sync. Use the plain
sequence below instead:

```powershell
cd vox-deorum
git checkout main
git pull origin main
git submodule update --init --recursive
npm install --include=dev
```

Then launch as in Step 7 (`scripts\vox-deorum.cmd`). A separate `npm run build:all`
isn't needed in this loop: launching runs each service's `start` script, which
builds that service fresh before running it (see Step 7's note on `start` vs
`start:dist`). Only run `build:all` by hand if the user wants to check the build
succeeds without launching the game, e.g. right after pulling and before playing.

If a branch other than `main` is involved (the user is testing a feature branch
rather than `main`), swap `git checkout main` / `git pull origin main` for the
branch name they specify.

Re-run `scripts\install.cmd` (Step 5) again, instead of just the sequence above,
whenever any of these changed since the last pull:

- Anything under `civ5-mod/` (the Lua/SQL/XML mod), since that's what gets copied
  into the game's MODS folder.
- `scripts/dll-release-info.txt` or the `civ5-dll` submodule's pinned commit, since
  that's what determines which prebuilt DLL gets downloaded.
- Anything that would change what `.env.default` provides as a template.

For changes confined to `bridge-service`, `mcp-server`, or `vox-agents` source, the
plain pull-and-build sequence above is enough; `install.cmd` would just redundantly
redownload the DLL and re-copy unchanged mod folders.

## If something needs troubleshooting

Check `docs/developers/operations.md` (log locations under each service's `logs/`
folder, debugger attach ports) and `docs/players/troubleshooting.md` in the repo
before improvising a fix.

## If asked to actually write code here

Stop and confirm first. The user's intent is Mac-only development; this machine is
for pulling, building, and playing. If they've genuinely changed their mind for a
specific reason, proceed, but don't assume it.
