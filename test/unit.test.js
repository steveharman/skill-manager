import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createContext, findProjectRoot, userConfigDir } from '../src/context.js';
import { checkNewName, parseFrontmatter, validateSkillData } from '../src/frontmatter.js';
import { parseSource } from '../src/sources.js';
import { didYouMean } from '../src/ui.js';
import { normalizeArgv } from '../src/cli.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'skm-unit-')));
after(() => rmSync(root, { recursive: true, force: true }));

describe('scope resolution', () => {
  const home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const env = { HOME: home };

  test('user config dir defaults to $HOME/.claude and honours CLAUDE_CONFIG_DIR', () => {
    assert.equal(userConfigDir(env), join(home, '.claude'));
    assert.equal(userConfigDir({ ...env, CLAUDE_CONFIG_DIR: join(root, 'cfg') }), join(root, 'cfg'));
  });

  test('project root is the nearest ancestor with .git', () => {
    const p = join(home, 'code', 'repo');
    mkdirSync(join(p, '.git'), { recursive: true });
    mkdirSync(join(p, 'a', 'b'), { recursive: true });
    assert.equal(findProjectRoot(join(p, 'a', 'b'), env), p);
  });

  test('project root is the nearest ancestor with .claude/ (nested wins over outer .git)', () => {
    const p = join(home, 'code', 'repo', 'pkg');
    mkdirSync(join(p, '.claude'), { recursive: true });
    mkdirSync(join(p, 'src'), { recursive: true });
    assert.equal(findProjectRoot(join(p, 'src'), env), p);
  });

  test("the home directory's .claude is not a project marker", () => {
    const d = join(home, 'notes', 'x');
    mkdirSync(d, { recursive: true });
    assert.equal(findProjectRoot(d, env), null);
    const ctx = createContext({ env, cwd: d });
    assert.equal(ctx.project, null);
    assert.equal(ctx.user.skillsDir, join(home, '.claude', 'skills'));
  });

  test('with CLAUDE_CONFIG_DIR elsewhere, ~/.claude still does not make $HOME a project', () => {
    const d = join(home, 'docs');
    mkdirSync(d, { recursive: true });
    assert.equal(findProjectRoot(d, { ...env, CLAUDE_CONFIG_DIR: join(root, 'cfg2') }), null);
  });

  test('--project-dir overrides detection; pointing it at $HOME yields no project', () => {
    const other = join(root, 'elsewhere');
    mkdirSync(other, { recursive: true });
    const ctx = createContext({ env, cwd: home, projectDir: other });
    assert.equal(ctx.project.skillsDir, join(other, '.claude', 'skills'));
    assert.equal(ctx.project.disabledDir, join(other, '.claude', 'skills-disabled'));
    assert.equal(createContext({ env, cwd: root, projectDir: home }).project, null);
    assert.throws(() => createContext({ env, cwd: root, projectDir: join(root, 'nope') }), /not found/);
  });

  test('--project=<path> is rewritten to --project --project-dir <path>', () => {
    assert.deepEqual(normalizeArgv(['list', '--project=/x']), ['list', '--project', '--project-dir', '/x']);
  });
});

describe('frontmatter', () => {
  test('parses name and description', () => {
    const r = parseFrontmatter('---\nname: a\ndescription: b\n---\nbody');
    assert.equal(r.hasFrontmatter, true);
    assert.deepEqual(r.data, { name: 'a', description: 'b' });
    assert.equal(r.body, 'body');
  });
  test('no frontmatter unless --- is the first line', () => {
    assert.equal(parseFrontmatter('\n---\nname: a\n---\n').hasFrontmatter, false);
  });
  test('reports invalid YAML and unclosed blocks', () => {
    assert.match(parseFrontmatter('---\nname: [oops\n---\n').error, /invalid YAML/);
    assert.match(parseFrontmatter('---\nname: a\n').error, /never closed/);
  });
  test('validation flags mismatch, missing description, long description, reserved names', () => {
    const codes = (dirName, text) => validateSkillData({ dirName, fileName: 'SKILL.md', parsed: parseFrontmatter(text) }).map((i) => i.code);
    assert.ok(codes('b', '---\nname: a\ndescription: x\n---\nbody').includes('name-mismatch'));
    assert.ok(codes('a', '---\nname: a\n---\nbody').includes('missing-description'));
    assert.ok(codes('a', `---\nname: a\ndescription: ${'x'.repeat(1100)}\n---\nbody`).includes('long-description'));
    assert.ok(codes('synced', '---\nname: synced\ndescription: x\n---\nbody').includes('reserved-name'));
    assert.ok(codes('a', 'just text').includes('no-frontmatter'));
    assert.deepEqual(codes('ok', '---\nname: ok\ndescription: fine\n---\nbody'), []);
  });
  test('checkNewName', () => {
    assert.equal(checkNewName('my-skill'), null);
    assert.match(checkNewName('My Skill'), /lowercase/);
    assert.match(checkNewName('synced'), /reserved/);
    assert.match(checkNewName('../x'), /slashes/);
  });
});

describe('source parsing', () => {
  const cwd = root;
  test('GitHub tree URL', () => {
    const s = parseSource('https://github.com/o/r/tree/main/skills/foo', { cwd });
    assert.equal(s.type, 'git');
    assert.equal(s.url, 'https://github.com/o/r.git');
    assert.deepEqual(s.treePath, ['main', 'skills', 'foo']);
  });
  test('GitHub blob URL to SKILL.md points at its folder', () => {
    const s = parseSource('https://github.com/o/r/blob/main/skills/foo/SKILL.md', { cwd });
    assert.deepEqual(s.treePath, ['main', 'skills', 'foo']);
  });
  test('owner/repo shorthand with and without a path', () => {
    assert.deepEqual(
      [parseSource('o/r', { cwd }).url, parseSource('o/r', { cwd }).subpath],
      ['https://github.com/o/r.git', undefined],
    );
    const s = parseSource('anthropics/skills/skills/pdf', { cwd });
    assert.equal(s.url, 'https://github.com/anthropics/skills.git');
    assert.equal(s.subpath, 'skills/pdf');
  });
  test('git URLs with #subpath', () => {
    const s = parseSource('git@github.com:o/r.git#skills/x', { cwd });
    assert.equal(s.url, 'git@github.com:o/r.git');
    assert.equal(s.subpath, 'skills/x');
    assert.equal(parseSource('https://gitlab.com/g/p.git#a', { cwd }).subpath, 'a');
    assert.throws(() => parseSource('https://h/r.git#../x', { cwd }), /\.\./);
  });
  test('an existing local folder wins over owner/repo shorthand', () => {
    mkdirSync(join(root, 'owner', 'repo'), { recursive: true });
    assert.equal(parseSource('owner/repo', { cwd: root }).type, 'local-dir');
  });
  test('missing explicit local path is a helpful error', () => {
    assert.throws(() => parseSource('./nope', { cwd }), /Path not found/);
  });
});

test('didYouMean', () => {
  assert.deepEqual(didYouMean('helo', ['hello', 'route', 'world']), ['hello']);
  assert.deepEqual(didYouMean('zzzzzz', ['hello']), []);
});
