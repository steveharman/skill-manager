// `skm` with no arguments: a friendly interactive menu.
import pc from 'picocolors';
import { createContext } from './context.js';
import { doctorCommand } from './commands/doctor.js';
import { installCommand, updateCommand } from './commands/install.js';
import { infoCommand, listCommand, searchCommand } from './commands/list.js';
import { newCommand, transferCommand, trashCommand, uninstallCommand } from './commands/manage.js';
import { dirFor } from './ops.js';
import { movePath, exists } from './fsutil.js';
import { collect } from './skills.js';
import { discoverPlugins } from './plugins.js';
import { applyPluginChanges, pluginListCommand } from './commands/plugin.js';
import { basename } from 'node:path';
import { SkmError, clack, out, plural, printError, prompt, tildify } from './ui.js';

const pickSkill = async (ctx, message, filter = () => true) => {
  const skills = collect(ctx).filter((e) => e.kind === 'skill' && filter(e));
  if (!skills.length) {
    out.info('No matching skills.');
    return null;
  }
  return prompt.select(message, skills.map((e) => ({
    value: e,
    label: `${e.name}${e.status === 'disabled' ? pc.yellow(' (disabled)') : ''}`,
    hint: e.scope,
  })));
};

/** One screen to flip skills on and off. */
async function toggleScreen(ctx) {
  const skills = collect(ctx).filter((e) => e.kind === 'skill');
  if (!skills.length) return out.info('No skills installed yet.');
  const keyOf = (e) => `${e.scope}:${e.dirName}`;
  const chosen = await prompt.multiselect(
    'Enabled skills (space toggles, enter saves):',
    skills.map((e) => ({ value: keyOf(e), label: e.name, hint: `${e.scope}${e.shadowedBy ? ', shadowed by user skill' : ''}` })),
    skills.filter((e) => e.status === 'enabled').map(keyOf),
  );
  const want = new Set(chosen);
  let changed = 0;
  for (const e of skills) {
    const to = want.has(keyOf(e)) ? 'enabled' : 'disabled';
    if (to === e.status) continue;
    const scope = e.scope === 'user' ? ctx.user : ctx.project;
    const dest = dirFor(scope, to, e.dirName);
    if (exists(dest)) {
      out.warn(`Skipped ${e.name}: ${tildify(dest)} already exists.`);
      continue;
    }
    movePath(e.path, dest);
    out.success(`${to === 'enabled' ? 'Enabled' : 'Disabled'} ${e.name} ${pc.dim(`(${e.scope})`)}`);
    changed++;
  }
  if (!changed) out.info('No changes.');
}

/**
 * One screen to flip plugins on and off. A change goes to the file that currently decides the plugin when
 * that is a project file (as .claude/settings.local.json, so nothing committed changes), else to user settings.
 */
async function pluginToggleScreen(ctx) {
  const plugins = [...new Map(discoverPlugins(ctx).filter((p) => p.applicable).map((p) => [p.id, p])).values()];
  if (!plugins.length) return out.info('No plugins installed here.');
  const chosen = await prompt.multiselect(
    'Enabled plugins (space toggles, enter saves):',
    plugins.map((p) => ({
      value: p.id, label: p.id,
      hint: `${plural(p.skillDirs.length, 'skill')} · ${p.scope}${p.decidedBy.scope === 'managed' ? ' · managed, locked' : ''}`,
    })),
    plugins.filter((p) => p.enabled).map((p) => p.id),
  );
  const want = new Set(chosen);
  const byTarget = { user: {}, local: {} };
  for (const p of plugins) {
    const to = want.has(p.id);
    if (to === p.enabled) continue;
    if (p.decidedBy.scope === 'managed') {
      out.warn(`Skipped ${p.id}: managed settings decide it.`);
      continue;
    }
    byTarget[p.decidedBy.scope === 'project' || p.decidedBy.scope === 'local' ? 'local' : 'user'][p.id] = to;
  }
  let changed = 0;
  for (const [target, changes] of Object.entries(byTarget))
    if (Object.keys(changes).length) changed += applyPluginChanges(ctx, changes, target).changed.length;
  if (!changed) out.info('No changes.');
}

