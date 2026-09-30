import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { createContext } from './context.js';
import { doctorCommand } from './commands/doctor.js';
import { installCommand, updateCommand } from './commands/install.js';
import { infoCommand, listCommand, searchCommand } from './commands/list.js';
import { disableCommand, enableCommand, newCommand, restoreCommand, transferCommand, trashCommand, uninstallCommand } from './commands/manage.js';
import { pluginDisableCommand, pluginEnableCommand, pluginListCommand } from './commands/plugin.js';
import { printError } from './ui.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const examples = (lines) => `\n${pc.bold('Examples:')}\n${lines.map((l) => `  ${pc.dim('$')} ${l}`).join('\n')}\n`;

/** Scope flags shared by most commands. */
function scoped(cmd, { dryRun = false } = {}) {
  cmd
    .option('-g, --user', 'user scope (~/.claude/skills)')
    .option('-p, --project', 'project scope (<project>/.claude/skills)')
    .option('--project-dir <path>', 'use this folder as the project root (also: --project=<path>)');
  if (dryRun) cmd.option('-n, --dry-run', 'show what would happen without changing anything');
  return cmd;
}

/** `--project=<path>` is shorthand for `--project --project-dir <path>`. */
export function normalizeArgv(argv) {
  const outArgs = [];
  for (const a of argv) {
    const m = /^--project=(.+)$/.exec(a);
    if (m) outArgs.push('--project', '--project-dir', m[1]);
    else outArgs.push(a);
  }
  return outArgs;
}

function action(fn, { projectDirImpliesProject = true } = {}) {
  return async (...args) => {
    const cmd = args.pop();
    const opts = cmd.optsWithGlobals();
    if (opts.input === false) process.env.SKM_NO_INPUT = '1';
    try {
      const ctx = createContext({ projectDir: opts.projectDir });
      if (opts.projectDir && projectDirImpliesProject) opts.project = opts.project || !opts.user;
      await fn(ctx, ...args.slice(0, -1), opts);
    } catch (e) {
      process.exitCode = printError(e);
    }
  };
}

