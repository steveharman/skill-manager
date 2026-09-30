import { join } from 'node:path';
import pc from 'picocolors';
import { selectedScopes } from '../context.js';
import { dirSize, listFiles } from '../fsutil.js';
import { loadsHere } from '../plugins.js';
import { collect, resolveSkill, scanPlugins } from '../skills.js';
import { sourceLabel } from '../state.js';
import { OTHER_PROJECT_LEGEND, entryScope, entryScopeLabel, formatBytes, out, plural, table, tildify } from '../ui.js';

/** Keep the end of long sources (the interesting part). */
const clip = (s, n) => (s.length > n ? '…' + s.slice(s.length - n + 1) : s);

/** A plugin skill whose plugin is installed for another project (it never loads where skm runs). */
const otherProject = (e) => e.scope === 'plugin' && e.pluginInfo && !e.pluginInfo.applicable;

/** STATUS is only ever on/off (plus qualifiers about on/off); where a skill lives belongs in SCOPE. */
function statusText(e) {
  if (e.kind === 'not-skill') return pc.dim('not a skill');
  if (e.kind === 'broken-link') return pc.red('broken link');
  if (otherProject(e)) return pc.dim(e.pluginState === 'disabled' ? 'disabled (plugin off)' : 'enabled');
  if (e.scope === 'plugin' && e.pluginState === 'disabled') return pc.yellow('disabled (plugin off)');
  if (e.status === 'disabled') return pc.yellow('disabled');
  if (e.override === 'off') return pc.yellow('off (settings)');
  if (e.shadowedBy) return pc.yellow('shadowed');
  return pc.green('enabled');
}

export function toJson(e) {
  return {
    name: e.name, dirName: e.dirName, scope: e.scope, status: e.kind === 'skill' ? e.status : e.kind,
    description: e.description, path: e.path, symlinkTarget: e.symlinkTarget || undefined,
    plugin: e.plugin, pluginState: e.pluginState, pluginScope: e.pluginInfo?.scope,
    projectPath: (e.scope === 'plugin' ? e.pluginInfo?.projectPath : e.projectRoot) || undefined,
    loadsHere: e.scope === 'plugin' ? loadsHere(e.pluginInfo) : undefined, source: e.record?.source, installedAt: e.record?.installedAt,
    override: e.override || undefined, shadowedBy: e.shadowedBy || undefined, note: e.note,
  };
}

function printHidden(hidden, opts) {
  const allHint = opts.pluginAllHint || 'use --all';
  const countPlugins = (list) => new Set(list.map((e) => `${e.plugin}|${e.pluginInfo.projectPath || ''}`)).size;
  if (hidden.off.length)
    out.log(pc.dim(`+ ${plural(hidden.off.length, 'skill')} from ${plural(countPlugins(hidden.off), 'disabled plugin')} hidden (${allHint})`));
  if (hidden.elsewhere.length)
    out.log(pc.dim(`+ ${plural(hidden.elsewhere.length, 'skill')} from ${plural(countPlugins(hidden.elsewhere), 'plugin')} installed for other projects hidden (${allHint})`));
}

