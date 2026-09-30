// Skills synced from the user's claude.ai account (read-only).
//
// Verified against code.claude.com/docs/en/skills ("Skills synced from claude.ai", "Names reserved for synced
// skills", "Remove a skill") and settings-reference (syncClaudeAiSkills, skillOverrides), Sept 2026:
// - Claude Code downloads the skills enabled for the signed-in claude.ai account into ~/.claude/skills/synced/
//   and loads them "in later sessions signed in to the same account". A skill turned off on claude.ai is
//   removed at the next sync, so every skill on disk is one that is on for its account.
// - Each synced skill runs as /anthropic-skills:<name> (and as /<name> when nothing else uses the short name).
// - To turn one off you change it on claude.ai; files edited or deleted under skills/synced are overwritten or
//   re-downloaded by the next sync. `syncClaudeAiSkills: false` (user, local or managed settings) stops loading
//   all of them.
// - The docs name skillOverrides for personal, project and bundled skills and never for synced ones (their
//   removal path is claude.ai), so skill-manager does not write skillOverrides for them.
//
// On disk (observed, not documented): skills/synced/<orgUuid>_<accountUuid>/ per account ("bucket"), each with a
// manifest.json ({lastUpdated, skills: [{skillId, name, description, source, updatedAt, creatorType?}]}) and one
// <skillId>/SKILL.md folder per skill, plus hidden .bucket-<name> marker files next to the buckets. The account
// Claude Code is signed in to is oauthAccount.{organizationUuid, accountUuid} in the global config file
// (~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json), so the active bucket is "<organizationUuid>_<accountUuid>".
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, isDir } from './fsutil.js';
import { settingsLayers } from './plugins.js';
import { readSkill } from './skills.js';
import { SkmError } from './ui.js';

export const SYNCED_PREFIX = 'anthropic-skills';
const BUCKET_RE = /^([0-9a-f-]{36})_([0-9a-f-]{36})$/i;

/** Global Claude Code config file (holds the signed-in oauthAccount). */
export function globalConfigFile(ctx) {
  const inConfigDir = join(ctx.configDir, '.claude.json');
  const inHome = join(ctx.home, '.claude.json');
  if (ctx.env.CLAUDE_CONFIG_DIR) return existsSync(inConfigDir) ? inConfigDir : inHome;
  return existsSync(inHome) ? inHome : inConfigDir;
}

/**
 * The bucket folder name for the account Claude Code is signed in to, or null when it can't be told
 * (API-key sign-in, no config file, unexpected format).
 */
export function activeBucketName(ctx) {
  const acct = readJson(globalConfigFile(ctx), null)?.oauthAccount;
  const org = acct?.organizationUuid;
  const user = acct?.accountUuid;
  return typeof org === 'string' && typeof user === 'string' && org && user ? `${org}_${user}` : null;
}

/** First 8 characters of the org uuid; longer when two buckets would otherwise read the same. */
function shortIds(buckets) {
  const short = new Map();
  for (const b of buckets) {
    const m = BUCKET_RE.exec(b);
    const s = m ? m[1].slice(0, 8) : b.slice(0, 8);
    const clash = buckets.some((o) => o !== b && (BUCKET_RE.exec(o)?.[1].slice(0, 8) ?? o.slice(0, 8)) === s);
    short.set(b, clash && m ? `${s}_${m[2].slice(0, 8)}` : s);
  }
  return short;
}

/** `syncClaudeAiSkills: false` in user, local or managed settings stops Claude Code loading synced skills. */
function syncOffLayer(ctx) {
  return settingsLayers(ctx).filter((l) => l.scope !== 'project' && l.data?.syncClaudeAiSkills === false).pop() || null;
}

/**
 * One entry per synced skill per bucket.
 * `active` is true when the bucket belongs to the signed-in account (or when that can't be determined: then
 * every bucket counts as active). `status` is 'disabled' only when syncClaudeAiSkills: false turns them all off.
 * @param {import('./context.js').Context} ctx
 * @returns {import('./skills.js').Entry[]}
 */
