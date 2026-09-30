// Discovering skills on disk and resolving a name typed by the user to one of them.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { readJson } from './fsutil.js';
import { discoverPlugins, loadsHere } from './plugins.js';
import { loadState } from './state.js';
import { SkmError, didYouMean, entryScope, isInteractive, prompt, tildify } from './ui.js';

/**
 * @typedef {object} Entry
 * @property {'skill'|'not-skill'|'broken-link'} kind
 * @property {'user'|'project'|'plugin'} scope
 * @property {'enabled'|'disabled'} status
 * @property {string} dirName   folder name on disk
 * @property {string} name      command name (frontmatter name, else folder name; plugin skills are plugin:skill)
 * @property {string} path
 * @property {string|null} fileName  actual SKILL.md filename found (case may differ)
 * @property {ReturnType<typeof parseFrontmatter>|null} parsed
 * @property {string} description
 * @property {string|null} symlinkTarget
 * @property {string} [plugin]  plugin id (name@marketplace) for plugin skills
 * @property {import('./plugins.js').Plugin} [pluginInfo]
 * @property {'enabled'|'disabled'} [pluginState]  the plugin's on/off state where it belongs (see pluginInfo.applicable)
 * @property {string|null} [projectRoot]  project root for project-scope skills
 * @property {object|null} record   skill-manager.json record
 * @property {string|null} override skillOverrides value from settings
 * @property {string|null} shadowedBy
 * @property {string} [note]
 */

/** Find SKILL.md in a folder, tolerating wrong case. */
export function findSkillFile(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  if (names.includes('SKILL.md')) return 'SKILL.md';
  return names.find((n) => n.toLowerCase() === 'skill.md') || null;
}

/** Read and parse a skill folder. */
export function readSkill(dir) {
  const fileName = findSkillFile(dir);
  if (!fileName) return { fileName: null, parsed: null };
  let text = '';
  try {
    text = readFileSync(join(dir, fileName), 'utf8');
  } catch (e) {
    return { fileName, parsed: { hasFrontmatter: false, data: {}, body: '', error: `cannot read: ${e.message}` } };
  }
  return { fileName, parsed: parseFrontmatter(text) };
}

function describe(parsed) {
  if (!parsed) return '';
  const d = parsed.data?.description;
  if (typeof d === 'string' && d.trim()) return d.trim();
  // Claude Code falls back to the first non-empty body line.
  const line = (parsed.body || '').split('\n').find((l) => l.trim());
  return line ? line.replace(/^#+\s*/, '').trim() : '';
}

function entryFor(dir, dirName, scope, status) {
  let symlinkTarget = null;
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      try {
        symlinkTarget = realpathSync(dir);
      } catch {
        return { kind: 'broken-link', scope, status, dirName, name: dirName, path: dir, fileName: null, parsed: null,
          description: '', symlinkTarget: '(missing)', record: null, override: null, shadowedBy: null };
      }
    }
  } catch {
    return null;
  }
  const { fileName, parsed } = readSkill(dir);
  const fmName = parsed?.data?.name;
  const name = typeof fmName === 'string' && fmName.trim() ? fmName.trim() : dirName;
  return {
    kind: fileName ? 'skill' : 'not-skill',
    scope, status, dirName, name, path: dir, fileName, parsed,
    description: describe(parsed), symlinkTarget, record: null, override: null, shadowedBy: null,
  };
}

function listDir(dir) {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

function isDirLike(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    try {
      return lstatSync(p).isSymbolicLink(); // broken link: still report it
    } catch {
      return false;
    }
  }
}

