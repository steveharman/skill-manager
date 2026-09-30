// Turning an install source string into a folder on disk, and finding skills inside it.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { findSkillFile } from './skills.js';
import { SkmError } from './ui.js';

const exec = promisify(execFile);
const ARCHIVE_RE = /\.(zip|skill)$/i;

/**
 * @typedef {{type: 'local-dir'|'local-file'|'archive'|'git', input: string, path?: string, url?: string,
 *   ref?: string, subpath?: string, treePath?: string[], display: string}} Source
 */

function expandHome(p, env) {
  return p === '~' || p.startsWith('~/') ? join(env.HOME || '', p.slice(1)) : p;
}

/**
 * @param {string} input
 * @param {{cwd?: string, env?: object, ref?: string}} [opts]
 * @returns {Source}
 */
export function parseSource(input, { cwd = process.cwd(), env = process.env, ref } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new SkmError('No install source given.', { hint: 'Example: skm install ./my-skill' });

  // 1. Local paths win when they exist (so "owner/repo" only means GitHub if no such folder exists).
  const looksLocal = /^(\.{1,2}[\\/]|[\\/]|~[\\/]?|[A-Za-z]:[\\/])/.test(raw) || raw === '.' || raw === '..';
  const localPath = resolve(cwd, expandHome(raw, env));
  if (looksLocal || existsSync(localPath)) {
    if (!existsSync(localPath))
      throw new SkmError(`Path not found: ${raw}`, { hint: 'Check the path, or use owner/repo for GitHub sources.' });
    const st = statSync(localPath);
    if (st.isDirectory()) return { type: 'local-dir', input: raw, path: localPath, display: localPath };
    if (ARCHIVE_RE.test(localPath)) return { type: 'archive', input: raw, path: localPath, display: basename(localPath) };
    if (/\.md$/i.test(localPath)) return { type: 'local-file', input: raw, path: localPath, display: localPath };
    throw new SkmError(`Don't know how to install ${basename(localPath)}.`, {
      hint: 'Use a skill folder, a SKILL.md file, a .zip/.skill archive, a git URL or owner/repo.',
    });
  }

  // 2. Remote archive.
  if (/^https?:\/\//i.test(raw) && ARCHIVE_RE.test(raw.split(/[?#]/)[0]))
    return { type: 'archive', input: raw, url: raw, display: raw };

  // 3. GitHub tree/blob URL: https://github.com/o/r/tree/<ref>/<path>
  const tree = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/(tree|blob)\/([^?#]+)/i.exec(raw);
  if (tree) {
    const [, owner, repo, kind, rest] = tree;
    let segs = rest.split('/').filter(Boolean).map(decodeURIComponent);
    if (kind === 'blob' && /\.md$/i.test(segs.at(-1) || '')) segs = segs.slice(0, -1);
    return { type: 'git', input: raw, url: `https://github.com/${owner}/${repo}.git`, treePath: segs, ref,
      display: `github:${owner}/${repo}` };
  }

  // 4. Any git URL, optional #subpath.
  const [urlPart, frag] = raw.split('#');
  if (/^(https?|ssh|git|file):\/\//i.test(urlPart) || /^[\w.-]+@[\w.-]+:/.test(urlPart) || /\.git$/i.test(urlPart)) {
    const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(urlPart);
    const url = gh ? `https://github.com/${gh[1]}/${gh[2]}.git` : urlPart;
    return { type: 'git', input: raw, url, ref, subpath: cleanSub(frag), display: gh ? `github:${gh[1]}/${gh[2]}` : urlPart };
  }

  // 5. GitHub shorthand: owner/repo[/path][#path] or github:owner/repo
  const sh = /^(?:github:)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([\w.-]+?)(?:\.git)?((?:\/[^#]+)?)(?:#(.+))?$/.exec(raw);
  if (sh) {
    const [, owner, repo, path, frag2] = sh;
    return { type: 'git', input: raw, url: `https://github.com/${owner}/${repo}.git`, ref,
      subpath: cleanSub(path || frag2), display: `github:${owner}/${repo}` };
  }

  throw new SkmError(`Could not understand the source "${raw}".`, {
    hint: [
      'Supported sources:',
      '  ./path/to/skill            a folder with SKILL.md (or a repo with many skills)',
      '  ./SKILL.md                 a single skill file',
      '  ./skill.zip | x.skill      an archive',
      '  owner/repo[/path]          GitHub shorthand',
      '  https://github.com/o/r/tree/main/skills/foo',
      '  https://host/repo.git#sub/path   any git URL',
    ],
  });
}

function cleanSub(s) {
  if (!s) return undefined;
  const c = s.replace(/^\/+|\/+$/g, '');
  if (!c) return undefined;
  if (normalize(c).split(sep).includes('..')) throw new SkmError('Sub-paths cannot contain "..".');
  return c;
}

async function git(args, opts = {}) {
  try {
    return await exec('git', args, {
      ...opts,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    if (e.code === 'ENOENT') throw new SkmError('git is not installed or not on PATH.', { hint: 'Install git to use git sources.' });
    throw e;
  }
}

/** Decide which leading tree-URL segments are the ref (branch names may contain slashes). */
async function splitTreePath(url, segs) {
  let refs = [];
  try {
    const { stdout } = await git(['ls-remote', '--heads', '--tags', url]);
    refs = stdout.split('\n').map((l) => l.split('\t')[1]).filter(Boolean)
      .map((r) => r.replace(/^refs\/(heads|tags)\//, '').replace(/\^\{\}$/, ''));
  } catch (e) {
    throw gitError(url, e);
  }
  for (let i = segs.length; i >= 1; i--) {
    const candidate = segs.slice(0, i).join('/');
    if (refs.includes(candidate)) return { ref: candidate, subpath: segs.slice(i).join('/') || undefined };
  }
  // Probably a commit SHA or unknown ref: treat first segment as ref.
  return { ref: segs[0], subpath: segs.slice(1).join('/') || undefined };
}

function gitError(url, e) {
  const msg = String(e.stderr || e.message || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
  return new SkmError(`Could not fetch ${url}`, {
    hint: [msg, 'Check the URL and your network. The repo may not exist or may be private; for private repos use an SSH URL (git@github.com:owner/repo.git).'].filter(Boolean),
  });
}

/**
 * Materialise a source into a local folder.
 * @param {Source} src
 * @returns {Promise<{root: string, subpath?: string, ref?: string, commit?: string, cleanup: () => void}>}
 */
export async function fetchSource(src) {
  if (src.type === 'local-dir') return { root: src.path, cleanup: () => {} };

  const tmp = mkdtempSync(join(tmpdir(), 'skm-'));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    if (src.type === 'local-file') {
      const dir = join(tmp, 'skill');
      mkdirSync(dir);
      writeFileSync(join(dir, 'SKILL.md'), readFileSync(src.path));
      return { root: dir, cleanup };
    }
    if (src.type === 'archive') {
      let buf;
      if (src.url) {
        const res = await fetch(src.url).catch((e) => {
          throw new SkmError(`Download failed: ${e.message}`);
        });
        if (!res.ok) throw new SkmError(`Download failed: HTTP ${res.status} for ${src.url}`);
        buf = new Uint8Array(await res.arrayBuffer());
      } else buf = new Uint8Array(readFileSync(src.path));
      extractZip(buf, join(tmp, 'x'));
      return { root: join(tmp, 'x'), cleanup };
    }
    // git
    let { ref, subpath } = src;
    if (src.treePath) ({ ref, subpath } = src.ref ? { ref: src.ref, subpath: src.treePath.join('/') } : await splitTreePath(src.url, src.treePath));
    const dest = join(tmp, 'repo');
    const args = ['clone', '--depth', '1', '--quiet'];
    if (ref) args.push('--branch', ref);
    args.push(src.url, dest);
    try {
      await git(args);
    } catch (e) {
      // `--branch` does not accept commit SHAs; fall back to a full fetch of that commit.
      if (ref && /^[0-9a-f]{7,40}$/i.test(ref)) {
        try {
          await git(['init', '--quiet', dest]);
          await git(['-C', dest, 'fetch', '--quiet', '--depth', '1', src.url, ref]);
          await git(['-C', dest, 'checkout', '--quiet', 'FETCH_HEAD']);
        } catch (e2) {
          throw gitError(src.url, e2);
        }
      } else throw gitError(src.url, e);
    }
    const { stdout } = await git(['-C', dest, 'rev-parse', 'HEAD']);
    return { root: dest, subpath, ref, commit: stdout.trim(), cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Unzip with zip-slip protection. */
export function extractZip(buf, dest) {
  let files;
  try {
    files = unzipSync(buf);
  } catch (e) {
    throw new SkmError(`Not a valid zip archive (${e.message}).`);
  }
  mkdirSync(dest, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store') continue;
    const target = resolve(dest, name);
    if (isAbsolute(name) || !target.startsWith(resolve(dest) + sep)) throw new SkmError(`Archive contains an unsafe path: ${name}`);
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '__MACOSX', '.venv', 'venv', 'dist', 'build']);

/**
 * Find skill folders under root (optionally within subpath). A folder with SKILL.md is a skill;
 * we do not descend into it.
 * @returns {{dir: string, rel: string}[]}
 */
export function discoverSkills(root, subpath, maxDepth = 6) {
  const base = subpath ? join(root, subpath) : root;
  if (!existsSync(base)) {
    const all = discoverSkills(root, undefined, maxDepth);
    throw new SkmError(`"${subpath}" was not found in the source.`, {
      hint: all.length ? ['Skills found in this source:', ...all.map((s) => `  ${s.rel || '.'}`)] : undefined,
    });
  }
  const found = [];
  const walk = (dir, depth) => {
    if (findSkillFile(dir)) {
      found.push({ dir, rel: relative(root, dir).split(sep).join('/') });
      return;
    }
    if (depth >= maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)))
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(join(dir, e.name), depth + 1);
  };
  walk(base, 0);
  return found;
}
