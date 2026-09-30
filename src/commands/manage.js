import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { getScope } from '../context.js';
import { checkNewName } from '../frontmatter.js';
import { exists, movePath } from '../fsutil.js';
import { assertManaged, dirFor, emptyTrashItem, existingIn, listTrash, resolveConflict, trashSkill } from '../ops.js';
import { collect, resolveSkill } from '../skills.js';
import { getRecord, removeRecord, setRecord } from '../state.js';
import { SkmError, didYouMean, isInteractive, out, plural, prompt, scopeColor, tildify } from '../ui.js';
import { chooseTargetScope } from './common.js';

const scopeOf = (ctx, e) => (e.scope === 'user' ? ctx.user : ctx.project);

export async function uninstallCommand(ctx, names, opts = {}) {
  const entries = [];
  for (const n of names) {
    const e = await resolveSkill(ctx, n, { ...opts, action: 'uninstall' });
    assertManaged(e, 'uninstall');
    if (!entries.some((x) => x.path === e.path)) entries.push(e);
  }
  out.log(`${opts.dryRun ? 'Would remove' : 'About to remove'} ${plural(entries.length, 'skill')}:`);
  for (const e of entries) out.log(`  ${pc.bold(e.name)} ${pc.dim(`${e.scope} · ${tildify(e.path)}`)}`);
  if (opts.dryRun) {
    out.dry(`move ${plural(entries.length, 'skill')} to ${tildify(ctx.trashDir)}`);
    return;
  }
  if (!opts.yes) {
    if (!isInteractive())
      throw new SkmError('Refusing to uninstall without confirmation in a non-interactive shell.', { hint: 'Re-run with -y / --yes.' });
    const ok = await prompt.confirm(`Remove ${entries.length === 1 ? 'it' : 'them'}? (they go to the skill-manager trash and can be restored)`, false);
    if (!ok) {
      out.info('Nothing removed.');
      return;
    }
  }
  for (const e of entries) {
    const scope = scopeOf(ctx, e);
    const item = trashSkill(ctx, scope, e.path, e.dirName, e.status);
    removeRecord(scope, e.dirName);
    out.success(`Removed ${pc.bold(e.name)} ${pc.dim(`(${e.scope})`)}`);
    out.hint(`Restore with: skm restore ${e.dirName}   (${tildify(item)})`);
  }
}

async function toggle(ctx, names, opts, to) {
  const verb = to === 'enabled' ? 'enable' : 'disable';
  if (!names.length) {
    if (!isInteractive()) throw new SkmError(`Which skill should I ${verb}?`, { hint: `skm ${verb} <name...>` });
    const pool = collect(ctx).filter((e) => e.kind === 'skill' && e.status !== to);
    if (!pool.length) {
      out.info(`Nothing to ${verb}: every skill is already ${to}.`);
      return;
    }
    const picked = await prompt.multiselect(`Select skills to ${verb}:`,
      pool.map((e) => ({ value: e, label: e.name, hint: e.scope })), [], true);
    return toggleEntries(ctx, picked, opts, to);
  }
  const entries = [];
  for (const n of names) entries.push(await resolveSkill(ctx, n, { ...opts, status: to === 'enabled' ? 'disabled' : 'enabled', action: verb }));
  return toggleEntries(ctx, entries, opts, to);
}

function toggleEntries(ctx, entries, opts, to) {
  const verb = to === 'enabled' ? 'Enabled' : 'Disabled';
  for (const e of entries) {
    assertManaged(e, to === 'enabled' ? 'enable' : 'disable');
    if (e.status === to) {
      out.info(`${e.name} is already ${to} ${pc.dim(`(${e.scope})`)}`);
      continue;
    }
    const scope = scopeOf(ctx, e);
    const dest = dirFor(scope, to, e.dirName);
    if (exists(dest))
      throw new SkmError(`Cannot ${to === 'enabled' ? 'enable' : 'disable'} ${e.name}: ${tildify(dest)} already exists.`, {
        hint: 'Two copies with the same folder name exist. Remove one with "skm rm".',
      });
    if (opts.dryRun) {
      out.dry(`${to === 'enabled' ? 'enable' : 'disable'} ${pc.bold(e.name)}: ${tildify(e.path)} ${pc.dim('→')} ${tildify(dest)}`);
      continue;
    }
    movePath(e.path, dest);
    out.success(`${verb} ${pc.bold(e.name)} ${pc.dim(`(${e.scope})`)}`);
    if (to === 'enabled' && e.override === 'off')
      out.warn(`${e.name} is still hidden by "skillOverrides": {"${e.name}": "off"} in your Claude Code settings.`);
  }
}

