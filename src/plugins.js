// Installed Claude Code plugins and whether each one is on, decided the way Claude Code decides it.
//
// Verified against code.claude.com/docs (settings-reference#enabledplugins, plugins/loading
// "Find where a plugin is enabled", plugins/manifest-reference#defaultenabled, managed-settings), Sept 2026:
// - `enabledPlugins` maps "name@marketplace" to true/false. Sources merge key by key and, for each id, the
//   value from the highest-precedence source that mentions it applies:
//   user (~/.claude/settings.json) < project (.claude/settings.json) < local (.claude/settings.local.json)
//   < managed. Managed `true` force-enables and `false` blocks; nothing overrides it.
// - An id no source mentions follows the plugin's `defaultEnabled` (marketplace entry over plugin.json),
//   which defaults to true.
// - Plugins synced from claude.ai load as "<name>@synced" and obey the same key; `syncClaudeAiPlugins: false`
//   (user, local or managed) stops them loading.
// - `skillOverrides` does NOT apply to plugin skills; a plugin is switched on or off as a whole.
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { exists, isDir, readJson, timestamp } from './fsutil.js';
import { activeBucketName } from './synced.js';
import { SkmError, tildify } from './ui.js';

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** System folder holding managed-settings.json and managed-settings.d/ (SKM_MANAGED_SETTINGS_DIR overrides). */
export function managedSettingsDir(env = process.env) {
  if (env.SKM_MANAGED_SETTINGS_DIR) return resolve(env.SKM_MANAGED_SETTINGS_DIR);
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/** managed-settings.json first, then managed-settings.d/*.json alphabetically (later wins). */
export function managedSettingsFiles(env = process.env) {
  const dir = managedSettingsDir(env);
  const files = [join(dir, 'managed-settings.json')];
  try {
    const drop = join(dir, 'managed-settings.d');
    for (const n of readdirSync(drop).sort()) if (n.endsWith('.json') && !n.startsWith('.')) files.push(join(drop, n));
  } catch {
    /* no drop-ins */
  }
  return files;
}

/**
 * The settings files that decide plugin state for a project root (or none), lowest precedence first.
 * @returns {{scope: 'user'|'project'|'local'|'managed', file: string, data: object|null, error?: string}[]}
 */
export function settingsLayers(ctx, projectRoot = ctx.project?.root ?? null) {
  const layers = [{ scope: 'user', file: join(ctx.configDir, 'settings.json') }];
  if (projectRoot && real(join(projectRoot, '.claude')) !== real(ctx.configDir)) {
    layers.push({ scope: 'project', file: join(projectRoot, '.claude', 'settings.json') });
    layers.push({ scope: 'local', file: join(projectRoot, '.claude', 'settings.local.json') });
  }
  for (const file of managedSettingsFiles(ctx.env)) layers.push({ scope: 'managed', file });
  return layers.map((l) => ({ ...l, ...readSettings(l.file) }));
}

function readSettings(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { data: null };
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? { data } : { data: null, error: 'not a JSON object' };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

/**
 * Which layer decides `id`, and what it says.
 * @returns {{enabled: boolean, scope: string, file: string|null, value?: boolean}}
 */
export function resolveEnabled(id, layers, defaultEnabled = true) {
  let decided = null;
  for (const l of layers) {
    const v = l.data?.enabledPlugins?.[id];
    if (typeof v === 'boolean') decided = { enabled: v, scope: l.scope, file: l.file, value: v };
  }
  return decided || { enabled: defaultEnabled, scope: 'default', file: null };
}

/** `syncClaudeAiPlugins: false` in user, local or managed settings turns every synced plugin off. */
function syncedPluginsOff(layers) {
  return layers.some((l) => l.scope !== 'project' && l.data?.syncClaudeAiPlugins === false);
}

export const splitId = (id) => {
  const at = id.lastIndexOf('@');
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: '' };
};

/** Skill folders a plugin ships: skills/*, manifest `skills` paths, or a lone SKILL.md at the root. */
export function pluginSkillDirs(root, manifest) {
  const dirs = [];
  const hasSkill = (d) => {
    try {
      return readdirSync(d).some((n) => n.toLowerCase() === 'skill.md');
    } catch {
      return false;
    }
  };
  const scan = (base) => {
    if (hasSkill(base)) {
      dirs.push(base);
      return;
    }
    let names = [];
    try {
      names = readdirSync(base).filter((n) => !n.startsWith('.')).sort();
    } catch {
      return;
    }
    for (const n of names) if (isDir(join(base, n)) && hasSkill(join(base, n))) dirs.push(join(base, n));
  };
  const extra = manifest?.skills;
  const declared = typeof extra === 'string' ? [extra] : Array.isArray(extra) ? extra.filter((s) => typeof s === 'string') : [];
  if (isDir(join(root, 'skills'))) scan(join(root, 'skills'));
  for (const rel of declared) {
    const p = resolve(root, rel);
    if (p === root || p.startsWith(root + '/')) scan(p);
  }
  if (!dirs.length && !declared.length && hasSkill(root)) dirs.push(root);
  return [...new Set(dirs)];
}

function marketplaceEntries(ctx, cache, marketplace) {
  if (cache.has(marketplace)) return cache.get(marketplace);
  const known = readJson(join(ctx.pluginsDir, 'known_marketplaces.json'), {})?.[marketplace];
  const base = known?.installLocation || join(ctx.pluginsDir, 'marketplaces', marketplace);
  const list = readJson(join(base, '.claude-plugin', 'marketplace.json'), null)?.plugins;
  const entries = Array.isArray(list) ? list : [];
  cache.set(marketplace, entries);
  return entries;
}

/** defaultEnabled: the marketplace entry's value wins over plugin.json's; both default to true. */
function defaultEnabledFor(ctx, cache, name, marketplace, manifest) {
  const entry = marketplace ? marketplaceEntries(ctx, cache, marketplace).find((p) => p?.name === name) : null;
  if (typeof entry?.defaultEnabled === 'boolean') return entry.defaultEnabled;
  if (typeof manifest?.defaultEnabled === 'boolean') return manifest.defaultEnabled;
  return true;
}

/**
 * @typedef {object} Plugin
 * @property {string} id            name@marketplace (name@synced for claude.ai plugins)
 * @property {string} name
 * @property {string} marketplace
 * @property {string} skillPrefix   namespace of its skills (manifest name, else the id's name)
 * @property {'user'|'project'|'local'|'managed'|'synced'} scope   install scope
 * @property {string|null} projectPath  for project/local installs
 * @property {boolean} applicable   loaded in the current context (false: installed for another project, or synced
 *                                  for a claude.ai account Claude Code is not signed in to)
 * @property {boolean} [otherAccount]  synced plugin from another claude.ai account's bucket
 * @property {string} [bucket]      synced plugins: the <org>_<account> bucket folder
 * @property {string} version
 * @property {string} installPath
 * @property {string[]} skillDirs
 * @property {boolean} enabled      on in the context it belongs to: for another project's install, what Claude Code
 *                                  decides when it runs in that project (user → its settings.json → its
 *                                  settings.local.json → managed)
 * @property {{scope: string, file: string|null, value?: boolean, reason?: string}} decidedBy
 * @property {'enabled'|'disabled'} state   always on/off; where it loads is `applicable` (location is not a state)
 */

/** True when the plugin is on in the directory skm runs in. */
export const loadsHere = (p) => Boolean(p?.applicable && p.enabled);

/** Every installed plugin, one row per install record (nothing de-duplicated), plus synced plugins. */
export function discoverPlugins(ctx) {
  const here = ctx.project ? real(ctx.project.root) : null;
  const layerCache = new Map();
  const layersFor = (root) => {
    const key = root || '';
    if (!layerCache.has(key)) layerCache.set(key, settingsLayers(ctx, root));
    return layerCache.get(key);
  };
  const mkCache = new Map();
  /** @type {Plugin[]} */
  const plugins = [];

  const installed = readJson(join(ctx.pluginsDir, 'installed_plugins.json'), null)?.plugins;
  if (installed && typeof installed === 'object') {
    for (const [id, installs] of Object.entries(installed)) {
      const { name, marketplace } = splitId(id);
      for (const inst of Array.isArray(installs) ? installs : [installs]) {
        if (!inst?.installPath) continue;
        const scope = inst.scope || 'user';
        const perProject = (scope === 'project' || scope === 'local') && inst.projectPath;
        const applicable = !perProject || real(inst.projectPath) === here;
        const root = perProject ? inst.projectPath : here;
        const manifest = readJson(join(inst.installPath, '.claude-plugin', 'plugin.json'), null);
        const dflt = defaultEnabledFor(ctx, mkCache, name, marketplace, manifest);
        const decidedBy = resolveEnabled(id, layersFor(applicable ? here : root), dflt);
        plugins.push({
          id, name, marketplace, skillPrefix: manifest?.name || name, scope,
          projectPath: perProject ? inst.projectPath : null, applicable,
          version: String(inst.version ?? manifest?.version ?? ''), installPath: inst.installPath,
          skillDirs: pluginSkillDirs(inst.installPath, manifest),
          enabled: decidedBy.enabled, decidedBy,
          state: decidedBy.enabled ? 'enabled' : 'disabled',
        });
      }
    }
  }

  // Plugins synced from claude.ai: <pluginsDir>/synced/<bucket>/<name>/, loaded as <name>@synced.
  const syncedRoot = join(ctx.pluginsDir, 'synced');
  let buckets = [];
  try {
    buckets = readdirSync(syncedRoot).filter((n) => !n.startsWith('.')).sort();
  } catch {
    /* none */
  }
  const layers = layersFor(here);
  const syncOff = syncedPluginsOff(layers);
  // Buckets are per claude.ai account (<org>_<account>); only the signed-in one loads. Unknown → treat all as live.
  const activeName = activeBucketName(ctx);
  const activeKnown = Boolean(activeName && buckets.includes(activeName));
  for (const b of buckets) {
    const bucket = join(syncedRoot, b);
    if (!isDir(bucket)) continue;
    const listing = readJson(join(bucket, 'manifest.json'), null)?.plugins;
    let names = [];
    try {
      names = readdirSync(bucket).filter((n) => !n.startsWith('.') && isDir(join(bucket, n))).sort();
    } catch {
      continue;
    }
    for (const dirName of names) {
      const installPath = join(bucket, dirName);
      const manifest = readJson(join(installPath, '.claude-plugin', 'plugin.json'), null);
      const name = manifest?.name || dirName;
      const id = `${name}@synced`;
      const meta = Array.isArray(listing) ? listing.find((p) => p?.name === name) : null;
      let decidedBy = resolveEnabled(id, layers, manifest?.defaultEnabled !== false);
      if (syncOff) {
        const l = layers.filter((x) => x.scope !== 'project' && x.data?.syncClaudeAiPlugins === false).pop();
        decidedBy = { enabled: false, scope: l.scope, file: l.file, reason: 'syncClaudeAiPlugins: false' };
      }
      plugins.push({
        id, name, marketplace: 'synced', skillPrefix: name, scope: 'synced', projectPath: null,
        applicable: !activeKnown || b === activeName, otherAccount: activeKnown && b !== activeName, bucket: b,
        version: String(meta?.version ?? manifest?.version ?? ''), installPath,
        skillDirs: pluginSkillDirs(installPath, manifest), enabled: decidedBy.enabled, decidedBy,
        state: decidedBy.enabled ? 'enabled' : 'disabled',
      });
    }
  }
  // An enabled plugin from any other origin with the same name wins over the synced copy.
  for (const p of plugins) {
    if (p.scope !== 'synced' || !p.enabled) continue;
    const other = plugins.find((o) => o.scope !== 'synced' && o.applicable && o.enabled && o.name === p.name);
    if (other) {
      p.enabled = false;
      p.state = 'disabled';
      p.decidedBy = { ...p.decidedBy, reason: `${other.id} is enabled and takes precedence` };
    }
  }
  return plugins.sort((a, b) => a.id.localeCompare(b.id) || Number(b.applicable) - Number(a.applicable));
}

/** Human description of what decided a plugin's state. */
export function decidedByLabel(p) {
  const d = p.decidedBy;
  if (d.reason && d.file) return `${tildify(d.file)} (${d.reason})`;
  if (d.reason) return d.reason;
  if (d.scope === 'default')
    return `default (defaultEnabled: ${p.enabled}${p.scope === 'synced' ? '; loads only when signed in with claude.ai' : ''})`;
  return `${tildify(d.file)}: ${d.value}`;
}

/** Settings file for a write target. */
export function settingsFileFor(ctx, target) {
  if (target === 'user') return join(ctx.configDir, 'settings.json');
  if (!ctx.project) return null;
  return join(ctx.project.claudeDir, target === 'local' ? 'settings.local.json' : 'settings.json');
}

function detectIndent(text) {
  const m = /^[ \t]+(?=")/m.exec(text);
  return m ? m[0] : 2;
}

/**
 * Set enabledPlugins entries in one settings file, keeping every other key.
 * Backs the old file up to <config>/skill-manager/backups first, then writes a temp file and renames it.
 * @param {Record<string, boolean>} changes
 * @returns {{changed: string[], backup: string|null, file: string}}
 */
export function writeEnabledPlugins(ctx, file, changes, { scope = 'user', dryRun = false } = {}) {
  let target = file;
  let text = null;
  if (exists(file)) {
    target = real(file); // write through a symlinked settings.json instead of replacing the link
    text = readFileSync(target, 'utf8');
  }
  let data = {};
  if (text !== null && text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new SkmError(`${tildify(file)} is not valid JSON, so skill-manager won't touch it.`, { hint: e.message });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new SkmError(`${tildify(file)} does not hold a JSON object, so skill-manager won't touch it.`);
  }
  const current = data.enabledPlugins && typeof data.enabledPlugins === 'object' ? data.enabledPlugins : {};
  const changed = Object.keys(changes).filter((id) => current[id] !== changes[id]);
  if (!changed.length || dryRun) return { changed, backup: null, file };
  data.enabledPlugins = { ...current };
  for (const id of changed) data.enabledPlugins[id] = changes[id];

  let backup = null;
  if (text !== null) {
    mkdirSync(ctx.backupDir, { recursive: true });
    backup = join(ctx.backupDir, `${timestamp()}__${scope}__${basename(file)}`);
    copyFileSync(target, backup);
    chmodSync(backup, statSync(target).mode & 0o777); // settings can hold tokens: keep 0600 files 0600
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.skm-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, text ? detectIndent(text) : 2) + '\n');
  try {
    if (text !== null) chmodSync(tmp, statSync(target).mode & 0o7777);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { changed, backup, file };
}