export async function listCommand(ctx, opts) {
  const scopes = selectedScopes(ctx, opts);
  const withPlugins = Boolean(opts.plugins || opts.all);
  let entries = collect(ctx, { scopes, plugins: withPlugins });
  if (!opts.all) entries = entries.filter((e) => e.kind !== 'not-skill');
  // Skills of plugins that are off here (or installed only for another project) stay out unless asked for.
  const hidden = { off: [], elsewhere: [] };
  if (withPlugins && !opts.all && !opts.disabled) {
    for (const e of entries) {
      if (e.scope !== 'plugin' || loadsHere(e.pluginInfo)) continue;
      hidden[e.pluginInfo.applicable ? 'off' : 'elsewhere'].push(e);
    }
    entries = entries.filter((e) => e.scope !== 'plugin' || loadsHere(e.pluginInfo));
  }
  if (opts.enabled) entries = entries.filter((e) => e.status === 'enabled');
  if (opts.disabled) entries = entries.filter((e) => e.status === 'disabled');

  if (opts.json) {
    out.log(JSON.stringify(entries.map(toJson), null, 2));
    return;
  }

  const order = { user: 0, project: 1, plugin: 2 };
  entries.sort((a, b) => order[a.scope] - order[b.scope] || a.name.localeCompare(b.name));

  if (!entries.length) {
    out.info('No skills installed yet.');
    for (const s of scopes) out.hint(`${s.scope}: ${tildify(s.skillsDir)}`);
    out.hint('Install one with "skm install <source>" or create one with "skm new <name>".');
    printHidden(hidden, opts);
    return;
  }

  const rows = entries.map((e) => {
    const dim = otherProject(e);
    return [
      e.kind === 'skill' && !dim ? pc.bold(e.name) : pc.dim(e.kind === 'skill' ? e.name : e.dirName),
      dim ? pc.dim(entryScopeLabel(e)) : entryScope(e),
      statusText(e),
      pc.dim(clip(e.scope === 'plugin' ? e.plugin : sourceLabel(e.record) || (e.symlinkTarget ? 'symlink' : '—'), 36)),
      '',
    ];
  });
  out.log(table(['NAME', 'SCOPE', 'STATUS', 'SOURCE', 'DESCRIPTION'], rows, {
    lastRaw: (i) => entries[i].kind === 'skill' ? entries[i].description : entries[i].note || 'no SKILL.md — ignored by Claude Code and skill-manager',
    lastColor: (s, i) => (entries[i].kind === 'skill' && !otherProject(entries[i]) ? s : pc.dim(s)),
  }));

  const skills = entries.filter((e) => e.kind === 'skill' && e.scope !== 'plugin');
  const disabled = skills.filter((e) => e.status === 'disabled').length;
  out.blank();
  const parts = [plural(skills.length, 'skill'), `${skills.length - disabled} enabled`];
  if (disabled) parts.push(`${disabled} disabled`);
  out.log(pc.dim(parts.join(' · ')));
  for (const s of scopes) out.log(pc.dim(`${s.scope.padEnd(7)} ${tildify(s.skillsDir)}`));
  if (entries.some(otherProject)) out.log(pc.dim(OTHER_PROJECT_LEGEND));
  if (entries.some((e) => e.shadowedBy))
    out.log(pc.yellow('shadowed') + pc.dim(': a user skill with the same name takes precedence in Claude Code.'));
  if (entries.some((e) => e.override === 'off'))
    out.log(pc.yellow('off (settings)') + pc.dim(': hidden by skillOverrides in a Claude Code settings.json.'));
  const pluginSkills = entries.filter((e) => e.kind === 'skill' && e.scope === 'plugin');
  if (pluginSkills.length) {
    const on = pluginSkills.filter((e) => loadsHere(e.pluginInfo));
    const elsewhere = pluginSkills.filter(otherProject).length;
    const off = pluginSkills.length - on.length - elsewhere;
    const plugins = new Set(on.map((e) => e.plugin));
    out.log(pc.dim(`${plural(on.length, 'plugin skill')} from ${plural(plugins.size, 'enabled plugin')}` +
      (off ? ` · ${off} from plugins that are off here` : '') +
      (elsewhere ? ` · ${elsewhere} from plugins installed for other projects` : '')));
  }
  printHidden(hidden, opts);
  if (entries.some((e) => e.pluginState === 'disabled' && !otherProject(e)))
    out.log(pc.yellow('disabled (plugin off)') + pc.dim(': the plugin is off in enabledPlugins; turn it on with "skm plugin enable <plugin>".'));
  if (!withPlugins && !opts.user && !opts.project) {
    const all = scanPlugins(ctx);
    const n = all.filter((e) => loadsHere(e.pluginInfo)).length;
    const here = all.filter((e) => e.pluginInfo.applicable);
    const how = opts.pluginHint || 'run "skm list --plugins"';
    if (n) out.log(pc.dim(`+ ${plural(n, 'plugin skill')} not shown (${how}).`));
    else if (here.length) out.log(pc.dim(`+ ${plural(here.length, 'plugin skill')} from plugins that are off not shown (${how}).`));
  }
}

export async function infoCommand(ctx, name, opts) {
  const matches = await resolveSkill(ctx, name, { ...opts, multiple: true }).catch(async (err) => {
    // Allow read-only info on plugin skills.
    const p = scanPlugins(ctx).filter((x) => x.name === name || x.name.endsWith(':' + name));
    if (p.length) return p;
    throw err;
  });
  if (opts.json && matches.length > 1) {
    out.log(JSON.stringify(matches.map((e) => ({ ...toJson(e), frontmatter: e.parsed?.data || null, files: listFiles(e.path) })), null, 2));
    return;
  }
  matches.forEach((e, i) => {
    if (i) out.log(pc.dim('\n' + '─'.repeat(40) + '\n'));
    showInfo(e, opts);
  });
}

