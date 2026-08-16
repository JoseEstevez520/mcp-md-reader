#!/usr/bin/env node
/**
 * Portable Codex-plugin entry point.
 *
 * This deliberately implements the small JSON-RPC surface this server needs
 * instead of bundling the full MCP SDK and its runtime code generator. The
 * regular npm package continues to use the official SDK in src/index.ts.
 */

import { createInterface } from 'node:readline';
import { readFile, stat as fsStat } from 'node:fs/promises';
import {
  parseMarkdownCached,
  renderTree,
  findSection,
  estimateTokens,
} from './parser.js';
import { queryIndex, findInVault, type QueryType } from './vault-index.js';

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const VALID_QUERIES = ['stats', 'node', 'neighbors', 'search_type', 'most_connected', 'isolated', 'path'] as const;

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const tools = [
  {
    name: 'md_find',
    description: 'Locate Markdown sections by headings, tags, and filenames, then retrieve one with md_section.',
    inputSchema: {
      type: 'object',
      properties: {
        vault_path: { type: 'string', description: 'Absolute path to the vault root directory' },
        query: { type: 'string', description: 'Topic or title to find' },
      },
      required: ['vault_path', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'md_tree',
    description: 'Return the heading tree of a Markdown file with estimated token counts per section.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the Markdown file' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'md_section',
    description: 'Return one Markdown section matched by heading text.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the Markdown file' },
        heading: { type: 'string', description: 'Heading text to match' },
      },
      required: ['path', 'heading'],
      additionalProperties: false,
    },
  },
  {
    name: 'md_frontmatter',
    description: 'Return only the YAML frontmatter of a Markdown file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the Markdown file' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'md_vault_index',
    description: 'Query the vault graph for statistics, nodes, neighbors, paths, hubs, and isolated notes.',
    inputSchema: {
      type: 'object',
      properties: {
        vault_path: { type: 'string', description: 'Absolute path to the vault root directory' },
        query: { type: 'string', enum: VALID_QUERIES },
        node_id: { type: 'string' },
        depth: { type: 'number' },
      },
      required: ['vault_path', 'query'],
      additionalProperties: false,
    },
  },
] as const;

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function savings(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((1 - part / whole) * 100);
}

function categorizeError(error: unknown, path: string): string {
  const e = error as { code?: string; message?: string };
  if (e.code === 'ENOENT') return `File not found: ${path}`;
  if (e.code === 'EACCES' || e.code === 'EPERM') return `Permission denied: ${path}`;
  if (e.code === 'EISDIR') return `Path is a directory, not a file: ${path}`;
  if (e.code === 'EMFILE' || e.code === 'ENFILE') return 'Too many open files (system limit). Try again shortly.';
  return e.message ?? `Unknown error reading: ${path}`;
}

