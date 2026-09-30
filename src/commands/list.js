import { join } from 'node:path';
import pc from 'picocolors';
import { selectedScopes } from '../context.js';
import { dirSize, listFiles } from '../fsutil.js';
import { loadsHere } from '../plugins.js';
import { collect, resolveSkill, scanPlugins } from '../skills.js';
import { sourceLabel } from '../state.js';
import { scanSynced } from '../synced.js';
import { OTHER_ACCOUNT_LEGEND, OTHER_PROJECT_LEGEND, entryScope, entryScopeLabel, formatBytes, out, plural, scopeLabel, table, tildify } from '../ui.js';

/** Keep the end of long sources (the interesting part). */
const clip = (s, n) => (s.length > n ? '…' + s.slice(s.length - n + 1) : s);

/** A plugin skill whose plugin is installed for another project (it never loads where skm runs). */
const otherProject = (e) => e.scope === 'plugin' && e.pluginInfo && !e.pluginInfo.applicable && !e.pluginInfo.otherAccount;
/** A claude.ai skill (or claude.ai plugin's skill) synced for an account Claude Code is not signed in to. */
const otherAccount = (e) => (e.scope === 'synced' && !e.active) || Boolean(e.scope === 'plugin' && e.pluginInfo?.otherAccount);
/** Rows drawn dimmed: they exist on disk but don't load where skm runs. */
const elsewhere = (e) => otherProject(e) || otherAccount(e);

/** STATUS is only ever on/off (plus qualifiers about on/off); where a skill lives belongs in SCOPE. */
function statusText(e) {
  if (e.kind === 'not-skill') return pc.dim('not a skill');
  if (e.kind === 'broken-link') return pc.red('broken link');
  if (otherProject(e)) return pc.dim(e.pluginState === 'disabled' ? 'disabled (plugin off)' : 'enabled');
  if (otherAccount(e)) return pc.dim(e.status);
  if (e.scope === 'synced' && e.status === 'disabled') return pc.yellow('disabled (sync off)');
  if (e.scope === 'plugin' && e.pluginState === 'disabled') return pc.yellow('disabled (plugin off)');
  if (e.status === 'disabled') return pc.yellow('disabled');
  if (e.override === 'off') return pc.yellow('off (settings)');
  if (e.shadowedBy) return pc.yellow('shadowed');
  return pc.green('enabled');
}

export function toJson(e) {
  return {
    name: e.name, dirName: e.dirName, scope: e.scope, scopeLabel: e.scope === 'plugin' ? scopeLabel(e.pluginInfo?.scope) : scopeLabel(e.scope),
    status: e.kind === 'skill' ? e.status : e.kind,
    description: e.description, path: e.path, symlinkTarget: e.symlinkTarget || undefined,
    plugin: e.plugin, pluginState: e.pluginState, pluginScope: e.pluginInfo?.scope,
    projectPath: (e.scope === 'plugin' ? e.pluginInfo?.projectPath : e.projectRoot) || undefined,
    loadsHere: e.scope === 'plugin' ? loadsHere(e.pluginInfo) : undefined, source: e.record?.source, installedAt: e.record?.installedAt,
    override: e.override || undefined, shadowedBy: e.shadowedBy || undefined, note: e.note,
    ...(e.scope === 'synced'
      ? { shortName: e.shortName, bucket: e.bucket, bucketShort: e.bucketShort, loadsHere: e.active && e.status === 'enabled',
          activeAccount: e.activeKnown ? e.active : undefined, syncSource: e.synced?.source, syncedAt: e.synced?.updatedAt, readOnly: true }
      : {}),
  };
}

function printHidden(hidden, opts) {
  const allHint = opts.pluginAllHint || 'use --all';
  const countPlugins = (list) => new Set(list.map((e) => `${e.plugin}|${e.pluginInfo.projectPath || ''}`)).size;
  if (hidden.off.length)
    out.log(pc.dim(`+ ${plural(hidden.off.length, 'skill')} from ${plural(countPlugins(hidden.off), 'disabled plugin')} hidden (${allHint})`));
  if (hidden.elsewhere.length)
    out.log(pc.dim(`+ ${plural(hidden.elsewhere.length, 'skill')} from ${plural(countPlugins(hidden.elsewhere), 'plugin')} installed for other projects hidden (${allHint})`));
  if (hidden.otherAccount.length) {
    const n = new Set(hidden.otherAccount.map((e) => e.bucket || e.pluginInfo?.bucket)).size;
    out.log(pc.dim(`+ ${plural(hidden.otherAccount.length, 'claude.ai skill')} synced for ${plural(n, 'other claude.ai account')} hidden (use --all)`));
  }
}

