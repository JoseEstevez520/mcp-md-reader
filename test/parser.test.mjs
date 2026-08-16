import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  estimateTokens,
  findSection,
  parseMarkdown,
  renderTree,
} from '../dist/parser.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('parses frontmatter, nested headings, and fenced code safely', async () => {
  const text = await readFile(join(fixtureDir, 'learning-notes.md'), 'utf8');
  const parsed = parseMarkdown(text);

  assert.equal(parsed.frontmatter?.title, 'Learning notes');
  assert.deepEqual(parsed.frontmatter?.tags, ['education', 'interfaces']);
  assert.equal(parsed.tree[0].title, 'Learning notes');
  assert.equal(parsed.tree[0].children[0].title, 'Cognitive load');
  assert.equal(parsed.tree[0].children[0].children[0].title, 'Worked example');

  const project = parseMarkdown(await readFile(join(fixtureDir, 'project.md'), 'utf8'));
  assert.equal(renderTree(project.tree).includes('not a heading'), false);
});

test('retrieves a fuzzy-matched section without returning the whole file', async () => {
  const text = await readFile(join(fixtureDir, 'learning-notes.md'), 'utf8');
  const parsed = parseMarkdown(text);
  const section = findSection(parsed, 'adaptive');

  assert.ok(section);
  assert.equal(section.node.title, 'Adaptive explanation');
  assert.match(section.content, /source can stay constant/);
  assert.ok(estimateTokens(section.content) < estimateTokens(text));
});
