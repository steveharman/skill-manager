// SKILL.md frontmatter parsing and validation rules.
import YAML from 'yaml';

/**
 * Claude Code only reads frontmatter when the opening `---` is the very first line.
 * @returns {{hasFrontmatter: boolean, data: Record<string, any>, body: string, error?: string}}
 */
export function parseFrontmatter(text) {
  text = String(text).replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return { hasFrontmatter: false, data: {}, body: text };
  const end = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === '---' || l.trimEnd() === '...'));
  if (end === -1)
    return { hasFrontmatter: false, data: {}, body: text, error: 'frontmatter starts with --- but is never closed' };
  const yamlText = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  try {
    const data = YAML.parse(yamlText) ?? {};
    if (typeof data !== 'object' || Array.isArray(data))
      return { hasFrontmatter: true, data: {}, body, error: 'frontmatter must be a YAML mapping (key: value)' };
    return { hasFrontmatter: true, data, body };
  } catch (e) {
    const msg = String(e.message || e).split('\n')[0];
    return { hasFrontmatter: true, data: {}, body, error: `invalid YAML: ${msg}` };
  }
}

export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024; // Agent Skills spec limit
export const LISTING_MAX = 1536; // Claude Code truncates description + when_to_use here
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Names Claude Code refuses to load from personal/project skill folders. */
export function isReservedName(name) {
  const n = String(name).toLowerCase();
  return n === 'synced' || n === 'anthropic-skills' || n.startsWith('anthropic-skills:');
}

/** A name we can safely use as a directory name. */
export function isSafeDirName(name) {
  return typeof name === 'string' && name.length > 0 && !/[\\/\0]/.test(name) && !name.startsWith('.');
}

/** Check a candidate skill name (used by `new` and `install --name`). Returns an error string or null. */
export function checkNewName(name) {
  if (!name) return 'a name is required';
  if (!isSafeDirName(name)) return 'names cannot contain slashes or start with a dot';
  if (isReservedName(name)) return `"${name}" is reserved by Claude Code`;
  if (name.length > NAME_MAX) return `names can be at most ${NAME_MAX} characters`;
  if (!NAME_RE.test(name)) return 'use lowercase letters, numbers and single hyphens (e.g. "my-skill")';
  return null;
}

/**
 * @typedef {{level: 'error'|'warn'|'info', code: string, message: string, hint?: string}} Issue
 * @param {{dirName: string, fileName?: string|null, parsed?: ReturnType<typeof parseFrontmatter>|null}} s
 * @returns {Issue[]}
 */
export function validateSkillData({ dirName, fileName, parsed }) {
  /** @type {Issue[]} */
  const issues = [];
  const add = (level, code, message, hint) => issues.push({ level, code, message, hint });
  if (!parsed) {
    add('error', 'no-skill-md', 'no SKILL.md file', 'A skill is a folder containing SKILL.md.');
    return issues;
  }
  if (fileName && fileName !== 'SKILL.md')
    add('warn', 'filename-case', `file is named "${fileName}", expected "SKILL.md"`,
      'Case-sensitive systems (Linux, cloud sessions) will not find it. Rename it to SKILL.md.');
  if (parsed.error) {
    add('error', 'bad-frontmatter', `frontmatter: ${parsed.error}`,
      'Claude Code still loads the skill but ignores every field, so it may never trigger.');
    return issues;
  }
  if (!parsed.hasFrontmatter) {
    add('error', 'no-frontmatter', 'SKILL.md has no YAML frontmatter',
      'Start the file with ---, then "name:" and "description:" lines, then ---.');
    return issues;
  }
  const { name, description } = parsed.data;
  if (name === undefined || name === null || name === '') {
    add('warn', 'missing-name', 'frontmatter has no "name"', `Claude Code falls back to the folder name ("${dirName}").`);
  } else if (typeof name !== 'string') {
    add('error', 'bad-name', '"name" must be a string');
  } else {
    if (isReservedName(name)) add('error', 'reserved-name', `"${name}" is a reserved name; Claude Code will skip this skill`);
    if (!isSafeDirName(name)) add('error', 'bad-name', `name "${name}" cannot contain slashes or start with a dot`);
    else if (!NAME_RE.test(name) || name.length > NAME_MAX)
      add('warn', 'name-format', `name "${name}" is not lowercase-kebab-case (max ${NAME_MAX} chars)`,
        'Other Agent Skills tools (Claude API, claude.ai) reject such names.');
    if (name !== dirName)
      add('warn', 'name-mismatch', `name "${name}" does not match folder "${dirName}"`,
        `The command will be /${name}. Rename the folder or the name so they agree.`);
  }
  if (isReservedName(dirName)) add('error', 'reserved-name', `folder name "${dirName}" is reserved; Claude Code will skip it`);
  if (description === undefined || description === null || String(description).trim() === '') {
    add('warn', 'missing-description', 'frontmatter has no "description"',
      'Claude decides when to use a skill from its description. Add one.');
  } else if (typeof description !== 'string') {
    add('error', 'bad-description', '"description" must be a string');
  } else {
    if (description.length > DESCRIPTION_MAX)
      add('warn', 'long-description', `description is ${description.length} chars (limit ${DESCRIPTION_MAX})`,
        'Claude API / claude.ai reject descriptions over 1024 characters. Put the key use case first.');
    const combined = description.length + (typeof parsed.data.when_to_use === 'string' ? parsed.data.when_to_use.length : 0);
    if (combined > LISTING_MAX)
      add('warn', 'listing-truncated', `description + when_to_use is ${combined} chars; Claude Code truncates at ${LISTING_MAX}`);
  }
  if (!parsed.body.trim()) add('warn', 'empty-body', 'SKILL.md has no instructions after the frontmatter');
  return issues;
}