export async function listCommand(ctx, opts) {
  const scopes = selectedScopes(ctx, opts);
  const withPlugins = Boolean(opts.plugins || opts.all);
  // claude.ai skills are account-level, like user skills: left out of a --project-only listing.
  const projectOnly = opts.project && !opts.user;
  const withSynced = Boolean((opts.claudeAi || opts.all) && !projectOnly);
  let entries = collect(ctx, { scopes, plugins: withPlugins, synced: withSynced });
  if (!opts.all) entries = entries.filter((e) => e.kind !== 'not-skill');
  // Skills of plugins that are off here (or installed only for another project) stay out unless asked for;
  // so do claude.ai skills synced for an account Claude Code isn't signed in to.
  const hidden = { off: [], elsewhere: [], otherAccount: [] };
  if (withSynced && !opts.all) {
    hidden.otherAccount.push(...entries.filter(otherAccount));
    entries = entries.filter((e) => !otherAccount(e));
  }
  if (withPlugins && !opts.all && !opts.disabled) {
    for (const e of entries) {
      if (e.scope !== 'plugin' || loadsHere(e.pluginInfo)) continue;
      hidden[e.pluginInfo.otherAccount ? 'otherAccount' : e.pluginInfo.applicable ? 'off' : 'elsewhere'].push(e);
    }
    entries = entries.filter((e) => e.scope !== 'plugin' || loadsHere(e.pluginInfo));
  }
  // --enabled / --disabled are about skills; folders that aren't skills (or broken links) have no on/off state.
  if (opts.enabled) entries = entries.filter((e) => e.kind === 'skill' && e.status === 'enabled');
  if (opts.disabled) entries = entries.filter((e) => e.kind === 'skill' && e.status === 'disabled');

  if (opts.json) {
    out.log(JSON.stringify(entries.map(toJson), null, 2));
    return;
  }

  const order = { user: 0, project: 1, plugin: 2, synced: 3 };
  entries.sort((a, b) => order[a.scope] - order[b.scope] || a.name.localeCompare(b.name));

  if (!entries.length) {
    out.info('No skills installed yet.');
    for (const s of scopes) out.hint(`${s.scope}: ${tildify(s.skillsDir)}`);
    out.hint('Install one with "skm install <source>" or create one with "skm new <name>".');
    printHidden(hidden, opts);
    return;
  }

  const source = (e) =>
    e.scope === 'plugin' ? e.plugin : e.scope === 'synced' ? e.bucketShort : sourceLabel(e.record) || (e.symlinkTarget ? 'symlink' : '—');
  const rows = entries.map((e) => {
    const dim = elsewhere(e);
    return [
      e.kind === 'skill' && !dim ? pc.bold(e.name) : pc.dim(e.kind === 'skill' ? e.name : e.dirName),
      dim ? pc.dim(entryScopeLabel(e)) : entryScope(e),
      statusText(e),
      pc.dim(clip(source(e), 36)),
      '',
    ];
  });
  out.log(table(['NAME', 'SCOPE', 'STATUS', 'SOURCE', 'DESCRIPTION'], rows, {
    lastRaw: (i) => entries[i].kind === 'skill' ? entries[i].description : entries[i].note || 'no SKILL.md — ignored by Claude Code and skill-manager',
    lastColor: (s, i) => (entries[i].kind === 'skill' && !elsewhere(entries[i]) ? s : pc.dim(s)),
  }));

  const skills = entries.filter((e) => e.kind === 'skill' && (e.scope === 'user' || e.scope === 'project'));
  const disabled = skills.filter((e) => e.status === 'disabled').length;
  out.blank();
  const parts = [plural(skills.length, 'skill'), `${skills.length - disabled} enabled`];
  if (disabled) parts.push(`${disabled} disabled`);
  out.log(pc.dim(parts.join(' · ')));
  for (const s of scopes) out.log(pc.dim(`${s.scope.padEnd(7)} ${tildify(s.skillsDir)}`));
  if (entries.some(otherProject)) out.log(pc.dim(OTHER_PROJECT_LEGEND));
  if (entries.some(otherAccount)) out.log(pc.dim(OTHER_ACCOUNT_LEGEND));
  const syncedRows = entries.filter((e) => e.scope === 'synced');
  if (syncedRows.length) {
    const live = syncedRows.filter((e) => !otherAccount(e));
    const other = syncedRows.length - live.length;
    const bucket = live[0]?.activeKnown ? ` (signed-in account ${live[0].bucketShort})` : '';
    out.log(pc.dim(`${plural(live.length, 'claude.ai skill')}${bucket}` + (other ? ` · ${other} synced for other accounts` : '') +
      ' · read-only: change them on claude.ai'));
    if (syncedRows.some((e) => e.status === 'disabled'))
      out.log(pc.yellow('disabled (sync off)') + pc.dim(': "syncClaudeAiSkills": false in a Claude Code settings.json stops them loading.'));
  }
  if (entries.some((e) => e.shadowedBy))
    out.log(pc.yellow('shadowed') + pc.dim(': a user skill with the same name takes precedence in Claude Code.'));
  if (entries.some((e) => e.override === 'off'))
    out.log(pc.yellow('off (settings)') + pc.dim(': hidden by skillOverrides in a Claude Code settings.json.'));
  const pluginSkills = entries.filter((e) => e.kind === 'skill' && e.scope === 'plugin');
  if (pluginSkills.length) {
    const on = pluginSkills.filter((e) => loadsHere(e.pluginInfo));
    const elsewhere = pluginSkills.filter(otherProject).length;
    const accounts = pluginSkills.filter(otherAccount).length;
    const off = pluginSkills.length - on.length - elsewhere - accounts;
    const plugins = new Set(on.map((e) => e.plugin));
    out.log(pc.dim(`${plural(on.length, 'plugin skill')} from ${plural(plugins.size, 'enabled plugin')}` +
      (off ? ` · ${off} from plugins that are off here` : '') +
      (elsewhere ? ` · ${elsewhere} from plugins installed for other projects` : '') +
      (accounts ? ` · ${accounts} from claude.ai plugins synced for other accounts` : '')));
  }
  printHidden(hidden, opts);
  if (entries.some((e) => e.pluginState === 'disabled' && !elsewhere(e)))
    out.log(pc.yellow('disabled (plugin off)') + pc.dim(': the plugin is off in enabledPlugins; turn it on with "skm plugin enable <plugin>".'));
  if (!withPlugins && !opts.user && !opts.project) {
    const all = scanPlugins(ctx);
    const n = all.filter((e) => loadsHere(e.pluginInfo)).length;
    const here = all.filter((e) => e.pluginInfo.applicable);
    const how = opts.pluginHint || 'run "skm list --plugins"';
    if (n) out.log(pc.dim(`+ ${plural(n, 'plugin skill')} not shown (${how}).`));
    else if (here.length) out.log(pc.dim(`+ ${plural(here.length, 'plugin skill')} from plugins that are off not shown (${how}).`));
  }
  if (!withSynced && !opts.user && !opts.project) {
    const n = scanSynced(ctx).filter((e) => e.active).length;
    if (n) out.log(pc.dim(`+ ${plural(n, 'claude.ai skill')} not shown (${opts.claudeAiHint || 'run "skm list --claude-ai"'}).`));
  }
}

