import { z } from 'zod';
import { resolveProject, statePaths } from './config.mjs';
import { OverleafRepo } from './git.mjs';
import { parseSections, sectionExtent, findSection, lineAt } from './latex.mjs';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const errorText = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });

const projectArg = z
  .string()
  .optional()
  .describe('Which configured project to use (the key in projects.json). Defaults to "default".');

export function registerTools(server, { projects, stateDir }) {
  const repos = new Map();
  const repoFor = (projectName) => {
    const project = resolveProject(projects, projectName);
    const key = `${project.key}:${project.projectId}`;
    if (!repos.has(key)) repos.set(key, new OverleafRepo(project, statePaths(stateDir, project)));
    return repos.get(key);
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

function describeCommit(what, result) {
  if (!result.committed) return `${what}: ${result.message}`;
  return `Pushed ${what} to Overleaf as commit ${result.sha} — "${result.message}".`;
}
