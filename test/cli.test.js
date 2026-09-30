import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { gitRepo, makeSyncedDir, sandbox, skillMd, snapshot, writeSkill } from './helpers.js';

let sb;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const json = (r) => {
  assert.equal(r.code, 0, r.out);
  return JSON.parse(r.stdout);
};

describe('list', () => {
  test('shows both scopes by default, filters by --user/--project, supports --json', () => {
    writeSkill(join(sb.userSkills, 'u1'), { name: 'u1' });
    writeSkill(join(sb.projectSkills, 'p1'), { name: 'p1' });
    const all = json(sb.run(['list', '--json']));
    assert.deepEqual(all.map((e) => `${e.scope}:${e.name}`).sort(), ['project:p1', 'user:u1']);
    assert.deepEqual(json(sb.run(['list', '--user', '--json'])).map((e) => e.name), ['u1']);
    assert.deepEqual(json(sb.run(['ls', '-p', '--json'])).map((e) => e.name), ['p1']);
    const table = sb.run(['list']);
    assert.equal(table.code, 0);
    assert.match(table.stdout, /NAME\s+SCOPE\s+STATUS\s+SOURCE\s+DESCRIPTION/);
    assert.match(table.stdout, /u1\s+user\s+enabled/);
  });

  test('a project skill\'s SCOPE is the project path (no "project" word); JSON keeps scope + projectPath', () => {
    const app = join(sb.home, 'work', 'myapp');
    mkdirSync(join(app, '.git'), { recursive: true });
    writeSkill(join(app, '.claude', 'skills', 'p1'), { name: 'p1', description: 'Project thing.' });
    const table = sb.run(['list'], { cwd: app });
    assert.equal(table.code, 0, table.out);
    assert.match(table.stdout, /p1\s+~\/work\/myapp\s+enabled/);
    assert.doesNotMatch(table.stdout, /p1\s+project\s/);
    assert.doesNotMatch(table.stdout, /installed for another project/, 'no legend without dimmed rows');
    const [row] = json(sb.run(['list', '--json'], { cwd: app }));
    assert.equal(row.scope, 'project');
    assert.equal(row.projectPath, app);
    assert.match(sb.run(['info', 'p1'], { cwd: app }).stdout, /scope\s+~\/work\/myapp/);
    assert.match(sb.run(['search', 'thing'], { cwd: app }).stdout, /p1 · ~\/work\/myapp/);
  });

  test('non-skill folders are hidden by default and flagged with --all', () => {
    makeSyncedDir(sb.userSkills);
    writeSkill(join(sb.userSkills, 'real'), { name: 'real' });
    assert.deepEqual(json(sb.run(['list', '--json'])).map((e) => e.name), ['real']);
    const all = json(sb.run(['list', '--all', '--json']));
    const synced = all.find((e) => e.dirName === 'synced');
    assert.equal(synced.status, 'not-skill');
    assert.match(sb.run(['list', '--all']).stdout, /synced\s+user\s+not a skill/);
  });

  test('--project outside a project gives a helpful error', () => {
    mkdirSync(join(sb.root, 'loose'));
    const r = sb.run(['list', '--project'], { cwd: join(sb.root, 'loose') });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No project found/);
    assert.match(r.stderr, /--project-dir/);
  });

  test('--project=<path> selects another project', () => {
    const other = join(sb.root, 'other');
    writeSkill(join(other, '.claude', 'skills', 'o1'), { name: 'o1' });
    assert.deepEqual(json(sb.run(['list', `--project=${other}`, '--json'])).map((e) => e.name), ['o1']);
  });

  test('CLAUDE_CONFIG_DIR replaces ~/.claude', () => {
    const cfg = join(sb.root, 'cfg');
    writeSkill(join(cfg, 'skills', 'c1'), { name: 'c1' });
    const r = sb.run(['list', '--user', '--json'], { env: { CLAUDE_CONFIG_DIR: cfg } });
    assert.deepEqual(json(r).map((e) => e.name), ['c1']);
  });

  test('plugin skills are listed read-only with --plugins', () => {
    const pluginDir = join(sb.home, '.claude', 'plugins', 'cache', 'mk', 'plug', '1.0.0');
    writeSkill(join(pluginDir, 'skills', 'pskill'), { name: 'pskill' });
    mkdirSync(join(sb.home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(sb.home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'plug@mk': [{ scope: 'user', installPath: pluginDir }] } }));
    assert.equal(json(sb.run(['list', '--json'])).length, 0);
    const withPlugins = json(sb.run(['list', '--plugins', '--json']));
    assert.equal(withPlugins[0].name, 'plug:pskill');
    const rm = sb.run(['rm', 'pskill', '-y']);
    assert.equal(rm.code, 1);
    assert.match(rm.stderr, /plugin/);
    assert.ok(existsSync(join(pluginDir, 'skills', 'pskill', 'SKILL.md')));
  });

  test('hint for hidden plugin skills names the full command', () => {
    const pluginDir = join(sb.home, '.claude', 'plugins', 'cache', 'mk', 'plug', '1.0.0');
    writeSkill(join(pluginDir, 'skills', 'pskill'), { name: 'pskill' });
    writeFileSync(join(sb.home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'plug@mk': [{ scope: 'user', installPath: pluginDir }] } }));
    writeSkill(join(sb.userSkills, 'u1'), { name: 'u1' });
    const r = sb.run(['list']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /\+ 1 plugin skill not shown \(run "skm list --plugins"\)\./);
  });

  test('bare list flags with no command run "skm list"', () => {
    const pluginDir = join(sb.home, '.claude', 'plugins', 'cache', 'mk', 'plug', '1.0.0');
    writeSkill(join(pluginDir, 'skills', 'pskill'), { name: 'pskill' });
    writeFileSync(join(sb.home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'plug@mk': [{ scope: 'user', installPath: pluginDir }] } }));
    writeSkill(join(sb.userSkills, 'u1'), { name: 'u1' });
    const plugins = sb.run(['--plugins']);
    assert.equal(plugins.code, 0, plugins.out);
    assert.match(plugins.stdout, /plug:pskill\s+user\s+enabled\s+plug@mk/, 'a plugin skill shows where its plugin is installed');
    assert.deepEqual(json(sb.run(['--json'])).map((e) => e.name), ['u1']);
    assert.deepEqual(json(sb.run(['--no-input', '--all', '--json'])).map((e) => e.name).sort(), ['plug:pskill', 'u1']);
    assert.deepEqual(json(sb.run(['--user', '--project-dir', sb.project, '--json'])).map((e) => e.name), ['u1']);
    // Anything that is not purely list flags is left to commander as before.
    const bad = sb.run(['--plugins', '--bogus']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /unknown option '--plugins'/);
    assert.match(sb.run(['--version']).stdout, /\d+\.\d+\.\d+/);
  });
});

