import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, chmod, access } from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;

/**
 * Overleaf project access over the Git bridge.
 *
 * Security note: the git token is never placed on a command line, in the
 * environment, or in the repository's .git/config.
 *
 *   - It lives in a 0600 file under the state directory.
 *   - Git is pointed at it through `credential.helper=store --file=...`.
 *   - The remote URL is the plain `https://git.overleaf.com/<id>`.
 *
 * Putting the token in the clone URL (the usual `https://git:TOKEN@host/id`
 * trick) leaks it through `ps`, into .git/config, and into every error message
 * git decides to print.
 */

const redact = (s) =>
  String(s ?? '')
    .replace(/https:\/\/git:[^@\s]+@/g, 'https://git:***@')
    .replace(/\b([A-Za-z0-9_-]{6})[A-Za-z0-9_-]{12,}\b/g, '$1…');

const git = async (args, opts = {}) => {
  try {
    return await execFileP('git', args, {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ASKPASS: '/bin/true',
        LC_ALL: 'C',
        ...opts.env,
      },
    });
  } catch (err) {
    const detail = redact(`${err.stderr || ''}${err.stdout || ''}${err.message || ''}`.trim());
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
};

export class OverleafRepo {
  constructor(project, paths) {
    this.project = project;
    this.repoPath = paths.repo;
    this.credentialsPath = paths.credentials;
    this.remoteUrl = `${project.gitBase}/${project.projectId}`;
    this.branch = project.branch;
    // Serialise every operation touching the working tree. Two concurrent tool
    // calls hitting `git add`/`commit` on the same clone produce a half-committed
    // tree that then fails to push.
    this.queue = Promise.resolve();
  }

  run(fn) {
    const next = this.queue.then(fn, fn);
    // Keep the chain alive even when a caller's operation rejects.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  credentialArgs() {
    return ['-c', `credential.helper=store --file=${this.credentialsPath}`];
  }

  async writeCredentials() {
    await mkdir(path.dirname(this.credentialsPath), { recursive: true, mode: 0o700 });
    const host = new URL(this.project.gitBase).host;
    const contents = `https://git:${this.project.token}@${host}\n`;
    await writeFile(this.credentialsPath, contents, { mode: 0o600 });
    await chmod(this.credentialsPath, 0o600);
  }

  async isCloned() {
    try {
      await access(path.join(this.repoPath, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  async ensureCloned() {
    if (await this.isCloned()) return;
    await mkdir(path.dirname(this.repoPath), { recursive: true, mode: 0o700 });
    await this.writeCredentials();
    await git([...this.credentialArgs(), 'clone', '--quiet', this.remoteUrl, this.repoPath]);
    // Persist the helper so later operations do not need it on the command line.
    await git(['-C', this.repoPath, 'config', 'credential.helper', `store --file=${this.credentialsPath}`]);
    await git(['-C', this.repoPath, 'config', 'user.email', 'overleaf-mcp@localhost']);
    await git(['-C', this.repoPath, 'config', 'user.name', 'Overleaf MCP']);
    this.branch = null; // let it be detected from the clone
  }

  async currentBranch() {
    if (this.branch) return this.branch;
    const { stdout } = await git(['-C', this.repoPath, 'symbolic-ref', '--short', 'HEAD']);
    this.branch = stdout.trim() || 'main';
    return this.branch;
  }

  /** Number of local commits the remote does not have. */
  async commitsAhead() {
    const branch = await this.currentBranch();
    try {
      const { stdout } = await git(['-C', this.repoPath, 'rev-list', '--count', `origin/${branch}..HEAD`]);
      return Number(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Bring the working tree to exactly match the remote.
   *
   * A plain `git pull` turns an unrelated history into a merge conflict that
   * needs a human; this server has no human. Because every write pushes
   * immediately, the local tree is expected to equal the remote, so a hard
   * reset is both safe and deterministic. If a previous push failed we refuse
   * rather than destroy the unpushed commit.
   */
  async fetchAndReset() {
    await this.ensureCloned();
    await git([...this.credentialArgs(), '-C', this.repoPath, 'fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
    const branch = await this.currentBranch();
    const ahead = await this.commitsAhead();
    if (ahead > 0) {
      throw new Error(
        `The local clone has ${ahead} unpushed commit(s) from an earlier failed push. ` +
          `Resolve it on the host (git -C ${this.repoPath} log) before retrying — continuing would discard them.`,
      );
    }
    await git(['-C', this.repoPath, 'reset', '--quiet', '--hard', `origin/${branch}`]);
  }

  /** Repository-relative path, rejected if it escapes the clone. */
  resolveSafePath(filePath) {
    const raw = String(filePath ?? '').trim();
    if (!raw) throw new Error('filePath is required');
    if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
      throw new Error(`filePath "${raw}" must be relative to the project root`);
    }
    const root = path.resolve(this.repoPath);
    const full = path.resolve(root, raw);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new Error(`filePath "${raw}" escapes the project directory`);
    }
    return { full, rel: path.relative(root, full).split(path.sep).join('/') };
  }

  async listFiles(extension) {
    const exts = String(extension ?? '.tex')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => (e.startsWith('.') ? e : `.${e}`));

    const walk = async (dir) => {
      const entries = await import('node:fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true }));
      const out = [];
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (!exts.length || exts.some((e) => entry.name.endsWith(e))) out.push(full);
      }
      return out;
    };

    const files = await walk(this.repoPath);
    return files.map((f) => path.relative(this.repoPath, f).split(path.sep).join('/')).sort();
  }

  async readFile(filePath) {
    const { full, rel } = this.resolveSafePath(filePath);
    let content;
    try {
      content = await readFile(full, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`File not found in project: ${rel}`);
      throw err;
    }
    return { rel, content };
  }

  async writeFile(filePath, content, commitMessage) {
    const { full, rel } = this.resolveSafePath(filePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
    return this.commitAndPush(rel, commitMessage);
  }

  async commitAndPush(rel, commitMessage) {
    const message = String(commitMessage ?? '').trim() || `Update ${rel} via overleaf-mcp`;
    await git(['-C', this.repoPath, 'add', '--', rel]);

    const { stdout: staged } = await git(['-C', this.repoPath, 'diff', '--cached', '--name-only']);
    if (!staged.trim()) {
      return { committed: false, message: 'No changes to commit — the file already matched the new content.' };
    }

    await git(['-C', this.repoPath, 'commit', '--quiet', '-m', message]);

    const branch = await this.currentBranch();
    try {
      await git([...this.credentialArgs(), '-C', this.repoPath, 'push', '--quiet', 'origin', `HEAD:${branch}`]);
    } catch (err) {
      if (/rejected|non-fast-forward|fetch first/i.test(err.message)) {
        throw new Error(
          'The push was rejected because the project changed on Overleaf while you were editing. ' +
            'Your change is committed locally. Call the tool again with the same arguments: the next call ' +
            're-pulls the project, reapplies the edit, and pushes.',
        );
      }
      throw err;
    }

    const { stdout: sha } = await git(['-C', this.repoPath, 'rev-parse', '--short', 'HEAD']);
    return { committed: true, sha: sha.trim(), message };
  }
}
