/**
 * Vault index compiler + query engine.
 *
 * Compiles all .md files in a vault into a graph-index.json,
 * then serves queries over that index.
 *
 * The existing per-file tools are the microscope.
 * This is the map.
 */

import { readFile, writeFile, stat, readdir, mkdir } from 'node:fs/promises';
import { join, relative, basename, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── Types ───────────────────────────────────────────────────────────────

export interface HeadingNode {
  title: string;
  level: number;
  line: number;
  children?: HeadingNode[];
}

export interface VaultNode {
  path: string;
  frontmatter: Record<string, unknown> | null;
  structure: HeadingNode[];
  links_out: string[];
  links_in: string[];
}

export interface GraphIndex {
  meta: {
    vault: string;
    generated_at: string;
    generator: string;
    total_nodes: number;
    total_edges: number;
  };
  nodes: Record<string, VaultNode>;
}

// ── Config ──────────────────────────────────────────────────────────────

const INDEX_DIRNAME = '.mcp-md-reader';        // index lives in <vault>/.mcp-md-reader/ by default
const INDEX_FILENAME = 'graph-index.json';
const STALE_MS = 60 * 60 * 1000; // 1 hour
const IGNORE_DIRS = new Set(['node_modules', '.git', '.obsidian', 'ATTACHMENTS', '.mcp-md-reader']);

// ── Compiler ────────────────────────────────────────────────────────────

function normalizeId(filename: string): string {
  return filename.replace(/\.md$/i, '').toLowerCase().replace(/\s+/g, '_');
}

async function walkMd(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkMd(full)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function extractFrontmatter(raw: string): [Record<string, unknown> | null, number] {
  if (!raw.startsWith('---')) return [null, 0];
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return [null, 0];
  const yamlBlock = raw.slice(4, end);
  const bodyStartLine = yamlBlock.split('\n').length + 2;
  try {
    const parsed = parseYaml(yamlBlock);
    return [parsed && typeof parsed === 'object' ? parsed : null, bodyStartLine];
  } catch {
    return [null, bodyStartLine];
  }
}

function stripCodeBlocks(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line.trimStart())) {
      inCode = !inCode;
      result.push('');
      continue;
    }
    result.push(inCode ? '' : line);
  }
  return result.join('\n');
}

function extractStructure(strippedContent: string, lineOffset: number): HeadingNode[] {
  const lines = strippedContent.split('\n');
  const flat: HeadingNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      flat.push({ title: match[2].trim(), level: match[1].length, line: i + 1 + lineOffset });
    }
  }
  return buildHeadingTree(flat);
}

function buildHeadingTree(flat: HeadingNode[]): HeadingNode[] {
  const root: HeadingNode[] = [];
  const stack: { node: HeadingNode; level: number }[] = [];
  for (const h of flat) {
    const node: HeadingNode = { title: h.title, level: h.level, line: h.line };
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    if (stack.length === 0) {
      root.push(node);
    } else {
      const parent = stack[stack.length - 1].node;
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    }
    stack.push({ node, level: h.level });
  }
  return root;
}

function extractLinks(strippedContent: string): string[] {
  const linkSet = new Set<string>();
  const regex = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(strippedContent)) !== null) {
    let target = match[1];
    if (target.includes('|')) target = target.split('|')[0];
    if (target.includes('#')) target = target.split('#')[0];
    if (target.includes('^')) target = target.split('^')[0];
    target = target.replace(/\\/g, '').trim();
    if (target) {
      const filename = target.includes('/') ? target.split('/').pop()! : target;
      const normalized = normalizeId(filename);
      if (normalized) linkSet.add(normalized);
    }
  }
  return [...linkSet].sort();
}

