import { readdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface WikiLink {
  target: string;   // raw target name (without .md)
  alias: string | null;
  line: number;      // 1-based
}

export interface GraphResult {
  file: string;
  outlinks: WikiLink[];
  inlinks: { source: string; alias: string | null; line: number }[];
}

export function extractWikilinks(text: string): WikiLink[] {
  const lines = text.split('\n');
  const links: WikiLink[] = [];

  for (let i = 0; i < lines.length; i++) {
    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;

    while ((match = WIKILINK_RE.exec(lines[i])) !== null) {
      links.push({
        target: match[1].trim(),
        alias: match[2]?.trim() ?? null,
        line: i + 1,
      });
    }
  }

  return links;
}

export async function findMdFiles(dir: string, recursive = false): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const e of entries) {
      const fullPath = join(dir, e.name);
      if (e.isFile() && e.name.endsWith('.md')) {
        files.push(fullPath);
      } else if (recursive && e.isDirectory() && !e.name.startsWith('.')) {
        const sub = await findMdFiles(fullPath, true);
        files.push(...sub);
      }
    }

    return files;
  } catch {
    return [];
  }
}

function nameWithoutExt(filePath: string): string {
  const name = basename(filePath);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

export async function buildGraph(
  targetPath: string,
  targetText: string,
  siblingTexts: Map<string, string>,
): Promise<GraphResult> {
  const dir = dirname(targetPath);
  const targetName = nameWithoutExt(targetPath);

  const outlinks = extractWikilinks(targetText);

  const inlinks: GraphResult['inlinks'] = [];

  for (const [siblingPath, siblingText] of siblingTexts) {
    if (siblingPath === targetPath) continue;
    const siblingLinks = extractWikilinks(siblingText);

    for (const link of siblingLinks) {
      const normalized = link.target.toLowerCase();
      if (normalized === targetName.toLowerCase()) {
        inlinks.push({
          source: siblingPath,
          alias: link.alias,
          line: link.line,
        });
      }
    }
  }

  return { file: targetPath, outlinks, inlinks };
}
