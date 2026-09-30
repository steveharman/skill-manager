# skill-manager (`skm`)

A friendly command-line manager for [Claude Code skills](https://code.claude.com/docs/en/skills):
list, install, enable/disable, update, move, scaffold and check them, in user and project scope,
and switch installed plugins on and off.

```text
$ skm list
NAME        SCOPE    STATUS    SOURCE                               DESCRIPTION
pdf         user     enabled   github:anthropics/skills/skills/pdf  Use this skill whenever the user wants to…
route       user     enabled   —                                    Route a task to the right Claude model…
deploy      project  disabled  local                                Deploy the app to staging…

3 skills · 2 enabled · 1 disabled
user    ~/.claude/skills
project ./.claude/skills
```

## Install

Requires Node.js 20 or newer and `git` (for git/GitHub sources).

```sh
cd /Volumes/External/steveharman/skill-manager
npm install          # dependencies
npm link             # puts `skm` and `skill-manager` on your PATH
# or: npm i -g .
```

Try it without installing: `node bin/skm.js list`.

To uninstall: `npm unlink -g skill-manager` (or `npm rm -g skill-manager`).

## Quick start

```sh
skm                                   # interactive menu (in a terminal)
skm list                              # everything, both scopes
skm install anthropics/skills         # pick skills from a multi-skill repo
skm disable noisy-skill               # hide it from Claude Code, keep the files
skm enable noisy-skill
skm plugin list                       # every installed plugin and what turns it on or off
skm plugin disable superpowers@claude-plugins-official
skm doctor                            # find problems
```

Every command has `--help` with examples: `skm install --help`.

## Scopes

| Scope   | Skills folder                  | Disabled skills                         | Metadata                              |
| ------- | ------------------------------ | --------------------------------------- | ------------------------------------- |
| user    | `~/.claude/skills/`            | `~/.claude/skills-disabled/`            | `~/.claude/skill-manager.json`        |
| project | `<project>/.claude/skills/`    | `<project>/.claude/skills-disabled/`    | `<project>/.claude/skill-manager.json` |
| plugin  | `~/.claude/plugins/…/skills/`  | whole plugin only — `skm plugin disable` | `enabledPlugins` in settings.json    |

- `~/.claude` honours `$HOME` and the `CLAUDE_CONFIG_DIR` override.
- The **project** is the nearest parent folder containing `.claude/` or `.git`. Your home
  folder's `~/.claude` never counts as a project marker. Point somewhere else with
  `--project-dir <path>` (or the short form `--project=<path>`).
- Flags: `-g` / `--user` and `-p` / `--project`. Without a flag, read commands (`list`, `search`,
  `doctor`) cover both scopes. Commands that change things work on whichever scope has the skill.
  If both scopes have it, `skm` asks you in a terminal, or tells you which flag to add.
- `install` and `new` default to **user** scope. Inside a project, in a terminal, they ask first
  (user is preselected).

## Commands

| Command | What it does |
| --- | --- |
| `skm list` (`ls`) | Table of skills: name, scope, status, source, description. `--user`, `--project`, `--json`, `--plugins` (adds skills of enabled plugins), `--enabled`, `--disabled`, `--all` (adds every plugin skill, including disabled plugins and plugins installed for other projects, and folders that are not skills) |
| `skm info <name>` | Full frontmatter, path, files, size, install source and commit |
| `skm install <source>` (`add`) | Install from a folder, a `SKILL.md`, a `.zip`/`.skill` archive, a git URL or GitHub (see below) |
| `skm uninstall <name...>` (`rm`) | Asks first (`-y` skips the question), then moves the skill to the trash. It is not hard-deleted |
| `skm enable/disable [name...]` | Turn skills on or off. Leave out the names to pick from a list |
| `skm update [name...]` (`up`) | Fetch again from the recorded source. Skips skills with local edits unless you pass `--force` |
| `skm new [name]` (`create`) | Create a `SKILL.md` from a template. `-d "description"`, `-e` opens `$EDITOR` |
| `skm move/copy <name> --to user\|project` (`mv`/`cp`) | Move or copy a skill between scopes. Its install record goes with it |
| `skm doctor [path]` (`validate`) | Check for problems. Pass a path to check a skill before you install it. Exits with code 1 if it finds errors |
| `skm search <term>` (`find`) | Search the names and descriptions of installed skills |
| `skm trash` / `skm restore <name>` | See removed skills and restore them. `skm trash --empty` deletes them for good |
| `skm plugin list` (`skm plugins`) | One row per installed plugin: `name@marketplace`, install scope, status, number of skills, version, and the settings file that decided the status. `--json` |
| `skm plugin enable/disable <name[@marketplace]...>` | Turn whole plugins on or off by writing `enabledPlugins`. User `settings.json` by default, `-p` for the project's `.claude/settings.json`, `--local` for `.claude/settings.local.json`. `--dry-run` |

`--dry-run` / `-n` works on every command that changes files. It prints each step and writes
nothing.

### Install sources

```sh
skm install ./my-skill                                   # folder containing SKILL.md
skm install ./some-repo                                  # folder containing many skills → picker
skm install ~/Downloads/SKILL.md --name my-skill         # single file
skm install ~/Downloads/pdf.skill                        # .skill / .zip archive (local or https URL)
skm install anthropics/skills                            # GitHub owner/repo → picker
skm install anthropics/skills/skills/pdf                 # GitHub owner/repo/path
skm install https://github.com/anthropics/skills/tree/main/skills/pdf
skm install git@github.com:me/private-skills.git#skills/foo --ref v2
```

- **Several skills in one source:** in a terminal you get a multi-select picker. In scripts,
  pass `--all` or `--skill <name>` (you can repeat it or use commas).
- **Checked before anything is copied:** a `SKILL.md` must exist, its YAML frontmatter must parse,
  and its name must be allowed. A skill with an error is not installed. Warnings, such as a missing
  description, are shown but do not block the install.
- **Name already taken:** in a terminal you choose overwrite or skip. In scripts the skill is skipped
  unless you pass `--force`. An overwritten copy goes to the trash.
- **What gets copied:** `.git/` and `node_modules/` are skipped. Symlinks are replaced by the files
  they point to, so the installed copy stands on its own.
- **Private repos:** `skm` runs git with prompts turned off (`GIT_TERMINAL_PROMPT=0`), so an HTTPS
  password prompt can't hang it. Use an SSH URL instead.

## How disabling works — and caveats (verified against the Claude Code docs, Sept 2026)

Claude Code loads skills only from `…/skills/<name>/SKILL.md` (enterprise, personal, project,
nested `.claude/skills` in subfolders, `--add-dir` folders, and plugins). `skm disable` moves a
skill into the sibling `skills-disabled/` folder. Claude Code never reads that folder, so the
skill disappears from Claude entirely. `skm enable` moves it back. Claude Code watches the skills
folders, so you don't need to restart it.

Things to know:

1. **Claude Code has its own switch.** The `skillOverrides` setting in `settings.json`
   (`{"skillOverrides": {"deploy": "off"}}`, or press Space in the `/skills` menu) hides a skill
   without moving any files. `skm` doesn't write that setting. It does read it: `skm list` shows
   such skills as `off (settings)`, and `skm enable` warns you when a setting still hides the skill.
   For skills committed to a **shared project repo**, `skillOverrides` in
   `.claude/settings.local.json` is often the better choice. With `skm disable`, git sees the move
   as a deletion that you could commit by accident. You can also add `.claude/skills-disabled/` to
   `.gitignore`.
2. **User skills beat project skills.** When a name is in both `~/.claude/skills/` and the
   project's `.claude/skills/`, Claude Code runs the **user** one (enterprise > personal >
   project). `skm list` marks the project copy as `shadowed`, and `skm doctor` warns about it.
