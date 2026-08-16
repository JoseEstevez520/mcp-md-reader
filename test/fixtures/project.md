# Project

## Goal

Read one relevant section instead of loading an entire Markdown document.

## Architecture

```ts
// Headings inside a code fence must not enter the document tree.
const example = '# not a heading';
```

## Decisions

- Keep retrieval deterministic.
- Estimate tokens with characters divided by four.
- Report benchmark results only for the corpus that was measured.
