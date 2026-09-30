# skill-manager (`skm`)

A friendly command-line manager for [Claude Code skills](https://code.claude.com/docs/en/skills):
list, install, enable/disable, update, move, scaffold and check them, in user and project scope,
and switch installed plugins on and off.

```text
$ skm list
NAME        SCOPE     STATUS    SOURCE                               DESCRIPTION
pdf         user      enabled   github:anthropics/skills/skills/pdf  Use this skill whenever the user wants to…
route       user      enabled   —                                    Route a task to the right Claude model…
deploy      ~/myapp   disabled  local                                Deploy the app to staging…

3 skills · 2 enabled · 1 disabled
user    ~/.claude/skills
project ./.claude/skills
```

SCOPE says where something is installed: `user`, `claude.ai` (synced from your claude.ai account), or the project's path
(e.g. `~/myapp`) for project scope. STATUS only ever says whether it is on: `enabled` or `disabled`,
plus qualifiers such as `shadowed`, `off (settings)` or `disabled (plugin off)`. Long project paths
are shortened from the left (`…/infra/health-worker`). `--json` keeps `scope: "project"` and puts the
path in a separate `projectPath` field; for claude.ai rows it keeps `scope: "synced"` and adds
`scopeLabel: "claude.ai"`.

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
| `skm list` (`ls`) | Table of skills: name, scope, status, source, description. `--user`, `--project`, `--json`, `--plugins` (adds skills of enabled plugins), `--claude-ai` (adds skills synced from your claude.ai account), `--enabled`, `--disabled` (both only ever list skills, never folders that aren't skills), `--all` (adds every plugin skill, including disabled plugins and plugins installed for other projects, every claude.ai skill, including other accounts', and folders that are not skills) |
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
   from your claude.ai account (see [Skills synced from claude.ai](#skills-synced-from-claudeai)).
   `skm` lists them but never changes that folder, and won't install anything under that name (or
   `anthropic-skills…`). Any other folder without a `SKILL.md` shows up in `skm list --all` as
   `not a skill` and is left alone. Hidden entries such as `~/.claude/skills/.trash/` are ignored.
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

## Skills synced from claude.ai

Claude Code downloads the skills enabled for your claude.ai account (your own, your organization's,
and Anthropic's such as `pdf` and `xlsx`) into `~/.claude/skills/synced/` (or
`$CLAUDE_CONFIG_DIR/skills/synced/`) and runs each as `/anthropic-skills:<name>` (also as `/<name>`
when nothing else uses that name). `skm list --claude-ai` lists them, one row each:

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

- **Hidden by default, like plugin skills.** They are read-only and mostly Anthropic's built-ins, so
  plain `skm list` stays about the skills you manage and ends with
  `+ 12 claude.ai skills not shown (run "skm list --claude-ai")`. `--all` includes them too.
  `skm search` and `skm info` always cover them (`skm info anthropic-skills:pdf`, or `skm info pdf`
  when no user or project skill is called `pdf`).
- **One folder per account.** The sync keeps a folder per claude.ai organization/account
  (`<org-uuid>_<account-uuid>`), each with a `manifest.json` and the skill folders. SOURCE shows the
  first 8 characters of the org id (plus the account's when two folders share an org) so copies are
  distinguishable. The account Claude Code is signed in to is read from `oauthAccount` in
  `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`); skills synced for any other account don't
  load, so they're hidden unless `--all` and then dimmed with an `other-account` legend. If `skm`
  can't tell which account is signed in (API-key sign-in, no config file), it shows every folder.
  The same applies to plugins synced from claude.ai (`~/.claude/plugins/synced/`).
- **Names and descriptions** come from `manifest.json`, falling back to the `SKILL.md` frontmatter.
  The manifest only lists skills that are on for the account (turning one off on claude.ai removes it
  at the next sync), so STATUS is `enabled`, or `disabled (sync off)` when
  `"syncClaudeAiSkills": false` in user, local or managed settings stops Claude Code loading them.
- **Read-only.** `skm disable/enable/uninstall/update/move/copy` on a synced skill exits with
  a message and changes nothing: turn it off in your skills settings on claude.ai (or **Customize**
  in the Claude desktop app), or set `"syncClaudeAiSkills": false` to stop loading all of them. Files
  edited or deleted under `skills/synced/` are overwritten by the next sync. The Claude Code docs
  describe `skillOverrides` for personal, project and bundled skills but not for synced ones, so `skm`
  doesn't write it for them. `skm doctor` doesn't check them (you can't fix them locally).

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
- **Plugins synced from claude.ai** show up as `<name>@synced` with SCOPE `claude.ai` (`--json` keeps
  `scope: "synced"` and adds `scopeLabel: "claude.ai"`). They load only in sessions signed in with
  your claude.ai account, only from that account's sync folder (others are dimmed, `otherAccount:
  true` in JSON), and `syncClaudeAiPlugins: false` turns them all off.
- **Plugins installed for another project** (install scope `project`/`local` with a different
  project path) show that project's path in SCOPE (a `local` install adds ` (local)`) and are dimmed,
  with a legend line under the table. Their STATUS is still `enabled`/`disabled`: what Claude Code
  decides when it runs in *that* project (user settings → that project's `.claude/settings.json` →
  its `.claude/settings.local.json` → managed), and DECIDED BY names that project's file. The
  summary line counts them separately (`… · 2 installed for other projects`), and `--json` has
  `loadsHere: false` for them.
- **Single plugin skills can't be switched.** Claude Code's `skillOverrides` doesn't apply to plugin
  skills, so `skm enable/disable plugin:skill` explains this and points at `skm plugin disable <plugin>`.
- Two marketplaces that ship the same plugin name are two separate plugins. `skm plugin disable
  <name>` asks which one in a terminal, and needs `name@marketplace` in scripts.

In the interactive menu, **Enable / disable plugins** is a checklist of the plugins that load here.
A change goes to user settings, or to `.claude/settings.local.json` when a project file currently
decides that plugin (so nothing committed changes).

In `skm list --plugins` / `--all`, a plugin skill's SCOPE is where its plugin is installed (`user`,
`claude.ai` or a project path; SOURCE names the plugin) and its STATUS is `enabled` or
`disabled (plugin off)`. By default only skills of plugins that load here are listed, followed by
lines such as `+ 42 skills from 4 disabled plugins hidden (use --all)` and
`+ 23 skills from 2 plugins installed for other projects hidden (use --all)`.

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
