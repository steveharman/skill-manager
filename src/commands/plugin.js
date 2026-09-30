// `skm plugin list|enable|disable`: switch whole plugins on and off through `enabledPlugins`.
import pc from 'picocolors';
import { noProjectError } from '../context.js';
import { decidedByLabel, discoverPlugins, settingsFileFor, settingsLayers, splitId, writeEnabledPlugins } from '../plugins.js';
import { OTHER_ACCOUNT_LEGEND, OTHER_PROJECT_LEGEND, SkmError, didYouMean, isInteractive, out, plural, prompt, scopeColor, scopeLabel, table, tildify } from '../ui.js';

/** STATUS is only ever enabled/disabled; another project's install is dimmed, its location is in SCOPE. */
const stateColor = (p) =>
  !p.applicable ? pc.dim(p.state) : p.state === 'enabled' ? pc.green('enabled') : pc.yellow('disabled');

function pluginJson(p) {
  return {
    id: p.id, name: p.name, marketplace: p.marketplace, scope: p.scope, scopeLabel: scopeLabel(p.scope), projectPath: p.projectPath || undefined,
    state: p.state, enabled: p.enabled, loadsHere: p.applicable && p.enabled, skills: p.skillDirs.length, version: p.version || undefined,
    decidedBy: { scope: p.decidedBy.scope, file: p.decidedBy.file || undefined, value: p.decidedBy.value, reason: p.decidedBy.reason },
    installPath: p.installPath, bucket: p.bucket, otherAccount: p.scope === 'synced' ? Boolean(p.otherAccount) : undefined,
  };
}

function warnUnreadable(ctx) {
  for (const l of settingsLayers(ctx)) if (l.error) out.warn(`Ignoring ${tildify(l.file)}: ${l.error}`);
}

export async function pluginListCommand(ctx, opts = {}) {
  const plugins = discoverPlugins(ctx);
  if (opts.json) {
    out.log(JSON.stringify(plugins.map(pluginJson), null, 2));
    return;
  }
  warnUnreadable(ctx);
  if (!plugins.length) {
    out.info('No plugins installed.');
    out.hint(`Claude Code records plugin installs in ${tildify(ctx.pluginsDir)}/installed_plugins.json. Install with /plugin.`);
    return;
  }
  const rows = plugins.map((p) => {
    const d = p.applicable ? (s) => s : pc.dim;
    return [p.applicable ? pc.bold(p.id) : pc.dim(p.id), p.applicable ? scopeColor(p.scope, p.projectPath) : pc.dim(scopeLabel(p.scope, p.projectPath)),
      stateColor(p), d(String(p.skillDirs.length)), pc.dim(p.version || '—'), ''];
  });
  out.log(table(['PLUGIN', 'SCOPE', 'STATUS', 'SKILLS', 'VERSION', 'DECIDED BY'], rows, {
    lastRaw: (i) => decidedByLabel(plugins[i]),
    lastColor: (s) => pc.dim(s),
    noTruncate: true, // the deciding file is the point of this column
  }));
  const here = plugins.filter((p) => p.applicable);
  const accounts = plugins.filter((p) => p.otherAccount).length;
  const elsewhere = plugins.length - here.length - accounts;
  const count = (st) => here.filter((p) => p.state === st).length;
  const parts = [plural(plugins.length, 'plugin'), `${count('enabled')} enabled`, `${count('disabled')} disabled`];
  if (elsewhere) parts.push(`${elsewhere} installed for other projects`);
  if (accounts) parts.push(`${accounts} synced for other claude.ai accounts`);
  out.blank();
  out.log(pc.dim(parts.join(' · ')));
  if (elsewhere) out.log(pc.dim(OTHER_PROJECT_LEGEND));
  if (accounts) out.log(pc.dim(OTHER_ACCOUNT_LEGEND));
  out.log(pc.dim(`Change with "skm plugin enable|disable <name>" (writes enabledPlugins; -p project, --local this machine only).`));
}

/** Every plugin id skm can offer: installed ones plus any id a settings file mentions. */
function knownIds(ctx, plugins) {
  const ids = new Set(plugins.map((p) => p.id));
  for (const l of settingsLayers(ctx)) for (const id of Object.keys(l.data?.enabledPlugins || {})) ids.add(id);
  return [...ids].sort();
}

/** Resolve "name" or "name@marketplace" to exactly one plugin id. */
export async function resolvePluginId(ctx, plugins, input, action = 'change') {
  const ids = knownIds(ctx, plugins);
  const lower = input.toLowerCase();
  const exact = ids.find((id) => id.toLowerCase() === lower);
  if (exact) return exact;
  const byName = input.includes('@') ? [] : ids.filter((id) => splitId(id).name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const describe = (id) => {
      const rows = plugins.filter((p) => p.id === id);
      return rows.length ? rows.map((p) => `${scopeLabel(p.scope, p.projectPath)}: ${p.state}`).join(', ') : 'not installed';
    };
    if (isInteractive())
      return prompt.select(`"${input}" is provided by more than one marketplace. Which one do you want to ${action}?`,
        byName.map((id) => ({ value: id, label: id, hint: describe(id) })));
    throw new SkmError(`"${input}" is ambiguous — ${byName.length} marketplaces provide it:`, {
      hint: [...byName.map((id) => `${id}  (${describe(id)})`), 'Pass the full name@marketplace.'],
    });
  }
  const sugg = didYouMean(input, [...ids, ...ids.map((id) => splitId(id).name)]);
  const hint = sugg.length ? [`Did you mean: ${sugg.join(', ')}?`] : [];
  hint.push('Run "skm plugin list" to see installed plugins.');
  throw new SkmError(`No plugin named "${input}".`, { hint });
}

