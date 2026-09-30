import pc from 'picocolors';
import { getScope } from '../context.js';
import { validateSkillData } from '../frontmatter.js';
import { SkmError, isInteractive, out, prompt, tildify } from '../ui.js';

/**
 * Pick the scope a new skill goes to. Explicit flags win; otherwise user scope,
 * unless we are in a project and can ask.
 */
export async function chooseTargetScope(ctx, opts, verb = 'install') {
  if (opts.user && opts.project) throw new SkmError('Pick one of --user or --project, not both.');
  if (opts.user) return ctx.user;
  if (opts.project) return getScope(ctx, 'project');
  if (ctx.project && isInteractive()) {
    return prompt.select(`Where should this skill ${verb === 'install' ? 'be installed' : 'go'}?`, [
      { value: ctx.user, label: 'User scope', hint: `${tildify(ctx.user.skillsDir)} — available in every project` },
      { value: ctx.project, label: 'Project scope', hint: `${tildify(ctx.project.skillsDir)} — this repo only, shareable via git` },
    ], ctx.user);
  }
  return ctx.user;
}

const LEVEL = {
  error: pc.red('error'),
  warn: pc.yellow('warn '),
  info: pc.cyan('info '),
};

export function printIssues(issues, indent = '  ') {
  for (const i of issues) {
    out.log(`${indent}${LEVEL[i.level]} ${i.message}`);
    if (i.hint) out.log(`${indent}      ${pc.dim(i.hint)}`);
  }
}

export { validateSkillData };
