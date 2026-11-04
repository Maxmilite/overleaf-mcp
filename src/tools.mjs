import { z } from 'zod';
import { parseSections, sectionExtent, findSection, lineAt, findIncludes } from './latex.mjs';
import path from 'node:path';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const errorText = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

const projectArg = z
  .string()
  .optional()
  .describe('Which configured project to use (the key in projects.json). Defaults to "default".');

/**
 * Walk the document tree from the root file, following \input and \include, and
 * collect every sectioning command with the file it came from. Templates that
 * keep one file per section would otherwise produce a empty outline.
 */
async function projectOutline(repo, rootFile) {
  const rows = [];
  const visited = new Set();

  const walk = async (file, depth, fromDir) => {
    if (depth > 8) return;
    // \input paths are usually root-relative but some templates make them
    // relative to the including file; try both before giving up.
    const candidates = fromDir ? [path.posix.normalize(file), path.posix.normalize(path.posix.join(fromDir, file))] : [path.posix.normalize(file)];
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
        lines.push(`- ${key}: ${p.name} (project id ${p.projectId})`);
      }
      return text(`Configured Overleaf projects:\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description:
        'List files in an Overleaf project. Defaults to .tex files; pass extension to widen it (e.g. ".tex,.bib", or "" for everything).',
      inputSchema: {
        extension: z.string().optional().describe('Comma-separated extension filter, e.g. ".tex,.bib". Pass "" for all files.'),
        projectName: projectArg,
      },
    },
    async ({ extension, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const files = await repo.listFiles(extension ?? '.tex');
        if (!files.length) return text('No files matched.');
        return text(files.map((f) => `- ${f}`).join('\n'));
      });
    },
  );

  server.registerTool(
    'get_tree',
    {
      title: 'Directory tree',
      description:
        'Show the project file tree with sizes, so you can see how the paper is organised before reading anything. LaTeX templates usually keep one file per section under sec/, with figures in their own directories — the sizes tell you which files hold prose and which are figure stubs.',
      inputSchema: {
        path: z.string().optional().describe('Directory to start from, relative to the project root. Defaults to the root.'),
        depth: z.number().optional().describe('How many directory levels to descend. Defaults to 3.'),
        projectName: projectArg,
      },
    },
    async ({ path: startPath, depth, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const { entries, truncated } = await repo.listTree({ dir: startPath || '.', depth: depth ?? 3 });
        if (!entries.length) return text('The directory is empty.');
        const lines = entries.map((e) => {
          const indent = '  '.repeat(e.depth);
          if (e.type === 'dir') return `${indent}${e.rel.split('/').pop()}/`;
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
      description: 'Read a file from the Overleaf project verbatim.',
      inputSchema: {
        filePath: z.string().describe('Path relative to the project root, e.g. "main.tex"'),
        projectName: projectArg,
      },
    },
    async ({ filePath, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const { rel, content } = await repo.readFile(filePath);
        return text(`${rel} (${content.length} chars)\n---\n${content}`);
      });
    },
  );

  server.registerTool(
    'get_sections',
    {
      title: 'List sections',
      description:
        'List the sectioning commands of a LaTeX file with their level, line number, and character range. Use this before get_section_content or write_section.',
      inputSchema: {
        filePath: z.string().describe('Path to the .tex file'),
        projectName: projectArg,
      },
    },
    async ({ filePath, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const { rel, content } = await repo.readFile(filePath);
        const sections = parseSections(content);
        if (!sections.length) return text(`${rel} contains no sectioning commands.`);
        const lines = sections.map((s, i) => {
          const { end } = sectionExtent(content, sections, i);
          return `${String(i).padStart(3)}  ${s.type.padEnd(14)} line ${String(lineAt(content, s.start)).padStart(5)}  [${s.start}, ${end})  ${s.title}`;
        });
        return text(`${rel}: ${sections.length} section(s)\n\n${lines.join('\n')}`);
      });
    },
  );

  server.registerTool(
    'get_section_content',
    {
      title: 'Read section',
      description:
        'Return one section of a LaTeX file, including its heading and everything it owns (subsections included), stopping at the next heading of the same or a higher level.',
      inputSchema: {
        filePath: z.string().describe('Path to the .tex file'),
        sectionTitle: z.string().describe('Exact section title, without the \\section{} wrapper'),
        projectName: projectArg,
      },
    },
    async ({ filePath, sectionTitle, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const { rel, content } = await repo.readFile(filePath);
        const sections = parseSections(content);
        const idx = findSection(sections, sectionTitle);
        if (idx === -1) {
          const known = sections.map((s) => s.title);
          return errorText(
            known.length
              ? `No section "${sectionTitle}" in ${rel}. Available: ${known.join(' | ')}`
              : `${rel} contains no sectioning commands.`,
          );
        }
        const { start, end } = sectionExtent(content, sections, idx);
        const body = content.slice(start, end);
        const line = lineAt(content, start);
        return text(`${rel} · ${sections[idx].type} · line ${line} · ${body.length} chars\n---\n${body}`);
      });
    },
  );

  server.registerTool(
    'status_summary',
    {
      title: 'Project summary',
      description: 'Summarise an Overleaf project: file inventory, section outline of the main .tex file, and repository state.',
      inputSchema: { projectName: projectArg },
    },
    async ({ projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const all = await repo.listFiles('');
        const tex = all.filter((f) => f.endsWith('.tex'));
        const branch = await repo.currentBranch();

        const out = [`Project: ${repo.project.name} (id ${repo.project.projectId})`, `Branch: ${branch}`, `Files: ${all.length} (${tex.length} LaTeX)`, ''];

        out.push('Files:');
        for (const f of all.slice(0, 200)) out.push(`  - ${f}`);
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
          const { content } = await repo.readFile(root);
          const sections = parseSections(content);
          out.push('', `Outline of ${root}:`);
          if (!sections.length) out.push('  (no sectioning commands)');
          for (const s of sections) out.push(`  ${'  '.repeat(Math.max(0, s.level - 2))}${s.type} — ${s.title}`);
        }
        return text(out.join('\n'));
      });
    },
  );

  server.registerTool(
    'read_image',
    {
      title: 'View image',
      description:
        'Return an image from the project as a picture so you can actually look at it. Use this to check a figure you or the user just changed. For LaTeX sources and other text files use read_file instead.',
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
          return errorText(`"${filePath}" is not an image this tool can display. Supported: ${Object.keys(IMAGE_MIME).join(', ')}. Use read_file for text.`);
        }
        const { rel, buffer } = await repo.readBinary(filePath);
        if (buffer.length > 8 * 1024 * 1024) {
          return errorText(`${rel} is ${formatSize(buffer.length)} — too large to send as an image.`);
        }
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
        'Add or replace a binary file (figure, PDF, image) in the project from base64 content, committing it to Overleaf. For text and LaTeX sources use write_file instead — base64 is only worth the overhead for binary assets.',
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
    'find_section',
    {
      title: 'Find section',
      description:
        'Search every .tex file in the project for sectioning commands whose title matches a query. Returns file, level and exact title, which is what get_section_content and write_section expect. Use this when you know the section name but not which file holds it.',
      inputSchema: {
        query: z.string().describe('Substring to look for in section titles (case-insensitive)'),
        projectName: projectArg,
      },
    },
    async ({ query, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const files = await repo.listFiles('.tex');
        const needle = query.toLowerCase();
        const hits = [];
        for (const f of files) {
          const { content } = await repo.readFile(f).catch(() => ({ content: null }));
          if (content === null) continue;
          for (const s of parseSections(content)) {
            if (s.title.toLowerCase().includes(needle)) {
              hits.push(`${f} · ${s.type} · line ${lineAt(content, s.start)} · ${s.title}`);
            }
          }
        }
        if (!hits.length) return text(`No section title contains "${query}" in ${files.length} .tex file(s).`);
        return text(`${hits.length} match(es) for "${query}":\n${hits.join('\n')}`);
      });
    },
  );

  server.registerTool(
    'write_file',
    {
      title: 'Write file',
      description:
        'Replace the entire contents of a file and push it to Overleaf as one commit. Prefer write_section for targeted edits — a whole-file write discards anything the model did not reproduce.',
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
    'write_section',
    {
      title: 'Write section',
      description:
        'Replace one section (heading included) and push the change to Overleaf. newContent must start with the section heading itself, e.g. "\\\\section{Introduction}\\n...". Anything the section owns — its subsections — is replaced too, so include them.',
      inputSchema: {
        filePath: z.string().describe('Path to the .tex file'),
        sectionTitle: z.string().describe('Exact title of the section to replace'),
        newContent: z.string().describe('Replacement text, starting with the section heading'),
        commitMessage: z.string().describe('Commit message shown in the Overleaf history'),
        projectName: projectArg,
      },
    },
    async ({ filePath, sectionTitle, newContent, commitMessage, projectName }) => {
      const repo = repoFor(projectName);
      return repo.run(async () => {
        await repo.fetchAndReset();
        const { rel, content } = await repo.readFile(filePath);
        const sections = parseSections(content);
        const idx = findSection(sections, sectionTitle);
        if (idx === -1) {
          const known = sections.map((s) => s.title);
          return errorText(
            known.length
              ? `No section "${sectionTitle}" in ${rel}. Available: ${known.join(' | ')}`
              : `${rel} contains no sectioning commands.`,
          );
        }

        if (!new RegExp(`\\\\${sections[idx].type}\\*?\\s*(\\[[^\\]]*\\])?\\{`).test(newContent)) {
          return errorText(
            `newContent must begin with the section heading (\\${sections[idx].type}{${sectionTitle}}). ` +
              'Without it the section would lose its heading.',
          );
        }

        const { start, end } = sectionExtent(content, sections, idx);
        const updated = content.slice(0, start) + newContent.replace(/\s+$/, '') + '\n\n' + content.slice(end).replace(/^\s*\n/, '');

        const result = await repo.writeFile(rel, updated, commitMessage);
        return text(describeCommit(`${rel} § ${sectionTitle}`, result));
      });
    },
  );
}

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

// ChatGPT rejects oversized tool arguments long before a megabyte, so uploads are
// capped well below what the transport could theoretically carry.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describeCommit(what, result) {
  if (!result.committed) return `${what}: ${result.message}`;
  return `Pushed ${what} to Overleaf as commit ${result.sha} — "${result.message}".`;
}