function targetOf(opts) {
  const picked = ['user', 'project', 'local'].filter((k) => opts[k]);
  if (picked.length > 1) throw new SkmError('Pick one of --user, --project or --local.');
  return picked[0] || 'user';
}

const TARGET_LABEL = { user: 'user settings', project: 'project settings', local: 'local project settings' };

/**
 * Write `enabledPlugins[id] = value` for each id into one settings file, then check the result.
 * @param {Record<string, boolean>} changes
 */
export function applyPluginChanges(ctx, changes, target, { dryRun = false } = {}) {
  const file = settingsFileFor(ctx, target);
  if (!file) throw noProjectError(ctx);
  const before = discoverPlugins(ctx);
  for (const id of Object.keys(changes)) {
    const managed = before.find((p) => p.id === id && p.applicable && p.decidedBy.scope === 'managed');
    if (managed)
      throw new SkmError(`${id} is ${managed.enabled ? 'forced on' : 'blocked'} by managed settings; no other file can change that.`, {
        hint: `${tildify(managed.decidedBy.file)} — ask your administrator.`,
      });
  }
  const { changed, backup } = writeEnabledPlugins(ctx, file, changes, { scope: target, dryRun });
  for (const id of Object.keys(changes)) {
    const verb = changes[id] ? 'enable' : 'disable';
    if (!changed.includes(id)) out.info(`${id} is already set to ${changes[id]} in ${tildify(file)}`);
    else if (dryRun) out.dry(`${verb} ${pc.bold(id)}: set enabledPlugins["${id}"] = ${changes[id]} in ${tildify(file)}`);
    else out.success(`${verb === 'enable' ? 'Enabled' : 'Disabled'} ${pc.bold(id)} ${pc.dim(`(${TARGET_LABEL[target]}: ${tildify(file)})`)}`);
  }
  if (dryRun) {
    if (changed.length) out.dry(`back up ${tildify(file)} to ${tildify(ctx.backupDir)} first`);
    return { changed, file };
  }
  if (backup) out.hint(`Previous file backed up to ${tildify(backup)}`);
  // Does the change take effect here? A higher-precedence file may still decide otherwise.
  const after = discoverPlugins(ctx);
  for (const id of Object.keys(changes)) {
    const here = after.filter((p) => p.id === id && p.applicable);
    if (!here.length) {
      const elsewhere = after.filter((p) => p.id === id);
      out.warn(elsewhere.length
        ? `${id} is installed only for ${elsewhere.map((p) => tildify(p.projectPath)).join(', ')}, so it doesn't load here either way.`
        : `${id} is not installed; the setting applies once it is.`);
      continue;
    }
    const wrong = here.find((p) => p.enabled !== changes[id]);
    if (wrong) {
      out.warn(`${id} is still ${wrong.enabled ? 'enabled' : 'disabled'} here: ${decidedByLabel(wrong)} takes precedence.`);
      if (wrong.decidedBy.scope === 'project' || wrong.decidedBy.scope === 'local')
        out.hint(`Override it for yourself with: skm plugin ${changes[id] ? 'enable' : 'disable'} ${id} --local`);
    }
  }
  if (changed.length) out.hint('Running Claude Code sessions pick this up after /reload-plugins or a restart.');
  return { changed, file };
}

export async function pluginToggleCommand(ctx, names, opts, value) {
  const verb = value ? 'enable' : 'disable';
  const target = targetOf(opts);
  if (target !== 'user' && !ctx.project) throw noProjectError(ctx);
  const plugins = discoverPlugins(ctx);
  let ids = [];
  if (!names.length) {
    if (!isInteractive()) throw new SkmError(`Which plugin should I ${verb}?`, { hint: `skm plugin ${verb} <name[@marketplace]...>` });
    const pool = [...new Map(plugins.filter((p) => p.applicable && p.enabled !== value).map((p) => [p.id, p])).values()];
    if (!pool.length) {
      out.info(`Nothing to ${verb}: every plugin here is already ${value ? 'enabled' : 'disabled'}.`);
      return;
    }
    ids = await prompt.multiselect(`Select plugins to ${verb}:`,
      pool.map((p) => ({ value: p.id, label: p.id, hint: `${plural(p.skillDirs.length, 'skill')}` })), [], true);
  } else {
    for (const n of names) {
      const id = await resolvePluginId(ctx, plugins, n, verb);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  applyPluginChanges(ctx, Object.fromEntries(ids.map((id) => [id, value])), target, { dryRun: opts.dryRun });
}

export const pluginEnableCommand = (ctx, names, opts) => pluginToggleCommand(ctx, names, opts, true);
export const pluginDisableCommand = (ctx, names, opts) => pluginToggleCommand(ctx, names, opts, false);