async function loadFile(path: string): Promise<string> {
  let metadata;
  try {
    metadata = await fsStat(path);
  } catch (error) {
    throw new Error(categorizeError(error, path));
  }
  if (metadata.isDirectory()) throw new Error(`Path is a directory, not a file: ${path}`);
  if (metadata.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${Math.round(metadata.size / 1024)}KB > ${MAX_FILE_SIZE / 1024}KB limit): ${path}`);
  }
  const buffer = await readFile(path);
  const checkLength = Math.min(buffer.length, 8192);
  for (let index = 0; index < checkLength; index += 1) {
    if (buffer[index] === 0) throw new Error(`Binary file detected (null byte at offset ${index}): ${path}`);
  }
  return buffer.toString('utf8');
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (name === 'md_find') {
      return textResult(await findInVault(requireString(args, 'vault_path'), requireString(args, 'query')));
    }
    if (name === 'md_tree') {
      const path = requireString(args, 'path');
      const source = await loadFile(path);
      const parsed = await parseMarkdownCached(path, source);
      const tree = renderTree(parsed.tree);
      const fullTokens = estimateTokens(source);
      const treeTokens = estimateTokens(tree);
      return textResult([
        `File: ${path}`,
        `Full file: ~${fullTokens} tokens`,
        `This tree: ~${treeTokens} tokens`,
        `Savings: ~${savings(treeTokens, fullTokens)}%`,
        '',
        tree,
      ].join('\n'));
    }
    if (name === 'md_section') {
      const path = requireString(args, 'path');
      const source = await loadFile(path);
      const parsed = await parseMarkdownCached(path, source);
      const result = findSection(parsed, requireString(args, 'heading'));
      if (!result) return textResult(`No section matching "${args.heading}" found.`, true);
      const sectionTokens = estimateTokens(result.content);
      const fullTokens = estimateTokens(source);
      return textResult([
        `Section: ${result.node.title} (level ${result.node.level})`,
        `Lines: ${result.node.lineStart + 1}-${result.node.lineEnd + 1}`,
        `Section tokens: ~${sectionTokens} | Full file: ~${fullTokens} | Savings: ~${savings(sectionTokens, fullTokens)}%`,
        '',
        result.content,
      ].join('\n'));
    }
    if (name === 'md_frontmatter') {
      const path = requireString(args, 'path');
      const source = await loadFile(path);
      const parsed = await parseMarkdownCached(path, source);
      if (!parsed.frontmatter) return textResult('No frontmatter found.');
      const fullTokens = estimateTokens(source);
      const frontmatterTokens = estimateTokens(parsed.frontmatterRaw ?? '');
      return textResult([
        `Frontmatter tokens: ~${frontmatterTokens} | Full file: ~${fullTokens} | Savings: ~${savings(frontmatterTokens, fullTokens)}%`,
        '',
        parsed.frontmatterRaw ?? '',
      ].join('\n'));
    }
    if (name === 'md_vault_index') {
      const vaultPath = requireString(args, 'vault_path');
      const query = requireString(args, 'query');
      if (!(VALID_QUERIES as readonly string[]).includes(query)) throw new Error(`Unsupported query: ${query}`);
      const nodeId = args.node_id === undefined ? undefined : requireString(args, 'node_id');
      if (args.depth !== undefined && typeof args.depth !== 'number') throw new Error('depth must be a number');
      return textResult(await queryIndex(vaultPath, query as QueryType, nodeId, args.depth as number | undefined));
    }
    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request: JsonRpcRequest): Promise<void> {
  if (request.id === undefined) return;
  const base = { jsonrpc: '2.0' as const, id: request.id };
  try {
    if (request.method === 'initialize') {
      const requestedVersion = typeof request.params?.protocolVersion === 'string'
        ? request.params.protocolVersion
        : '2024-11-05';
      write({
        ...base,
        result: {
          protocolVersion: requestedVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mcp-md-reader', version: '1.4.1' },
          instructions: 'Use md_find or md_tree to locate structure, then md_section to retrieve only the relevant Markdown section.',
        },
      });
      return;
    }
    if (request.method === 'ping') {
      write({ ...base, result: {} });
      return;
    }
    if (request.method === 'tools/list') {
      write({ ...base, result: { tools } });
      return;
    }
    if (request.method === 'tools/call') {
      const name = requireString(request.params ?? {}, 'name');
      const rawArguments = request.params?.arguments;
      if (rawArguments !== undefined && (typeof rawArguments !== 'object' || rawArguments === null || Array.isArray(rawArguments))) {
        throw new Error('arguments must be an object');
      }
      write({ ...base, result: await callTool(name, (rawArguments ?? {}) as Record<string, unknown>) });
      return;
    }
    write({ ...base, error: { code: -32601, message: `Method not found: ${request.method}` } });
  } catch (error) {
    write({ ...base, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } });
  }
}

const input = createInterface({ input: process.stdin, terminal: false });
input.on('line', (line) => {
  if (line.trim().length === 0) return;
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    void handle(request);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
});

console.error('mcp-md-reader Codex plugin running on stdio');
