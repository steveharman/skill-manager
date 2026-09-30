// Where things live: user scope, project scope, plugins, trash.
import { existsSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SkmError, tildify } from './ui.js';

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export function homeDir(env = process.env) {
  return resolve(env.HOME || homedir());
}

/** The user-level Claude config dir: $CLAUDE_CONFIG_DIR or ~/.claude. */
export function userConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homeDir(env), '.claude');
}

/**
 * Nearest ancestor of `start` containing `.claude/` or `.git`.
 * The home directory's `.claude/` (the user config dir) never counts as a project marker,
 * otherwise every folder under $HOME would look like "a project" whose skills are the user skills.
 * @returns {string|null}
 */
export function findProjectRoot(start, env = process.env) {
  const home = real(homeDir(env));
  const cfg = real(userConfigDir(env));
  let dir = resolve(start);
  for (;;) {
    const claude = join(dir, '.claude');
    if (isDir(claude) && real(claude) !== cfg && real(dir) !== home) return dir;
    if (existsSync(join(dir, '.git')) && real(dir) !== home) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @typedef {{scope: 'user'|'project', root: string, claudeDir: string, skillsDir: string,
 *   disabledDir: string, stateFile: string, settingsFiles: string[]}} ScopeInfo
 * @typedef {{env: object, cwd: string, home: string, user: ScopeInfo, project: ScopeInfo|null,
 *   projectExplicit: boolean, configDir: string, pluginsDir: string, trashDir: string}} Context
 */

function scopeInfo(scope, claudeDir, root) {
  return {
    scope,
    root,
    claudeDir,
    skillsDir: join(claudeDir, 'skills'),
    disabledDir: join(claudeDir, 'skills-disabled'),
    stateFile: join(claudeDir, 'skill-manager.json'),
    settingsFiles:
      scope === 'user'
        ? [join(claudeDir, 'settings.json')]
        : [join(claudeDir, 'settings.json'), join(claudeDir, 'settings.local.json')],
  };
}

/**
 * @param {{env?: object, cwd?: string, projectDir?: string}} [opts]
 * @returns {Context}
 */
export function createContext({ env = process.env, cwd = process.cwd(), projectDir } = {}) {
  const configDir = userConfigDir(env);
  let projectRoot = null;
  if (projectDir) {
    projectRoot = resolve(cwd, projectDir);
    if (!isDir(projectRoot))
      throw new SkmError(`Project directory not found: ${projectDir}`, {
        hint: 'Pass an existing folder to --project-dir (or --project=<path>).',
      });
  } else {
    projectRoot = findProjectRoot(cwd, env);
  }
  const project = projectRoot ? scopeInfo('project', join(projectRoot, '.claude'), projectRoot) : null;
  // If the "project" is really the user config dir (e.g. --project-dir ~), drop it.
  const sameAsUser = project && real(project.claudeDir) === real(configDir);
  return {
    env,
    cwd,
    home: homeDir(env),
    configDir,
    user: scopeInfo('user', configDir, homeDir(env)),
    project: sameAsUser ? null : project,
    projectExplicit: Boolean(projectDir),
    pluginsDir: join(configDir, 'plugins'),
    trashDir: join(configDir, 'skill-manager', 'trash'),
  };
}

/** Scopes selected by --user / --project flags (both when neither is given). */
export function selectedScopes(ctx, opts = {}) {
  const wantUser = Boolean(opts.user);
  const wantProject = Boolean(opts.project);
  if (wantProject && !ctx.project) throw noProjectError(ctx);
  if (wantUser && !wantProject) return [ctx.user];
  if (wantProject && !wantUser) return [ctx.project];
  return ctx.project ? [ctx.user, ctx.project] : [ctx.user];
}

export function noProjectError(ctx) {
  return new SkmError(`No project found from ${tildify(ctx.cwd)}.`, {
    hint: [
      'A project is the nearest folder containing .claude/ or .git.',
      'Run inside a project, or point at one with --project-dir <path>.',
    ],
  });
}

export function getScope(ctx, name) {
  if (name === 'user') return ctx.user;
  if (name === 'project') {
    if (!ctx.project) throw noProjectError(ctx);
    return ctx.project;
  }
  throw new SkmError(`Unknown scope "${name}".`, { hint: 'Use "user" or "project".' });
}