export async function runMenu() {
  clack.intro(pc.bold(' skill-manager '));
  for (;;) {
    const ctx = createContext();
    const skills = collect(ctx).filter((e) => e.kind === 'skill');
    const where = ctx.project ? `user + project ${pc.dim(basename(ctx.project.root))}` : 'user scope (not in a project)';
    const plugins = discoverPlugins(ctx);
    const pluginIds = new Set(plugins.filter((p) => p.applicable).map((p) => p.id));
    const onIds = new Set(plugins.filter((p) => p.state === 'enabled').map((p) => p.id));
    const pluginSummary = pluginIds.size ? ` · ${onIds.size}/${plural(pluginIds.size, 'plugin')} on` : '';
    const choice = await prompt.select(`${plural(skills.length, 'skill')}${pluginSummary} · ${where}\nWhat would you like to do?`, [
      { value: 'list', label: 'List skills' },
      { value: 'plugins', label: 'List plugin skills', hint: 'skills from enabled plugins' },
      { value: 'toggle', label: 'Enable / disable skills' },
      { value: 'pluginList', label: 'List plugins', hint: 'every installed plugin and what decides it' },
      { value: 'pluginToggle', label: 'Enable / disable plugins' },
      { value: 'install', label: 'Install a skill', hint: 'folder, archive, git URL, owner/repo' },
      { value: 'new', label: 'Create a new skill' },
      { value: 'info', label: 'Show details of a skill' },
      { value: 'search', label: 'Search skills' },
      { value: 'update', label: 'Update skills from their sources' },
      { value: 'move', label: 'Move / copy between user and project' },
      { value: 'uninstall', label: 'Uninstall a skill' },
      { value: 'doctor', label: 'Check for problems (doctor)' },
      { value: 'trash', label: 'Trash / restore' },
      { value: 'exit', label: 'Exit' },
    ], 'list');
    if (choice === 'exit') break;
    try {
      out.blank();
      switch (choice) {
        case 'list':
          await listCommand(ctx, { pluginHint: 'choose "List plugin skills" in the menu' });
          break;
        case 'plugins':
          await listCommand(ctx, { plugins: true, pluginAllHint: 'turn them on with "Enable / disable plugins"' });
          break;
        case 'pluginList':
          await pluginListCommand(ctx, {});
          break;
        case 'pluginToggle':
          await pluginToggleScreen(ctx);
          break;
        case 'toggle':
          await toggleScreen(ctx);
          break;
        case 'install': {
          const source = await prompt.text('Install from', {
            placeholder: './my-skill  ·  owner/repo  ·  https://github.com/o/r/tree/main/skills/x',
            validate: (v) => (v?.trim() ? undefined : 'Enter a source'),
          });
          await installCommand(ctx, source.trim(), {});
          break;
        }
        case 'new':
          await newCommand(ctx, undefined, {});
          break;
        case 'info': {
          const e = await pickSkill(ctx, 'Which skill?');
          if (e) await infoCommand(ctx, e.dirName, { [e.scope]: true });
          break;
        }
        case 'search': {
          const term = await prompt.text('Search for', { validate: (v) => (v?.trim() ? undefined : 'Enter a term') });
          await searchCommand(ctx, term.trim(), {});
          break;
        }
        case 'update':
          await updateCommand(ctx, [], {});
          break;
        case 'move': {
          if (!ctx.project) throw new SkmError('Not inside a project, so there is nowhere to move to.', { hint: 'cd into a project first.' });
          const e = await pickSkill(ctx, 'Which skill?');
          if (!e) break;
          const mode = await prompt.select('Move or copy?', [{ value: 'move', label: 'Move' }, { value: 'copy', label: 'Copy' }]);
          await transferCommand(ctx, e.dirName, { [e.scope]: true, to: e.scope === 'user' ? 'project' : 'user' }, mode);
          break;
        }
        case 'uninstall': {
          const e = await pickSkill(ctx, 'Uninstall which skill?');
          if (e) await uninstallCommand(ctx, [e.dirName], { [e.scope]: true });
          break;
        }
        case 'doctor':
          await doctorCommand(ctx, undefined, {});
          process.exitCode = 0;
          break;
        case 'trash': {
          await trashCommand(ctx, {});
          break;
        }
      }
    } catch (e) {
      if (e instanceof SkmError && e.exitCode === 130) continue;
      printError(e);
      process.exitCode = 0;
    }
    out.blank();
  }
  clack.outro(pc.dim('Bye. Run "skm --help" for all commands.'));
}