export function buildProgram() {
  const program = new Command();
  program
    .name('skm')
    .usage('[command] [options]')
    .description(
      `${pc.bold('skill-manager')} — install, enable/disable, update and check Claude Code skills.\n\n` +
        `Skills live in ${pc.cyan('~/.claude/skills')} (user scope) and ${pc.magenta('<project>/.claude/skills')} (project scope).\n` +
        `Run ${pc.bold('skm')} with no arguments for an interactive menu.`,
    )
    .version(pkg.version, '-v, --version')
    .option('--no-input', 'never prompt; fail with a hint instead (also SKM_NO_INPUT=1)')
    .showHelpAfterError(pc.dim('(add --help for usage)'))
    .showSuggestionAfterError(true)
    .configureHelp({ sortSubcommands: false, subcommandTerm: (c) => c.name() + (c.alias() ? `|${c.alias()}` : '') + ' ' + c.usage() });

  scoped(program.command('list').alias('ls').description('list installed skills (both scopes by default)'))
    .option('--json', 'machine-readable output')
    .option('--plugins', 'also list skills from enabled plugins (read-only)')
    .option('--claude-ai', 'also list skills synced from your claude.ai account (read-only)')
    .option('-a, --all', 'include every plugin skill (also from disabled plugins and other projects), claude.ai skills (also for other accounts) and non-skill folders')
    .option('--enabled', 'only enabled skills')
    .option('--disabled', 'only disabled skills')
    .addHelpText('after', examples(['skm list', 'skm ls --user', 'skm list --project --json', 'skm list --plugins', 'skm list --claude-ai', 'skm list --all']))
    .action(action((ctx, opts) => listCommand(ctx, opts)));

  scoped(program.command('info').argument('<name>', 'skill name').description('show frontmatter, location, files and source of a skill'))
    .option('--json', 'machine-readable output')
    .option('--all-files', 'list every file')
    .addHelpText('after', examples(['skm info route', 'skm info my-skill --project --json']))
    .action(action((ctx, name, opts) => infoCommand(ctx, name, opts)));

  scoped(program.command('install').alias('add').argument('<source>', 'folder, SKILL.md, .zip/.skill, git URL or owner/repo[/path]')
    .description('install skills from a folder, file, archive, git repo or GitHub'), { dryRun: true })
    .option('-a, --all', 'install every skill found in the source')
    .option('-s, --skill <name...>', 'install only these skills from a multi-skill source')
    .option('--name <name>', 'install under a different name (single skill only)')
    .option('--ref <ref>', 'git branch, tag or commit')
    .option('-f, --force', 'overwrite an existing skill with the same name')
    .addHelpText('after', examples([
      'skm install ./my-skill                       # a folder with SKILL.md',
      'skm install ~/Downloads/pdf.skill            # a .skill / .zip archive',
      'skm install anthropics/skills --skill pdf    # GitHub shorthand, pick one',
      'skm install anthropics/skills/skills/pdf     # GitHub shorthand with a path',
      'skm install https://github.com/o/r/tree/main/skills/foo',
      'skm install git@github.com:o/r.git#skills/foo --project',
      'skm install ./repo --all --force --dry-run',
    ]))
    .action(action((ctx, source, opts) => installCommand(ctx, source, opts)));

  scoped(program.command('uninstall').alias('rm').argument('<name...>', 'skill name(s)')
    .description('remove skills (moved to the skill-manager trash, restorable)'), { dryRun: true })
    .option('-y, --yes', 'do not ask for confirmation')
    .addHelpText('after', examples(['skm rm old-skill', 'skm uninstall a b c -y', 'skm rm dup --project']))
    .action(action((ctx, names, opts) => uninstallCommand(ctx, names, opts)));

  scoped(program.command('enable').argument('[name...]', 'skill name(s); omit to pick interactively')
    .description('re-enable disabled skills'), { dryRun: true })
    .addHelpText('after', examples(['skm enable my-skill', 'skm enable a b --project']))
    .action(action((ctx, names, opts) => enableCommand(ctx, names, opts)));

  scoped(program.command('disable').argument('[name...]', 'skill name(s); omit to pick interactively')
    .description('hide skills from Claude Code without deleting them'), { dryRun: true })
    .addHelpText('after', `\nDisabled skills are moved to a sibling ${pc.cyan('.claude/skills-disabled/')} folder, which Claude Code does not read.\n` +
      examples(['skm disable noisy-skill', 'skm disable a b c', 'skm disable deploy --project --dry-run']))
    .action(action((ctx, names, opts) => disableCommand(ctx, names, opts)));

  scoped(program.command('update').alias('up').argument('[name...]', 'skill name(s); omit to update everything with a recorded source')
    .description('re-fetch skills from where they were installed from'), { dryRun: true })
    .option('-f, --force', 'overwrite local edits')
    .addHelpText('after', examples(['skm update', 'skm update pdf', 'skm update --project --dry-run']))
    .action(action((ctx, names, opts) => updateCommand(ctx, names, opts)));

  scoped(program.command('new').alias('create').argument('[name]', 'skill name (lowercase-kebab-case)')
    .description('scaffold a new skill with a SKILL.md template'), { dryRun: true })
    .option('-d, --description <text>', 'the skill description')
    .option('-e, --edit', 'open SKILL.md in $EDITOR afterwards')
    .option('--no-edit', 'do not offer to open an editor')
    .addHelpText('after', examples(['skm new release-notes', 'skm new review-pr -d "Use when reviewing a pull request" --project -e']))
    .action(action((ctx, name, opts) => newCommand(ctx, name, opts)));

  for (const mode of ['move', 'copy']) {
    scoped(program.command(mode).alias(mode === 'move' ? 'mv' : 'cp').argument('<name>', 'skill name')
      .description(`${mode} a skill between user and project scope`), { dryRun: true })
      .addOption(new Option('--to <scope>', 'destination scope').choices(['user', 'project']))
      .addOption(new Option('--from <scope>', 'source scope when the name exists in both').choices(['user', 'project']))
      .option('-f, --force', 'overwrite a skill with the same name at the destination')
      .addHelpText('after', examples([`skm ${mode} my-skill --to project`, `skm ${mode} my-skill --to user --from project`]))
      .action(action((ctx, name, opts) => transferCommand(ctx, name, opts, mode)));
  }

  scoped(program.command('doctor').alias('validate').argument('[path]', 'check one skill folder or SKILL.md instead of everything installed')
    .description('check skills for problems (frontmatter, names, duplicates, long descriptions)'))
    .option('--json', 'machine-readable output')
    .option('-V, --verbose', 'also show passing skills and informational notes')
    .addHelpText('after', examples(['skm doctor', 'skm doctor --project', 'skm validate ./my-new-skill', 'skm doctor --json']) +
      `\nExits with code 1 when any error is found (useful in CI).\n`)
    .action(action((ctx, path, opts) => doctorCommand(ctx, path, opts)));

  scoped(program.command('search').alias('find').argument('<term>', 'text to look for')
    .description('search installed skill names and descriptions'))
    .option('--json', 'machine-readable output')
    .option('--no-plugins', 'leave out plugin skills')
    .addHelpText('after', examples(['skm search pdf', 'skm find deploy --user']))
    .action(action((ctx, term, opts) => searchCommand(ctx, term, opts)));

  const plugin = program.command('plugin').alias('plugins')
    .description('list installed plugins and switch them on or off (enabledPlugins in settings.json)');
  plugin.command('list', { isDefault: true }).alias('ls').description('one row per installed plugin: scope, status, skills, version, deciding settings file')
    .option('--json', 'machine-readable output')
    .option('--project-dir <path>', 'evaluate for this project root instead of the current one')
    .addHelpText('after', examples(['skm plugin list', 'skm plugins --json']))
    .action(action((ctx, opts) => pluginListCommand(ctx, opts), { projectDirImpliesProject: false }));
  for (const [verb, fn] of [['enable', pluginEnableCommand], ['disable', pluginDisableCommand]]) {
    plugin.command(verb).argument('[name...]', 'plugin name or name@marketplace; omit to pick interactively')
      .description(`${verb} whole plugins by writing enabledPlugins (user settings by default)`)
      .option('-g, --user', 'write ~/.claude/settings.json (default)')
      .option('-p, --project', 'write <project>/.claude/settings.json (shared with the repo)')
      .option('--local', 'write <project>/.claude/settings.local.json (this machine only)')
      .option('--project-dir <path>', 'project root for -p / --local')
      .option('-n, --dry-run', 'show what would happen without changing anything')
      .addHelpText('after', `\nThe previous settings file is backed up to ~/.claude/skill-manager/backups/ first.\n` + examples([
        `skm plugin ${verb} superpowers@claude-plugins-official`,
        `skm plugin ${verb} caveman --local`,
        `skm plugin ${verb} atlassian notion --dry-run`,
      ]))
      .action(action((ctx, names, opts) => fn(ctx, names, opts), { projectDirImpliesProject: false }));
  }

  program.command('trash').description('show skills removed by skill-manager (restorable)')
    .option('--empty', 'permanently delete everything in the trash')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('-n, --dry-run', 'show what would happen')
    .option('--json', 'machine-readable output')
    .option('--project-dir <path>', 'project root')
    .addHelpText('after', examples(['skm trash', 'skm trash --empty -y']))
    .action(action((ctx, opts) => trashCommand(ctx, opts)));

  program.command('restore').argument('<name>', 'skill name (newest trash entry wins)')
    .description('bring back a skill from the trash')
    .addOption(new Option('--to <scope>', 'restore into this scope instead of the original').choices(['user', 'project']))
    .option('-n, --dry-run', 'show what would happen')
    .option('--project-dir <path>', 'project root')
    .action(action((ctx, name, opts) => restoreCommand(ctx, name, opts)));

  program.addHelpText('after', examples([
    'skm                               # interactive menu',
    'skm list',
    'skm install anthropics/skills     # pick from a multi-skill repo',
    'skm disable some-skill',
    'skm plugin list                   # plugins and whether each one is on',
    'skm plugin disable superpowers',
    'skm doctor',
  ]) + `\nRun ${pc.bold('skm <command> --help')} for details on a command.\n`);

  return program;
}

