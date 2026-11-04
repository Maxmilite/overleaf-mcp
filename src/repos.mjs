import { resolveProject, statePaths } from './config.mjs';
import { OverleafRepo } from './git.mjs';

/**
 * One OverleafRepo per project, shared by every caller.
 *
 * Sharing matters: each repo serialises git operations behind its own mutex, and
 * two registries would mean two mutexes over one working tree — exactly the
 * concurrent add/commit that leaves a half-written index behind.
 */
export function createRepoRegistry({ projects, stateDir }) {
  const repos = new Map();
  return (projectName) => {
    const project = resolveProject(projects, projectName);
    const key = `${project.key}:${project.projectId}`;
    if (!repos.has(key)) repos.set(key, new OverleafRepo(project, statePaths(stateDir, project)));
    return repos.get(key);
  };
}