describe('install', () => {
  test('from a local folder into user scope (default) and project scope', () => {
    const src = writeSkill(join(sb.src, 'hello'), { name: 'hello' });
    writeFileSync(join(src, 'helper.py'), 'print(1)');
    let r = sb.run(['install', src]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Installed hello/);
    assert.ok(existsSync(join(sb.userSkills, 'hello', 'SKILL.md')));
    assert.ok(existsSync(join(sb.userSkills, 'hello', 'helper.py')));
    const state = JSON.parse(readFileSync(join(sb.home, '.claude', 'skill-manager.json'), 'utf8'));
    assert.equal(state.skills.hello.source.type, 'local-dir');
    assert.equal(state.skills.hello.source.path, src);

    r = sb.run(['install', src, '--project']);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(sb.projectSkills, 'hello', 'SKILL.md')));
    assert.match(r.stderr, /user skill named "hello" also exists and takes precedence/);
  });

  test('from a single SKILL.md file and from a .zip archive', () => {
    writeSkill(join(sb.src, 'f'), { name: 'from-file' });
    assert.equal(sb.run(['install', join(sb.src, 'f', 'SKILL.md')]).code, 0);
    assert.ok(existsSync(join(sb.userSkills, 'from-file', 'SKILL.md')));

    const zip = zipSync({ 'zipped/SKILL.md': strToU8(skillMd('zipped')), 'zipped/ref/notes.md': strToU8('notes') });
    writeFileSync(join(sb.src, 'zipped.skill'), zip);
    const r = sb.run(['install', join(sb.src, 'zipped.skill')]);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(sb.userSkills, 'zipped', 'ref', 'notes.md')));
  });

  test('zip archives with unsafe paths are rejected', () => {
    writeFileSync(join(sb.src, 'evil.zip'), zipSync({ '../../evil/SKILL.md': strToU8(skillMd('evil')) }));
    const r = sb.run(['install', join(sb.src, 'evil.zip')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unsafe path/);
  });

  test('from a git repo with several skills: non-TTY asks for --all/--skill, subpath works', () => {
    const repo = gitRepo(join(sb.root, 'repo'), {
      'skills/alpha/SKILL.md': skillMd('alpha'),
      'skills/beta/SKILL.md': skillMd('beta'),
      'README.md': '# repo',
    });
    let r = sb.run(['install', repo.url]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /contains 2 skills/);
    assert.match(r.stderr, /--all/);

    r = sb.run(['install', repo.url, '--skill', 'alpah']);
    assert.match(r.stderr, /Did you mean: alpha/);

    r = sb.run(['install', `${repo.url}#skills/beta`]);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(sb.userSkills, 'beta', 'SKILL.md')));
    assert.ok(!existsSync(join(sb.userSkills, 'alpha')));

    r = sb.run(['install', repo.url, '--all', '--project']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readdirSync(sb.projectSkills).sort(), ['alpha', 'beta']);
    const state = JSON.parse(readFileSync(join(sb.project, '.claude', 'skill-manager.json'), 'utf8'));
    assert.equal(state.skills.alpha.source.subpath, 'skills/alpha');
    assert.match(state.skills.alpha.commit, /^[0-9a-f]{40}$/);
    assert.ok(!existsSync(join(sb.projectSkills, 'alpha', '.git')));
  });

  test('invalid SKILL.md is refused before anything is copied', () => {
    writeSkill(join(sb.src, 'bad'), { raw: 'no frontmatter at all\n' });
    const r = sb.run(['install', join(sb.src, 'bad')]);
    assert.equal(r.code, 1);
    assert.match(r.out, /no YAML frontmatter/);
    assert.ok(!existsSync(join(sb.userSkills, 'bad')));
  });

  test('conflicts: skipped without --force (non-TTY), replaced with --force (old copy trashed)', () => {
    const src = writeSkill(join(sb.src, 'dup'), { name: 'dup', body: 'v1' });
    assert.equal(sb.run(['install', src]).code, 0);
    writeSkill(src, { name: 'dup', body: 'v2' });
    let r = sb.run(['install', src]);
    assert.match(r.stderr, /Skipped dup/);
    assert.match(readFileSync(join(sb.userSkills, 'dup', 'SKILL.md'), 'utf8'), /v1/);
    r = sb.run(['install', src, '--force']);
    assert.equal(r.code, 0, r.out);
    assert.match(readFileSync(join(sb.userSkills, 'dup', 'SKILL.md'), 'utf8'), /v2/);
    assert.ok(sb.run(['trash']).stdout.includes('dup'));
  });

  test('--dry-run changes nothing', () => {
    const src = writeSkill(join(sb.src, 'dry'), { name: 'dry' });
    const before = snapshot(sb.home);
    const r = sb.run(['install', src, '--dry-run']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /dry run/);
    assert.deepEqual(snapshot(sb.home), before);
  });

  test('--name renames the folder and the frontmatter name', () => {
    const src = writeSkill(join(sb.src, 'orig'), { name: 'orig' });
    assert.equal(sb.run(['install', src, '--name', 'renamed']).code, 0);
    assert.match(readFileSync(join(sb.userSkills, 'renamed', 'SKILL.md'), 'utf8'), /^name: renamed$/m);
  });
});