/** Options `skm list` accepts; `true` means the option takes a value. */
const LIST_FLAGS = {
  '--json': false, '--plugins': false, '--claude-ai': false, '-a': false, '--all': false, '--enabled': false, '--disabled': false,
  '-g': false, '--user': false, '-p': false, '--project': false, '--project-dir': true,
};

/**
 * Bare list flags with no command (`skm --plugins`, `skm --json`) mean `skm list <flags>`.
 * Returns the rewritten args, or the input unchanged when it is anything else.
 */
export function bareListArgs(args) {
  const globals = [];
  let i = 0;
  while (args[i] === '--no-input') globals.push(args[i++]);
  const rest = args.slice(i);
  if (!rest.length) return args;
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j];
    if (a === '--no-input') continue;
    if (!(a in LIST_FLAGS)) return args;
    if (LIST_FLAGS[a]) j++;
  }
  return [...globals, 'list', ...rest];
}

export async function main(argv = process.argv) {
  const args = normalizeArgv(argv.slice(2));
  const { isInteractive } = await import('./ui.js');
  if (args.length === 0 || (args.length === 1 && args[0] === '--no-input')) {
    if (isInteractive() && args.length === 0) {
      const { runMenu } = await import('./menu.js');
      try {
        await runMenu();
      } catch (e) {
        process.exitCode = printError(e);
      }
      return;
    }
    buildProgram().outputHelp();
    return;
  }
  await buildProgram().parseAsync(bareListArgs(args), { from: 'user' });
}
