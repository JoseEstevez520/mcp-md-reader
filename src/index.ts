#!/usr/bin/env node
/**
 * mcp-md-reader — MCP server for intelligent markdown reading.
 *
 * Tools:
 *   md_tree(path)             — heading tree with token estimates
 *   md_section(path, heading) — content of a specific section (fuzzy match)
 *   md_search(path, query)    — text search, returns matching sections
 *   md_frontmatter(path)      — YAML frontmatter only
 *   md_graph(path)            — wikilink graph (outlinks + inlinks)
 *   md_search_vault(dir, q)   — multi-file search across a directory
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  parseMarkdownCached,
  renderTree,
  findSection,
  searchInFile,
  estimateTokens,
} from './parser.js';
import { buildGraph, findMdFiles } from './graph.js';

// ── Helpers ────────────────────────────────────────────────────────────

async function loadFile(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

// ── Server setup ───────────────────────────────────────────────────────

const server = new McpServer({
  name: 'mcp-md-reader',
  version: '1.0.0',
});

// ── Tool: md_tree ──────────────────────────────────────────────────────

server.tool(
  'md_tree',
  'Returns the heading tree of a markdown file with estimated token counts per section. Use this FIRST to understand file structure before reading specific sections.',
  { path: z.string().describe('Absolute path to the .md file') },
  async ({ path }) => {
    try {
      const text = await loadFile(path);
      const parsed = await parseMarkdownCached(path, text);
      const treeText = renderTree(parsed.tree);
      const fullTokens = estimateTokens(text);
      const treeTokens = estimateTokens(treeText);

      const header = [
        `File: ${path}`,
        `Full file: ~${fullTokens} tokens`,
        `This tree: ~${treeTokens} tokens`,
        `Savings: ~${Math.round((1 - treeTokens / fullTokens) * 100)}%`,
        '',
      ].join('\n');

      return { content: [{ type: 'text' as const, text: header + treeText }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: md_section ───────────────────────────────────────────────────

server.tool(
  'md_section',
  'Returns the content of a specific section matched by heading text (fuzzy match). Use after md_tree to read only what you need.',
  {
    path: z.string().describe('Absolute path to the .md file'),
    heading: z.string().describe('Heading text to match (fuzzy, case-insensitive)'),
  },
  async ({ path, heading }) => {
    try {
      const text = await loadFile(path);
      const parsed = await parseMarkdownCached(path, text);
      const result = findSection(parsed, heading);

      if (!result) {
        return {
          content: [{ type: 'text' as const, text: `No section matching "${heading}" found.` }],
          isError: true,
        };
      }

      const tokens = estimateTokens(result.content);
      const fullTokens = estimateTokens(text);

      const header = [
        `Section: ${result.node.title} (level ${result.node.level})`,
        `Lines: ${result.node.lineStart + 1}-${result.node.lineEnd + 1}`,
        `Section tokens: ~${tokens} | Full file: ~${fullTokens} | Savings: ~${Math.round((1 - tokens / fullTokens) * 100)}%`,
        '',
      ].join('\n');

      return { content: [{ type: 'text' as const, text: header + result.content }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: md_search ────────────────────────────────────────────────────

server.tool(
  'md_search',
  'Searches for text within a markdown file and returns matching lines with their section context.',
  {
    path: z.string().describe('Absolute path to the .md file'),
    query: z.string().describe('Text to search for (case-insensitive)'),
  },
  async ({ path, query }) => {
    try {
      const text = await loadFile(path);
      const parsed = await parseMarkdownCached(path, text);
      const results = searchInFile(parsed, query);

      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No matches for "${query}".` }],
        };
      }

      const fullTokens = estimateTokens(text);
      const output = results.map((r, i) => [
        `--- Match ${i + 1} (line ${r.lineNumber}, under "${r.heading}") ---`,
        r.context,
      ].join('\n')).join('\n\n');

      const resultTokens = estimateTokens(output);

      const header = [
        `Found ${results.length} match(es) for "${query}"`,
        `Result tokens: ~${resultTokens} | Full file: ~${fullTokens} | Savings: ~${Math.round((1 - resultTokens / fullTokens) * 100)}%`,
        '',
      ].join('\n');

      return { content: [{ type: 'text' as const, text: header + output }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: md_frontmatter ───────────────────────────────────────────────

server.tool(
  'md_frontmatter',
  'Returns only the YAML frontmatter of a markdown file.',
  { path: z.string().describe('Absolute path to the .md file') },
  async ({ path }) => {
    try {
      const text = await loadFile(path);
      const parsed = await parseMarkdownCached(path, text);

      if (!parsed.frontmatter) {
        return {
          content: [{ type: 'text' as const, text: 'No frontmatter found.' }],
        };
      }

      const fullTokens = estimateTokens(text);
      const fmTokens = estimateTokens(parsed.frontmatterRaw!);

      const header = [
        `Frontmatter tokens: ~${fmTokens} | Full file: ~${fullTokens} | Savings: ~${Math.round((1 - fmTokens / fullTokens) * 100)}%`,
        '',
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text: header + parsed.frontmatterRaw }],
      };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: md_graph ────────────────────────────────────────────────────

server.tool(
  'md_graph',
  'Returns the wikilink graph for a markdown file: outlinks ([[target]]) and inlinks (other files in the same directory that link to it).',
  { path: z.string().describe('Absolute path to the .md file') },
  async ({ path }) => {
    try {
      const text = await loadFile(path);
      const mdFiles = await findMdFiles(dirname(path));

      const siblingTexts = new Map<string, string>();
      for (const f of mdFiles) {
        try {
          siblingTexts.set(f, await loadFile(f));
        } catch {
          // skip unreadable files
        }
      }

      const graph = await buildGraph(path, text, siblingTexts);

      const outSection = graph.outlinks.length > 0
        ? graph.outlinks.map(l =>
            `  → [[${l.target}]]${l.alias ? ` (alias: ${l.alias})` : ''} (line ${l.line})`
          ).join('\n')
        : '  (none)';

      const inSection = graph.inlinks.length > 0
        ? graph.inlinks.map(l =>
            `  ← ${l.source}${l.alias ? ` (alias: ${l.alias})` : ''} (line ${l.line})`
          ).join('\n')
        : '  (none)';

      const output = [
        `Graph for: ${path}`,
        ``,
        `Outlinks (${graph.outlinks.length}):`,
        outSection,
        ``,
        `Inlinks (${graph.inlinks.length}):`,
        inSection,
      ].join('\n');

      return { content: [{ type: 'text' as const, text: output }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Tool: md_search_vault ─────────────────────────────────────────────

server.tool(
  'md_search_vault',
  'Searches for text across ALL .md files in a directory. Returns file, section, line, and context.',
  {
    directory: z.string().describe('Absolute path to the directory to search'),
    query: z.string().describe('Text to search for (case-insensitive)'),
    limit: z.number().optional().default(20).describe('Max results to return (default 20, 0 = unlimited)'),
  },
  async ({ directory, query, limit }) => {
    try {
      const { stat: fsStat } = await import('node:fs/promises');
      try {
        await fsStat(directory);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Directory not found: ${directory}` }],
          isError: true,
        };
      }

      const mdFiles = await findMdFiles(directory, true);

      if (mdFiles.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No .md files found in ${directory}` }],
        };
      }

      const MAX_RESULTS = limit === 0 ? Infinity : limit;
      const allResults: { file: string; heading: string; lineNumber: number; context: string }[] = [];

      for (const filePath of mdFiles) {
        if (allResults.length >= MAX_RESULTS) break;

        try {
          const text = await loadFile(filePath);
          const parsed = await parseMarkdownCached(filePath, text);
          const matches = searchInFile(parsed, query);

          for (const m of matches) {
            if (allResults.length >= MAX_RESULTS) break;
            allResults.push({
              file: filePath,
              heading: m.heading,
              lineNumber: m.lineNumber,
              context: m.context,
            });
          }
        } catch {
          // skip unreadable files
        }
      }

      if (allResults.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No matches for "${query}" in ${mdFiles.length} files.` }],
        };
      }

      const output = allResults.map((r, i) => [
        `--- Match ${i + 1}: ${r.file} (line ${r.lineNumber}, under "${r.heading}") ---`,
        r.context,
      ].join('\n')).join('\n\n');

      const header = [
        `Found ${allResults.length} match(es) for "${query}" across ${mdFiles.length} files`,
        MAX_RESULTS === Infinity ? '(no limit)' : `(showing up to ${MAX_RESULTS} results)`,
        '',
      ].join('\n');

      return { content: [{ type: 'text' as const, text: header + output }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ── Start ──────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-md-reader server running on stdio');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
