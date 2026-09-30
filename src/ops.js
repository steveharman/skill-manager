// Mutating building blocks shared by commands. Callers handle --dry-run before calling these.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copySkillDir, exists, hashDir, movePath, readJson, timestamp, writeJsonAtomic } from './fsutil.js';
import { getRecord, removeRecord, setRecord } from './state.js';
import { findSkillFile, pluginSkillError } from './skills.js';
import { SkmError, isInteractive, prompt, scopeColor } from './ui.js';

/** Set the frontmatter `name:` of a skill folder (used by install --name). */
export function rewriteName(dir, newName) {
  const file = join(dir, findSkillFile(dir) || 'SKILL.md');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end === -1) return;
  const idx = lines.findIndex((l, i) => i > 0 && i < end && /^name\s*:/.test(l));
  if (idx === -1) lines.splice(1, 0, `name: ${newName}`);
  else lines[idx] = `name: ${newName}`;
  writeFileSync(file, lines.join('\n'));
}

/** Where an entry of this scope/status lives. */
export const dirFor = (scope, status, dirName) =>
  join(status === 'disabled' ? scope.disabledDir : scope.skillsDir, dirName);

/**
 * Move a skill folder into the trash, with enough metadata to restore it.
 * @returns {string} trash item path
 */
export function trashSkill(ctx, scope, entryPath, dirName, status, reason = 'uninstall') {
  const item = join(ctx.trashDir, `${timestamp()}__${scope.scope}__${dirName}`);
  const record = getRecord(scope, dirName);
  movePath(entryPath, join(item, 'skill'));
  writeJsonAtomic(join(item, 'meta.json'), {
    name: dirName, scope: scope.scope, status, originalPath: entryPath,
    projectRoot: scope.scope === 'project' ? scope.root : undefined,
    record, reason, trashedAt: new Date().toISOString(),
  });
  return item;
}

export function listTrash(ctx) {
  let names = [];
  try {
    names = readdirSync(ctx.trashDir);
  } catch {
    return [];
  }
  return names
    .map((n) => ({ id: n, path: join(ctx.trashDir, n), meta: readJson(join(ctx.trashDir, n, 'meta.json'), null) }))
    .filter((t) => t.meta && existsSync(join(t.path, 'skill')))
    .sort((a, b) => b.id.localeCompare(a.id));
}

export function emptyTrashItem(item) {
  rmSync(item.path, { recursive: true, force: true });
}

/**
 * Ask how to handle a name clash. Returns 'overwrite' | 'skip'.
 * Non-interactive: overwrite only with --force.
 */
export async function resolveConflict(what, { force }) {
  if (force) return 'overwrite';
  if (!isInteractive()) return 'skip';
  return prompt.select(`${what} already exists. What should happen?`, [
    { value: 'overwrite', label: 'Overwrite', hint: 'the old copy goes to the skill-manager trash' },
    { value: 'skip', label: 'Skip' },
  ], 'skip');
}

/** Existing enabled/disabled copies of a folder name in a scope. */
export function existingIn(scope, dirName) {
  return ['enabled', 'disabled']
    .map((status) => ({ status, path: dirFor(scope, status, dirName) }))
    .filter((x) => exists(x.path));
}

/**
 * Copy a validated skill folder into a scope, replacing (trashing) any existing copy.
 * @returns {{path: string, hash: string}}
 */
export function placeSkill(ctx, scope, srcDir, dirName, { status = 'enabled', record, replace = [], rename } = {}) {
  const target = dirFor(scope, status, dirName);
  // Stage next to (not inside) skills/ so Claude Code never sees a half-copied skill.
  const staging = join(scope.claudeDir, `.skm-staging-${dirName}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  copySkillDir(srcDir, staging);
  if (rename) rewriteName(staging, rename);
  try {
    for (const old of replace) trashSkill(ctx, scope, old.path, dirName, old.status, 'replaced');
    movePath(staging, target);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  const hash = hashDir(target);
  if (record) setRecord(scope, dirName, { ...record, hash });
  return { path: target, hash };
}

export function describeScope(scope) {
  return `${scopeColor(scope.scope)} scope`;
}

export function assertManaged(entry, action) {
  if (entry.scope === 'plugin') throw pluginSkillError(entry, action);
  if (entry.kind === 'not-skill') throw new SkmError(`"${entry.dirName}" is not a skill; leaving it alone.`);
}

export { removeRecord };
