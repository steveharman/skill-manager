import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  ACCT_A, ACCT_B, ORG_A, ORG_B, makeSyncedBucket, sandbox, signIn, snapshot, writeSettings, writeSkill,
} from './helpers.js';

let sb;
let cfg;
let userSettings;
beforeEach(() => {
  sb = sandbox();
  cfg = join(sb.home, '.claude');
  userSettings = join(cfg, 'settings.json');
});
afterEach(() => sb.cleanup());

const json = (r) => {
  assert.equal(r.code, 0, r.out);
  return JSON.parse(r.stdout);
};
const synced = (rows) => rows.filter((e) => e.scope === 'synced');

describe('skills synced from claude.ai', () => {
  test('each synced skill is its own row: anthropic-skills:<name>, SCOPE claude.ai, SOURCE the short bucket id', () => {
    makeSyncedBucket(cfg, ORG_A, ACCT_A, [{ name: 'pdf' }, { name: 'morning', inManifest: false }]);
    signIn(join(sb.home, '.claude.json'), ORG_A, ACCT_A);
    writeSkill(join(sb.userSkills, 'mine'), { name: 'mine' });

    // Default list: only the user's own skills, plus a count of what --claude-ai adds. No "synced" folder row.
    const plain = sb.run(['list']);
    assert.equal(plain.code, 0, plain.out);
    assert.match(plain.stdout, /\+ 2 claude\.ai skills not shown \(run "skm list --claude-ai"\)/);
    assert.doesNotMatch(plain.stdout, /not a skill|anthropic-skills:/);
    assert.deepEqual(json(sb.run(['list', '--json'])).map((e) => e.name), ['mine']);

    const rows = synced(json(sb.run(['list', '--claude-ai', '--json'])));
    assert.deepEqual(rows.map((e) => e.name), ['anthropic-skills:morning', 'anthropic-skills:pdf']);
    const pdf = rows.find((e) => e.shortName === 'pdf');
    assert.equal(pdf.scopeLabel, 'claude.ai');
    assert.equal(pdf.status, 'enabled');
    assert.equal(pdf.bucketShort, '3d0a8465');
    assert.equal(pdf.activeAccount, true);
    assert.equal(pdf.description, 'Manifest text for pdf.', 'manifest description wins');
    assert.equal(rows.find((e) => e.shortName === 'morning').description, 'Frontmatter text for morning.', 'falls back to SKILL.md');

    const table = sb.run(['list', '--claude-ai']).stdout;
    assert.match(table, /anthropic-skills:pdf\s+claude\.ai\s+enabled\s+3d0a8465\s+Manifest text for pdf\./);
    assert.match(table, /mine\s+user\s+enabled/);
    assert.match(table, /2 claude\.ai skills \(signed-in account 3d0a8465\) · read-only/);
    assert.doesNotMatch(table, /not shown/);

    // --all never brings back a "synced — not a skill" row.
    const all = json(sb.run(['list', '--all', '--json']));
    assert.equal(all.find((e) => e.dirName === 'synced'), undefined);
    assert.equal(synced(all).length, 2);
    // --project alone is about the project: no account-level skills.
    assert.deepEqual(json(sb.run(['list', '--project', '--claude-ai', '--json'])), []);
  });

  test('two buckets: rows are told apart by SOURCE; the signed-in one loads, the other is hidden unless --all (then dimmed)', () => {
    makeSyncedBucket(cfg, ORG_A, ACCT_A, [{ name: 'pdf' }, { name: 'deep-research' }]);
    makeSyncedBucket(cfg, ORG_B, ACCT_B, [{ name: 'pdf' }, { name: 'google-workspace' }]);

    // Nobody signed in (e.g. API key): can't tell, so every bucket is shown as-is.
    const unknown = synced(json(sb.run(['list', '--claude-ai', '--json'])));
    assert.deepEqual(unknown.map((e) => `${e.name}@${e.bucketShort}`), [
      'anthropic-skills:deep-research@3d0a8465', 'anthropic-skills:google-workspace@57a2e8c8',
      'anthropic-skills:pdf@3d0a8465', 'anthropic-skills:pdf@57a2e8c8',
    ]);
    assert.ok(unknown.every((e) => e.activeAccount === undefined && e.loadsHere));
    const unknownTable = sb.run(['list', '--claude-ai']).stdout;
    assert.match(unknownTable, /anthropic-skills:pdf\s+claude\.ai\s+enabled\s+3d0a8465/);
    assert.match(unknownTable, /anthropic-skills:pdf\s+claude\.ai\s+enabled\s+57a2e8c8/);
    assert.doesNotMatch(unknownTable, /other claude\.ai account|other-account rows/);

    signIn(join(sb.home, '.claude.json'), ORG_A, ACCT_A);
    const live = sb.run(['list', '--claude-ai']);
    assert.doesNotMatch(live.stdout, /google-workspace|57a2e8c8\s/);
    assert.match(live.stdout, /\+ 2 claude\.ai skills synced for 1 other claude\.ai account hidden \(use --all\)/);

    const all = synced(json(sb.run(['list', '--all', '--json'])));
    assert.equal(all.length, 4);
    assert.deepEqual(all.filter((e) => !e.activeAccount).map((e) => e.bucketShort), ['57a2e8c8', '57a2e8c8']);
    assert.ok(all.filter((e) => !e.activeAccount).every((e) => e.loadsHere === false));
    const allTable = sb.run(['list', '--all']).stdout;
    assert.match(allTable, /other-account rows: synced for another claude\.ai account/);
    assert.match(allTable, /2 claude\.ai skills \(signed-in account 3d0a8465\) · 2 synced for other accounts/);
  });

  test('buckets sharing an org prefix get the account prefix too', () => {
    makeSyncedBucket(cfg, ORG_A, ACCT_A, [{ name: 'pdf' }]);
    makeSyncedBucket(cfg, ORG_A, ACCT_B, [{ name: 'pdf' }]);
    const rows = synced(json(sb.run(['list', '--claude-ai', '--json'])));
    assert.deepEqual(rows.map((e) => e.bucketShort).sort(), ['3d0a8465_ba7a8649', '3d0a8465_d79d73e5']);
  });

  test('CLAUDE_CONFIG_DIR: buckets and the signed-in account are read from there', () => {
    const alt = join(sb.root, 'alt-config');
    makeSyncedBucket(alt, ORG_A, ACCT_A, [{ name: 'pdf' }]);
    makeSyncedBucket(alt, ORG_B, ACCT_B, [{ name: 'xlsx' }]);
    signIn(join(alt, '.claude.json'), ORG_B, ACCT_B);
    const env = { CLAUDE_CONFIG_DIR: alt };
    assert.deepEqual(synced(json(sb.run(['list', '--claude-ai', '--json'], { env }))).map((e) => e.name), ['anthropic-skills:xlsx']);
    assert.deepEqual(synced(json(sb.run(['list', '--claude-ai', '--json']))), [], 'nothing under the sandbox HOME');
  });

  test('read-only: every changing command refuses with a claude.ai message and touches nothing', () => {
    const bucket = makeSyncedBucket(cfg, ORG_A, ACCT_A, [{ name: 'pdf' }, { name: 'morning' }]);
    signIn(join(sb.home, '.claude.json'), ORG_A, ACCT_A);
    writeSettings(userSettings, { theme: 'dark' });
    const before = snapshot(join(cfg, 'skills', 'synced'));
    const settingsBefore = readFileSync(userSettings, 'utf8');
    const cmds = [
      ['disable', 'anthropic-skills:pdf'], ['disable', 'pdf'], ['enable', 'morning'], ['rm', 'anthropic-skills:pdf', '-y'],
      ['uninstall', 'morning', '-y'], ['update', 'pdf'], ['move', 'pdf', '--to', 'project'], ['copy', 'anthropic-skills:morning', '--to', 'user'],
      ['disable', 'pdf', '--dry-run'],
    ];
    for (const c of cmds) {
      const r = sb.run(c);
      assert.equal(r.code, 1, `${c.join(' ')}: ${r.out}`);
      assert.match(r.stderr, /synced from your claude\.ai account/, c.join(' '));
      assert.match(r.stderr, /managed by claude\.ai/, c.join(' '));
    }
    assert.match(sb.run(['disable', 'pdf']).stderr, /syncClaudeAiSkills/);
    assert.deepEqual(snapshot(join(cfg, 'skills', 'synced')), before);
    assert.equal(readFileSync(userSettings, 'utf8'), settingsBefore, 'no skillOverrides written');
    assert.ok(!existsSync(join(sb.userDisabled, 'pdf')));
    assert.ok(existsSync(join(bucket, 'pdf', 'SKILL.md')));
    // A bulk update (no names) only looks at user/project skills.
    assert.equal(sb.run(['update']).code, 0);
    assert.deepEqual(snapshot(join(cfg, 'skills', 'synced')), before);
  });

  test('a user skill with the same short name is the one that gets changed', () => {
    makeSyncedBucket(cfg, ORG_A, ACCT_A, [{ name: 'pdf' }]);
    writeSkill(join(sb.userSkills, 'pdf'), { name: 'pdf' });
    const r = sb.run(['disable', 'pdf']);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(sb.userDisabled, 'pdf', 'SKILL.md')));
    assert.ok(existsSync(join(cfg, 'skills', 'synced', `${ORG_A}_${ACCT_A}`, 'pdf', 'SKILL.md')));
  });

  test('info and search work on synced skills; doctor ignores them', () => {
    makeSyncedBucket(cfg, ORG_A, ACCT_A, [
      { name: 'pdf' },
      // Would be a doctor error in a user skill: no frontmatter at all.
      { name: 'odd', fm: 'no frontmatter here\n' },
    ]);
    signIn(join(sb.home, '.claude.json'), ORG_A, ACCT_A);

    const info = sb.run(['info', 'anthropic-skills:pdf']);
    assert.equal(info.code, 0, info.out);
    assert.match(info.stdout, /^anthropic-skills:pdf/);
    assert.match(info.stdout, /scope\s+claude\.ai \(synced from claude\.ai, read-only\)/);
    assert.match(info.stdout, new RegExp(`account\\s+${ORG_A}_${ACCT_A} \\(signed in\\)`));
    assert.match(info.stdout, /source\s+claude\.ai \(anthropic\)/);
    assert.match(info.stdout, /Managed by claude\.ai/);
    assert.doesNotMatch(info.stdout, /Edit:/);
    assert.equal(json(sb.run(['info', 'pdf', '--json'])).scope, 'synced');

    const search = sb.run(['search', 'manifest text']);
    assert.match(search.stdout, /anthropic-skills:odd · claude\.ai/);
    assert.match(search.stdout, /anthropic-skills:pdf · claude\.ai/);

    const doc = sb.run(['doctor', '-V']);
    assert.equal(doc.code, 0, doc.out);
    assert.doesNotMatch(doc.out, /anthropic-skills|synced|odd/);
  });

  test('syncClaudeAiSkills: false shows them as disabled (sync off)', () => {
    makeSyncedBucket(cfg, ORG_A, ACCT_A, [{ name: 'pdf' }]);
    writeSettings(userSettings, { syncClaudeAiSkills: false });
    const [row] = synced(json(sb.run(['list', '--claude-ai', '--json'])));
    assert.equal(row.status, 'disabled');
    assert.match(sb.run(['list', '--claude-ai']).stdout, /anthropic-skills:pdf\s+claude\.ai\s+disabled \(sync off\)/);
    const r = sb.run(['enable', 'pdf']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /syncClaudeAiSkills/);
  });

  test('plugins synced from claude.ai show SCOPE claude.ai; JSON keeps scope "synced"', () => {
    writeSkill(join(cfg, 'plugins', 'synced', `${ORG_A}_${ACCT_A}`, 'cloudy', 'skills', 'k'), { name: 'k' });
    const [p] = json(sb.run(['plugin', 'list', '--json']));
    assert.equal(p.id, 'cloudy@synced');
    assert.equal(p.scope, 'synced');
    assert.equal(p.scopeLabel, 'claude.ai');
    assert.match(sb.run(['plugin', 'list']).stdout, /cloudy@synced\s+claude\.ai\s+enabled/);
    const row = json(sb.run(['list', '--plugins', '--json'])).find((e) => e.name === 'cloudy:k');
    assert.equal(row.pluginScope, 'synced');
    assert.equal(row.scopeLabel, 'claude.ai');
    assert.match(sb.run(['list', '--plugins']).stdout, /cloudy:k\s+claude\.ai\s+enabled\s+cloudy@synced/);
  });
});

