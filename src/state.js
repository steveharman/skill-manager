// Per-scope metadata file (install source, content hash) kept next to the skills folder.
import { readJson, writeJsonAtomic } from './fsutil.js';

const empty = () => ({ version: 1, skills: {} });

export function loadState(scope) {
  const s = readJson(scope.stateFile, null);
  if (!s || typeof s !== 'object' || typeof s.skills !== 'object') return empty();
  return s;
}

export function saveState(scope, state) {
  writeJsonAtomic(scope.stateFile, state);
}

export function getRecord(scope, dirName) {
  return loadState(scope).skills[dirName] || null;
}

export function setRecord(scope, dirName, record) {
  const s = loadState(scope);
  s.skills[dirName] = record;
  saveState(scope, s);
}

export function removeRecord(scope, dirName) {
  const s = loadState(scope);
  if (!(dirName in s.skills)) return null;
  const rec = s.skills[dirName];
  delete s.skills[dirName];
  saveState(scope, s);
  return rec;
}

/** Short human label for a recorded source. */
export function sourceLabel(record) {
  if (!record?.source) return '';
  const s = record.source;
  if (s.type === 'git') {
    const gh = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(s.url || '');
    const base = gh ? `github:${gh[1]}` : s.url;
    return s.subpath ? `${base}/${s.subpath}` : base;
  }
  if (s.type === 'archive') return `archive:${(s.path || s.url || '').split('/').pop()}`;
  if (s.type === 'local-file' || s.type === 'local-dir') return 'local';
  if (s.type === 'scaffold') return 'created';
  return s.type;
}