export function scanSynced(ctx) {
  const root = join(ctx.configDir, 'skills', 'synced');
  let buckets = [];
  try {
    buckets = readdirSync(root).filter((n) => !n.startsWith('.') && isDir(join(root, n))).sort();
  } catch {
    return [];
  }
  if (!buckets.length) return [];
  const activeName = activeBucketName(ctx);
  const known = activeName && buckets.includes(activeName);
  const short = shortIds(buckets);
  const off = syncOffLayer(ctx);
  const entries = [];
  for (const bucket of buckets) {
    const dir = join(root, bucket);
    const manifest = readJson(join(dir, 'manifest.json'), null);
    const listed = Array.isArray(manifest?.skills) ? manifest.skills.filter((s) => s && typeof s === 'object') : [];
    let dirs = [];
    try {
      dirs = readdirSync(dir).filter((n) => !n.startsWith('.') && isDir(join(dir, n))).sort();
    } catch {
      continue;
    }
    for (const dirName of dirs) {
      const path = join(dir, dirName);
      const { fileName, parsed } = readSkill(path);
      const meta = listed.find((s) => s.skillId === dirName) || listed.find((s) => s.name === dirName) || null;
      if (!fileName && !meta) continue; // not a skill folder
      const fm = parsed?.data || {};
      const pick = (...v) => v.find((x) => typeof x === 'string' && x.trim())?.trim() || '';
      const shortName = pick(meta?.name, fm.name, dirName);
      entries.push({
        kind: 'skill', scope: 'synced', status: off ? 'disabled' : 'enabled', dirName, shortName,
        name: `${SYNCED_PREFIX}:${shortName}`, path, fileName, parsed,
        description: pick(meta?.description, fm.description), symlinkTarget: null, record: null, override: null,
        shadowedBy: null, bucket, bucketShort: short.get(bucket), active: known ? bucket === activeName : true,
        activeKnown: Boolean(known), syncOff: off ? { file: off.file, scope: off.scope } : null,
        synced: meta ? { source: meta.source, updatedAt: meta.updatedAt, creatorType: meta.creatorType } : null,
      });
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || Number(b.active) - Number(a.active) || a.bucket.localeCompare(b.bucket));
}

/** Does a user-typed name refer to this synced skill? (full name, short name or folder name) */
export function matchesSynced(e, name) {
  const n = name.toLowerCase();
  return e.name.toLowerCase() === n || e.shortName.toLowerCase() === n || e.dirName.toLowerCase() === n;
}

/** Refusal for any change to a synced skill: claude.ai owns it. */
export function syncedSkillError(entry, action = 'change') {
  const verb = { uninstall: 'removed', enable: 'enabled', disable: 'disabled', update: 'updated', move: 'moved', copy: 'copied' }[action] || 'changed';
  const hint = [];
  if (action === 'enable' && entry.syncOff)
    hint.push(`All synced skills are off: "syncClaudeAiSkills": false in ${entry.syncOff.file}. Remove that to load them again.`);
  else if (action === 'enable')
    hint.push('It is already on for its claude.ai account. Turn skills on in your skills settings on claude.ai (or Customize in the Claude desktop app).');
  else if (action === 'update')
    hint.push('Claude Code re-downloads it from claude.ai about every 10 minutes while a signed-in session runs.');
  else if (action === 'copy' || action === 'move')
    hint.push(`To make a local copy you own, copy the folder yourself: ${entry.path}`);
  else
    hint.push('Turn it off in your skills settings on claude.ai (or Customize in the Claude desktop app); the next sync removes it. Some Anthropic skills, such as pdf and xlsx, always sync.');
  if (action === 'disable' || action === 'uninstall') {
    hint.push('To stop loading every synced skill on this machine: set "syncClaudeAiSkills": false in ~/.claude/settings.json.');
    hint.push('Deleting files under ~/.claude/skills/synced does not stick: the next sync downloads them again.');
  }
  return new SkmError(`"${entry.name}" is synced from your claude.ai account and can't be ${verb} here — it's managed by claude.ai.`, { hint });
}

/** Refusal for the reserved skills/synced folder itself. */
export function syncedFolderError(path) {
  return new SkmError('"synced" is the folder where Claude Code keeps skills synced from claude.ai — skill-manager leaves it alone.', {
    hint: [path, 'List those skills with "skm list --claude-ai"; change them on claude.ai.'],
  });
}