describe('plugins synced from claude.ai, per account', () => {
  test('only the signed-in bucket\'s synced plugins load; others are hidden unless --all and dimmed', () => {
    writeSkill(join(cfg, 'plugins', 'synced', `${ORG_A}_${ACCT_A}`, 'mine', 'skills', 'k'), { name: 'k' });
    writeSkill(join(cfg, 'plugins', 'synced', `${ORG_B}_${ACCT_B}`, 'theirs', 'skills', 'k'), { name: 'k' });
    // Unknown account: both count as loaded.
    const unknown = json(sb.run(['plugin', 'list', '--json']));
    assert.ok(unknown.every((p) => p.loadsHere && p.otherAccount === false));
    signIn(join(sb.home, '.claude.json'), ORG_A, ACCT_A);
    const rows = Object.fromEntries(json(sb.run(['plugin', 'list', '--json'])).map((p) => [p.id, p]));
    assert.equal(rows['mine@synced'].loadsHere, true);
    assert.equal(rows['theirs@synced'].loadsHere, false);
    assert.equal(rows['theirs@synced'].otherAccount, true);
    assert.match(sb.run(['plugin', 'list']).stdout, /1 synced for other claude\.ai accounts/);
    const list = sb.run(['list', '--plugins']).stdout;
    assert.match(list, /mine:k\s+claude\.ai/);
    assert.doesNotMatch(list, /theirs:k/);
    assert.match(list, /\+ 1 claude\.ai skill synced for 1 other claude\.ai account hidden \(use --all\)/);
    const all = sb.run(['list', '--all']).stdout;
    assert.match(all, /theirs:k\s+claude\.ai/);
    assert.match(all, /other-account rows/);
  });
});
