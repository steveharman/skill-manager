# skill-manager (`skm`)

A command-line manager for [Claude Code skills](https://code.claude.com/docs/en/skills). It lists,
installs, enables/disables, updates, moves, scaffolds and checks skills in user and project scope,
shows the read-only skills that come from plugins and from your claude.ai account, and switches
installed plugins on and off.

```text
$ skm list
NAME        SCOPE     STATUS    SOURCE                               DESCRIPTION
pdf         user      enabled   github:anthropics/skills/skills/pdf  Use this skill whenever the user wants to…
route       user      enabled   symlink                              Route a task to the right Claude model…
deploy      ~/myapp   disabled  local                                Deploy the app to staging…

3 skills · 2 enabled · 1 disabled
user    ~/.claude/skills
project ./.claude/skills
+ 12 claude.ai skills not shown (run "skm list --claude-ai").
```

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Reading the tables: SCOPE and STATUS](#reading-the-tables-scope-and-status)
- [Scopes and project detection](#scopes-and-project-detection)
- [Command reference](#command-reference)
- [How enabling and disabling works](#how-enabling-and-disabling-works)
- [Precedence: which copy Claude Code uses](#precedence-which-copy-claude-code-uses)
- [Install sources](#install-sources)
- [Updating and local edits](#updating-and-local-edits)
- [Trash and restore](#trash-and-restore)
- [What `doctor` checks](#what-doctor-checks)
- [JSON output](#json-output)
- [Interactive menu](#interactive-menu)
- [Scripts, CI and environment variables](#scripts-ci-and-environment-variables)
- [Files and paths](#files-and-paths)
- [Caveats and limitations](#caveats-and-limitations)
- [Development](#development)

## Install

Requires Node.js 20 or newer, and `git` for git/GitHub sources.

```sh
git clone https://github.com/steveharman/skill-manager.git   # private repo
cd skill-manager
npm install          # dependencies
npm link             # puts `skm` and `skill-manager` on your PATH
# or: npm i -g .
```

Both `npm link` and `npm i -g .` link the global command to this checkout, so a `git pull` takes
effect straight away. Try it without installing: `node bin/skm.js list`.

**The link is per Node version.** It lives in the global prefix of the Node that ran it. After you
switch or upgrade Node (nvm, fnm, Volta, Homebrew), run `npm link` again in the checkout if `skm` is
no longer found.

Uninstall: `npm unlink -g skill-manager` (or `npm rm -g skill-manager`).

## Quick start

```sh
skm                                   # interactive menu (in a terminal)
skm list                              # your skills, user + project scope
skm list --plugins --claude-ai        # also plugin skills and claude.ai skills
skm install anthropics/skills         # pick skills from a multi-skill repo
skm disable noisy-skill               # hide it from Claude Code, keep the files
skm enable noisy-skill
skm plugin list                       # every installed plugin and what turns it on or off
skm plugin disable superpowers@claude-plugins-official
skm doctor                            # find problems
```

Every command has `--help` with examples, e.g. `skm install --help`, `skm plugin disable --help`.

## Reading the tables: SCOPE and STATUS

**SCOPE says where something is installed.** **STATUS only says whether it is on.**

| SCOPE shows | Meaning |
| --- | --- |
| `user` | `~/.claude/skills/` (or a user-scope plugin) |
| a path, e.g. `~/myapp` | project scope: that project's `.claude/skills/`. Long paths keep their tail: `…/infra/health-worker` |
| `~/other (local)` | a plugin installed with `local` scope for that project |
| `claude.ai` | synced from your claude.ai account (skills, or plugins named `<name>@synced`) |

| STATUS | Meaning |
| --- | --- |
| `enabled` | Claude Code loads it |
| `disabled` | in `skills-disabled/`, so Claude Code doesn't see it |
| `off (settings)` | on disk, but `skillOverrides` in a settings file hides it |
| `shadowed` | a user skill with the same name wins (project skills only) |
| `disabled (plugin off)` | a plugin skill whose plugin is off in `enabledPlugins` |
| `disabled (sync off)` | a claude.ai skill, but `"syncClaudeAiSkills": false` stops them loading |
| `not a skill` / `broken link` | a folder without `SKILL.md`, or a dangling symlink (only with `--all`) |

**Dimmed rows** exist on disk but don't load where you run `skm`: plugins installed for another
project, and claude.ai skills or plugins synced for another claude.ai account. A legend line under
the table says which (`other-project rows: …` / `other-account rows: …` when colour is off).

The SOURCE column shows where a skill came from: `github:owner/repo/path`, a git URL,
`archive:<file>`, `local`, `created` (made with `skm new`), `symlink`, `—` (unknown), the plugin id
for plugin skills, or the first 8 characters of the claude.ai org id for synced skills.

```text
$ skm plugin list
PLUGIN                               SCOPE                         STATUS    SKILLS  VERSION  DECIDED BY
caveman@caveman                      user                          enabled   5       84cc3c1  ~/.claude/settings.json: true
cloudflare@cloudflare                ~/pikkos/infra/health-worker  enabled   8       1.0.0    default (defaultEnabled: true)
revenuecat@claude-plugins-official   ~/carememo                    enabled   18      2.2.1    ~/carememo/.claude/settings.json: true
superpowers@claude-plugins-official  user                          disabled  15      6.4.1    ~/.claude/settings.json: false
token-optimizer-cowork@synced        claude.ai                     enabled   5       0006     default (defaultEnabled: true; …)

5 plugins · 2 enabled · 1 disabled · 2 installed for other projects
dimmed: installed for another project — loads only when Claude Code runs there
Change with "skm plugin enable|disable <name>" (writes enabledPlugins; -p project, --local this machine only).
```

## Scopes and project detection

| Scope | Skills folder | Disabled skills | Install records |
| --- | --- | --- | --- |
| user | `~/.claude/skills/` | `~/.claude/skills-disabled/` | `~/.claude/skill-manager.json` |
| project | `<project>/.claude/skills/` | `<project>/.claude/skills-disabled/` | `<project>/.claude/skill-manager.json` |
| plugin | `<plugin>/skills/…` (read-only) | whole plugin only: `skm plugin disable` | `enabledPlugins` in settings |
| claude.ai | `~/.claude/skills/synced/<account>/…` (read-only) | on claude.ai only | managed by Claude Code |

- `~/.claude` honours `$HOME` and `CLAUDE_CONFIG_DIR`.
- **The project** is the nearest parent folder (from the current directory) containing `.claude/`
  or `.git`. Your home folder never counts as a project, even though it contains `~/.claude`.
- `--project-dir <path>` uses another folder as the project, and on its own also selects project
  scope. `--project=<path>` is shorthand for `--project --project-dir <path>`. For both scopes with
  another project, pass `-g -p --project-dir <path>`. (On `plugin` commands and `trash`/`restore`,
  `--project-dir` only sets the project root.)
- `-g` / `--user` and `-p` / `--project` pick a scope. Without them, read commands (`list`,
  `search`, `doctor`) cover both. Commands that change a skill act on whichever scope has it; if
  both do, `skm` asks in a terminal, or tells you to add `--user` or `--project`.
- `install` and `new` default to **user** scope. Inside a project, in a terminal, they ask first
  (user is preselected).

## Command reference

Global options: `-v, --version`, `-h, --help`, `--no-input` (never prompt; same as
`SKM_NO_INPUT=1`). Running `skm` with no arguments opens the [menu](#interactive-menu) in a
terminal, or prints help otherwise.

Scope options, accepted by every skill command below unless noted: `-g, --user`, `-p, --project`,
`--project-dir <path>` (and `--project=<path>`). `-n, --dry-run` is available on every command that
changes files: it prints each step and writes nothing.

| Command (aliases) | Purpose |
| --- | --- |
| [`list`](#skm-list) (`ls`) | Table of skills |
| [`info <name>`](#skm-info) | Everything about one skill |
| [`search <term>`](#skm-search) (`find`) | Search names and descriptions |
| [`install <source>`](#skm-install) (`add`) | Install from a folder, file, archive, git or GitHub |
| [`uninstall <name...>`](#skm-uninstall) (`rm`) | Move skills to the trash |
| [`enable` / `disable [name...]`](#skm-enable--skm-disable) | Turn skills on or off |
| [`update [name...]`](#skm-update) (`up`) | Re-fetch from the recorded source |
| [`new [name]`](#skm-new) (`create`) | Scaffold a `SKILL.md` |
| [`move` / `copy <name>`](#skm-move--skm-copy) (`mv` / `cp`) | Between user and project scope |
| [`doctor [path]`](#skm-doctor) (`validate`) | Check for problems |
| [`trash`](#skm-trash--skm-restore) / [`restore <name>`](#skm-trash--skm-restore) | See, restore or purge removed skills |
| [`plugin list`](#skm-plugin) (`plugins`, `plugin ls`) | Installed plugins and what decides each |
| [`plugin enable` / `disable [name...]`](#skm-plugin) | Turn whole plugins on or off |

### `skm list`

| Option | Effect |
| --- | --- |
| `--plugins` | add skills of plugins that load here (read-only) |
| `--claude-ai` | add skills synced for the signed-in claude.ai account (read-only; left out with `--project` alone) |
| `-a, --all` | add every plugin skill (also disabled plugins and other projects' installs), every claude.ai skill (also other accounts') and folders that aren't skills |
| `--enabled` / `--disabled` | only skills in that state (never non-skill folders) |
| `--json` | [machine-readable](#json-output) |

Without `--plugins` / `--claude-ai`, the footer says how many were left out, e.g.
`+ 23 plugin skills not shown (run "skm list --plugins").` With `--plugins`, skills of plugins that
are off or installed for other projects stay hidden and are counted
(`+ 42 skills from 4 disabled plugins hidden (use --all)`).

**Bare-flag shorthand:** `list` flags with no command mean `skm list`. `skm --plugins` is
`skm list --plugins`; `skm --json -g` is `skm list --json -g`. This works for `--json`, `--plugins`,
`--claude-ai`, `-a/--all`, `--enabled`, `--disabled`, `-g/--user`, `-p/--project`,
`--project-dir <path>` (and `--no-input`).

```sh
skm list
skm ls --user
skm list --project --json
skm list --plugins
skm list --claude-ai
skm list --all
skm --disabled
```

### `skm info`

`skm info <name> [--json] [--all-files]`: frontmatter, path, symlink target, files (first 25 unless
`--all-files`), size, install source, ref, commit and dates, any `skillOverrides` value and
shadowing. Also works read-only for plugin skills (`skm info superpowers:brainstorming`) and
claude.ai skills (`skm info anthropic-skills:pdf`, or `skm info pdf` when no user or project skill
has that name). When a name matches in both scopes, it asks in a terminal and shows all matches
otherwise.

```sh
skm info route
skm info my-skill --project --json
```

### `skm search`

`skm search <term> [--json] [--no-plugins]` searches names and descriptions (name matches first).
Without a scope flag it covers user and project skills, every installed plugin's skills (unless
`--no-plugins`) and claude.ai skills (other accounts' marked as such). `--user` covers user and
claude.ai skills; `--project` only project skills.

```sh
skm search pdf
skm find deploy --project
```

### `skm install`

`skm install <source>` with `-a, --all`, `-s, --skill <name...>`, `--name <name>`, `--ref <ref>`,
`-f, --force`, `-n, --dry-run` and the scope options. See [Install sources](#install-sources).

```sh
skm install ./my-skill
skm install anthropics/skills --skill pdf
skm install ./some-repo --all --force --dry-run
```

### `skm uninstall`

`skm uninstall <name...> [-y]` lists what it will remove, asks (or needs `-y, --yes` in scripts),
then moves each skill to the [trash](#trash-and-restore) and drops its install record. Nothing is
hard-deleted.

```sh
skm rm old-skill
skm uninstall a b c -y
```

### `skm enable` / `skm disable`

`skm enable|disable [name...]` moves skills between `skills/` and `skills-disabled/`
([details](#skills)). Leave out the names to pick from a list in a terminal. `enable` warns when
`skillOverrides` still hides the skill. Plugin and claude.ai skills are refused with an explanation.

```sh
skm disable noisy-skill
skm enable a b --project
skm disable deploy --project --dry-run
```

### `skm update`

`skm update [name...] [-f, --force]` re-fetches skills from where they were installed. With no
names it goes through every skill in scope and skips those without a recorded source. See
[Updating and local edits](#updating-and-local-edits).

```sh
skm update
skm update pdf
skm update --project --dry-run
```

### `skm new`

`skm new [name]` creates `<scope>/skills/<name>/SKILL.md` from a template (frontmatter plus *When
to use*, *Instructions* and *Examples* sections) and records it as `created`.

| Option | Effect |
| --- | --- |
| `-d, --description <text>` | the description (asked for in a terminal; otherwise a TODO placeholder) |
| `-e, --edit` | open it in `$VISUAL` / `$EDITOR` afterwards (in a terminal it offers this anyway when an editor is set) |
| `--no-edit` | don't offer to open an editor |

Names must be lowercase-kebab-case, at most 64 characters, and not reserved (`synced`,
`anthropic-skills…`).

```sh
skm new release-notes
skm new review-pr -d "Use when reviewing a pull request" --project -e
```

### `skm move` / `skm copy`

`skm move|copy <name> --to user|project [--from user|project] [-f, --force]` moves or copies a
skill between scopes, keeping its enabled/disabled state and install record. `--from` picks the
source when both scopes have the name. At the destination, an existing copy is skipped unless you
choose overwrite (terminal) or pass `--force`; an overwritten copy goes to the trash. Without
`--to`, a terminal session moves to the other scope; scripts must pass `--to`.

```sh
skm move my-skill --to project
skm copy my-skill --to user --from project
```

### `skm doctor`

`skm doctor [path] [--json] [-V, --verbose]` checks installed user and project skills, or with a
path, one skill folder or `SKILL.md` before you install it. `--verbose` also shows passing skills
and informational notes. Exits with code 1 when it finds an error, so it works in CI. See
[What `doctor` checks](#what-doctor-checks).

```sh
skm doctor
skm doctor --project
skm validate ./my-new-skill
skm doctor --json
```

### `skm trash` / `skm restore`

`skm trash [--json]` lists removed and replaced skills. `skm trash --empty [-y] [-n]` deletes them
for good (asks first, or needs `-y`). `skm restore <name> [--to user|project] [-n]` puts the newest
trash entry with that name (or trash id) back. See [Trash and restore](#trash-and-restore).

```sh
skm trash
skm restore old-skill
skm trash --empty -y
```

### `skm plugin`

| Command | Options |
| --- | --- |
| `skm plugin list` (also `skm plugin`, `skm plugins`, `skm plugin ls`) | `--json`, `--project-dir <path>` (evaluate for another project) |
| `skm plugin enable [name...]` / `skm plugin disable [name...]` | `-g, --user` (default: `~/.claude/settings.json`), `-p, --project` (`<project>/.claude/settings.json`, shared with the repo), `--local` (`<project>/.claude/settings.local.json`, this machine only), `--project-dir <path>`, `-n, --dry-run` |

`plugin list` shows one row per install record: `name@marketplace`, SCOPE, STATUS, number of
skills, version, and DECIDED BY (the settings file and value that decided it, or the default).
`enable`/`disable` take a plugin name or `name@marketplace` (or pick from a list in a terminal);
an id that only appears in a settings file is accepted too. See [Plugins](#plugins).

```sh
skm plugin list
skm plugins --json
skm plugin disable superpowers@claude-plugins-official
skm plugin disable caveman --local
skm plugin enable superpowers --dry-run
```

## How enabling and disabling works

### Skills

Claude Code loads skills only from `…/skills/<name>/SKILL.md`. `skm disable` moves the skill folder
into the sibling `skills-disabled/` folder, which Claude Code never reads, so the skill disappears
from Claude entirely; `skm enable` moves it back. Claude Code watches the skills folders, so no
restart is needed. If a folder of the same name already exists at the destination, `skm` stops
and tells you.

Claude Code also has its own switch: `skillOverrides` in a settings file
(`{"skillOverrides": {"deploy": "off"}}`, or Space in the `/skills` menu) hides a skill without
moving files. `skm` never writes it, but reads it from user `settings.json`, project
`.claude/settings.json` and `.claude/settings.local.json` (later wins): such skills show as
`off (settings)`, `doctor --verbose` notes them and `skm enable` warns about them.

For skills committed to a **shared project repo**, prefer `skillOverrides` in
`.claude/settings.local.json`: with `skm disable`, git sees the move as a deletion you could commit
by accident. Alternatively add `.claude/skills-disabled/` to `.gitignore`.

### Plugins

Claude Code decides whether a plugin is on from `enabledPlugins` (`{"name@marketplace": true|false}`)
in its settings files, not from `installed_plugins.json`. `skm` resolves it the same way:

- **Precedence, lowest first:** user `~/.claude/settings.json` → project `.claude/settings.json` →
  local `.claude/settings.local.json` → managed settings. For each plugin id, the highest file that
  mentions it wins. Outside a project only user and managed settings apply.
- **Managed settings win outright**: managed `true` forces a plugin on and `false` blocks it.
  `skm plugin enable/disable` refuses to change such a plugin. Managed settings are read from
  `managed-settings.json` and `managed-settings.d/*.json` (alphabetical, later wins) in
  `/Library/Application Support/ClaudeCode/` (macOS), `/etc/claude-code/` (Linux) or
  `C:\Program Files\ClaudeCode\` (Windows).
- **No entry anywhere:** the plugin's `defaultEnabled` applies (the marketplace entry's value over
  `plugin.json`'s), which defaults to **on**.
- **Plugins installed for another project** (install scope `project`/`local` with a different
  project path) are dimmed, with that project's path in SCOPE. Their STATUS is what Claude Code
  would decide when it runs in *that* project (user → its `settings.json` → its
  `settings.local.json` → managed), DECIDED BY names that file, and `--json` has
  `loadsHere: false`.
- **Plugins synced from claude.ai** appear as `<name>@synced` with SCOPE `claude.ai`. They load
  only from the signed-in account's sync folder (others are dimmed, `otherAccount: true` in JSON);
  `"syncClaudeAiPlugins": false` in user, local or managed settings turns them all off; and an
  enabled plugin of the same name from a marketplace takes precedence over the synced copy.
- Two marketplaces shipping the same plugin name are two plugins. `skm plugin disable <name>` asks
  which in a terminal and needs `name@marketplace` in scripts.

**How `skm plugin enable/disable` writes settings:** it changes only `enabledPlugins[id]`, keeps
every other key and their order, writes with the file's existing indent (2 spaces for a new file)
and a trailing newline, keeps the file mode, writes through a symlinked `settings.json`, and
refuses to touch a file that isn't a valid JSON object. It first copies the old file to
`~/.claude/skill-manager/backups/<timestamp>__<target>__<file>`, then writes a temp file and renames
it into place (atomic). If a higher-precedence file still decides the other way, `skm` says so and
suggests `--local`. It never touches `installed_plugins.json` or the plugin cache. Running Claude
Code sessions pick the change up after `/reload-plugins` or a restart.

### Plugin skills

Plugin skills are read-only and named `plugin:skill`. **They can't be switched one by one**:
Claude Code's `skillOverrides` doesn't apply to plugin skills, so `skm enable/disable plugin:skill`
explains this and points at `skm plugin enable|disable <plugin>`. In `skm list --plugins`, a
plugin skill's SCOPE is where its plugin is installed and STATUS is `enabled` or
`disabled (plugin off)`. `skm` finds a plugin's skills in its `skills/` folder, in paths listed
under `skills` in `plugin.json`, or a lone `SKILL.md` at the plugin root.

### Skills synced from claude.ai

Claude Code downloads the skills enabled for your claude.ai account (your own, your
organization's, and Anthropic's such as `pdf` and `xlsx`) into `~/.claude/skills/synced/` and runs
each as `/anthropic-skills:<name>` (also as `/<name>` when nothing else uses that name).

```text
$ skm list --claude-ai
NAME                            SCOPE      STATUS   SOURCE    DESCRIPTION
route                           user       enabled  symlink   Route a task to the right Claude model…
anthropic-skills:deep-research  claude.ai  enabled  3d0a8465  Use this skill when the user's prompt…
anthropic-skills:pdf            claude.ai  enabled  3d0a8465  Use this skill whenever the user wants…

1 skill · 1 enabled
user    ~/.claude/skills
2 claude.ai skills (signed-in account 3d0a8465) · read-only: change them on claude.ai
+ 9 claude.ai skills synced for 1 other claude.ai account hidden (use --all)
```

- **Hidden by default**, like plugin skills: `--claude-ai` or `--all` shows them. `search` and
  `info` always cover them.
- **Active account detection.** The sync keeps one folder per claude.ai organization/account
  (`<org-uuid>_<account-uuid>`), each with a `manifest.json` and the skill folders. The signed-in
  account is read from `oauthAccount` (`organizationUuid`, `accountUuid`) in `~/.claude.json` (with
  `CLAUDE_CONFIG_DIR`: `$CLAUDE_CONFIG_DIR/.claude.json` first). Skills synced for other accounts
  don't load, so they're hidden unless `--all`, then dimmed. If `skm` can't tell who is signed in
  (API-key sign-in, no config file), it treats every folder as live. SOURCE shows the first 8
  characters of the org id (plus the account's when two folders share an org).
- **Names and descriptions** come from `manifest.json`, falling back to the `SKILL.md`
  frontmatter. Everything on disk is on for its account (turning a skill off on claude.ai removes it
  at the next sync), so STATUS is `enabled`, or `disabled (sync off)` when
  `"syncClaudeAiSkills": false` in user, local or managed settings stops Claude Code loading them.
- **Read-only.** `disable`, `enable`, `uninstall`, `update`, `move` and `copy` on a synced skill exit
  with an explanation and change nothing: turn it off in your skills settings on claude.ai (or
  **Customize** in the Claude desktop app), or set `"syncClaudeAiSkills": false` to stop loading all
  of them. Local edits under `skills/synced/` are overwritten by the next sync. `skm` doesn't write
  `skillOverrides` for them (the Claude Code docs only describe it for personal, project and bundled
  skills), and `doctor` doesn't check them.

## Precedence: which copy Claude Code uses

- **User skills beat project skills.** When a name exists in both `~/.claude/skills/` and the
  project's `.claude/skills/` (compared case-insensitively), Claude Code runs the user one
  (enterprise > personal > project). `skm list` marks the project copy `shadowed`, `doctor` warns,
  and `install` (either scope) and `move`/`copy` into project scope warn when they create such a
  pair.
- **The command name comes from the frontmatter.** If `name:` differs from the folder name, the
  command is `/name`; `doctor` flags the mismatch. `skm install --name x` renames both the folder and
  the frontmatter `name:`.
- **Plugin skills** are namespaced (`/plugin:skill`), so they don't clash with yours.
- **claude.ai skills** always answer to `/anthropic-skills:<name>`; the short `/<name>` only when
  nothing else uses it.
- **Plugins:** user < project < local < managed settings, then `defaultEnabled` (see
  [Plugins](#plugins)).

## Install sources

```sh
skm install ./my-skill                                   # folder containing SKILL.md
skm install ./some-repo                                  # folder containing many skills → picker
skm install ~/Downloads/SKILL.md --name my-skill         # single file
skm install ~/Downloads/pdf.skill                        # .skill / .zip archive (local or https URL)
skm install anthropics/skills                            # GitHub owner/repo → picker
skm install anthropics/skills/skills/pdf                 # GitHub owner/repo/path
skm install github:anthropics/skills#skills/pdf          # same, with the path as a fragment
skm install https://github.com/anthropics/skills/tree/main/skills/pdf
skm install https://github.com/anthropics/skills.git#skills/pdf --ref main
skm install git@github.com:you/private-skills.git#skills/foo --ref v2   # placeholder: your repo
```

- **Local paths win**: `owner/repo` means GitHub only when no such folder exists. `~` is expanded.
- **GitHub tree/blob URLs**: the branch or tag is worked out from the remote (branch names may
  contain `/`); a blob URL to a `.md` file installs its folder. `--ref` overrides the URL's ref.
- **Any git URL** (`https://`, `ssh://`, `git://`, `file://`, `user@host:path`, or ending in `.git`)
  takes an optional `#sub/path`. `--ref` accepts a branch, tag or commit SHA. Clones are shallow.
- **Archives**: `.zip` or `.skill`, local or an `https://` URL; unsafe paths inside (zip-slip) are
  rejected.
- **Several skills in one source**: a multi-select picker in a terminal. In scripts, pass `--all`
  or `--skill <name>` (repeat it or use commas). Discovery skips `.git`, `node_modules`, `dist`,
  `build`, virtualenvs and `__MACOSX`, and doesn't look inside a skill folder.
- **Checked before anything is copied**: a `SKILL.md` must exist (any case), its YAML frontmatter
  must parse, and its name must be usable. A skill with an error is not installed. Warnings (such as
  a missing description) are shown but don't block.
- **Name already taken** in the target scope: in a terminal you choose overwrite or skip. In scripts
  it is skipped unless `--force`. An overwritten copy goes to the trash.
- **What gets copied**: `.git/`, `node_modules/` and `.DS_Store` are skipped; symlinks are replaced
  by the files they point to, so the installed copy stands alone. The copy is built in a staging
  folder next to `skills/` and moved into place in one step, so Claude Code never sees a half-copied
  skill.
- **Private repos**: `skm` runs git with prompts off (`GIT_TERMINAL_PROMPT=0`), so an HTTPS
  password prompt can't hang it. Use an SSH URL.

The source, ref, sub-path, commit and a content hash are recorded in the scope's
`skill-manager.json` for `update`.

## Updating and local edits

`skm update` re-fetches each skill from its recorded source (the same folder, archive, or repo +
ref), finds it again by its recorded sub-path or by name, and compares content hashes:

- identical: reported as up to date;
- **edited locally** (the files no longer match the hash recorded at install): skipped with a
  warning, unless you confirm in a terminal or pass `--force`;
- the new version has an invalid `SKILL.md`: the current copy is kept;
- otherwise replaced; the old copy goes to the trash. A disabled skill stays disabled, and an
  `install --name` rename is re-applied.

Skills made with `skm new` or copied in by hand have no source and are skipped. `update` exits
with code 1 if any skill failed.

## Trash and restore

`uninstall`, and any overwrite by `install`, `update`, `move` or `copy`, moves the old folder to
`~/.claude/skill-manager/trash/<timestamp>__<scope>__<name>/` (a `skill/` folder plus `meta.json`
with the original scope, path, status, project root and install record). The trash is shared by all
projects.

`skm restore <name>` restores the newest matching entry to its original scope and status with its
install record. A project skill restores only from inside its original project, unless you pass
`--to user|project`. It refuses if the name already exists there. `skm trash --empty` deletes
everything in the trash permanently.

## What `doctor` checks

Errors make `doctor` exit with code 1. `info` notes only appear with `--verbose`.

| Level | Code | Check |
| --- | --- | --- |
| error | `no-skill-md` | folder has no `SKILL.md` (path checks) |
| error | `bad-frontmatter` | frontmatter never closed, invalid YAML, or not a mapping |
| error | `no-frontmatter` | `SKILL.md` doesn't start with `---` frontmatter |
| error | `bad-name` / `bad-description` | `name` / `description` not a string; name contains `/` or starts with `.` |
| error | `reserved-name` | name or folder is `synced` or `anthropic-skills…` |
| error | `broken-link` | symlinked skill points to a missing folder |
| warn | `filename-case` | file is e.g. `skill.md`; case-sensitive systems won't find it |
| warn | `missing-name` | no `name` (Claude Code uses the folder name) |
| warn | `name-format` | not lowercase-kebab-case, or over 64 characters |
| warn | `name-mismatch` | `name` differs from the folder name |
| warn | `missing-description` | no `description` |
| warn | `long-description` | description over 1024 characters (Agent Skills / Claude API limit) |
| warn | `listing-truncated` | `description` + `when_to_use` over 1536 characters (Claude Code cuts it off) |
| warn | `empty-body` | no instructions after the frontmatter |
| warn | `shadowed` | a user skill with the same name wins over this project skill |
| warn | `duplicate-in-scope` | two enabled skills in one scope share a name |
| warn | `enabled-and-disabled` | the same folder exists in both `skills/` and `skills-disabled/` |
| info | `override-off` | hidden by `skillOverrides` |
| info | `shadows-project` | this user skill shadows a project skill |
| info | `stale-record` | `skill-manager.json` has a record for a folder that's gone |
| info | `not-skill` | folder without `SKILL.md` |

Plugin and claude.ai skills are not checked; you can't fix them locally.

## JSON output

`list`, `info`, `search`, `doctor`, `trash` and `plugin list` take `--json`.

**Skills** (`list`, `search`: an array; `info`: one object, or an array when several match):

| Field | Meaning |
| --- | --- |
| `name`, `dirName` | command name (`plugin:skill` / `anthropic-skills:<name>` for read-only skills) and folder name |
| `scope` | `user`, `project`, `plugin` or `synced` (raw value; never a path) |
| `scopeLabel` | display label: `user`, `project`, `claude.ai`; for plugin skills the plugin's install scope |
| `projectPath` | project root for project skills, and for plugin skills from a project/local install |
| `status` | `enabled`, `disabled`, `not-skill` or `broken-link` |
| `description`, `path`, `symlinkTarget` | |
| `source`, `installedAt` | from `skill-manager.json` |
| `override`, `shadowedBy` | `skillOverrides` value; `"user"` when shadowed |
| `plugin`, `pluginState`, `pluginScope`, `loadsHere` | plugin skills: plugin id, its on/off state, its install scope, and whether it loads where you ran `skm` |
| `shortName`, `bucket`, `bucketShort`, `activeAccount`, `loadsHere`, `syncSource`, `syncedAt`, `readOnly` | claude.ai skills (`activeAccount` only when the signed-in account is known) |
| `frontmatter`, `files`, `size`, `record` | `info` only (`size` and `record` for a single match) |

**Plugins** (`plugin list`): `id`, `name`, `marketplace`, `scope` (`user`, `project`, `local`,
`managed`, `synced`), `scopeLabel`, `projectPath`, `state`, `enabled`, `loadsHere`, `skills`
(count), `version`, `decidedBy` (`scope`, `file`, `value`, `reason`), `installPath`, and for synced
plugins `bucket` and `otherAccount`.

**doctor**: `{errors, warnings, results: [{label, path, scope, status, issues: [{level, code,
message, hint}]}]}`.

**trash**: `[{id, name, scope, status, originalPath, projectRoot, record, reason, trashedAt}]`,
where `reason` is `uninstall` or `replaced`.

## Interactive menu

`skm` with no arguments, in a terminal, opens a menu showing the skill count, plugins on, and
whether you're in a project:

List skills · List plugin skills · List claude.ai skills · Enable / disable skills · List plugins ·
Enable / disable plugins · Install a skill · Create a new skill · Show details of a skill · Search
skills · Update skills from their sources · Move / copy between user and project · Uninstall a skill
· Check for problems (doctor) · Trash / restore · Exit

**Enable / disable skills** and **Enable / disable plugins** are checklists (Space toggles, Enter
saves). A plugin change goes to user settings, or to `.claude/settings.local.json` when a project
file currently decides that plugin (so nothing committed changes); plugins decided by managed
settings are skipped.

## Scripts, CI and environment variables

`skm` asks questions only when stdin and stdout are a terminal. With `--no-input`,
`SKM_NO_INPUT=1`, `CI` set, or piped I/O, it never prompts; where it needs an answer it stops with
an error naming the flag to add (`-y`, `--force`, `--all`, `--skill`, `--to`, `--user`/`--project`,
`name@marketplace`).

| Variable | Effect |
| --- | --- |
| `HOME` | home folder (`~`) |
| `CLAUDE_CONFIG_DIR` | replaces `~/.claude` everywhere: skills, settings, plugins, claude.ai sync, and skill-manager's own records, trash and backups |
| `SKM_NO_INPUT`, `CI` | never prompt |
| `SKM_MANAGED_SETTINGS_DIR` | read managed settings from this folder instead of the system one (used by the tests) |
| `SKM_DEBUG` | print stack traces for unexpected errors |
| `VISUAL`, `EDITOR` | editor for `skm new -e` |
| `NO_COLOR`, `FORCE_COLOR` | turn colour off / on |

## Files and paths

Paths shown for `~/.claude` follow `CLAUDE_CONFIG_DIR`.

| Path | skm | What |
| --- | --- | --- |
| `~/.claude/skills/<name>/`, `<project>/.claude/skills/<name>/` | read, write | enabled skills |
| `~/.claude/skills-disabled/`, `<project>/.claude/skills-disabled/` | read, write | disabled skills |
| `~/.claude/skill-manager.json`, `<project>/.claude/skill-manager.json` | read, write | install records: source (type, input, URL/path, ref, sub-path), commit, content hash, rename, dates |
| `~/.claude/skill-manager/trash/` | read, write | removed and replaced skills |
| `~/.claude/skill-manager/backups/` | write | settings files as they were before `skm plugin enable/disable` |
| `<scope>/.claude/.skm-staging-*` | write (temporary) | staging copies during install/update |
| `~/.claude/settings.json`, `<project>/.claude/settings.json`, `<project>/.claude/settings.local.json` | read; write `enabledPlugins` only via `skm plugin enable/disable` or the menu | `enabledPlugins`, `skillOverrides`, `syncClaudeAiSkills`, `syncClaudeAiPlugins` |
| `managed-settings.json`, `managed-settings.d/*.json` (system folder) | read | managed `enabledPlugins`, sync switches |
| `~/.claude/plugins/installed_plugins.json` | read | installed plugins and their install scope/project |
| `~/.claude/plugins/known_marketplaces.json`, `…/marketplaces/<m>/.claude-plugin/marketplace.json`, `<plugin>/.claude-plugin/plugin.json` | read | `defaultEnabled`, plugin name, version, skill paths |
| `~/.claude/plugins/synced/<account>/` | read | plugins synced from claude.ai |
| `~/.claude/skills/synced/<account>/` (`manifest.json` + skill folders) | read | skills synced from claude.ai |
| `~/.claude.json` | read | `oauthAccount`: the signed-in claude.ai account |
| `$TMPDIR/skm-*` | write (temporary) | clones and extracted archives, removed afterwards |

State files are written atomically (temp file + rename).

## Caveats and limitations

- **Only one project root is managed.** Claude Code also loads `.claude/skills/` from parent
  folders up to the repo root, from nested subfolders, and from `--add-dir` folders. `skm` scans
  only the project root it detects (or `--project-dir`).
- **Enterprise (managed) skills** aren't listed.
- **Not everything that decides plugin state is visible.** MDM profiles, server-managed settings
  from claude.ai, and the `claude --settings` flag can change what Claude Code does without `skm`
  seeing it; only `skillOverrides` from user, project and local settings is read.
- **The claude.ai sync layout is observed, not documented** (`<org>_<account>` folders,
  `manifest.json`, `.bucket-*` markers). A Claude Code update could change it.
- **Disabling a skill in a shared repo** shows up in git as a deletion. Use `skillOverrides` in
  `.claude/settings.local.json`, or ignore `.claude/skills-disabled/`.
- **Concurrent settings writes.** `skm plugin enable/disable` reads, changes and replaces the
  settings file. If Claude Code or another tool writes the same file at the same moment, one change
  can be lost; the backup in `~/.claude/skill-manager/backups/` has the previous version. Running two
  `skm` commands at once can likewise lose an install record.
- Cowork and cloud sessions don't read `~/.claude/skills`, so local changes don't reach them.
- Legacy `.claude/commands/*.md` files are not managed.
- Folders under `skills/` without a `SKILL.md` are left alone (shown with `--all`); hidden entries
  such as `skills/.trash/` are ignored.
- Developed and tested on macOS.

## Development

```sh
npm install
npm test          # node --test, all files in test/
npm start -- list # same as node bin/skm.js list
```

Every test runs the CLI or the modules against a temporary `HOME`, project and managed-settings
folder, never your real `~/.claude`. Test files: `test/cli.test.js` (end-to-end commands),
`test/plugins.test.js` (plugin discovery, `enabledPlugins` precedence, settings writes),
`test/synced.test.js` (claude.ai skills and plugins), `test/unit.test.js` (parsing and helpers),
`test/helpers.js` (sandbox and fixtures).

Source layout:

| File | Role |
| --- | --- |
| `bin/skm.js` | entry point (Node version check) |
| `src/cli.js` | commander wiring, help, bare-flag shorthand |
| `src/menu.js` | interactive menu |
| `src/context.js` | config dir, scopes, project detection |
| `src/skills.js` | finding skills, shadowing, `skillOverrides`, name resolution |
| `src/plugins.js` | installed plugins, `enabledPlugins` precedence, settings writes |
| `src/synced.js` | claude.ai-synced skills and active-account detection |
| `src/sources.js` | parsing and fetching install sources |
| `src/ops.js` | trash, placing skills |
| `src/state.js` | `skill-manager.json` records |
| `src/frontmatter.js` | `SKILL.md` parsing and validation rules |
| `src/fsutil.js` | moves, hashing, atomic JSON writes |
| `src/ui.js` | output, tables, prompts, errors |
| `src/commands/*` | one file per command group |

License: MIT (as declared in `package.json`).
