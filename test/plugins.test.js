import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resolveEnabled } from '../src/plugins.js';
import { installPlugin, sandbox, snapshot, writeSettings, writeSkill } from './helpers.js';

let sb;
let userSettings;
let projectSettings;
let localSettings;
beforeEach(() => {
  sb = sandbox();
  userSettings = join(sb.home, '.claude', 'settings.json');
  projectSettings = join(sb.project, '.claude', 'settings.json');
  localSettings = join(sb.project, '.claude', 'settings.local.json');
});
afterEach(() => sb.cleanup());

const json = (r) => {
  assert.equal(r.code, 0, r.out);
  return JSON.parse(r.stdout);
};
const pluginRows = (args = [], opts) => json(sb.run(['plugin', 'list', '--json', ...args], opts));
const byId = (rows) => Object.fromEntries(rows.map((p) => [p.id + (p.projectPath ? `|${p.projectPath}` : ''), p]));
const loose = () => {
  const d = join(sb.root, 'loose');
  mkdirSync(d, { recursive: true });
  return d;
};

describe('plugin status', () => {
  test('user settings decide, and an absent key means enabled (defaultEnabled defaults to true)', () => {
    installPlugin(sb.home, 'off@mk', { skills: ['a', 'b'] });
    installPlugin(sb.home, 'on@mk', { skills: ['c'] });
    installPlugin(sb.home, 'unset@mk', { skills: ['d'] });
    writeSettings(userSettings, { enabledPlugins: { 'off@mk': false, 'on@mk': true } });

    // Same answer inside a project and outside any project.
    for (const cwd of [sb.project, loose()]) {
      const rows = byId(pluginRows([], { cwd }));
      assert.equal(rows['off@mk'].state, 'disabled');
      assert.equal(rows['off@mk'].decidedBy.scope, 'user');
      assert.equal(rows['off@mk'].decidedBy.file, userSettings);
      assert.equal(rows['on@mk'].state, 'enabled');
      assert.equal(rows['unset@mk'].state, 'enabled');
      assert.equal(rows['unset@mk'].decidedBy.scope, 'default');
      assert.equal(rows['off@mk'].skills, 2);

      const listed = json(sb.run(['list', '--plugins', '--json'], { cwd })).map((e) => e.name).sort();
      assert.deepEqual(listed, ['on:c', 'unset:d']);
    }
    const all = json(sb.run(['list', '--all', '--json']));
    const a = all.find((e) => e.name === 'off:a');
    assert.equal(a.status, 'disabled');
    assert.equal(a.pluginState, 'disabled');

    const table = sb.run(['list', '--plugins']);
    assert.equal(table.code, 0, table.out);
    assert.doesNotMatch(table.stdout, /off:a/);
    assert.match(table.stdout, /\+ 2 skills from 1 disabled plugin hidden \(use --all\)/);
    assert.match(sb.run(['list', '--all']).stdout, /off:a\s+plugin\s+disabled \(plugin off\)/);
    assert.match(sb.run(['plugin', 'list']).stdout, /off@mk\s+user\s+disabled\s+2\s+1\.0\.0\s+.*settings\.json: false/);
  });

  test('defaultEnabled: false in plugin.json keeps an unset plugin off; the marketplace entry overrides it', () => {
    installPlugin(sb.home, 'quiet@mk', { manifest: { defaultEnabled: false } });
    installPlugin(sb.home, 'loud@mk', { manifest: { defaultEnabled: false } });
    const mkDir = join(sb.home, '.claude', 'plugins', 'marketplaces', 'mk', '.claude-plugin');
    mkdirSync(mkDir, { recursive: true });
    writeFileSync(join(mkDir, 'marketplace.json'), JSON.stringify({ name: 'mk', plugins: [{ name: 'loud', defaultEnabled: true }] }));
    const rows = byId(pluginRows());
    assert.equal(rows['quiet@mk'].state, 'disabled');
    assert.equal(rows['quiet@mk'].decidedBy.scope, 'default');
    assert.equal(rows['loud@mk'].state, 'enabled');
  });

  test('project settings override user settings, only inside that project', () => {
    installPlugin(sb.home, 'p@mk');
    writeSettings(userSettings, { enabledPlugins: { 'p@mk': false } });
    writeSettings(projectSettings, { enabledPlugins: { 'p@mk': true } });
    const inside = byId(pluginRows())['p@mk'];
    assert.equal(inside.state, 'enabled');
    assert.equal(inside.decidedBy.scope, 'project');
    assert.equal(byId(pluginRows([], { cwd: loose() }))['p@mk'].state, 'disabled');
  });

  test('settings.local.json overrides the project file', () => {
    installPlugin(sb.home, 'p@mk');
    writeSettings(projectSettings, { enabledPlugins: { 'p@mk': true } });
    writeSettings(localSettings, { enabledPlugins: { 'p@mk': false } });
    const row = byId(pluginRows())['p@mk'];
    assert.equal(row.state, 'disabled');
    assert.equal(row.decidedBy.scope, 'local');
    assert.equal(row.decidedBy.file, localSettings);
  });

  test('managed settings beat everything and cannot be changed', () => {
    installPlugin(sb.home, 'p@mk');
    writeSettings(localSettings, { enabledPlugins: { 'p@mk': true } });
    writeSettings(join(sb.managed, 'managed-settings.json'), { enabledPlugins: { 'p@mk': false } });
    assert.equal(byId(pluginRows())['p@mk'].decidedBy.scope, 'managed');
    const before = snapshot(join(sb.home, '.claude'));
    const r = sb.run(['plugin', 'enable', 'p']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /blocked by managed settings/);
    assert.deepEqual(snapshot(join(sb.home, '.claude')), before);
  });

  test('a project-scope install for another project is shown as project-only, not skipped', () => {
    const other = join(sb.root, 'other');
    installPlugin(sb.home, 'elsewhere@mk', { scope: 'project', projectPath: other, skills: ['x'] });
    writeSettings(join(other, '.claude', 'settings.json'), { enabledPlugins: { 'elsewhere@mk': true } });

    const row = byId(pluginRows())[`elsewhere@mk|${other}`];
    assert.equal(row.state, 'project-only');
    assert.equal(row.scope, 'project');
    assert.equal(row.enabled, true, 'enabled in the project it belongs to');
    assert.match(sb.run(['plugin', 'list']).stdout, /elsewhere@mk\s+project\s+project-only \(.*other\)/);

    assert.deepEqual(json(sb.run(['list', '--plugins', '--json'])), []);
    assert.match(sb.run(['list', '--plugins']).stdout, /\+ 1 skill from 1 plugin installed only for other projects hidden \(use --all\)/);
    const all = json(sb.run(['list', '--all', '--json']));
    assert.equal(all.find((e) => e.name === 'elsewhere:x').pluginState, 'project-only');
    assert.match(sb.run(['list', '--all']).stdout, /elsewhere:x\s+plugin\s+project-only \(/);

    // In its own project it is simply enabled.
    assert.equal(byId(pluginRows([], { cwd: other }))[`elsewhere@mk|${other}`].state, 'enabled');
  });

  test('the same plugin from two marketplaces is two entries', () => {
    installPlugin(sb.home, 'dup@one', { skills: ['s'] });
    installPlugin(sb.home, 'dup@two', { skills: ['s'] });
    writeSettings(userSettings, { enabledPlugins: { 'dup@one': false } });
    const rows = byId(pluginRows());
    assert.equal(rows['dup@one'].state, 'disabled');
    assert.equal(rows['dup@two'].state, 'enabled');
    const all = json(sb.run(['list', '--all', '--json'])).filter((e) => e.name === 'dup:s');
    assert.deepEqual(all.map((e) => e.plugin).sort(), ['dup@one', 'dup@two']);
  });

  test('plugins synced from claude.ai are listed as <name>@synced and obey enabledPlugins', () => {
    const dir = join(sb.home, '.claude', 'plugins', 'synced', 'bucket-1', 'cloudy');
    writeSkill(join(dir, 'skills', 'k'), { name: 'k' });
    assert.equal(byId(pluginRows())['cloudy@synced'].state, 'enabled');
    writeSettings(userSettings, { enabledPlugins: { 'cloudy@synced': false } });
    assert.equal(byId(pluginRows())['cloudy@synced'].state, 'disabled');
  });

  test('CLAUDE_CONFIG_DIR moves the user settings file too', () => {
    const cfgHome = join(sb.root, 'fakehome');
    installPlugin(cfgHome, 'p@mk'); // <fakehome>/.claude/plugins
    writeSettings(join(cfgHome, '.claude', 'settings.json'), { enabledPlugins: { 'p@mk': false } });
    const env = { CLAUDE_CONFIG_DIR: join(cfgHome, '.claude') };
    assert.equal(byId(pluginRows([], { env }))['p@mk'].state, 'disabled');
    assert.deepEqual(pluginRows(), [], 'nothing under the sandbox HOME itself');
  });

  test('resolveEnabled: later layers win; non-boolean values are ignored', () => {
    const layers = [
      { scope: 'user', file: 'u', data: { enabledPlugins: { a: true, b: false } } },
      { scope: 'project', file: 'p', data: { enabledPlugins: { a: false, b: 'weird' } } },
      { scope: 'local', file: 'l', data: null },
    ];
    assert.deepEqual(resolveEnabled('a', layers), { enabled: false, scope: 'project', file: 'p', value: false });
    assert.deepEqual(resolveEnabled('b', layers), { enabled: false, scope: 'user', file: 'u', value: false });
    assert.deepEqual(resolveEnabled('c', layers, false), { enabled: false, scope: 'default', file: null });
  });
});

describe('plugin enable/disable', () => {
  const original = {
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)'], deny: [] },
    enabledPlugins: { 'keep@mk': true, 'p@mk': true },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
  };

  test('writes enabledPlugins in user settings, keeps every other key, and backs up the old file', () => {
    installPlugin(sb.home, 'p@mk');
    installPlugin(sb.home, 'keep@mk');
    writeSettings(userSettings, original);
    chmodSync(userSettings, 0o600);
    const before = readFileSync(userSettings, 'utf8');

    const r = sb.run(['plugin', 'disable', 'p']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Disabled p@mk/);
    const text = readFileSync(userSettings, 'utf8');
    assert.ok(text.endsWith('}\n'), 'trailing newline');
    assert.match(text, /^\{\n {2}"model": "opus",/, '2-space JSON, key order kept');
    assert.deepEqual(JSON.parse(text), { ...original, enabledPlugins: { 'keep@mk': true, 'p@mk': false } });
    assert.equal(statSync(userSettings).mode & 0o777, 0o600, 'file mode kept');
    assert.equal(byId(pluginRows())['p@mk'].state, 'disabled');

    const backups = join(sb.home, '.claude', 'skill-manager', 'backups');
    const files = readdirSync(backups);
    assert.equal(files.length, 1);
    assert.match(files[0], /__user__settings\.json$/);
    assert.equal(readFileSync(join(backups, files[0]), 'utf8'), before);
    assert.equal(statSync(join(backups, files[0])).mode & 0o777, 0o600, 'backup is as private as the original');
    assert.ok(!readdirSync(join(sb.home, '.claude')).some((n) => n.includes('.tmp')), 'no temp file left');

    const again = sb.run(['plugin', 'enable', 'p@mk']);
    assert.equal(again.code, 0, again.out);
    assert.equal(JSON.parse(readFileSync(userSettings, 'utf8')).enabledPlugins['p@mk'], true);
  });

  test('creates the key (and the file) when missing', () => {
    installPlugin(sb.home, 'p@mk');
    const r = sb.run(['plugin', 'disable', 'p']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(readFileSync(userSettings, 'utf8')), { enabledPlugins: { 'p@mk': false } });
  });

  test('-p writes the project settings.json and --local writes settings.local.json', () => {
    installPlugin(sb.home, 'p@mk');
    writeSettings(userSettings, original);
    const userBefore = readFileSync(userSettings, 'utf8');
    assert.equal(sb.run(['plugin', 'disable', 'p', '-p']).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(projectSettings, 'utf8')), { enabledPlugins: { 'p@mk': false } });
    assert.equal(sb.run(['plugin', 'enable', 'p', '--local']).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(localSettings, 'utf8')), { enabledPlugins: { 'p@mk': true } });
    assert.equal(readFileSync(userSettings, 'utf8'), userBefore);
    assert.equal(byId(pluginRows())['p@mk'].decidedBy.scope, 'local');

    const outside = sb.run(['plugin', 'disable', 'p', '--local'], { cwd: loose() });
    assert.equal(outside.code, 1);
    assert.match(outside.stderr, /No project found/);
  });

  test('warns when a higher-precedence file still decides the other way', () => {
    installPlugin(sb.home, 'p@mk');
    writeSettings(projectSettings, { enabledPlugins: { 'p@mk': true } });
    const r = sb.run(['plugin', 'disable', 'p']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stderr, /still enabled here/);
    assert.match(r.stderr, /skm plugin disable p@mk --local/);
  });

  test('--dry-run writes nothing', () => {
    installPlugin(sb.home, 'p@mk');
    writeSettings(userSettings, original);
    const before = snapshot(join(sb.home, '.claude'));
    const r = sb.run(['plugin', 'disable', 'p', '--dry-run']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /\[dry run\].*enabledPlugins\["p@mk"\] = false/);
    assert.deepEqual(snapshot(join(sb.home, '.claude')), before);
  });

  test('did-you-mean on a typo, and nothing is written', () => {
    installPlugin(sb.home, 'superpowers@mk');
    const r = sb.run(['plugin', 'disable', 'superpowres']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No plugin named "superpowres"/);
    assert.match(r.stderr, /Did you mean: .*superpowers/);
    assert.throws(() => readFileSync(userSettings));
  });

  test('a name from two marketplaces needs @marketplace when not interactive', () => {
    installPlugin(sb.home, 'dup@one');
    installPlugin(sb.home, 'dup@two');
    const r = sb.run(['plugin', 'disable', 'dup']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ambiguous/);
    assert.match(r.stderr, /dup@one/);
    assert.match(r.stderr, /dup@two/);
    assert.equal(sb.run(['plugin', 'disable', 'dup@two']).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(userSettings, 'utf8')).enabledPlugins, { 'dup@two': false });
  });

  test('refuses to rewrite a settings file that is not valid JSON', () => {
    installPlugin(sb.home, 'p@mk');
    writeSettings(userSettings, null, '{ "model": "opus", // comment\n}');
    const r = sb.run(['plugin', 'disable', 'p']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(readFileSync(userSettings, 'utf8'), '{ "model": "opus", // comment\n}');
  });

  test('a symlinked settings.json stays a symlink', () => {
    installPlugin(sb.home, 'p@mk');
    const realFile = writeSettings(join(sb.root, 'dotfiles', 'settings.json'), { model: 'opus' });
    symlinkSync(realFile, userSettings);
    assert.equal(sb.run(['plugin', 'disable', 'p']).code, 0);
    assert.ok(lstatSync(userSettings).isSymbolicLink());
    assert.deepEqual(JSON.parse(readFileSync(realFile, 'utf8')), { model: 'opus', enabledPlugins: { 'p@mk': false } });
  });

  test('skm enable/disable on a single plugin skill points at "skm plugin disable"', () => {
    const dir = installPlugin(sb.home, 'p@mk', { skills: ['pskill'] });
    writeSettings(userSettings, {}, '{}\n');
    const before = snapshot(join(sb.home, '.claude'));
    const off = sb.run(['disable', 'p:pskill']);
    assert.equal(off.code, 1);
    assert.match(off.stderr, /skillOverrides/);
    assert.match(off.stderr, /skm plugin disable p@mk/);
    const on = sb.run(['enable', 'p:pskill']);
    assert.equal(on.code, 1);
    assert.match(on.stderr, /already enabled/);
    writeSettings(userSettings, { enabledPlugins: { 'p@mk': false } });
    const on2 = sb.run(['enable', 'p:pskill']);
    assert.match(on2.stderr, /skm plugin enable p@mk/);
    writeSettings(userSettings, {}, '{}\n');
    assert.deepEqual(snapshot(join(sb.home, '.claude')), before);
    assert.ok(statSync(join(dir, 'skills', 'pskill', 'SKILL.md')));
  });
});