describe('enable / disable', () => {
  test('disable moves to skills-disabled/, enable moves back; status shows in list', () => {
    writeSkill(join(sb.userSkills, 'tog'), { name: 'tog' });
    let r = sb.run(['disable', 'tog']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(join(sb.userSkills, 'tog')));
    assert.ok(existsSync(join(sb.userDisabled, 'tog', 'SKILL.md')));
    assert.equal(json(sb.run(['list', '--json']))[0].status, 'disabled');
    assert.match(sb.run(['disable', 'tog']).stdout, /already disabled/);

    r = sb.run(['enable', 'tog']);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(sb.userSkills, 'tog', 'SKILL.md')));
    assert.ok(!existsSync(join(sb.userDisabled, 'tog')));
  });

  test('project scope, several names, and --dry-run', () => {
    writeSkill(join(sb.projectSkills, 'a'), { name: 'a' });
    writeSkill(join(sb.projectSkills, 'b'), { name: 'b' });
    assert.equal(sb.run(['disable', 'a', 'b', '--dry-run']).code, 0);
    assert.ok(existsSync(join(sb.projectSkills, 'a')));
    assert.equal(sb.run(['disable', 'a', 'b']).code, 0);
    assert.deepEqual(readdirSync(sb.projectDisabled).sort(), ['a', 'b']);
  });

  test('same name in both scopes is ambiguous without a scope flag', () => {
    writeSkill(join(sb.userSkills, 'x'), { name: 'x' });
    writeSkill(join(sb.projectSkills, 'x'), { name: 'x' });
    const r = sb.run(['disable', 'x']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ambiguous/);
    assert.equal(sb.run(['disable', 'x', '--project']).code, 0);
    assert.ok(existsSync(join(sb.projectDisabled, 'x')));
    assert.ok(existsSync(join(sb.userSkills, 'x')));
  });

  test('typos get suggestions', () => {
    writeSkill(join(sb.userSkills, 'deploy'), { name: 'deploy' });
    const r = sb.run(['disable', 'deplyo']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Did you mean: deploy/);
  });
});

