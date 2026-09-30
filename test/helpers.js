import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'skm.js');

/** A sandbox with a fake HOME and a project folder. Never touches the real ~/.claude. */
export function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skm-test-')));
  const home = join(root, 'home');
  const project = join(root, 'project');
  const src = join(root, 'src');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(src, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, SKM_NO_INPUT: '1', NO_COLOR: '1', TMPDIR: process.env.TMPDIR || tmpdir() };
  return {
    root, home, project, src, env,
    userSkills: join(home, '.claude', 'skills'),
    userDisabled: join(home, '.claude', 'skills-disabled'),
    projectSkills: join(project, '.claude', 'skills'),
    projectDisabled: join(project, '.claude', 'skills-disabled'),
    /** Run the CLI. Returns {code, stdout, stderr, out} (out = stdout+stderr). */
    run(args, { cwd = project, env: extra = {} } = {}) {
      const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function writeSkill(dir, { name, description = `The ${name} skill. Use when testing.`, body = 'Instructions.\n', raw } = {}) {
  mkdirSync(dir, { recursive: true });
  const text = raw ?? `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  writeFileSync(join(dir, 'SKILL.md'), text);
  return dir;
}

/** A non-skill folder like ~/.claude/skills/synced: UUID subdirs plus hidden .bucket-* files. */
export function makeSyncedDir(skillsDir) {
  const d = join(skillsDir, 'synced');
  const uuid = '3d0a8465-ab81-4162-93bf-9d3079518e11_ba7a8649';
  mkdirSync(join(d, uuid), { recursive: true });
  writeFileSync(join(d, `.bucket-${uuid}`), 'bucket-data');
  writeFileSync(join(d, uuid, 'data.bin'), 'payload');
  return d;
}

/** Snapshot of every file/dir under p (path -> content or 'dir'). */
export function snapshot(p) {
  const outMap = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      const st = statSync(f);
      if (st.isDirectory()) {
        outMap[relative(p, f)] = 'dir';
        walk(f);
      } else outMap[relative(p, f)] = readFileSync(f, 'utf8');
    }
  };
  walk(p);
  return outMap;
}

export function gitRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return {
    url: 'file://' + dir,
    commit(filesUpdate) {
      for (const [rel, content] of Object.entries(filesUpdate)) writeFileSync(join(dir, rel), content);
      g('add', '-A');
      g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'update');
    },
  };
}

export const skillMd = (name, description = `The ${name} skill.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`;