3. **`synced` is reserved.** `~/.claude/skills/synced/` holds skills that Claude Code downloads
   from your claude.ai account. `skm` never changes it and won't install anything under that name
   (or `anthropic-skills…`). `skm list --all` shows it as `not a skill`. Any other folder without a
   `SKILL.md` is left alone in the same way. Hidden entries such as `~/.claude/skills/.trash/` are
   ignored.
4. **Only the project root is managed.** Claude Code also loads `.claude/skills/` from parent
   folders up to the repo root, and from nested subfolders. `skm` manages only the one project
   root it detects (or the one you pass with `--project-dir`).
5. **The command name comes from the frontmatter.** If `name:` differs from the folder name, the
   command is `/name`. `skm doctor` flags the mismatch. `skm install --name x` renames both the
   folder and the frontmatter `name:`.
6. **Description length.** `skm doctor` warns above 1024 characters (the Agent Skills / Claude API
   limit). It also warns when `description` + `when_to_use` goes over 1536 characters, the point
   where Claude Code cuts off the text shown in its skill list.
7. Cowork and cloud sessions don't read `~/.claude/skills`, so local changes don't reach them.
8. Legacy `.claude/commands/*.md` files are not managed.

## Plugins (verified against the Claude Code docs, Sept 2026)

Claude Code decides whether a plugin is on from `enabledPlugins` (`{"name@marketplace": true|false}`)
in its settings files, not from `installed_plugins.json`. `skm` reads it the same way:

- **Precedence, lowest first:** user `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`)
  → project `.claude/settings.json` → local `.claude/settings.local.json` → managed settings. For each
  plugin id, the highest file that mentions it wins. Managed `false` blocks a plugin and managed `true`
  forces it on; nothing else can change either. Outside a project only user and managed settings apply.
- **No entry anywhere:** the plugin's `defaultEnabled` applies (the marketplace entry's value over
  `plugin.json`'s), which defaults to **on**.
- **Managed settings** are read from `managed-settings.json` and `managed-settings.d/*.json` in
  `/Library/Application Support/ClaudeCode/` (macOS) or `/etc/claude-code/` (Linux). MDM profiles and
  server-managed settings from claude.ai are not visible to `skm`.
- **Plugins synced from claude.ai** show up as `<name>@synced` (scope `synced`). They load only in
  sessions signed in with your claude.ai account, and `syncClaudeAiPlugins: false` turns them all off.
- **Plugins installed for another project** (install scope `project`/`local` with a different
  project path) are listed as `project-only (<path>)`. Their status there comes from that project's
  settings files.
- **Single plugin skills can't be switched.** Claude Code's `skillOverrides` doesn't apply to plugin
  skills, so `skm enable/disable plugin:skill` explains this and points at `skm plugin disable <plugin>`.
- Two marketplaces that ship the same plugin name are two separate plugins. `skm plugin disable
  <name>` asks which one in a terminal, and needs `name@marketplace` in scripts.

In the interactive menu, **Enable / disable plugins** is a checklist of the plugins that load here.
A change goes to user settings, or to `.claude/settings.local.json` when a project file currently
decides that plugin (so nothing committed changes).

Status words in `skm list --plugins` / `--all`: `enabled`, `disabled (plugin off)`,
`project-only (<path>)`. By default only skills of enabled plugins are listed, followed by a line such
as `+ 42 skills from 4 disabled plugins hidden (use --all)`.

`skm plugin enable/disable` writes one key and leaves everything else alone: it keeps every other
key and their order, writes 2-space JSON (or the file's existing indent) with a trailing newline,
keeps the file mode, writes through a symlinked `settings.json`, and refuses to touch a file that is
not valid JSON. It copies the old file to `~/.claude/skill-manager/backups/` first, then writes a
temp file and renames it into place. If a higher-precedence file still decides the other way (for
example the project enables a plugin you disabled in user settings), `skm` says so and suggests
`--local`. It never touches `installed_plugins.json` or the plugin cache. Running Claude Code sessions
pick up the change after `/reload-plugins` or a restart.

## Files skill-manager writes

- `<scope>/.claude/skill-manager.json`: the install source (type, URL/path, ref, sub-path),
  commit, content hash and dates. `update` uses it, and it's how local edits are detected.
- `~/.claude/skill-manager/trash/<timestamp>__<scope>__<name>/`: removed and replaced skills,
  with a `meta.json` file that `restore` uses.
- `enabledPlugins` in a Claude Code settings file, only when you run `skm plugin enable/disable`
  (or use the menu's plugin screen). The previous file is kept in
  `~/.claude/skill-manager/backups/<timestamp>__<scope>__<file>`.
- Copies are built in a staging folder (`.claude/.skm-staging-*`) and then moved into place in one
  step, so Claude Code never sees a half-copied skill.

## Non-interactive use

`skm` detects when it isn't in a terminal (piped output, CI, `SKM_NO_INPUT=1`, `--no-input`). It
then never asks questions. When it would need an answer, it stops with an error that names the
flag to add (`-y`, `--force`, `--all`, `--user`/`--project`). `NO_COLOR=1` turns colours off.
Most read commands have `--json` output.

## Development

```sh
npm test        # node:test; every test uses a temporary HOME, project and managed-settings folder, never your real ~/.claude
```

Layout: `bin/skm.js` (entry point) · `src/cli.js` (commander wiring and help) · `src/menu.js`
(interactive menu) · `src/context.js` (scopes and project detection) · `src/skills.js` (finding
skills and resolving names) · `src/plugins.js` (installed plugins, `enabledPlugins` precedence,
settings writes) · `src/sources.js` (parsing and fetching sources) · `src/ops.js`
(trash, placing skills) · `src/frontmatter.js` (parsing and validation rules) ·
`src/commands/*` (one file per command group).

Set `SKM_DEBUG=1` to print stack traces for unexpected errors.