/** All entries (skills and non-skill folders) in one scope, enabled and disabled. */
export function scanScope(scope) {
  const state = loadState(scope);
  /** @type {Entry[]} */
  const entries = [];
  for (const [base, status] of [[scope.skillsDir, 'enabled'], [scope.disabledDir, 'disabled']]) {
    for (const dirName of listDir(base)) {
      const p = join(base, dirName);
      if (!isDirLike(p)) continue;
      const e = entryFor(p, dirName, scope.scope, status);
      if (!e) continue;
      e.record = state.skills[dirName] || null;
      e.projectRoot = scope.scope === 'project' ? scope.root : null;
      if (e.kind === 'not-skill' && dirName === 'synced' && scope.scope === 'user')
        e.note = 'claude.ai synced skills (managed by Claude Code)';
      entries.push(e);
    }
  }
  return entries;
}

/**
 * Skills shipped by installed plugins (read-only), one entry per skill per install record.
 * `status`/`pluginState` are the plugin's on/off state where it belongs (for another project's install, in that
 * project); whether it loads where skm runs is `pluginInfo.applicable`.
 * @param {import('./context.js').Context} ctx
 * @param {import('./plugins.js').Plugin[]} [plugins]
 */
export function scanPlugins(ctx, plugins = discoverPlugins(ctx)) {
  const entries = [];
  for (const plugin of plugins) {
    for (const p of plugin.skillDirs) {
      const e = entryFor(p, basename(p), 'plugin', plugin.enabled ? 'enabled' : 'disabled');
      if (!e || e.kind !== 'skill') continue;
      e.plugin = plugin.id;
      e.pluginInfo = plugin;
      e.pluginState = plugin.state;
      e.name = `${plugin.skillPrefix}:${e.name}`;
      entries.push(e);
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.plugin.localeCompare(b.plugin));
}

/**
 * Error for trying to change a single plugin skill. Claude Code's skillOverrides does not apply to
 * plugin skills (code.claude.com/docs/en/skills), so the only switch is the whole plugin.
 */
export function pluginSkillError(entry, action) {
  const { name } = entry.pluginInfo || { name: entry.plugin.split('@')[0] };
  const already = (action === 'disable') === !loadsHere(entry.pluginInfo);
  if (already && (action === 'enable' || action === 'disable'))
    return new SkmError(`"${entry.name}" comes from the plugin ${entry.plugin}, which is already ${action}d here.`, {
      hint: "Claude Code's skillOverrides setting does not apply to plugin skills; see \"skm plugin list\" for what decides each plugin.",
    });
  if (action === 'enable' || action === 'disable')
    return new SkmError(`"${entry.name}" comes from the plugin ${entry.plugin}; single plugin skills can't be ${action}d.`, {
      hint: [
        "Claude Code's skillOverrides setting does not apply to plugin skills, so a plugin is on or off as a whole.",
        `Turn the whole plugin ${action === 'enable' ? 'on' : 'off'}: skm plugin ${action} ${entry.plugin}`,
      ],
    });
  return new SkmError(`"${entry.name}" comes from the plugin ${entry.plugin} and is read-only.`, {
    hint: [`Switch the plugin with "skm plugin disable ${name}", or remove it with "claude plugin uninstall ${entry.plugin}".`],
  });
}

/** Merged skillOverrides from user, project and local settings (later wins). */
export function readSkillOverrides(ctx) {
  const files = [...ctx.user.settingsFiles, ...(ctx.project?.settingsFiles || [])];
  const merged = {};
  for (const f of files) {
    const o = readJson(f, null)?.skillOverrides;
    if (o && typeof o === 'object') Object.assign(merged, o);
  }
  return merged;
}

/**
 * Everything skill-manager knows about, with shadowing and settings overrides applied.
 * @param {import('./context.js').Context} ctx
 * @param {{scopes?: import('./context.js').ScopeInfo[], plugins?: boolean}} [opts]
 * @returns {Entry[]}
 */
export function collect(ctx, { scopes, plugins = false } = {}) {
  const all = [];
  const scopeList = scopes || [ctx.user, ...(ctx.project ? [ctx.project] : [])];
  for (const s of scopeList) all.push(...scanScope(s));
  if (plugins) all.push(...scanPlugins(ctx));
  const overrides = readSkillOverrides(ctx);
  // skillOverrides does not apply to plugin skills (Claude Code docs), so only user/project skills get one.
  for (const e of all) if (e.kind === 'skill' && e.scope !== 'plugin' && overrides[e.name]) e.override = overrides[e.name];
  // Claude Code precedence: personal (user) skills win over project skills with the same name.
  const userNames = new Set(
    (scopes && !scopes.includes(ctx.user) ? scanScope(ctx.user) : all)
      .filter((e) => e.scope === 'user' && e.kind === 'skill' && e.status === 'enabled')
      .map((e) => e.name.toLowerCase()),
  );
  for (const e of all)
    if (e.scope === 'project' && e.kind === 'skill' && e.status === 'enabled' && userNames.has(e.name.toLowerCase()))
      e.shadowedBy = 'user';
  return all;
}

const matches = (e, name) => {
  const n = name.toLowerCase();
  return e.dirName.toLowerCase() === n || e.name.toLowerCase() === n;
};

/**
 * Resolve a user-typed name to exactly one managed skill.
 * @param {import('./context.js').Context} ctx
 * @param {string} name
 * @param {{user?: boolean, project?: boolean, status?: 'enabled'|'disabled', action?: string}} [opts]
 * @returns {Promise<Entry>}
 */
export async function resolveSkill(ctx, name, opts = {}) {
  const scopes = opts.user && !opts.project ? [ctx.user] : opts.project && !opts.user ? [ctx.project] : undefined;
  if (opts.project && !ctx.project) {
    const { noProjectError } = await import('./context.js');
    throw noProjectError(ctx);
  }
  const all = collect(ctx, { scopes });
  let found = all.filter((e) => e.kind !== 'not-skill' && matches(e, name));
  if (opts.status) {
    const withStatus = found.filter((e) => e.status === opts.status);
    if (withStatus.length) found = withStatus;
  }
  if (found.length === 1) return opts.multiple ? found : found[0];
  if (found.length > 1 && opts.multiple && !isInteractive()) return found;
  if (found.length === 0) {
    const nonSkill = all.find((e) => e.kind === 'not-skill' && e.dirName.toLowerCase() === name.toLowerCase());
    if (nonSkill)
      throw new SkmError(`"${name}" is not a skill (no SKILL.md) — skill-manager leaves it alone.`, {
        hint: nonSkill.note ? `${tildify(nonSkill.path)}: ${nonSkill.note}` : tildify(nonSkill.path),
      });
    const plugin = scanPlugins(ctx).find((e) => matches(e, name) || e.dirName.toLowerCase() === name.toLowerCase());
    if (plugin) throw pluginSkillError(plugin, opts.action);
    const everything = collect(ctx).filter((e) => e.kind === 'skill');
    const sugg = didYouMean(name, everything.flatMap((e) => [e.dirName, e.name]));
    const where = scopes ? `${scopes[0].scope} scope` : 'user or project scope';
    const hint = sugg.length ? [`Did you mean: ${sugg.join(', ')}?`] : [];
    hint.push('Run "skm list" to see installed skills.');
    throw new SkmError(`No skill named "${name}" in ${where}.`, { hint });
  }
  // Ambiguous: same name in several places.
  if (isInteractive()) {
    const chosen = await prompt.select(
      `"${name}" exists in more than one place. Which one${opts.action ? ` do you want to ${opts.action}` : ''}?`,
      found.map((e) => ({ value: e, label: `${entryScope(e)} ${e.status}`, hint: tildify(e.path) })),
    );
    return opts.multiple ? [chosen] : chosen;
  }
  const label = (e) => `${e.scope} (${e.status}) ${tildify(e.path)}`;
  throw new SkmError(`"${name}" is ambiguous — found ${found.length} matches:`, {
    hint: [...found.map(label), 'Pick one with --user or --project.'],
  });
}
