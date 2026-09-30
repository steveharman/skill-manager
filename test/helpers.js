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
  const managed = join(root, 'managed'); // never the machine's real managed-settings.json
  const env = { PATH: process.env.PATH, HOME: home, SKM_NO_INPUT: '1', NO_COLOR: '1', TMPDIR: process.env.TMPDIR || tmpdir(),
    SKM_MANAGED_SETTINGS_DIR: managed };
  return {
    root, home, project, src, env, managed,
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

/**
 * Record a plugin install the way Claude Code does (installed_plugins.json + a cache folder with skills).
 * @returns {string} install path
 */
export function installPlugin(home, id, { scope = 'user', projectPath, skills = ['s1'], version = '1.0.0', manifest } = {}) {
  const [name, marketplace] = id.split('@');
  const pluginsDir = join(home, '.claude', 'plugins');
  const installPath = join(pluginsDir, 'cache', marketplace, name, version);
  for (const s of skills) writeSkill(join(installPath, 'skills', s), { name: s });
  if (manifest) {
    mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
    writeFileSync(join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, ...manifest }));
  }
  const file = join(pluginsDir, 'installed_plugins.json');
  let data = { version: 2, plugins: {} };
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* first install */
  }
  (data.plugins[id] ||= []).push({ scope, installPath, version, ...(projectPath ? { projectPath } : {}) });
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
  return installPath;
}

/** Write a settings.json-style file. */
export function writeSettings(file, data, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text ?? JSON.stringify(data, null, 2) + '\n');
  return file;
}

export const ORG_A = '3d0a8465-ab81-4162-93bf-9d3079518e11';
export const ACCT_A = 'ba7a8649-2f05-4d52-960f-9cfd56a249cf';
export const ORG_B = '57a2e8c8-ac61-4723-b920-be0bc1ee3eb6';
export const ACCT_B = 'd79d73e5-7622-4ffa-9585-d7edf74bdc71';

/**
 * A claude.ai sync bucket the way Claude Code writes it: <config>/skills/synced/<org>_<account>/ with a
 * manifest.json, one folder per skill and a hidden .bucket-<name> marker next to it.
 * @param {string} configDir  the .claude folder
 * @param {{name: string, description?: string, inManifest?: boolean, fm?: string}[]} skills
 * @returns {string} bucket path
 */
export function makeSyncedBucket(configDir, org, account, skills) {
  const root = join(configDir, 'skills', 'synced');
  const bucket = `${org}_${account}`;
  const dir = join(root, bucket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, `.bucket-${bucket}`), '');
  writeFileSync(join(dir, '.last-complete-round'), 'round cli');
  const manifest = { lastUpdated: 1790766625370, skills: [] };
  for (const s of skills) {
    writeSkill(join(dir, s.name), { raw: s.fm ?? `---\nname: ${s.name}\ndescription: "Frontmatter text for ${s.name}."\n---\n\nBody.\n` });
    if (s.inManifest !== false)
      manifest.skills.push({ skillId: s.name, name: s.name, description: s.description ?? `Manifest text for ${s.name}.`,
        source: 'anthropic', updatedAt: '2026-09-22T18:00:37.886566Z' });
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

/** The global config Claude Code keeps next to HOME (~/.claude.json), signed in to one org/account. */
export function signIn(file, org, account) {
  writeFileSync(file, JSON.stringify({ oauthAccount: { organizationUuid: org, accountUuid: account, emailAddress: 'x@y' } }));
}