export async function compileIndex(vaultRoot: string): Promise<GraphIndex> {
  const files = await walkMd(vaultRoot);

  // Detect duplicate filenames
  const nameCount = new Map<string, number>();
  for (const f of files) {
    const name = normalizeId(basename(f));
    nameCount.set(name, (nameCount.get(name) || 0) + 1);
  }

  const nodes: Record<string, VaultNode> = {};

  for (const filePath of files) {
    const raw = await readFile(filePath, 'utf-8');
    const relPath = relative(vaultRoot, filePath).replace(/\\/g, '/');
    const baseName = normalizeId(basename(filePath));

    const id = (nameCount.get(baseName) || 0) > 1
      ? normalizeId(relPath.replace(/\//g, '_'))
      : baseName;

    const [frontmatter, bodyStartLine] = extractFrontmatter(raw);
    const body = raw.split('\n').slice(bodyStartLine).join('\n');
    const stripped = stripCodeBlocks(body);
    const structure = extractStructure(stripped, bodyStartLine);
    const links_out = extractLinks(stripped);

    nodes[id] = { path: relPath, frontmatter, structure, links_out, links_in: [] };
  }

  // Resolve backlinks
  const simpleNameToId = new Map<string, string | null>();
  for (const [id, node] of Object.entries(nodes)) {
    const simpleName = normalizeId(basename(node.path));
    if (simpleNameToId.has(simpleName)) {
      simpleNameToId.set(simpleName, null); // ambiguous
    } else {
      simpleNameToId.set(simpleName, id);
    }
  }

  function resolveTarget(targetId: string): string | undefined {
    if (nodes[targetId]) return targetId;
    const mapped = simpleNameToId.get(targetId);
    if (mapped && nodes[mapped]) return mapped;
    return undefined;
  }

  for (const [sourceId, node] of Object.entries(nodes)) {
    for (const targetId of node.links_out) {
      const resolved = resolveTarget(targetId);
      if (resolved) nodes[resolved].links_in.push(sourceId);
    }
  }

  for (const node of Object.values(nodes)) node.links_in.sort();

  let totalEdges = 0;
  for (const node of Object.values(nodes)) totalEdges += node.links_out.length;

  return {
    meta: {
      vault: vaultRoot,
      generated_at: new Date().toISOString(),
      generator: 'graphd v0.1',
      total_nodes: Object.keys(nodes).length,
      total_edges: totalEdges,
    },
    nodes,
  };
}

// ── Index loader (with auto-recompile) ──────────────────────────────────

let cachedIndex: GraphIndex | null = null;
let cachedVault: string | null = null;
let cachedAt = 0;

function indexPath(vaultRoot: string): string {
  // Default: <vault>/.mcp-md-reader/graph-index.json.
  // Override the directory with the MD_READER_INDEX_DIR env var if you prefer
  // to keep the index outside the vault.
  const dir = process.env.MD_READER_INDEX_DIR || join(vaultRoot, INDEX_DIRNAME);
  return join(dir, INDEX_FILENAME);
}

export async function getIndex(vaultRoot: string): Promise<GraphIndex> {
  // Return memory cache if fresh
  if (cachedIndex && cachedVault === vaultRoot && Date.now() - cachedAt < STALE_MS) {
    return cachedIndex;
  }

  const idxPath = indexPath(vaultRoot);
  let needsCompile = false;

  try {
    const s = await stat(idxPath);
    if (Date.now() - s.mtimeMs > STALE_MS) {
      needsCompile = true;
    }
  } catch {
    needsCompile = true;
  }

  if (needsCompile) {
    const index = await compileIndex(vaultRoot);
    const dir = dirname(idxPath);
    await mkdir(dir, { recursive: true });
    await writeFile(idxPath, JSON.stringify(index, null, 2), 'utf-8');
    cachedIndex = index;
    cachedVault = vaultRoot;
    cachedAt = Date.now();
    return index;
  }

  // Load from disk
  const raw = await readFile(idxPath, 'utf-8');
  cachedIndex = JSON.parse(raw) as GraphIndex;
  cachedVault = vaultRoot;
  cachedAt = Date.now();
  return cachedIndex;
}

// ── Query engine ────────────────────────────────────────────────────────

export type QueryType = 'stats' | 'node' | 'neighbors' | 'search_type' | 'most_connected' | 'isolated' | 'path';

export async function queryIndex(
  vaultRoot: string,
  query: QueryType,
  nodeId?: string,
  depth?: number,
): Promise<string> {
  const index = await getIndex(vaultRoot);
  const { nodes, meta } = index;

  switch (query) {
    case 'stats':
      return formatStats(meta, nodes);

    case 'node':
      return formatNode(nodes, nodeId);

    case 'neighbors':
      return formatNeighbors(nodes, nodeId, depth ?? 1);

    case 'search_type':
      return formatSearchType(nodes, nodeId);

    case 'most_connected':
      return formatMostConnected(nodes, depth ?? 10);

    case 'isolated':
      return formatIsolated(nodes);

    case 'path':
      return formatPath(nodes, nodeId);

    default:
      return `Unknown query type: "${query}". Valid: stats, node, neighbors, search_type, most_connected, isolated, path`;
  }
}

// ── Query formatters ────────────────────────────────────────────────────

function formatStats(meta: GraphIndex['meta'], nodes: Record<string, VaultNode>): string {
  // Count by frontmatter type
  const typeCounts = new Map<string, number>();
  for (const node of Object.values(nodes)) {
    const type = (node.frontmatter?.type ?? node.frontmatter?.tipo ?? 'untyped') as string;
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  }

  const typeLines = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `  ${t}: ${c}`)
    .join('\n');

  return [
    `Vault: ${meta.vault}`,
    `Generated: ${meta.generated_at}`,
    `Total nodes: ${meta.total_nodes}`,
    `Total edges: ${meta.total_edges}`,
    '',
    'Types:',
    typeLines,
  ].join('\n');
}

function formatNode(nodes: Record<string, VaultNode>, nodeId?: string): string {
  if (!nodeId) return 'Error: node_id is required for query "node"';
  const node = nodes[nodeId];
  if (!node) {
    // Fuzzy search
    const candidates = Object.keys(nodes).filter(k => k.includes(nodeId));
    if (candidates.length > 0) {
      return `Node "${nodeId}" not found. Similar: ${candidates.slice(0, 10).join(', ')}`;
    }
    return `Node "${nodeId}" not found.`;
  }
  return JSON.stringify({ [nodeId]: node }, null, 2);
}

function formatNeighbors(nodes: Record<string, VaultNode>, nodeId?: string, depth = 1): string {
  if (!nodeId) return 'Error: node_id is required for query "neighbors"';
  if (!nodes[nodeId]) return `Node "${nodeId}" not found.`;

  const visited = new Set<string>();
  const queue: { id: string; dist: number }[] = [{ id: nodeId, dist: 0 }];
  const result: Record<string, VaultNode & { distance: number }> = {};

  while (queue.length > 0) {
    const { id, dist } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const node = nodes[id];
    if (!node) continue;

    result[id] = { ...node, distance: dist };

    if (dist < depth) {
      for (const neighbor of [...node.links_out, ...node.links_in]) {
        if (!visited.has(neighbor) && nodes[neighbor]) {
          queue.push({ id: neighbor, dist: dist + 1 });
        }
      }
    }
  }

  const header = `Neighbors of "${nodeId}" (depth ${depth}): ${Object.keys(result).length} nodes\n`;
  return header + JSON.stringify(result, null, 2);
}

function formatSearchType(nodes: Record<string, VaultNode>, typeQuery?: string): string {
  if (!typeQuery) return 'Error: node_id (= type to search) is required for query "search_type"';

  const matches: { id: string; path: string }[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    const type = (node.frontmatter?.type ?? node.frontmatter?.tipo ?? '') as string;
    if (type.toLowerCase() === typeQuery.toLowerCase()) {
      matches.push({ id, path: node.path });
    }
  }

  if (matches.length === 0) return `No nodes with type "${typeQuery}" found.`;

  const lines = matches.map(m => `  ${m.id} — ${m.path}`).join('\n');
  return `Nodes with type "${typeQuery}" (${matches.length}):\n${lines}`;
}

function formatMostConnected(nodes: Record<string, VaultNode>, n: number): string {
  const ranked = Object.entries(nodes)
    .map(([id, node]) => ({
      id,
      total: node.links_out.length + node.links_in.length,
      out: node.links_out.length,
      in: node.links_in.length,
      path: node.path,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, n);

  const lines = ranked.map(
    (r, i) => `${String(i + 1).padStart(2)}. ${r.id.padEnd(40)} ${String(r.total).padStart(4)} (out:${String(r.out).padStart(3)}, in:${String(r.in).padStart(3)})  ${r.path}`
  );

  return `Top ${n} most connected nodes:\n${lines.join('\n')}`;
}

function formatIsolated(nodes: Record<string, VaultNode>): string {
  const isolated = Object.entries(nodes)
    .filter(([, node]) => node.links_out.length === 0 && node.links_in.length === 0)
    .map(([id, node]) => `  ${id} — ${node.path}`);

  if (isolated.length === 0) return 'No isolated nodes found.';
  return `Isolated nodes (${isolated.length}):\n${isolated.join('\n')}`;
}

function formatPath(nodes: Record<string, VaultNode>, nodeId?: string): string {
  if (!nodeId || !nodeId.includes('>')) {
    return 'Error: node_id must be "origin>destination" for query "path"';
  }

  const [origin, destination] = nodeId.split('>').map(s => s.trim());
  if (!nodes[origin]) return `Origin node "${origin}" not found.`;
  if (!nodes[destination]) return `Destination node "${destination}" not found.`;

  // BFS shortest path
  const visited = new Map<string, string | null>(); // node → parent
  const queue: string[] = [origin];
  visited.set(origin, null);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === destination) {
      // Reconstruct path
      const path: string[] = [];
      let cursor: string | null = destination;
      while (cursor !== null) {
        path.unshift(cursor);
        cursor = visited.get(cursor) ?? null;
      }
      return `Path (${path.length - 1} hops): ${path.join(' → ')}`;
    }

    const node = nodes[current];
    if (!node) continue;

    for (const neighbor of [...node.links_out, ...node.links_in]) {
      if (!visited.has(neighbor) && nodes[neighbor]) {
        visited.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }

  return `No path found between "${origin}" and "${destination}".`;
}

// ── find: query-driven navigation ────────────────────────────────────────
//
// The graph queries above are the *map* — you ask for a node and get its
// surroundings. `find` is the *front door*: given a natural-language need,
// it returns only the sections whose titles/tags match, ranked, so the LLM
// lands on the right place without loading the whole catalog.
//
// Deterministic: pure structural matching on titles, tags and doc names.
// No embeddings, no LLM. The consuming model does the reasoning over the
// compact result and then reads one section with md_section.

const FIND_BUDGET_TOKENS = 4000;   // stop adding regions past this
const MAX_REGIONS = 12;            // hard cap on regions returned
const AMBIGUOUS_DOC_SPREAD = 20;   // more matching docs than this → doc list

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'como', 'cual', 'cuales', 'donde', 'que',
  'los', 'las', 'del', 'una', 'uno', 'por', 'con', 'para', 'sobre',
  'este', 'esta', 'esto', 'sus', 'como',
]);

function est(s: string): number {
  return Math.ceil(s.length / 4);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

/** Two tokens are related if one contains the other or they share a 4+ char prefix.
 *  Catches Spanish morphology (aislar↔aislamiento, config↔configuración). */
function related(a: string, b: string): boolean {
  if (a.includes(b) || b.includes(a)) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 4;
}

function docTags(fm: Record<string, unknown> | null): string[] {
  if (!fm) return [];
  const raw = (fm.tags ?? fm.etiquetas ?? fm.tag ?? []) as unknown;
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(t => String(t).toLowerCase());
}

/** Query tokens that appear in a piece of text (via substring or `related`). */
function matched(qTokens: string[], text: string): string[] {
  const tl = text.toLowerCase();
  const tw = tokenize(text);
  return qTokens.filter(q => tl.includes(q) || tw.some(w => related(q, w)));
}

interface FlatHeading {
  title: string;
  breadcrumb: string[]; // ancestor titles within the doc
}

function flattenWithPath(structure: HeadingNode[], trail: string[] = []): FlatHeading[] {
  const out: FlatHeading[] = [];
  for (const h of structure) {
    out.push({ title: h.title, breadcrumb: [...trail] });
    if (h.children && h.children.length) {
      out.push(...flattenWithPath(h.children, [...trail, h.title]));
    }
  }
  return out;
}

interface DocMatch {
  path: string;
  absPath: string;
  linksIn: number;
  coverage: number; // distinct query tokens matched anywhere in this doc
  headings: { title: string; breadcrumb: string[]; hits: number }[];
}

export async function findInVault(vaultRoot: string, query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return 'Error: query is required for find.';

  const { nodes } = await getIndex(vaultRoot);
  const qTokens = tokenize(trimmed);
  const q = qTokens.length ? qTokens : [trimmed.toLowerCase()];

  const matches: DocMatch[] = [];

  for (const [id, node] of Object.entries(nodes)) {
    const flat = flattenWithPath(node.structure);
    const covered = new Set<string>();

    // doc name + tags contribute to coverage (but aren't shown as sections)
    for (const t of matched(q, id.replace(/_/g, ' '))) covered.add(t);
    for (const tag of docTags(node.frontmatter)) {
      for (const t of matched(q, tag)) covered.add(t);
    }

    const headings = flat
      .map(h => {
        const hits = matched(q, h.title);
        for (const t of hits) covered.add(t);
        return { title: h.title, breadcrumb: h.breadcrumb, hits: hits.length };
      })
      .filter(h => h.hits > 0)
      .sort((a, b) => b.hits - a.hits);

    if (covered.size === 0) continue;

    // matched by name/tag only → surface top-level headings as entry points
    const shownHeadings = headings.length > 0
      ? headings
      : flat.slice(0, 4).map(h => ({ title: h.title, breadcrumb: h.breadcrumb, hits: 0 }));

    matches.push({
      path: node.path,
      absPath: join(vaultRoot, node.path),
      linksIn: node.links_in.length,
      coverage: covered.size,
      headings: shownHeadings,
    });
  }

  // ── No match → offer entry points ──
  if (matches.length === 0) {
    const hubs = Object.values(nodes)
      .map(n => ({ path: n.path, deg: n.links_in.length + n.links_out.length }))
      .sort((a, b) => b.deg - a.deg)
      .slice(0, 8)
      .map(h => `  ${h.path}`);
    return [
      `No structural match for "${query}".`,
      `Titles, tags and filenames don't contain these terms. Try broader words, or`,
      `start from one of the most-connected notes:`,
      ...hubs,
    ].join('\n');
  }

  // rank: coverage first (more query terms = more relevant), then importance
  matches.sort((a, b) =>
    b.coverage - a.coverage ||
    b.headings[0].hits - a.headings[0].hits ||
    b.linksIn - a.linksIn,
  );

  // ── Ambiguous → too many docs, return a ranked doc list ──
  if (matches.length > AMBIGUOUS_DOC_SPREAD) {
    const top = matches.slice(0, 15).map(m =>
      `  ${m.path.padEnd(50)} (${m.headings.length} sec, in:${m.linksIn})`,
    );
    return [
      `"${query}" is broad — ${matches.length} documents match.`,
      `Showing the 15 most relevant. Refine the query, or open one with md_tree:`,
      '',
      ...top,
    ].join('\n');
  }

  // ── Normal → compact regions, budget-capped ──
  const blocks: string[] = [];
  let used = 0;
  let shown = 0;
  for (const m of matches) {
    const lines = [`${m.absPath}   (in:${m.linksIn})`];
    for (const h of m.headings.slice(0, 6)) {
      const crumb = h.breadcrumb.length ? h.breadcrumb.join(' › ') + ' › ' : '';
      lines.push(`  · ${crumb}${h.title}`);
    }
    const block = lines.join('\n');
    if (shown > 0 && used + est(block) > FIND_BUDGET_TOKENS) break;
    blocks.push(block);
    used += est(block);
    if (++shown >= MAX_REGIONS) break;
  }

  const header = [
    `Found ${matches.length} matching document(s) for "${query}" (showing ${shown}).`,
    `Read a section →  md_section(path, heading)`,
    '',
  ].join('\n');

  return header + blocks.join('\n\n');
}
