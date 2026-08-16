#!/usr/bin/env node
/**
 * Reproducible benchmark for mcp-md-reader.
 *
 * By default it uses the public Markdown corpus in test/fixtures. Set
 * MD_READER_BENCHMARK_DIR to measure a different corpus without putting local
 * paths or filenames in source control.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findMdFiles } from './graph.js';
import { estimateTokens, findSection, parseMarkdown, renderTree } from './parser.js';

interface FileResult {
  file: string;
  fullTokens: number;
  treeTokens: number;
  sectionTokens: number;
}

function saving(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((1 - part / whole) * 100);
}

async function runBenchmark(): Promise<void> {
  const corpusDir = resolve(process.env.MD_READER_BENCHMARK_DIR ?? 'test/fixtures');
  const files = await findMdFiles(corpusDir, true);

  if (files.length === 0) {
    throw new Error(`No Markdown files found in benchmark corpus: ${corpusDir}`);
  }

  const results: FileResult[] = [];
  const started = performance.now();

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const parsed = parseMarkdown(text);
    const fullTokens = estimateTokens(text);
    const treeTokens = estimateTokens(renderTree(parsed.tree));
    const firstHeading = parsed.tree[0]?.title;
    const section = firstHeading ? findSection(parsed, firstHeading) : null;
    const sectionTokens = section ? estimateTokens(section.content) : 0;

    results.push({
      file: file.slice(corpusDir.length + 1).replaceAll('\\', '/'),
      fullTokens,
      treeTokens,
      sectionTokens,
    });
  }

  const fullTokens = results.reduce((sum, result) => sum + result.fullTokens, 0);
  const treeTokens = results.reduce((sum, result) => sum + result.treeTokens, 0);
  const sectionTokens = results.reduce((sum, result) => sum + result.sectionTokens, 0);
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;

  console.log(`Corpus: ${corpusDir}`);
  console.log(`Files: ${results.length}`);
  for (const result of results) {
    console.log(
      `${result.file}: full ~${result.fullTokens}, tree ~${result.treeTokens}, ` +
      `first section ~${result.sectionTokens} estimated tokens`,
    );
  }
  console.log(`Tree saving for this corpus: ${saving(treeTokens, fullTokens)}%`);
  console.log(`Tree plus first section saving for this corpus: ${saving(treeTokens + sectionTokens, fullTokens)}%`);
  console.log(`Elapsed: ${elapsedMs}ms`);
  console.log('Method: estimated tokens = ceil(characters / 4); results are corpus-specific.');
}

runBenchmark().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
