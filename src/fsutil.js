// Filesystem helpers: safe moves across devices, hashing, sizes.
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const exists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

export const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Move a file/dir/symlink. Falls back to copy+remove across filesystems. */
export function movePath(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  try {
    renameSync(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    rmSync(src, { recursive: true, force: true });
  }
}

const SKIP_ON_INSTALL = new Set(['.git', 'node_modules', '.DS_Store']);

/** Copy a skill folder for installation, dereferencing symlinks and skipping VCS junk. */
export function copySkillDir(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, {
    recursive: true,
    dereference: true,
    filter: (s) => !SKIP_ON_INSTALL.has(s.split(/[\\/]/).pop()),
  });
}

/** All files under dir, relative, sorted. Does not follow symlinked dirs. */
export function listFiles(dir) {
  const outFiles = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_ON_INSTALL.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else outFiles.push(relative(dir, p));
    }
  };
  walk(dir);
  return outFiles.sort();
}

export function dirSize(dir) {
  let total = 0;
  for (const f of listFiles(dir)) {
    try {
      total += lstatSync(join(dir, f)).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

/** Content hash of a skill folder: stable across copies and machines. */
export function hashDir(dir) {
  const h = createHash('sha256');
  for (const f of listFiles(dir)) {
    const p = join(dir, f);
    h.update(f.split('\\').join('/') + '\0');
    const st = lstatSync(p);
    h.update(st.isSymbolicLink() ? 'link:' + readlinkSync(p) : readFileSync(p));
    h.update('\0');
  }
  return h.digest('hex');
}

export function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, p);
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
