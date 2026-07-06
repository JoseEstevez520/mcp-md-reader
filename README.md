<p align="center">
  <h1 align="center">mcp-md-reader</h1>
  <p align="center">
    <strong>MCP server for intelligent markdown reading — read only what you need</strong>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/MCP-compatible-blue?style=flat-square" alt="MCP">
    <img src="https://img.shields.io/badge/license-Apache_2.0-green?style=flat-square" alt="License">
    <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square" alt="Node">
    <img src="https://img.shields.io/badge/token_savings-~90%25-orange?style=flat-square" alt="Token Savings">
  </p>
</p>

---

> AI agents waste context reading entire markdown files when they only need one section. This server fixes that.

## The problem

A 3,000-token markdown file might have 12 sections. The agent needs one. Without `mcp-md-reader`, it reads all 3,000 tokens. With it, it reads ~60 tokens for the tree and ~300 for the section. **~90% savings on average.**

## Tools

| Tool | What it does | Typical savings |
|------|-------------|-----------------|
| `md_tree` | Heading tree with estimated token counts | ~97% |
| `md_section` | One section by name (fuzzy match) | ~88-98% |
| `md_search` | Search text within a file | ~77% |
| `md_frontmatter` | YAML frontmatter only | ~99% |
| `md_graph` | Wikilink graph (outlinks + inlinks) | — |
| `md_search_vault` | Search across all `.md` files in a directory (recursive) | — |

The intended workflow: call `md_tree` first to see the structure, then `md_section` to read only what you need.

## Setup

```bash
git clone https://github.com/JoseEstevez520/mcp-md-reader.git
cd mcp-md-reader
npm install
npm run build
```

Then register with Claude Code:

```bash
claude mcp add md-reader -- node /full/path/to/mcp-md-reader/dist/index.js
```

Restart Claude Code. The 6 tools will appear as native tools in your session.

## Tech stack

<p>
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/MCP_SDK-1C3C3C?style=for-the-badge" alt="MCP SDK">
</p>

| Layer | Detail |
|-------|--------|
| **Transport** | stdio (MCP protocol 2024-11-05) |
| **Parser** | Pure string parsing, zero external deps |
| **Cache** | LRU with mtime validation (100 entries) |
| **Matching** | Fuzzy heading match with short-query protection |

## How it works

The server parses markdown into a heading tree on first read, caches the result (validated by file modification time), and serves only the requested slice. No external parsing libraries — just string splitting by `#` headings with code-block awareness.

The fuzzy matcher scores heading similarity using exact match, substring match (4+ chars only), and word overlap. Queries shorter than 4 characters are rejected to prevent false positives.

`md_search_vault` recursively scans all `.md` files in a directory tree, skipping hidden folders.

## Example

```
> md_tree("notes/project.md")

File: notes/project.md
Full file: ~2428 tokens
This tree: ~84 tokens
Savings: ~97%
# Project  (~7 tok)
  ## Objective  (~59 tok)
  ## Current state  (~804 tok)
  ## Decisions  (~297 tok)

> md_section("notes/project.md", "Decisions")

Section: Decisions (level 2)
Lines: 124-133
Section tokens: ~297 | Full file: ~2428 | Savings: ~88%
## Decisions
- Path B (pgvector + RLS) as baseline...
```

## Origin

Built as part of the [ANFAIA Summer Grants 2026](https://anfaia.org) research on post-markdown formats for AI agents. The core insight: instead of inventing a new format, make the reader smarter over plain markdown.

## License

Distributed under the [Apache 2.0](LICENSE) license.

---

<p align="center">
  <em>Built for <a href="https://github.com/modelcontextprotocol">MCP</a>-compatible AI agents.</em>
</p>
