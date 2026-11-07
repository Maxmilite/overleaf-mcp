import { z } from 'zod';
import { parseSections, findIncludes } from './latex.mjs';
import { convertImage, targetPathFor, SUPPORTED_INPUT, MAX_IMAGE_BYTES } from './image.mjs';
import path from 'node:path';

/**
 * Tool surface.
 *
 * The primitives are deliberately mechanical — a tree, a line-numbered read, a
 * regex search, and an atomic edit that works on exact bytes. There is no
 * "section" abstraction here on purpose: section titles are not unique across a
 * paper, a section's extent is ambiguous the moment a subsection exists, and
 * every guess the server makes is a silent edit the user did not ask for.
 *
 * `apply_edits` is the only writer that matters. It either applies every edit in
 * the call or none of them, and it refuses ambiguous matches instead of picking
 * one — a commit is much harder to undo than a retry.
 */

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const errorText = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

const projectArg = z
  .string()
  .optional()
  .describe('Which configured project to use (the key in projects.json). Defaults to "default".');

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_CONVERT_BATCH_BYTES = 256 * 1024 * 1024;
const READ_DEFAULT_LINES = 400;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describeCommit(what, result) {
  if (!result.committed) return `${what}: ${result.message}`;
  return `Pushed ${what} to Overleaf as commit ${result.sha} — "${result.message}".`;
}

/** Count non-overlapping occurrences. */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

/** A window of lines with 1-based numbering, so edit ranges are unambiguous. */
function numbered(content, offset = 1, limit = READ_DEFAULT_LINES) {
  const lines = content.split('\n');
  const total = lines.length;
  const from = Math.max(1, Math.min(offset, total));
  const to = Math.min(total, from + limit - 1);
  const body = lines
    .slice(from - 1, to)
    .map((line, i) => `${String(from + i).padStart(6)}\t${line}`)
    .join('\n');
  return { body, from, to, total, truncated: to < total || from > 1 };
}

/**
 * Walk the document tree from the root file, following \input and \include.
 * CVPR-style templates keep one file per section, so the root document holds
 * almost no prose.
 */
async function projectOutline(repo, rootFile) {
  const rows = [];
  const visited = new Set();

  const walk = async (file, depth, fromDir) => {
    if (depth > 8) return;
    const candidates = fromDir
      ? [path.posix.normalize(file), path.posix.normalize(path.posix.join(fromDir, file))]
      : [path.posix.normalize(file)];

    let rel = null;
    let content = null;
    for (const candidate of candidates) {
      if (visited.has(candidate)) return;
      try {
        ({ content } = await repo.readFile(candidate));
        rel = candidate;
        break;
      } catch {
        /* try the next candidate */
      }
    }
    if (content === null) return;
    visited.add(rel);

    for (const s of parseSections(content)) rows.push({ file: rel, type: s.type, level: s.level, title: s.title });
    const dir = path.posix.dirname(rel);
    for (const inc of findIncludes(content)) await walk(inc, depth + 1, dir === '.' ? null : dir);
  };

  await walk(rootFile, 0, null);
  return rows;
}

