import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('bundled Codex plugin server starts and exposes its five tools', async () => {
  const client = new Client({ name: 'mcp-md-reader-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'plugin', 'mcp-md-reader.cjs')],
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['md_find', 'md_frontmatter', 'md_section', 'md_tree', 'md_vault_index'],
    );
  } finally {
    await client.close();
  }
});
