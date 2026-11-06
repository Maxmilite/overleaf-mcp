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

  async fetchQuiet() {
    await git([...this.credentialArgs(), '-C', this.repoPath, 'fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  }

  /**
   * Replay local commits on top of the remote.
   *
   * Overleaf gets edited in the browser while we hold a clone, so a push can
   * lose the race. Rebasing keeps our commit instead of dropping it; if the
   * two histories disagree, abandon the rebase and leave the clone clean for a
   * human rather than leaving a half-resolved tree behind.
   */
  async rebaseOntoRemote() {
    const branch = await this.currentBranch();
    try {
      await git(['-C', this.repoPath, 'rebase', '--quiet', `origin/${branch}`]);
      return true;
    } catch {
      await git(['-C', this.repoPath, 'rebase', '--abort']).catch(() => {});
      return false;
    }
  }

  /**
   * Bring the working tree to exactly match the remote.
   *
   * A plain `git pull` turns an unrelated history into a merge conflict that
   * needs a human; this server has no human. Because every write pushes
   * immediately, the local tree is expected to equal the remote, so a hard
   * reset is both safe and deterministic.
   *
   * The exception is a commit left behind by a push that lost the race — that
   * one is somebody's edit, so replay it instead of discarding it.
   */
  async fetchAndReset() {
    await this.ensureCloned();
    await this.fetchQuiet();
    const branch = await this.currentBranch();
    const ahead = await this.commitsAhead();

    if (ahead > 0) {
      if (await this.rebaseOntoRemote()) return;
      throw new Error(
        `The clone has ${ahead} unpushed commit(s) that conflict with changes made on Overleaf. ` +
          `Resolve them on the host: git -C ${this.repoPath} rebase origin/${branch}`,
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

  /**
   * Directory listing with sizes, for navigation.
   *
   * A flat file list is not enough to orient in a paper repository: `sec/3_method.tex`
   * (20 KB of prose) and `sec/figures/teaser/teaser-1.tex` (a 300-byte figure stub)
   * are indistinguishable once the paths are flattened, and the model then guesses.
   *
   * Directories whose files are all filtered out still appear, annotated with how
   * many were hidden — a paper repository is mostly figures, and listing 40 jpgs
   * buries the five files that actually matter.
   */
  async listTree({ dir = '.', depth = 3, maxEntries = 400, match = () => true } = {}) {
    const { full: startFull } = this.resolveSafePath(dir);
    const root = path.resolve(this.repoPath);
    const fs = await import('node:fs/promises');
    const entries = [];
    let truncated = false;

    const walk = async (current, level) => {
      const dirents = await fs.readdir(current, { withFileTypes: true });
      dirents.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      let hidden = 0;
      const childDirs = [];
      for (const dirent of dirents) {
        if (dirent.name === '.git' || dirent.name === 'node_modules') continue;
        const abs = path.join(current, dirent.name);
        const rel = path.relative(root, abs).split(path.sep).join('/');

        if (dirent.isDirectory()) {
          childDirs.push({ abs, rel });
          continue;
        }
        if (!match(rel)) {
          hidden++;
          continue;
        }
        if (entries.length >= maxEntries) {
          truncated = true;
          continue;
        }
        const stat = await fs.stat(abs).catch(() => null);
        entries.push({ rel, type: 'file', size: stat ? stat.size : 0, depth: level });
      }

      if (hidden) entries.push({ rel: path.relative(root, current).split(path.sep).join('/') || '.', type: 'hidden', count: hidden, depth: level });

      for (const child of childDirs) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        entries.push({ rel: child.rel, type: 'dir', depth: level });
        if (level < depth) await walk(child.abs, level + 1);
      }
    };

    await walk(startFull, 0);
    return { entries, truncated };
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

  /** Raw bytes, for images and PDFs that cannot go through utf8. */
  async readBinary(filePath) {
    const { full, rel } = this.resolveSafePath(filePath);
    const fs = await import('node:fs/promises');
    try {
      return { rel, buffer: await fs.readFile(full) };
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error(`File not found in project: ${rel}`);
      throw err;
    }
  }

  async writeBinary(filePath, buffer, commitMessage) {
    const { full, rel } = this.resolveSafePath(filePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return this.commitAndPush(rel, commitMessage);
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
    const push = () => git([...this.credentialArgs(), '-C', this.repoPath, 'push', '--quiet', 'origin', `HEAD:${branch}`]);

    try {
      await push();
    } catch (err) {
      if (!/rejected|non-fast-forward|fetch first/i.test(err.message)) throw err;

      // Somebody saved in the browser between our fetch and our push. Replay our
      // commit on top of theirs and try once more — retrying the whole tool call
      // would redo the edit against a tree that already contains it.
      await this.fetchQuiet();
      if (!(await this.rebaseOntoRemote())) {
        throw new Error(
          'The project changed on Overleaf while you were editing, and the two changes conflict. ' +
            'Your edit is committed locally but not pushed. Resolve it on the host: ' +
            `git -C ${this.repoPath} rebase origin/${branch}`,
        );
      }
      await push();
    }

    const { stdout: sha } = await git(['-C', this.repoPath, 'rev-parse', '--short', 'HEAD']);
    return { committed: true, sha: sha.trim(), message };
  }
}