export function registerTools(server, { projects, repoFor }) {
  const projectLabel = (key) => {
    const p = projects[key];
    return `- ${key}: ${p.name} (project id ${p.projectId})`;
  };

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List the Overleaf projects this server can access.',
      inputSchema: {},
    },
    async () => {
      const seen = new Set();
      const lines = [];
      for (const [key, p] of Object.entries(projects)) {
        if (seen.has(p)) continue;
        seen.add(p);
        lines.push(projectLabel(key));
      }
      return text(`Configured Overleaf projects:\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'get_tree',
    {
      title: 'Directory tree',
      description:
        'Show the project file tree with sizes so you can see how the paper is organised before reading anything. LaTeX templates usually keep one file per section under sec/, with figures in their own directories; sizes tell you which files hold prose and which are figure stubs.',
      inputSchema: {
        path: z.string().optional().describe('Directory to start from, relative to the project root. Defaults to the root.'),
        depth: z.number().optional().describe('How many directory levels to descend. Defaults to 3.'),
        all: z.boolean().optional().describe('Include images and PDFs as well. Off by default, because figure directories otherwise bury the source files.'),
        projectName: projectArg,
      },
    },
    async ({ path: startPath, depth, all, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const match = all ? () => true : (rel) => !/\.(png|jpe?g|gif|webp|bmp|tiff?|pdf|eps|ps|mp4|mov|zip)$/i.test(rel);
        const { entries, truncated } = await repo.listTree({ dir: startPath || '.', depth: depth ?? 3, match });
        if (!entries.length) return text('The directory is empty.');

        const lines = entries.map((e) => {
          const indent = '  '.repeat(e.depth);
          if (e.type === 'dir') return `${indent}${e.rel.split('/').pop()}/`;
          if (e.type === 'hidden') return `${indent}(${e.count} binary/image file${e.count === 1 ? '' : 's'})`;
          const name = e.rel.split('/').pop();
          return `${indent}${name.padEnd(Math.max(12, 34 - indent.length))}${formatSize(e.size)}`;
        });

        const files = entries.filter((e) => e.type === 'file');
        const total = files.reduce((sum, f) => sum + f.size, 0);
        return text(
          `${repo.project.name} — ${files.length} files, ${formatSize(total)}\n\n${lines.join('\n')}` +
            (truncated ? '\n\n(listing truncated; narrow it with path or depth)' : ''),
        );
      });
    },
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description:
        'Read a file with line numbers. Use offset and limit to page through long files instead of reading them whole — a 2000-line paper section costs more context than the edit needs.',
      inputSchema: {
        filePath: z.string().describe('Path relative to the project root, e.g. "sec/3_method.tex"'),
        offset: z.number().optional().describe('First line to return, 1-based. Defaults to 1.'),
        limit: z.number().optional().describe('How many lines to return. Defaults to 400.'),
        projectName: projectArg,
      },
    },
    async ({ filePath, offset, limit, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const { rel, content } = await repo.readFile(filePath);
        const { body, from, to, total, truncated } = numbered(content, offset ?? 1, limit ?? READ_DEFAULT_LINES);
        const header =
          truncated || from > 1
            ? `${rel} — lines ${from}-${to} of ${total}, ${content.length} chars total`
            : `${rel} — ${total} lines, ${content.length} chars`;
        return text(`${header}\n${body}`);
      });
    },
  );

  server.registerTool(
    'grep',
    {
      title: 'Search',
      description:
        'Regex search across the project files and return file:line matches. Faster than reading files to find where something lives — use it to locate a section, a macro, a figure reference or a TODO.',
      inputSchema: {
        pattern: z.string().describe('JavaScript regular expression, e.g. "\\\\\\\\section\\\\{(Intro|Method)" or "TODO"'),
        path: z.string().optional().describe('Only search files whose path starts with this prefix, e.g. "sec/".'),
        extension: z.string().optional().describe('Only search this extension. Defaults to .tex'),
        maxResults: z.number().optional().describe('Stop after this many matches. Defaults to 60.'),
        projectName: projectArg,
      },
    },
    async ({ pattern, path: pathPrefix, extension, maxResults, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        let re;
        try {
          re = new RegExp(pattern);
        } catch (err) {
          return errorText(`Invalid regular expression: ${err.message}`);
        }

        const files = await repo.listFiles(extension ?? '.tex');
        const limit = maxResults ?? 60;
        const hits = [];
        let scanned = 0;

        for (const file of files) {
          if (pathPrefix && !file.startsWith(pathPrefix)) continue;
          scanned++;
          const { content } = await repo.readFile(file).catch(() => ({ content: null }));
          if (content === null) continue;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              const trimmed = lines[i].trim();
              hits.push(`${file}:${i + 1}: ${trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed}`);
              if (hits.length >= limit) break;
            }
          }
          if (hits.length >= limit) break;
        }

        if (!hits.length) return text(`No match for /${pattern}/ in ${scanned} file(s).`);
        return text(`${hits.length} match(es) in ${scanned} file(s):\n${hits.join('\n')}${hits.length >= limit ? '\n(stopped at the limit)' : ''}`);
      });
    },
  );

  server.registerTool(
    'apply_edits',
    {
      title: 'Edit file',
      description:
        'Edit a file and push it to Overleaf as one commit. Every edit in the call must apply, or nothing is written — a half-applied commit is worse than a retry. Use read_file first to get the exact text and line numbers.',
      inputSchema: {
        filePath: z.string().describe('Path relative to the project root'),
        edits: z
          .array(
            z.object({
              oldText: z.string().optional().describe('Exact text to replace. Must appear exactly once unless replaceAll is set.'),
              newText: z.string().optional().describe('Replacement text. Use "" to delete.'),
              startLine: z.number().optional().describe('First line of a range to replace, 1-based inclusive (alternative to oldText).'),
              endLine: z.number().optional().describe('Last line of the range, 1-based inclusive.'),
              replaceAll: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one.'),
            }),
          )
          .describe('Edits to apply. Use either oldText/newText or startLine/endLine/newText in a call, not a mix.'),
        commitMessage: z.string().describe('Commit message shown in the Overleaf history'),
        projectName: projectArg,
      },
    },
    async ({ filePath, edits, commitMessage, projectName }) => {
      const repo = repoFor(projectName);
      if (!edits?.length) return errorText('edits must contain at least one entry.');

      const byRange = edits.filter((e) => e.startLine != null || e.endLine != null);
      const byText = edits.filter((e) => e.startLine == null && e.endLine == null);
      if (byRange.length && byText.length) {
        return errorText(
          'A single call must use one addressing mode. Pass either oldText/newText or startLine/endLine/newText, not both — ' +
            'line numbers and text anchors cannot both stay valid once the first edit shifts the file.',
        );
      }

      return repo.run(async () => {
        await repo.fetchAndReset();
        const { rel, content } = await repo.readFile(filePath);
        let working = content;

        try {
          if (byRange.length) {
            const lines = working.split('\n');
            // Apply from the bottom up so earlier edits cannot invalidate later line numbers.
            const sorted = [...byRange].sort((a, b) => (b.startLine ?? 0) - (a.startLine ?? 0));
            for (const edit of sorted) {
              const start = edit.startLine;
              const end = edit.endLine;
              if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error('startLine and endLine must both be integers');
              if (start < 1 || end < start || end > lines.length) {
                throw new Error(`Range [${start}, ${end}] is outside the file (it has ${lines.length} lines)`);
              }
              lines.splice(start - 1, end - start + 1, ...(edit.newText ?? '').split('\n'));
            }
            working = lines.join('\n');
          } else {
            for (const [index, edit] of byText.entries()) {
              const oldText = edit.oldText;
              if (!oldText) throw new Error(`edit ${index + 1}: oldText is required`);
              const count = countOccurrences(working, oldText);
              if (count === 0) {
                throw new Error(
                  `edit ${index + 1}: oldText was not found. The file may have changed, or the text differs by whitespace — ` +
                    'read the file again and copy the exact characters, including indentation.',
                );
              }
              if (count > 1 && !edit.replaceAll) {
                throw new Error(
                  `edit ${index + 1}: oldText matches ${count} times. Extend it with surrounding lines so it is unique, ` +
                    'or set replaceAll when every occurrence really should change.',
                );
              }
              working = edit.replaceAll
                ? working.split(oldText).join(edit.newText ?? '')
                : working.replace(oldText, edit.newText ?? '');
            }
          }
        } catch (err) {
          return errorText(`${err.message}\n\nNothing was written.`);
        }

        if (working === content) return text(`${rel}: the edits produced no change.`);

        const result = await repo.writeFile(rel, working, commitMessage);
        const delta = working.split('\n').length - content.split('\n').length;
        const sizeNote = delta === 0 ? 'line count unchanged' : `${delta > 0 ? '+' : ''}${delta} line(s)`;
        return text(`${describeCommit(`${rel} (${edits.length} edit${edits.length === 1 ? '' : 's'}, ${sizeNote})`, result)}`);
      });
    },
  );

  server.registerTool(
    'write_file',
    {
      title: 'Write file',
      description:
        'Replace a whole file, or create a new one, and push it as one commit. For changing part of an existing file prefer apply_edits — a whole-file write discards anything you did not reproduce exactly.',
      inputSchema: {
        filePath: z.string().describe('Path relative to the project root'),
        content: z.string().describe('Full new file content'),
        commitMessage: z.string().describe('Commit message shown in the Overleaf history'),
        projectName: projectArg,
      },
    },
    async ({ filePath, content, commitMessage, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const result = await repo.writeFile(filePath, content, commitMessage);
        return text(describeCommit(filePath, result));
      });
    },
  );

  server.registerTool(
    'move_files',
    {
      title: 'Move or rename files',
      description:
        'Move or rename files and directories, pushing one commit. Use it to reorganise figures without rewriting their contents. Paths inside \\input and \\includegraphics are not rewritten — grep for the old name afterwards.',
      inputSchema: {
        moves: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .describe('Source and destination pairs, e.g. [{"from":"figures/old.png","to":"figures/new.png"}]'),
        commitMessage: z.string().describe('Commit message shown in the Overleaf history'),
        projectName: projectArg,
      },
    },
    async ({ moves, commitMessage, projectName }) => {
      const repo = repoFor(projectName);
      if (!moves?.length) return errorText('moves must contain at least one pair.');

      return repo.run(async () => {
        await repo.fetchAndReset();
        const missing = [];
        for (const { from } of moves) {
          const info = await repo.inspect(from).catch((err) => ({ exists: false, rel: err.message }));
          if (!info.exists) missing.push(from);
        }
        if (missing.length) return errorText(`Not found, nothing was moved:\n${missing.map((m) => `  ${m}`).join('\n')}`);

        const touched = [];
        for (const { from, to } of moves) touched.push(...(await repo.moveRaw(from, to)));
        const result = await repo.commitAndPush(touched, commitMessage);
        const summary = moves.map((m) => `  ${m.from} → ${m.to}`).join('\n');
        return text(`${summary}\n${describeCommit(`${moves.length} move(s)`, result)}`);
      });
    },
  );

  server.registerTool(
    'delete_files',
    {
      title: 'Delete files',
      description:
        'Delete files, or directories with recursive, in one commit. Overleaf keeps the history so this is recoverable, but grep for references first — a deleted figure that is still in \\includegraphics breaks the build.',
      inputSchema: {
        filePaths: z.array(z.string()).describe('Paths to delete, relative to the project root'),
        recursive: z.boolean().optional().describe('Required to delete a directory and everything inside it'),
        commitMessage: z.string().describe('Commit message shown in the Overleaf history'),
        projectName: projectArg,
      },
    },
    async ({ filePaths, recursive, commitMessage, projectName }) => {
      const repo = repoFor(projectName);
      if (!filePaths?.length) return errorText('filePaths must contain at least one path.');

      return repo.run(async () => {
        await repo.fetchAndReset();

        // Check the whole batch before unlinking anything, so a typo cannot leave
        // a half-deleted directory that the next call silently rolls back.
        const missing = [];
        const directories = [];
        let bytes = 0;
        for (const p of filePaths) {
          const info = await repo.inspect(p);
          if (!info.exists) missing.push(p);
          else {
            if (info.isDirectory) directories.push(p);
            bytes += info.size;
          }
        }
        if (missing.length) return errorText(`Not found, nothing was deleted:\n${missing.map((m) => `  ${m}`).join('\n')}`);
        if (directories.length && !recursive) {
          return errorText(
            `These are directories:\n${directories.map((d) => `  ${d}`).join('\n')}\n` +
              'Pass recursive: true to delete them and everything inside.',
          );
        }

        const removed = [];
        for (const p of filePaths) removed.push(await repo.removeRaw(p, { recursive: true }));
        const result = await repo.commitAndPush(removed, commitMessage);
        const summary = removed.slice(0, 40).map((r) => `  - ${r}`).join('\n');
        return text(
          `${summary}${removed.length > 40 ? `\n  … ${removed.length - 40} more` : ''}\n` +
            describeCommit(`${removed.length} path(s), ${formatSize(bytes)} freed`, result),
        );
      });
    },
  );

  server.registerTool(
    'convert_images',
    {
      title: 'Convert images',
      description:
        'Transcode images in a batch and push one commit — the only way to change image bytes, because the model cannot decode a PNG. Converting png to jpeg also rewrites the extension; update \\includegraphics with grep and apply_edits afterwards. JPEG suits photographs; line art and plots usually get smaller and sharper as PNG or PDF.',
      inputSchema: {
        filePaths: z.array(z.string()).describe('Image paths to convert, e.g. ["figures/a.png","figures/b.png"]'),
        format: z.enum(['jpeg', 'png', 'webp']).describe('Target format'),
        quality: z.number().optional().describe('1-100 for jpeg/webp. Defaults to 82.'),
        keepOriginal: z.boolean().optional().describe('Defaults to true. Set false to delete the source after converting, which is what actually saves space.'),
        background: z.string().optional().describe('Colour flattened behind transparency when writing jpeg, e.g. "#ffffff". Defaults to white.'),
        commitMessage: z.string().describe('Commit message shown in the Overleaf history'),
        projectName: projectArg,
      },
    },
    async ({ filePaths, format, quality, keepOriginal, background, commitMessage, projectName }) => {
      const repo = repoFor(projectName);
      if (!filePaths?.length) return errorText('filePaths must contain at least one path.');

      return repo.run(async () => {
        await repo.fetchAndReset();

        // Convert everything in memory first: a batch that fails on file 30 must
        // not leave 29 half-converted files and a broken build.
        const jobs = [];
        let totalIn = 0;
        for (const p of filePaths) {
          if (!SUPPORTED_INPUT.test(p)) return errorText(`Not an image this tool can read: ${p}`);
          const { rel, buffer } = await repo.readBinary(p);
          if (buffer.length > MAX_IMAGE_BYTES) return errorText(`${rel} is ${formatSize(buffer.length)}, over the ${formatSize(MAX_IMAGE_BYTES)} limit.`);
          totalIn += buffer.length;
          if (totalIn > MAX_CONVERT_BATCH_BYTES) {
            return errorText(`This batch is over ${formatSize(MAX_CONVERT_BATCH_BYTES)}; split it into smaller calls.`);
          }
          let converted;
          try {
            converted = await convertImage(buffer, { format, quality, background });
          } catch (err) {
            return errorText(`${rel}: ${err.message}\n\nNothing was written.`);
          }
          jobs.push({ source: rel, target: targetPathFor(rel, format), before: buffer.length, ...converted });
        }

        const written = [];
        const removed = [];
        for (const job of jobs) {
          written.push(await repo.writeRaw(job.target, job.buffer));
          if (!keepOriginal && job.target !== job.source) removed.push(await repo.removeRaw(job.source));
        }

        const result = await repo.commitAndPush([...written, ...removed], commitMessage);
        const rows = jobs.map((j) => {
          const delta = j.buffer.length - j.before;
          const pct = j.before ? Math.round((delta / j.before) * 100) : 0;
          const arrow = j.target === j.source ? 'recompressed' : `${j.source} → ${j.target}`;
          return `  ${arrow}\n    ${formatSize(j.before)} → ${formatSize(j.buffer.length)} (${pct > 0 ? '+' : ''}${pct}%)`;
        });
        const grew = jobs.filter((j) => j.buffer.length >= j.before).length;
        const note = grew ? `\n${grew} file(s) got larger — that format is a poor fit for them.` : '';
        return text(`${rows.join('\n')}${note}\n${describeCommit(`${jobs.length} image(s) to ${format}`, result)}`);
      });
    },
  );

  server.registerTool(
    'read_image',
    {
      title: 'View image',
      description:
        'Return an image from the project as a picture so you can actually look at it. Use this to check a figure after changing it. For LaTeX sources use read_file instead.',
      inputSchema: {
        filePath: z.string().describe('Path to the image, e.g. "figures/pipeline/latent.jpg"'),
        projectName: projectArg,
      },
    },
    async ({ filePath, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const mime = IMAGE_MIME[path.extname(filePath).toLowerCase()];
        if (!mime) {
          return errorText(`"${filePath}" is not an image this tool can display. Supported: ${Object.keys(IMAGE_MIME).join(', ')}.`);
        }
        const { rel, buffer } = await repo.readBinary(filePath);
        if (buffer.length > 8 * 1024 * 1024) return errorText(`${rel} is ${formatSize(buffer.length)} — too large to send as an image.`);
        return {
          content: [
            { type: 'image', data: buffer.toString('base64'), mimeType: mime },
            { type: 'text', text: `${rel} · ${formatSize(buffer.length)} · ${mime}` },
          ],
        };
      });
    },
  );

  server.registerTool(
    'upload_file',
    {
      title: 'Upload file',
      description:
        'Add or replace a binary file (figure, PDF) from base64 content, committing it to Overleaf. For text and LaTeX sources use write_file — base64 is only worth the overhead for binary assets.',
      inputSchema: {
        filePath: z.string().describe('Destination path, e.g. "figures/method/overview.png"'),
        contentBase64: z.string().describe('File bytes, base64 encoded'),
        commitMessage: z.string().describe('Commit message shown in the Overleaf history'),
        projectName: projectArg,
      },
    },
    async ({ filePath, contentBase64, commitMessage, projectName }) => {
      const repo = repoFor(projectName);
      const cleaned = String(contentBase64).replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
      if (!cleaned) return errorText('contentBase64 is empty.');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return errorText('contentBase64 is not valid base64.');

      const buffer = Buffer.from(cleaned, 'base64');
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return errorText(
          `${formatSize(buffer.length)} exceeds the ${formatSize(MAX_UPLOAD_BYTES)} limit for this tool. ` +
            'Use the /files HTTP endpoint instead (see the server documentation).',
        );
      }

      return repo.run(async () => {
        await repo.fetchAndReset();
        const result = await repo.writeBinary(filePath, buffer, commitMessage);
        return text(`${describeCommit(filePath, result)} (${formatSize(buffer.length)})`);
      });
    },
  );

  server.registerTool(
    'status_summary',
    {
      title: 'Project summary',
      description: 'Orientation for an unfamiliar project: file inventory, the section outline of the whole document tree, and repository state.',
      inputSchema: { projectName: projectArg },
    },
    async ({ projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const all = await repo.listFiles('');
        const tex = all.filter((f) => f.endsWith('.tex'));
        const branch = await repo.currentBranch();

        const out = [
          `Project: ${repo.project.name} (id ${repo.project.projectId})`,
          `Branch: ${branch}`,
          `Files: ${all.length} (${tex.length} LaTeX)`,
          '',
          'Files:',
          ...all.slice(0, 200).map((f) => `  - ${f}`),
        ];
        if (all.length > 200) out.push(`  … ${all.length - 200} more`);

        // The root document is whichever .tex carries \documentclass; main.tex is
        // just the overwhelmingly common name for it.
        let root = null;
        for (const f of tex) {
          const { content } = await repo.readFile(f).catch(() => ({ content: '' }));
          if (/\\documentclass/.test(content)) {
            root = f;
            break;
          }
        }
        root = root ?? tex[0];

        if (root) {
          const rows = await projectOutline(repo, root);
          out.push('', `Outline from ${root}:`);
          if (!rows.length) out.push('  (no sectioning commands in the document tree)');
          let currentFile = null;
          for (const row of rows) {
            if (row.file !== currentFile) {
              out.push(`  [${row.file}]`);
              currentFile = row.file;
            }
            out.push(`    ${'  '.repeat(Math.max(0, row.level - 2))}${row.type} — ${row.title}`);
          }
        }
        return text(out.join('\n'));
      });
    },
  );
}
