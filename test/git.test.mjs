import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OverleafRepo } from '../src/git.mjs';

/**
 * A push can lose the race with somebody saving in the Overleaf editor, and a
 * commit left behind by a failed push must not be thrown away. These tests pin
 * down what happens next.
 *
 * The race is real, not simulated: a pre-push hook makes a second clone commit
 * and push first, so the push under test is genuinely rejected as
 * non-fast-forward.
 */

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function scaffold() {
  const root = await mkdtemp(path.join(tmpdir(), 'olmcp-git-'));
  const remote = path.join(root, 'remote.git');
  const author = path.join(root, 'author');
  const state = path.join(root, 'state');

  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  mkdir(author);
  git(author, 'init', '--quiet', '--initial-branch=main');
  git(author, 'config', 'user.email', 'author@example.com');
  git(author, 'config', 'user.name', 'Author');
  await writeFile(path.join(author, 'main.tex'), 'line one\nline two\nline three\n');
  git(author, 'add', '-A');
  git(author, 'commit', '--quiet', '-m', 'init');
  git(author, 'remote', 'add', 'origin', remote);
  git(author, 'push', '--quiet', 'origin', 'main');

  mkdir(state, { recursive: true });
  // Overleaf answers on https://git.overleaf.com/<id>; a bare repo on disk speaks
  // the same protocol and keeps the test offline. gitBase/projectId compose into
  // the remote URL, so the bare repo *is* the project id.
  const repo = new OverleafRepo(
    { name: 'Test', projectId: 'remote.git', token: 'unused', gitBase: `file://${root}`, branch: undefined },
    { repo: path.join(state, 'repo'), credentials: path.join(state, 'cred') },
  );
  await repo.writeCredentials();
  await repo.ensureCloned();

  const mark = path.join(root, 'hook-fired');
  const hooks = path.join(state, 'repo', '.git', 'hooks');
  await mkdir(hooks, { recursive: true });

  return {
    root,
    remote,
    author,
    repo,
    repoDir: path.join(state, 'repo'),
    /** Make the next push lose the race by committing `changes` from the author clone. */
    async raceWith(changes, message = 'browser save') {
      const body = Object.entries(changes)
        .map(([file, content]) => `cat > '${path.join(author, file)}' <<'EOF'\n${content}EOF`)
        .join('\n');
      const script = `#!/bin/sh
[ -f '${mark}' ] && exit 0
touch '${mark}'
cd '${author}' || exit 0
git pull --quiet --no-rebase origin main
${body}
git add -A && git commit --quiet -m '${message}' && git push --quiet origin main
exit 0
`;
      const hookPath = path.join(hooks, 'pre-push');
      await writeFile(hookPath, script);
      await chmod(hookPath, 0o755);
    },
    remoteLog: () => git(root, '--git-dir', remote, 'log', '--format=%s', 'main'),
    remoteFile: (file) => git(root, '--git-dir', remote, 'show', `main:${file}`),
  };
}

test('a push that loses the race is replayed on top of the other commit', async () => {
  const s = await scaffold();
  try {
    await s.repo.fetchAndReset();
    await s.raceWith({ 'other.tex': 'unrelated\n' });

    const result = await s.repo.writeFile('main.tex', 'line one\nline two EDITED\nline three\n', 'edit from mcp');
    assert.equal(result.committed, true);

    const log = s.remoteLog();
    assert.match(log, /edit from mcp/);
    assert.match(log, /browser save/);
    // Their commit must come first — ours was replayed, not merged in reverse.
    assert.ok(log.indexOf('edit from mcp') < log.indexOf('browser save'), 'our edit sits on top');
    assert.equal(s.remoteFile('other.tex').trim(), 'unrelated');
    assert.match(s.remoteFile('main.tex'), /line two EDITED/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('an unpushed commit is replayed by the next call, not hard-reset away', async () => {
  const s = await scaffold();
  try {
    await s.repo.fetchAndReset();
    // A commit that never reached the remote, as a rejected push would leave behind.
    await writeFile(path.join(s.repoDir, 'notes.tex'), 'our local work\n');
    git(s.repoDir, 'add', '-A');
    git(s.repoDir, 'commit', '--quiet', '-m', 'stranded edit');

    await s.raceWith({ 'other.tex': 'unrelated\n' });
    // Put the remote ahead without pushing: the author's hook only fires on a push,
    // so advance it directly.
    git(s.author, 'pull', '--quiet', '--no-rebase', 'origin', 'main');
    await writeFile(path.join(s.author, 'other.tex'), 'unrelated\n');
    git(s.author, 'add', '-A');
    git(s.author, 'commit', '--quiet', '-m', 'browser save');
    git(s.author, 'push', '--quiet', 'origin', 'main');

    await s.repo.fetchAndReset();
    assert.equal(await s.repo.commitsAhead(), 1, 'the stranded commit survived the fetch');
    assert.match(await readFile(path.join(s.repoDir, 'notes.tex'), 'utf8'), /our local work/);

    await s.repo.writeFile('other.tex', 'edited by mcp\n', 'second edit');
    assert.match(s.remoteLog(), /stranded edit/);
    assert.match(s.remoteLog(), /browser save/);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test('a conflicting push aborts cleanly and keeps the local commit', async () => {
  const s = await scaffold();
  try {
    await s.repo.fetchAndReset();
    // The author rewrites the same line we are about to touch.
    await s.raceWith({ 'main.tex': 'line one\nTHEIRS\nline three\n' }, 'their edit');

    await assert.rejects(
      () => s.repo.writeFile('main.tex', 'line one\nOURS\nline three\n', 'our edit'),
      /conflict/i,
    );

    // No half-finished rebase left on disk for the next tool call to trip over.
    const head = await readFile(path.join(s.repoDir, '.git', 'HEAD'), 'utf8');
    assert.ok(head.trim().startsWith('ref:'), 'still on a branch');
    assert.doesNotMatch(git(s.repoDir, 'status', '--porcelain', '-b'), /rebase in progress/);
    // Our edit is still here, and still ours.
    assert.match(git(s.repoDir, 'show', 'HEAD:main.tex'), /OURS/);
    assert.equal(await s.repo.commitsAhead(), 1);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});