export async function infoCommand(ctx, name, opts) {
  // resolveSkill also returns claude.ai-synced skills (read-only) when no user/project skill matches.
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
  kv('scope', entryScope(e) + (e.plugin ? pc.dim(` (${e.plugin}, read-only)`) : '') +
    (e.scope === 'synced' ? pc.dim(' (synced from claude.ai, read-only)') : ''));
  if (otherProject(e)) kv('loads', pc.dim('only when Claude Code runs in that project'));
  if (otherAccount(e)) kv('loads', pc.dim('only when Claude Code is signed in to that claude.ai account'));
  if (e.scope === 'synced') {
    kv('account', `${e.bucket}${e.activeKnown ? (e.active ? pc.dim(' (signed in)') : pc.dim(' (not signed in)')) : ''}`);
    kv('invoke', `/${e.name}` + pc.dim(` (or /${e.shortName} when no other skill or command uses that name)`));
  }
  kv('status', statusText(e));
  kv('path', tildify(e.path));
  if (e.symlinkTarget) kv('links to', tildify(e.symlinkTarget));
  if (e.dirName !== e.name && e.scope !== 'plugin' && e.scope !== 'synced') kv('folder', e.dirName);
  if (e.synced?.source) kv('source', `claude.ai (${e.synced.source})`);
  if (e.synced?.updatedAt) kv('updated', e.synced.updatedAt);
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
  if (e.scope === 'synced') {
    out.blank();
    out.log(pc.dim('Managed by claude.ai: change or turn it off in your claude.ai skills settings; local edits are overwritten by the next sync.'));
  } else if (e.scope !== 'plugin') {
    out.blank();
    out.log(pc.dim(`Edit: ${tildify(join(e.path, e.fileName || 'SKILL.md'))}`));
  }
}

export async function searchCommand(ctx, term, opts) {
  const scopes = selectedScopes(ctx, opts);
  const t = term.toLowerCase();
  const everywhere = !opts.user && !opts.project;
  const entries = collect(ctx, { scopes, plugins: everywhere && opts.plugins !== false, synced: everywhere || (opts.user && !opts.project) })
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
    const where = otherAccount(e) ? pc.dim(`${entryScopeLabel(e)} ${e.bucketShort} (other account)`) : entryScope(e);
    out.log(`${pc.bold(hl(e.name))} ${pc.dim('·')} ${where}${e.status === 'disabled' ? pc.yellow(' (disabled)') : ''}`);
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