export const enableCommand = (ctx, names, opts) => toggle(ctx, names, opts, 'enabled');
export const disableCommand = (ctx, names, opts) => toggle(ctx, names, opts, 'disabled');

export async function transferCommand(ctx, name, opts, mode) {
  if (!opts.to) {
    if (!isInteractive()) throw new SkmError(`Where to? Pass --to user or --to project.`);
  }
  const e = await resolveSkill(ctx, name, {
    user: opts.from === 'user' || opts.user, project: opts.from === 'project' || opts.project, action: mode,
  });
  assertManaged(e, mode);
  const toName = opts.to || (e.scope === 'user' ? 'project' : 'user');
  const dest = getScope(ctx, toName);
  const src = scopeOf(ctx, e);
  if (dest.scope === src.scope) throw new SkmError(`${e.name} is already in ${toName} scope.`);
  const existing = existingIn(dest, e.dirName);
  if (existing.length) {
    const decision = await resolveConflict(`"${e.dirName}" in ${toName} scope`, opts);
    if (decision === 'skip') {
      out.warn(`Skipped: ${e.dirName} already exists in ${toName} scope.${opts.force ? '' : ' Use --force to overwrite.'}`);
      return;
    }
  }
  const target = dirFor(dest, e.status, e.dirName);
  const verb = mode === 'move' ? 'Moved' : 'Copied';
  if (opts.dryRun) {
    out.dry(`${mode} ${pc.bold(e.name)}: ${tildify(e.path)} ${pc.dim('→')} ${tildify(target)}`);
    return;
  }
  for (const old of existing) trashSkill(ctx, dest, old.path, e.dirName, old.status, 'replaced');
  const rec = getRecord(src, e.dirName);
  if (mode === 'move') {
    movePath(e.path, target);
    removeRecord(src, e.dirName);
  } else {
    mkdirSync(join(target, '..'), { recursive: true });
    cpSync(e.path, target, { recursive: true, verbatimSymlinks: true });
  }
  if (rec) setRecord(dest, e.dirName, rec);
  out.success(`${verb} ${pc.bold(e.name)} ${scopeColor(e.scope)} ${pc.dim('→')} ${scopeColor(dest.scope)} ${pc.dim(tildify(target))}`);
  if (dest.scope === 'project' && collect(ctx, { scopes: [ctx.user] }).some((x) => x.kind === 'skill' && x.status === 'enabled' && x.name === e.name))
    out.warn(`The user copy of "${e.name}" still exists and takes precedence over the project copy.`);
}

const TEMPLATE = (name, description) => `---
name: ${name}
description: ${description}
---

# ${name
  .split('-')
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join(' ')}

## When to use

Describe the situations where Claude should use this skill.

## Instructions

1. Step one.
2. Step two.

## Examples

- Example request: "..."
`;