function showInfo(e, opts) {
  const files = listFiles(e.path);
  const size = dirSize(e.path);
  if (opts.json) {
    out.log(JSON.stringify({ ...toJson(e), frontmatter: e.parsed?.data || null, files, size, record: e.record }, null, 2));
    return;
  }
  const kv = (k, v) => out.log(`${pc.dim(k.padEnd(12))} ${v}`);
  out.log(pc.bold(e.name));
  out.blank();
  kv('scope', entryScope(e) + (e.plugin ? pc.dim(` (${e.plugin}, read-only)`) : ''));
  if (otherProject(e)) kv('loads', pc.dim('only when Claude Code runs in that project'));
  kv('status', statusText(e));
  kv('path', tildify(e.path));
  if (e.symlinkTarget) kv('links to', tildify(e.symlinkTarget));
  if (e.dirName !== e.name && e.scope !== 'plugin') kv('folder', e.dirName);
  if (e.record?.source) {
    kv('source', sourceLabel(e.record));
    if (e.record.source.ref) kv('ref', e.record.source.ref);
    if (e.record.commit) kv('commit', e.record.commit.slice(0, 12));
    if (e.record.installedAt) kv('installed', e.record.installedAt);
    if (e.record.updatedAt) kv('updated', e.record.updatedAt);
  }
  if (e.override) kv('settings', `skillOverrides: "${e.override}"`);
  if (e.shadowedBy) kv('note', pc.yellow('a user skill with the same name takes precedence'));
  kv('size', `${formatBytes(size)} in ${plural(files.length, 'file')}`);
  out.blank();
  out.log(pc.bold('Frontmatter'));
  if (e.parsed?.error) out.log(pc.red(`  ${e.parsed.error}`));
  else if (!e.parsed?.hasFrontmatter) out.log(pc.red('  (none)'));
  else
    for (const [k, v] of Object.entries(e.parsed.data)) {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      out.log(`  ${pc.cyan(k)}: ${val.replace(/\n/g, '\n    ')}`);
    }
  out.blank();
  out.log(pc.bold('Files'));
  const max = opts.allFiles ? files.length : 25;
  for (const f of files.slice(0, max)) out.log(`  ${f}`);
  if (files.length > max) out.log(pc.dim(`  … ${files.length - max} more (use --all-files)`));
  if (e.scope !== 'plugin') {
    out.blank();
    out.log(pc.dim(`Edit: ${tildify(join(e.path, e.fileName || 'SKILL.md'))}`));
  }
}

export async function searchCommand(ctx, term, opts) {
  const scopes = selectedScopes(ctx, opts);
  const t = term.toLowerCase();
  const entries = collect(ctx, { scopes, plugins: !opts.user && !opts.project && opts.plugins !== false })
    .filter((e) => e.kind === 'skill')
    .map((e) => {
      const inName = e.name.toLowerCase().includes(t) || e.dirName.toLowerCase().includes(t);
      const inDesc = e.description.toLowerCase().includes(t);
      return { e, score: inName ? 2 : inDesc ? 1 : 0 };
    })
    .filter((x) => x.score)
    .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  if (opts.json) {
    out.log(JSON.stringify(entries.map((x) => toJson(x.e)), null, 2));
    return;
  }
  if (!entries.length) {
    out.info(`No installed skills match "${term}".`);
    return;
  }
  const hl = (s) => s.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), (m) => pc.bold(pc.yellow(m)));
  const width = (process.stdout.columns || 120) - 4;
  for (const { e } of entries) {
    out.log(`${pc.bold(hl(e.name))} ${pc.dim('·')} ${entryScope(e)}${e.status === 'disabled' ? pc.yellow(' (disabled)') : ''}`);
    const d = e.description.replace(/\s+/g, ' ');
    const i = d.toLowerCase().indexOf(t);
    const start = i > width / 2 ? i - Math.floor(width / 3) : 0;
    let snippet = d.slice(start, start + width);
    if (start > 0) snippet = '…' + snippet.slice(1);
    if (start + width < d.length) snippet = snippet.slice(0, -1) + '…';
    out.log(`  ${pc.dim(hl(snippet))}`);
  }
  out.blank();
  out.log(pc.dim(plural(entries.length, 'match', 'matches')));
}