describe('uninstall / restore', () => {
  test('requires -y when not interactive, moves to trash, restore brings it back with its state', () => {
    const src = writeSkill(join(sb.src, 'gone'), { name: 'gone' });
    sb.run(['install', src]);
    let r = sb.run(['rm', 'gone']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /-y/);
    assert.ok(existsSync(join(sb.userSkills, 'gone')));

    r = sb.run(['uninstall', 'gone', '-y']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(join(sb.userSkills, 'gone')));
    const trash = join(sb.home, '.claude', 'skill-manager', 'trash');
    assert.equal(readdirSync(trash).length, 1);
    let state = JSON.parse(readFileSync(join(sb.home, '.claude', 'skill-manager.json'), 'utf8'));
    assert.equal(state.skills.gone, undefined);

    r = sb.run(['restore', 'gone']);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(sb.userSkills, 'gone', 'SKILL.md')));
    state = JSON.parse(readFileSync(join(sb.home, '.claude', 'skill-manager.json'), 'utf8'));
    assert.equal(state.skills.gone.source.type, 'local-dir');
  });

  test('uninstalling a disabled skill works and restores as disabled', () => {
    writeSkill(join(sb.userSkills, 'd'), { name: 'd' });
    sb.run(['disable', 'd']);
    assert.equal(sb.run(['rm', 'd', '-y']).code, 0);
    assert.ok(!existsSync(join(sb.userDisabled, 'd')));
    sb.run(['restore', 'd']);
    assert.ok(existsSync(join(sb.userDisabled, 'd', 'SKILL.md')));
  });
});

