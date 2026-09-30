import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import pc from 'picocolors';
import { selectedScopes } from '../context.js';
import { parseFrontmatter, validateSkillData } from '../frontmatter.js';
import { collect, readSkill } from '../skills.js';
import { loadState } from '../state.js';
import { SkmError, out, plural, scopeColor, tildify } from '../ui.js';
import { printIssues } from './common.js';

/**
 * Check installed skills (or a single path) for problems.
 * @returns {{errors: number, warnings: number, results: object[]}}
 */
export async function doctorCommand(ctx, target, opts = {}) {
  const results = [];
  const push = (label, path, issues, extra = {}) => results.push({ label, path, issues, ...extra });

  if (target) {
    // Validate an arbitrary folder / SKILL.md before installing it.
    const p = resolve(ctx.cwd, target);
    if (!existsSync(p)) throw new SkmError(`Path not found: ${target}`);
    const isFile = statSync(p).isFile();
    const dir = isFile ? dirname(p) : p;
    let parsed, fileName;
    if (isFile) {
      fileName = basename(p);
      parsed = parseFrontmatter(readFileSync(p, 'utf8'));
    } else ({ fileName, parsed } = readSkill(dir));
    const name = typeof parsed?.data?.name === 'string' ? parsed.data.name : basename(dir);
    push(name, dir, validateSkillData({ dirName: isFile && fileName !== 'SKILL.md' ? name : basename(dir), fileName: isFile ? 'SKILL.md' : fileName, parsed }));
  } else {
    const scopes = selectedScopes(ctx, opts);
    const entries = collect(ctx, { scopes });
    // Global checks need both scopes even if only one was selected.
    const allEntries = collect(ctx);
    for (const e of entries) {
      if (e.kind === 'not-skill') {
        if (opts.verbose) push(e.dirName, e.path, [{ level: 'info', code: 'not-skill', message: e.note || 'not a skill (no SKILL.md) — ignored' }], { scope: e.scope });
        continue;
      }
      if (e.kind === 'broken-link') {
        push(e.dirName, e.path, [{ level: 'error', code: 'broken-link', message: 'symlink points to a missing folder', hint: `Remove it: skm rm ${e.dirName}` }], { scope: e.scope });
        continue;
      }
      const issues = validateSkillData({ dirName: e.dirName, fileName: e.fileName, parsed: e.parsed });
      if (e.shadowedBy)
        issues.push({ level: 'warn', code: 'shadowed', message: `a user skill named "${e.name}" takes precedence over this project skill`,
          hint: 'Claude Code: personal skills win over project skills. Rename one, or remove the user copy.' });
      if (e.status === 'enabled' && allEntries.some((o) => o.path !== e.path && o.scope === e.scope && o.status === 'enabled' && o.kind === 'skill' && o.name.toLowerCase() === e.name.toLowerCase()))
        issues.push({ level: 'warn', code: 'duplicate-in-scope', message: `another ${e.scope} skill also uses the name "${e.name}"`, hint: 'Only one of them will be reachable as /' + e.name });
      if (e.status === 'enabled' && e.override === 'off')
        issues.push({ level: 'info', code: 'override-off', message: 'hidden by "skillOverrides": "off" in Claude Code settings' });
      if (e.status === 'disabled' && allEntries.some((o) => o.scope === e.scope && o.status === 'enabled' && o.dirName === e.dirName))
        issues.push({ level: 'warn', code: 'enabled-and-disabled', message: 'both an enabled and a disabled copy exist', hint: `Remove one: skm rm ${e.dirName} --${e.scope}` });
      if (e.status === 'enabled' && e.scope === 'user' && allEntries.some((o) => o.scope === 'project' && o.status === 'enabled' && o.kind === 'skill' && o.name.toLowerCase() === e.name.toLowerCase()))
        issues.push({ level: 'info', code: 'shadows-project', message: `shadows the project skill "${e.name}"` });
      push(e.name, e.path, issues, { scope: e.scope, status: e.status });
    }
    // Stale metadata.
    for (const s of scopes) {
      const state = loadState(s);
      for (const name of Object.keys(state.skills)) {
        if (!existsSync(join(s.skillsDir, name)) && !existsSync(join(s.disabledDir, name)))
          push(name, s.stateFile, [{ level: 'info', code: 'stale-record', message: `skill-manager has a record for "${name}" but the folder is gone`, hint: 'Harmless. It is cleaned up when you reinstall or uninstall.' }], { scope: s.scope });
      }
    }
  }

  const errors = results.reduce((n, r) => n + r.issues.filter((i) => i.level === 'error').length, 0);
  const warnings = results.reduce((n, r) => n + r.issues.filter((i) => i.level === 'warn').length, 0);
  if (opts.json) {
    out.log(JSON.stringify({ errors, warnings, results }, null, 2));
  } else {
    let clean = 0;
    for (const r of results) {
      const relevant = r.issues.filter((i) => opts.verbose || i.level !== 'info');
      if (!relevant.length) {
        clean++;
        if (opts.verbose || target) out.log(`${pc.green('✔')} ${pc.bold(r.label)} ${r.scope ? scopeColor(r.scope) : ''}`);
        continue;
      }
      const worst = relevant.some((i) => i.level === 'error') ? pc.red('✖') : relevant.some((i) => i.level === 'warn') ? pc.yellow('▲') : pc.cyan('ℹ');
      out.log(`${worst} ${pc.bold(r.label)} ${r.scope ? scopeColor(r.scope) : ''} ${pc.dim(tildify(r.path))}`);
      printIssues(relevant, '    ');
    }
    if (results.length) out.blank();
    const summary = `${plural(results.length, target ? 'skill' : 'item')} checked · ${errors ? pc.red(plural(errors, 'error')) : '0 errors'} · ${warnings ? pc.yellow(plural(warnings, 'warning')) : '0 warnings'}`;
    out.log(errors || warnings ? summary : `${pc.green('✔')} ${summary}${!target && clean ? pc.dim(' — all good') : ''}`);
  }
  if (errors) process.exitCode = 1;
  return { errors, warnings, results };
}
