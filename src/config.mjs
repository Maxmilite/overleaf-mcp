import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Project configuration.
 *
 * A "project" is one Overleaf project reachable over the Git bridge. Every
 * project needs its own project id; the git token is account-wide on Overleaf,
 * so a single token normally serves all of them.
 *
 * Sources, first match wins:
 *   1. OVERLEAF_PROJECTS_CONFIG=/abs/path/projects.json
 *   2. OVERLEAF_PROJECT_ID [+ OVERLEAF_GIT_TOKEN | OVERLEAF_GIT_TOKEN_FILE]
 *
 * Deliberately no "read projects.json out of the current directory" fallback:
 * a server started by systemd has an unpredictable cwd, and silently adopting
 * whatever happens to be there is how you end up editing the wrong paper.
 */

const fail = (msg) => {
  throw new Error(`[config] ${msg}`);
};

const readToken = async (entry, key) => {
  if (typeof entry.gitToken === 'string' && entry.gitToken.trim()) {
    return entry.gitToken.trim();
  }
  if (typeof entry.gitTokenFile === 'string' && entry.gitTokenFile.trim()) {
    try {
      return (await readFile(entry.gitTokenFile.trim(), 'utf8')).trim();
    } catch (err) {
      fail(`project "${key}": cannot read gitTokenFile ${entry.gitTokenFile}: ${err.message}`);
    }
  }
  return '';
};

const normalise = (key, entry, token, env) => {
  const projectId = String(entry.projectId ?? '').trim();
  if (!projectId) fail(`project "${key}" is missing projectId`);
  if (/\s/.test(projectId)) fail(`project "${key}" projectId contains whitespace`);
  // The project id becomes a path component as well as a git remote, so keep it
  // to the character set Overleaf actually issues.
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    fail(`project "${key}" projectId "${projectId}" contains unexpected characters`);
  }
  if (!token) fail(`project "${key}" has no git token`);
  return {
    key,
    name: String(entry.name ?? key).trim() || key,
    projectId,
    token,
    // Overleaf's git bridge may serve either branch name depending on age.
    branch: String(entry.branch ?? '').trim() || null,
    // Overridable for Overleaf Server Pro / self-hosted instances.
    gitBase: String(entry.gitBase ?? env.OVERLEAF_GIT_BASE ?? 'https://git.overleaf.com').replace(/\/$/, ''),
  };
};

export async function loadProjects(env = process.env) {
  const projects = {};

  if (env.OVERLEAF_PROJECTS_CONFIG) {
    let raw;
    try {
      raw = JSON.parse(await readFile(env.OVERLEAF_PROJECTS_CONFIG, 'utf8'));
    } catch (err) {
      fail(`cannot load OVERLEAF_PROJECTS_CONFIG: ${err.message}`);
    }
    const entries = raw?.projects ?? {};
    for (const [key, entry] of Object.entries(entries)) {
      projects[key] = normalise(key, entry ?? {}, await readToken(entry ?? {}, key), env);
    }
  } else if (env.OVERLEAF_PROJECT_ID) {
    const entry = {
      projectId: env.OVERLEAF_PROJECT_ID,
      name: env.OVERLEAF_PROJECT_NAME,
      gitToken: env.OVERLEAF_GIT_TOKEN,
      gitTokenFile: env.OVERLEAF_GIT_TOKEN_FILE,
    };
    projects.default = normalise('default', entry, await readToken(entry, 'default'), env);
  }

  if (Object.keys(projects).length === 0) {
    fail('no Overleaf project configured. Set OVERLEAF_PROJECTS_CONFIG, or OVERLEAF_PROJECT_ID with OVERLEAF_GIT_TOKEN / OVERLEAF_GIT_TOKEN_FILE.');
  }

  if (!projects.default) {
    // No explicit "default" key: promote the first entry so callers that omit
    // projectName still work.
    const [firstKey] = Object.keys(projects);
    projects.default = projects[firstKey];
  }

  return projects;
}

export const resolveProject = (projects, projectName) => {
  const key = String(projectName ?? 'default').trim() || 'default';
  const project = projects[key];
  if (!project) {
    const known = Object.keys(projects).filter((k) => k !== 'default' || projects[k].key === 'default');
    throw new Error(`Unknown project "${key}". Known projects: ${[...new Set(known)].join(', ')}`);
  }
  return project;
};

/** Stable on-disk directory name for a project, independent of its display name. */
export const projectSlug = (project) => `${project.key}-${project.projectId}`.replace(/[^A-Za-z0-9_.-]/g, '_');

export const statePaths = (stateDir, project) => {
  const slug = projectSlug(project);
  return {
    repo: path.join(stateDir, 'repos', slug),
    credentials: path.join(stateDir, 'credentials', slug),
  };
};