describe('update', () => {
  test('re-pulls from a local folder and from git; local edits need --force', () => {
    const src = writeSkill(join(sb.src, 'up'), { name: 'up', body: 'v1' });
    sb.run(['install', src]);
    writeSkill(src, { name: 'up', body: 'v2' });
    let r = sb.run(['update', 'up']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Updated up/);
    assert.match(readFileSync(join(sb.userSkills, 'up', 'SKILL.md'), 'utf8'), /v2/);
    assert.match(sb.run(['update', 'up']).stdout, /up to date/);

    const repo = gitRepo(join(sb.root, 'repo'), { 'skills/g/SKILL.md': skillMd('g', 'first') });
    sb.run(['install', repo.url]);
    repo.commit({ 'skills/g/SKILL.md': skillMd('g', 'second') });
    writeFileSync(join(sb.userSkills, 'g', 'local.txt'), 'my edit');
    r = sb.run(['update']);
    assert.match(r.stderr, /local edits/);
    assert.match(readFileSync(join(sb.userSkills, 'g', 'SKILL.md'), 'utf8'), /first/);
    r = sb.run(['update', 'g', '--force']);
    assert.equal(r.code, 0, r.out);
    assert.match(readFileSync(join(sb.userSkills, 'g', 'SKILL.md'), 'utf8'), /second/);
  });

  test('a disabled skill stays disabled after update', () => {
    const src = writeSkill(join(sb.src, 'dz'), { name: 'dz', body: 'v1' });
    sb.run(['install', src]);
    sb.run(['disable', 'dz']);
    writeSkill(src, { name: 'dz', body: 'v2' });
    assert.equal(sb.run(['update']).code, 0);
    assert.match(readFileSync(join(sb.userDisabled, 'dz', 'SKILL.md'), 'utf8'), /v2/);
    assert.ok(!existsSync(join(sb.userSkills, 'dz')));
  });
});

describe('doctor', () => {
  test('clean install passes with exit 0', () => {
    writeSkill(join(sb.userSkills, 'fine'), { name: 'fine' });
    const r = sb.run(['doctor']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /0 errors/);
  });

  test('finds missing frontmatter, name mismatch, long description, shadowing; exits 1 on errors', () => {
    writeSkill(join(sb.userSkills, 'nofm'), { raw: '# just markdown\n' });
    writeSkill(join(sb.userSkills, 'dir-name'), { name: 'other-name' });
    writeSkill(join(sb.userSkills, 'long'), { name: 'long', description: 'x'.repeat(1200) });
    writeSkill(join(sb.userSkills, 'shared'), { name: 'shared' });
    writeSkill(join(sb.projectSkills, 'shared'), { name: 'shared' });
    const r = sb.run(['doctor', '--json']);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.stdout);
    const codes = (label, scope) => report.results.find((x) => x.label === label && (!scope || x.scope === scope)).issues.map((i) => i.code);
    assert.ok(codes('nofm').includes('no-frontmatter'));
    assert.ok(codes('other-name').includes('name-mismatch'));
    assert.ok(codes('long').includes('long-description'));
    assert.ok(codes('shared', 'project').includes('shadowed'));
    assert.ok(report.errors >= 1);
    const human = sb.run(['doctor']);
    assert.match(human.stdout, /takes precedence over this project skill/);
  });

  test('validate <path> checks a folder before installing', () => {
    writeSkill(join(sb.src, 'v'), { name: 'v', description: '' });
    const r = sb.run(['validate', join(sb.src, 'v')]);
    assert.match(r.stdout, /no "description"/);
  });
});

describe('non-skill folders are never touched', () => {
  test('synced/ survives every command', () => {
    const synced = makeSyncedDir(sb.userSkills);
    const before = snapshot(synced);
    const src = writeSkill(join(sb.src, 'n'), { name: 'n' });
    const cmds = [
      ['list', '--all'], ['install', src], ['disable', 'n'], ['enable', 'n'], ['update'], ['doctor', '-V'],
      ['search', 'synced'], ['move', 'n', '--to', 'project'], ['move', 'n', '--to', 'user'], ['rm', 'n', '-y'],
      ['rm', 'synced', '-y'], ['disable', 'synced'], ['info', 'synced'], ['new', 'fresh'],
      ['install', src, '--name', 'synced'],
    ];
    for (const c of cmds) sb.run(c);
    assert.deepEqual(snapshot(synced), before);
    const rm = sb.run(['rm', 'synced', '-y']);
    assert.equal(rm.code, 1);
    assert.match(rm.stderr, /not a skill/);
    assert.match(sb.run(['install', src, '--name', 'synced']).stderr, /reserved/);
  });
});

