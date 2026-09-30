import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import pc from 'picocolors';
import { checkNewName, isReservedName, isSafeDirName, validateSkillData } from '../frontmatter.js';
import { copySkillDir, hashDir } from '../fsutil.js';
import { existingIn, placeSkill, resolveConflict, rewriteName } from '../ops.js';
import { collect, readSkill, resolveSkill } from '../skills.js';
import { discoverSkills, fetchSource, parseSource } from '../sources.js';
import { SkmError, clack, didYouMean, isInteractive, out, plural, prompt, scopeColor, tildify, truncate } from '../ui.js';
import { chooseTargetScope, printIssues } from './common.js';

/** Folder-name fallback for a skill found at the root of a (possibly temporary) source copy. */
export function rootNameFor(src) {
  const strip = (s) => s.replace(/\.(zip|skill|md|git)$/i, '');
  if (src.type === 'local-file')
    return /^skill\.md$/i.test(basename(src.path)) ? basename(dirname(src.path)) : strip(basename(src.path));
  if (src.type === 'local-dir') return basename(src.path);
  if (src.type === 'archive') return strip(basename((src.path || src.url).split(/[?#]/)[0]));
  return strip(basename(String(src.url || '').replace(/\/+$/, '')));
}

/** Read + validate every discovered skill folder. */
function inspect(found, root, rootName) {
  return found.map((f) => {
    const { fileName, parsed } = readSkill(f.dir);
    const fmName = typeof parsed?.data?.name === 'string' ? parsed.data.name.trim() : '';
    const dirName = f.dir === root && rootName ? rootName : basename(f.dir);
    const name = fmName || dirName;
    // Validate as if installed under its target folder name (= its skill name).
    const issues = validateSkillData({ dirName: name, fileName, parsed });
    const description = typeof parsed?.data?.description === 'string' ? parsed.data.description : '';
    return { ...f, name, description, issues, ok: !issues.some((i) => i.level === 'error') };
  });
}

async function pickSkills(candidates, opts, sourceLabel) {
  if (candidates.length === 1) return candidates;
  if (opts.skill?.length) {
    const wanted = opts.skill.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    const picked = [];
    for (const w of wanted) {
      const c = candidates.find((x) => x.name === w || basename(x.dir) === w || x.rel === w);
      if (!c) {
        const sugg = didYouMean(w, candidates.map((x) => x.name));
        throw new SkmError(`No skill "${w}" in ${sourceLabel}.`, {
          hint: [sugg.length ? `Did you mean: ${sugg.join(', ')}?` : '', `Available: ${candidates.map((x) => x.name).join(', ')}`].filter(Boolean),
        });
      }
      picked.push(c);
    }
    return picked;
  }
  if (opts.all) return candidates;
  if (!isInteractive())
    throw new SkmError(`${sourceLabel} contains ${candidates.length} skills. Choose which to install.`, {
      hint: [
        ...candidates.map((c) => {
          const w = Math.max(...candidates.map((x) => x.name.length + (x.ok ? 0 : 10)));
          return `  ${(c.name + (c.ok ? '' : ' (invalid)')).padEnd(w)}  ${truncate(c.description, 60)}`;
        }),
        'Use --all, or --skill <name> (repeatable / comma-separated).',
      ],
    });
  return prompt.multiselect(
    `${sourceLabel} contains ${candidates.length} skills. Pick the ones to install (space to toggle, a = all):`,
    candidates.map((c) => ({
      value: c,
      label: c.ok ? c.name : `${c.name} ${pc.red('(invalid)')}`,
      hint: truncate(c.description || c.rel, 70),
      disabled: !c.ok,
    })),
    [],
    true,
  );
}

/**
 * Install one or more skills from a source.
 * @returns {Promise<{installed: string[], skipped: string[], failed: string[]}>}
 */
export async function installCommand(ctx, sourceInput, opts = {}) {
  const src = parseSource(sourceInput, { cwd: ctx.cwd, env: ctx.env, ref: opts.ref });
  const spin = isInteractive() && src.type !== 'local-dir' ? clack.spinner() : null;
  spin?.start(`Fetching ${src.display}`);
  let fetched;
  try {
    fetched = await fetchSource(src);
  } catch (e) {
    spin?.stop('Fetch failed', 1);
    throw e;
  }
  spin?.stop(`Fetched ${src.display}`);
  const result = { installed: [], skipped: [], failed: [] };
  try {
    const found = discoverSkills(fetched.root, fetched.subpath ?? src.subpath);
    if (!found.length)
      throw new SkmError(`No SKILL.md found in ${src.display}${src.subpath ? '/' + src.subpath : ''}.`, {
        hint: 'A skill is a folder containing a SKILL.md file with name/description frontmatter.',
      });

    const candidates = inspect(found, fetched.root, rootNameFor(src));

    let chosen = await pickSkills(candidates, opts, src.display);
    if (opts.name) {
      if (chosen.length !== 1) throw new SkmError('--name can only be used when installing a single skill.');
      const err = checkNewName(opts.name);
      if (err) throw new SkmError(`Invalid --name: ${err}.`);
      chosen = [{ ...chosen[0], name: opts.name, renamed: opts.name }];
    }

    // Validation gate.
    for (const c of chosen) {
      if (!c.ok) {
        out.error(`${c.name}: SKILL.md is invalid — not installing.`);
        printIssues(c.issues.filter((i) => i.level === 'error'));
        result.failed.push(c.name);
      } else if (!isSafeDirName(c.name) || isReservedName(c.name)) {
        out.error(`${c.name}: cannot be used as a skill folder name.`);
        result.failed.push(c.name);
      }
    }
    chosen = chosen.filter((c) => !result.failed.includes(c.name));
    if (!chosen.length) throw new SkmError('Nothing to install.', { exitCode: 1 });

    const scope = await chooseTargetScope(ctx, opts, 'install');
    const other = scope.scope === 'user' ? ctx.project : ctx.user;
    const otherNames = other ? new Set(collect(ctx, { scopes: [other] }).filter((e) => e.kind === 'skill').map((e) => e.name.toLowerCase())) : new Set();

    for (const c of chosen) {
      const existing = existingIn(scope, c.name);
      let replace = [];
      if (existing.length) {
        const decision = await resolveConflict(`"${c.name}" (${scope.scope} scope)`, opts);
        if (decision === 'skip') {
          out.warn(`Skipped ${c.name}: already installed in ${scope.scope} scope.${opts.force || isInteractive() ? '' : ' Use --force to overwrite.'}`);
          result.skipped.push(c.name);
          continue;
        }
        replace = existing;
      }
      const warnings = c.issues.filter((i) => i.level !== 'error' && i.code !== 'name-mismatch');
      const target = tildify(`${scope.skillsDir}/${c.name}`);
      if (opts.dryRun) {
        out.dry(`install ${pc.bold(c.name)} ${pc.dim('→')} ${target}${replace.length ? pc.yellow(' (overwrite)') : ''}`);
        if (warnings.length) printIssues(warnings);
        result.installed.push(c.name);
        continue;
      }
      const record = {
        source: {
          type: src.type, input: src.input, url: src.url, path: src.path,
          ref: fetched.ref ?? src.ref, subpath: c.rel || undefined,
        },
        commit: fetched.commit,
        renamed: c.renamed,
        installedAt: new Date().toISOString(),
      };
      placeSkill(ctx, scope, c.dir, c.name, { record, replace, rename: c.renamed });
      out.success(`Installed ${pc.bold(c.name)} ${pc.dim('→')} ${target} ${pc.dim(`(${scopeColor(scope.scope)})`)}`);
      if (warnings.length) printIssues(warnings);
      if (otherNames.has(c.name.toLowerCase()))
        out.warn(scope.scope === 'project'
          ? `A user skill named "${c.name}" also exists and takes precedence over this project copy.`
          : `A project skill named "${c.name}" also exists; this user copy takes precedence.`);
      result.installed.push(c.name);
    }
    if (result.installed.length && !opts.dryRun) {
      const names = result.installed.map((n) => '/' + n).join(', ');
      out.log(pc.dim(`Claude Code picks this up automatically (use ${names}, or let Claude invoke it).`));
    }
    return result;
  } finally {
    fetched.cleanup();
  }
}

/** Re-pull skills from their recorded source. */
export async function updateCommand(ctx, names, opts = {}) {
  let targets;
  if (names?.length) {
    targets = [];
    for (const n of names) targets.push(await resolveSkill(ctx, n, { ...opts, action: 'update' }));
  } else {
    const scopes = opts.user ? [ctx.user] : opts.project ? [ctx.project] : undefined;
    targets = collect(ctx, { scopes }).filter((e) => e.kind === 'skill');
  }
  const summary = { updated: [], current: [], skipped: [], failed: [] };
  const cache = new Map();
  try {
    for (const e of targets) {
      const scope = e.scope === 'user' ? ctx.user : ctx.project;
      const rec = e.record;
      if (!rec?.source || rec.source.type === 'scaffold') {
        if (names?.length)
          out.warn(`${e.name}: no recorded install source (created locally or installed by hand) — skipping.`);
        summary.skipped.push(e.name);
        continue;
      }
      let src;
      try {
        src = { ...rec.source };
        if (src.type === 'local-dir' || src.type === 'local-file' || (src.type === 'archive' && src.path)) {
          const p = parseSource(src.path, { cwd: ctx.cwd, env: ctx.env });
          Object.assign(src, p, { subpath: rec.source.subpath });
        } else if (src.type === 'archive') {
          src.display = src.url;
        } else {
          src.display = src.url;
          src.subpath = undefined;
          src.treePath = undefined;
        }
      } catch (err) {
        out.error(`${e.name}: source is gone (${rec.source.path || rec.source.url}).`);
        summary.failed.push(e.name);
        continue;
      }
      const key = `${src.type}|${src.url || src.path}|${src.ref || ''}`;
      let fetched = cache.get(key);
      if (!fetched) {
        const spin = isInteractive() ? clack.spinner() : null;
        spin?.start(`Fetching ${src.display}`);
        try {
          fetched = await fetchSource(src);
          spin?.stop(`Fetched ${src.display}`);
        } catch (err) {
          spin?.stop('Fetch failed', 1);
          out.error(`${e.name}: ${err.message}`);
          summary.failed.push(e.name);
          continue;
        }
        cache.set(key, fetched);
      }
      // Locate the skill again inside the fresh copy: recorded sub-path first, then by name.
      let dir;
      const all = discoverSkills(fetched.root);
      const bySub = all.find((f) => f.rel === (rec.source.subpath || ''));
      if (bySub) dir = bySub.dir;
      else {
        const byName = inspect(all, fetched.root, rootNameFor(src)).find((c) => c.name === e.dirName || c.name === e.name);
        dir = byName?.dir;
      }
      if (!dir) {
        out.error(`${e.name}: no longer found in ${src.display}.`);
        summary.failed.push(e.name);
        continue;
      }
      const [candidate] = inspect([{ dir, rel: rec.source.subpath || '' }], fetched.root, e.dirName);
      if (!candidate.ok) {
        out.error(`${e.name}: the new version has an invalid SKILL.md — keeping the current one.`);
        printIssues(candidate.issues.filter((i) => i.level === 'error'));
        summary.failed.push(e.name);
        continue;
      }
      let newHash = hashDir(dir);
      if (rec.renamed) {
        const tmp = mkdtempSync(join(tmpdir(), 'skm-cmp-'));
        try {
          copySkillDir(dir, join(tmp, 's'));
          rewriteName(join(tmp, 's'), rec.renamed);
          newHash = hashDir(join(tmp, 's'));
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
      const curHash = hashDir(e.path);
      if (newHash === curHash) {
        out.log(`${pc.dim('=')} ${e.name} ${pc.dim(`(${e.scope}) is up to date`)}`);
        summary.current.push(e.name);
        continue;
      }
      if (rec.hash && rec.hash !== curHash && !opts.force) {
        const ok = isInteractive() && (await prompt.confirm(`${e.name} has local edits. Overwrite them with the upstream version?`, false));
        if (!ok) {
          out.warn(`${e.name}: has local edits — skipped. Use --force to overwrite (the old copy goes to the trash).`);
          summary.skipped.push(e.name);
          continue;
        }
      }
      if (opts.dryRun) {
        out.dry(`update ${pc.bold(e.name)} (${scopeColor(e.scope)})`);
        summary.updated.push(e.name);
        continue;
      }
      placeSkill(ctx, scope, dir, e.dirName, {
        status: e.status,
        rename: rec.renamed,
        replace: [{ path: e.path, status: e.status }],
        record: { ...rec, commit: fetched.commit ?? rec.commit, updatedAt: new Date().toISOString() },
      });
      out.success(`Updated ${pc.bold(e.name)} ${pc.dim(`(${e.scope}${e.status === 'disabled' ? ', disabled' : ''})`)}`);
      summary.updated.push(e.name);
    }
  } finally {
    for (const f of cache.values()) f.cleanup();
  }
  const bits = [];
  if (summary.updated.length) bits.push(pc.green(`${summary.updated.length} ${opts.dryRun ? 'would update' : 'updated'}`));
  if (summary.current.length) bits.push(`${summary.current.length} up to date`);
  if (summary.skipped.length) bits.push(pc.dim(`${summary.skipped.length} skipped${names?.length ? '' : ' (no recorded source)'}`));
  if (summary.failed.length) bits.push(pc.red(`${summary.failed.length} failed`));
  if (!targets.length) out.info('No skills to update.');
  else out.log(bits.join(pc.dim(' · ')) || `${plural(targets.length, 'skill')} checked`);
  if (summary.failed.length) process.exitCode = 1;
  return summary;
}