export async function newCommand(ctx, name, opts = {}) {
  if (!name) {
    if (!isInteractive()) throw new SkmError('Give the new skill a name.', { hint: 'skm new my-skill' });
    name = await prompt.text('Skill name', { placeholder: 'my-skill', validate: (v) => checkNewName(v) || undefined });
  }
  const err = checkNewName(name);
  if (err) {
    const fixed = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    throw new SkmError(`Invalid skill name "${name}": ${err}.`, { hint: fixed && !checkNewName(fixed) ? `Try: skm new ${fixed}` : undefined });
  }
  let description = opts.description;
  if (!description && isInteractive())
    description = await prompt.text('Description — what it does and when Claude should use it', {
      placeholder: 'Use when …',
      validate: (v) => (v && v.length > 1024 ? 'Keep it under 1024 characters' : undefined),
    });
  description = (description || 'TODO: what this skill does and when Claude should use it.').replace(/\n/g, ' ');
  const scope = await chooseTargetScope(ctx, opts, 'new');
  const target = join(scope.skillsDir, name);
  if (existingIn(scope, name).length)
    throw new SkmError(`A skill named "${name}" already exists in ${scope.scope} scope.`, { hint: `Edit it: ${tildify(join(target, 'SKILL.md'))}` });
  const yamlDesc = /[:#{}[\],&*?|<>=!%@`'"]|^\s|\s$/.test(description) ? JSON.stringify(description) : description;
  const file = join(target, 'SKILL.md');
  if (opts.dryRun) {
    out.dry(`create ${tildify(file)}`);
    return;
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(file, TEMPLATE(name, yamlDesc));
  setRecord(scope, name, { source: { type: 'scaffold' }, installedAt: new Date().toISOString() });
  out.success(`Created ${pc.bold(name)} in ${scopeColor(scope.scope)} scope`);
  out.log(`  ${tildify(file)}`);
  const editor = ctx.env.VISUAL || ctx.env.EDITOR;
  let open = opts.edit;
  if (open === undefined && editor && isInteractive()) open = await prompt.confirm(`Open it in ${editor}?`, true);
  if (open) {
    if (!editor) {
      out.warn('Set $EDITOR (or $VISUAL) to open files automatically.');
      return;
    }
    const r = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
    if (r.status !== 0) out.warn(`${editor} exited with code ${r.status}.`);
  } else out.hint('Edit the file, then check it with: skm doctor');
}

export async function trashCommand(ctx, opts = {}) {
  const items = listTrash(ctx);
  if (opts.empty) {
    if (!items.length) return out.info('Trash is already empty.');
    if (opts.dryRun) return out.dry(`permanently delete ${plural(items.length, 'item')} in ${tildify(ctx.trashDir)}`);
    if (!opts.yes) {
      if (!isInteractive()) throw new SkmError('Refusing to empty the trash without confirmation.', { hint: 'Re-run with -y.' });
      if (!(await prompt.confirm(`Permanently delete ${plural(items.length, 'item')}? This cannot be undone.`, false))) return;
    }
    for (const i of items) emptyTrashItem(i);
    return out.success(`Emptied the trash (${plural(items.length, 'item')}).`);
  }
  if (opts.json) return out.log(JSON.stringify(items.map((i) => ({ id: i.id, ...i.meta })), null, 2));
  if (!items.length) return out.info(`Trash is empty ${pc.dim(`(${tildify(ctx.trashDir)})`)}`);
  for (const i of items)
    out.log(`${pc.bold(i.meta.name)} ${pc.dim('·')} ${scopeColor(i.meta.scope)} ${pc.dim(`· ${i.meta.reason} · ${i.meta.trashedAt}`)}`);
  out.blank();
  out.log(pc.dim(`Restore with "skm restore <name>". Items live in ${tildify(ctx.trashDir)}.`));
}

export async function restoreCommand(ctx, name, opts = {}) {
  const items = listTrash(ctx).filter((i) => i.meta.name === name || i.id === name);
  if (!items.length) {
    const sugg = didYouMean(name, listTrash(ctx).map((i) => i.meta.name));
    throw new SkmError(`Nothing named "${name}" in the trash.`, {
      hint: sugg.length ? `Did you mean: ${sugg.join(', ')}?` : 'See what is there with "skm trash".',
    });
  }
  const item = items[0]; // newest
  const { meta } = item;
  let scope;
  if (opts.to) scope = getScope(ctx, opts.to);
  else if (meta.scope === 'user') scope = ctx.user;
  else if (ctx.project && ctx.project.root === meta.projectRoot) scope = ctx.project;
  else throw new SkmError(`${name} came from another project (${tildify(meta.projectRoot)}).`, { hint: 'Run from that project, or pass --to user|project.' });
  const status = meta.status === 'disabled' ? 'disabled' : 'enabled';
  const target = dirFor(scope, status, meta.name);
  if (existingIn(scope, meta.name).length)
    throw new SkmError(`${meta.name} already exists in ${scope.scope} scope.`, { hint: 'Uninstall or rename the current copy first.' });
  if (opts.dryRun) return out.dry(`restore ${meta.name} → ${tildify(target)}`);
  movePath(join(item.path, 'skill'), target);
  if (meta.record) setRecord(scope, meta.name, meta.record);
  emptyTrashItem(item);
  out.success(`Restored ${pc.bold(meta.name)} → ${tildify(target)}${status === 'disabled' ? pc.dim(' (disabled)') : ''}`);
}