describe('symlinked skills (like ~/.claude/skills/route)', () => {
  test('disable/enable/uninstall move the link, never the target', () => {
    const target = writeSkill(join(sb.root, 'elsewhere', 'linked'), { name: 'linked' });
    symlinkSync(target, join(sb.userSkills, 'linked'));
    const before = snapshot(join(sb.root, 'elsewhere'));
    assert.equal(json(sb.run(['list', '--json']))[0].symlinkTarget, target);
    assert.equal(sb.run(['disable', 'linked']).code, 0);
    assert.ok(lstatSync(join(sb.userDisabled, 'linked')).isSymbolicLink());
    assert.equal(sb.run(['enable', 'linked']).code, 0);
    assert.ok(lstatSync(join(sb.userSkills, 'linked')).isSymbolicLink());
    assert.equal(sb.run(['rm', 'linked', '-y']).code, 0);
    assert.ok(!existsSync(join(sb.userSkills, 'linked')));
    assert.deepEqual(snapshot(join(sb.root, 'elsewhere')), before);
  });
});

describe('move / copy / new / search', () => {
  test('move and copy between scopes, carrying install metadata', () => {
    const src = writeSkill(join(sb.src, 'mv'), { name: 'mv' });
    sb.run(['install', src]);
    let r = sb.run(['move', 'mv', '--to', 'project']);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(sb.projectSkills, 'mv', 'SKILL.md')));
    assert.ok(!existsSync(join(sb.userSkills, 'mv')));
    const pstate = JSON.parse(readFileSync(join(sb.project, '.claude', 'skill-manager.json'), 'utf8'));
    assert.equal(pstate.skills.mv.source.type, 'local-dir');
    r = sb.run(['copy', 'mv', '--to', 'user']);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(sb.userSkills, 'mv', 'SKILL.md')));
    assert.ok(existsSync(join(sb.projectSkills, 'mv', 'SKILL.md')));
  });

  test('new scaffolds a valid skill that passes doctor', () => {
    let r = sb.run(['new', 'my-skill', '-d', 'Use when: testing scaffolds', '--project']);
    assert.equal(r.code, 0, r.out);
    const text = readFileSync(join(sb.projectSkills, 'my-skill', 'SKILL.md'), 'utf8');
    assert.match(text, /^---\nname: my-skill\ndescription: "Use when: testing scaffolds"\n---/);
    assert.equal(sb.run(['doctor']).code, 0);
    r = sb.run(['new', 'Bad Name']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Try: skm new bad-name/);
  });

  test('search matches names and descriptions', () => {
    writeSkill(join(sb.userSkills, 'pdf-tools'), { name: 'pdf-tools', description: 'Work with PDF files.' });
    writeSkill(join(sb.userSkills, 'other'), { name: 'other', description: 'Converts documents to pdf.' });
    writeSkill(join(sb.userSkills, 'nope'), { name: 'nope', description: 'Unrelated.' });
    const names = json(sb.run(['search', 'pdf', '--json'])).map((e) => e.name);
    assert.deepEqual(names, ['pdf-tools', 'other']);
  });
});

describe('help and UX', () => {
  test('every command has --help with examples', () => {
    for (const c of ['list', 'info', 'install', 'uninstall', 'enable', 'disable', 'update', 'new', 'move', 'copy', 'doctor', 'search']) {
      const r = sb.run([c, '--help']);
      assert.equal(r.code, 0, c);
      assert.match(r.stdout, /Usage:/, c);
    }
    assert.match(sb.run(['install', '--help']).stdout, /Examples:/);
  });
  test('no args without a TTY prints help instead of hanging', () => {
    const r = sb.run([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /skill-manager/);
  });
  test('unknown command suggests the right one', () => {
    assert.match(sb.run(['instal']).stderr, /Did you mean install/);
  });
});
