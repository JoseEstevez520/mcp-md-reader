#!/usr/bin/env node
/**
 * mcp-md-reader — MCP server for intelligent markdown reading.
 *
 * Tools:
 *   md_find(vault, query)     — find the sections that match a need (front door)
 *   md_tree(path)             — heading tree with token estimates
 *   md_section(path, heading) — content of a specific section (fuzzy match)
 *   md_frontmatter(path)      — YAML frontmatter only
 *   md_vault_index(vault, q)  — query the full vault graph index (map view)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, stat as fsStat } from 'node:fs/promises';
import {
  parseMarkdownCached,
  renderTree,
  findSection,
  estimateTokens,
} from './parser.js';
import { queryIndex, findInVault, type QueryType } from './vault-index.js';

// ── Helpers ────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB limit

/**
 * Categorize errors into user-friendly messages.
 */
function categorizeError(e: any, path: string): string {
  const code = e?.code;
  if (code === 'ENOENT') return `File not found: ${path}`;
  if (code === 'EACCES' || code === 'EPERM') return `Permission denied: ${path}`;
  if (code === 'EISDIR') return `Path is a directory, not a file: ${path}`;
  if (code === 'EMFILE' || code === 'ENFILE') return `Too many open files (system limit). Try again shortly.`;
  if (e?.message) return e.message;
  return `Unknown error reading: ${path}`;
}

async function loadFile(path: string): Promise<string> {
  // Check file size before reading to avoid memory issues
  let s;
  try {
    s = await fsStat(path);
  } catch (e: any) {
    throw new Error(categorizeError(e, path));
  }

  if (s.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${path}`);
  }

  if (s.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${Math.round(s.size / 1024)}KB > ${MAX_FILE_SIZE / 1024}KB limit): ${path}`);
  }

  if (s.size === 0) {
    return ''; // Empty file, not an error
  }

  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (e: any) {
    throw new Error(categorizeError(e, path));
  }

  // Detect binary files: check first 8KB for null bytes
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) {
      throw new Error(`Binary file detected (null byte at offset ${i}): ${path}`);
    }
  }

  // Decode as UTF-8
  return buf.toString('utf-8');
}

// ── Server setup ───────────────────────────────────────────────────────

const server = new McpServer(
  {
    name: 'mcp-md-reader',
    version: '1.4.1',
  },
  {
    instructions: `mcp-md-reader provides intelligent markdown reading tools that save ~90% of tokens compared to reading full files.

## When to use these tools

- **Navigating to a section by topic**: Use md_find with a topic/title-oriented need (e.g. "rate limiting", "multi-tenant RLS"). It matches headings/tags/filenames (NOT body text) and returns the matching sections ranked. Use it to locate a section, then md_section to read it. For finding a specific word that lives in body prose, prefer full-text search (Grep) — md_find complements search, it does not replace it.
- **Reading .md files**: Use md_tree to see one file's heading structure, then md_section to read only the section you need. This is the biggest token saver — do NOT read entire markdown files with generic file-reading tools when md_tree + md_section will do.
- **Exploring relationships**: Use md_vault_index for graph queries — neighbors, shortest path, hubs, stats. Note: links are resolved from [[wikilinks]] and need reasonably unique note names.
- **Checking metadata**: Use md_frontmatter to read just the YAML frontmatter without loading the full file.

## Recommended workflow

1. To find a word in body text → use full-text search (Grep). To navigate by topic → md_find.
2. md_section (path, heading) → read only the section you located (biggest token saving)
3. md_tree → if you need the full structure of one file
4. md_vault_index → to explore links (neighbors) or paths between notes`,
  },
);

// ── Tool: md_find ──────────────────────────────────────────────────────

server.tool(
  'md_find',
  'Locate a section by its topic/title across the vault. Matches STRUCTURE — headings, tags and filenames — NOT body prose, and returns the matching sections ranked, without loading the whole vault; then read one with md_section(path, heading). Deterministic (no embeddings, no LLM). This is structural navigation and a COMPLEMENT to full-text search: to find a specific word that appears in body text, use Grep/full-text search instead.',
  {
    vault_path: z.string().describe('Absolute path to the vault root directory'),
    query: z.string().describe('What you are looking for, in natural language (e.g. "row level security multi-tenant")'),
  },
  async ({ vault_path, query }) => {
    try {
      const result = await findInVault(vault_path, query);
      return { content: [{ type: 'text' as const, text: result }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

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

// ── Tool: md_vault_index ─────────────────────────────────────────────

const VALID_QUERIES = ['stats', 'node', 'neighbors', 'search_type', 'most_connected', 'isolated', 'path'] as const;

server.tool(
  'md_vault_index',
  'Queries the full vault graph index — the bird\'s-eye map of all nodes, links, and structure. Use this to understand vault topology, find connections, and navigate before drilling into specific files with md_tree/md_section.',
  {
    vault_path: z.string().describe('Absolute path to the vault root directory'),
    query: z.enum(VALID_QUERIES).describe('Query type: stats | node | neighbors | search_type | most_connected | isolated | path'),
    node_id: z.string().optional().describe('Node ID (for node, neighbors, path queries). For path: "origin>destination". For search_type: the type value to search.'),
    depth: z.number().optional().describe('Traversal depth for neighbors (default 1), or N for most_connected top-N (default 10)'),
  },
  async ({ vault_path, query, node_id, depth }) => {
    try {
      const result = await queryIndex(vault_path, query as QueryType, node_id, depth);
      return { content: [{ type: 'text' as const, text: result }] };
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
