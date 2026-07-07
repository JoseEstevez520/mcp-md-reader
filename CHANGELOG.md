# Changelog

## v1.1.0 — Hardening Release (2026-07-07)

### 1. Parallel vault search (`md_search_vault`)
- **Before**: Sequential file reads with `for...of` loop
- **After**: Batched parallel reads with `Promise.allSettled` (batch size 50)
- **Impact**: 162 files searched in 31ms (0.2ms/file average)

### 2. Parallel graph sibling reads (`md_graph`)
- Sibling file reads now use `Promise.allSettled` instead of sequential loop
- `findMdFiles` now traverses subdirectories in parallel and skips `node_modules`

### 3. Persistent disk cache
- Cache now writes to `%TEMP%/mcp-md-reader-cache/index.json`
- Survives server restarts
- Validates entries against file mtime on load
- Auto-evicts entries older than 7 days
- Capped at 100 entries (same as memory)
- **Cache speedup**: 2.9x on 1438-line file (100 iterations)

### 4. Fuzzy matcher improvements
- **Before**: Required 4+ chars for any match; 2-3 char queries always returned 0
- **After**: 2-3 char queries match on word boundaries:
  - Prefix match: "en" matches "engagement", "da" matches "Dashboard"
  - Acronym match: "UI" matches "User Interface", "MCP" matches "Model Context Protocol"
  - CamelCase boundary: "SC" matches "SkillCard Component"
  - Short substrings like "no" still correctly rejected (won't match "conocimiento")
- **Test suite**: 14/14 fuzzy tests passing

### 5. Error handling hardened
- **Binary file detection**: Scans first 8KB for null bytes, rejects with clear message
- **File size limit**: 2MB cap prevents memory issues on huge files
- **Empty file handling**: Returns empty string, not an error
- **Permission errors**: Categorized with user-friendly messages (EACCES, EPERM, ENOENT, EISDIR, EMFILE)
- **Directory-as-file**: Detected and reported before reading
- `loadFile` now uses `fsStat` check before `readFile`

### 6. Benchmark suite v2.0
- Added timing measurements per file (parse time in ms)
- Added fuzzy matcher test suite (14 test cases)
- Added cache benchmark (cold vs warm, speedup ratio)
- Added vault-wide parallel search benchmark
- Added graph benchmark (outlinks, inlinks, timing)
- 5-phase benchmark structure: per-file, fuzzy, cache, vault search, graph

### Metrics summary

| Metric | Value |
|---|---|
| Files tested | 14 |
| Total bugs | 0 |
| Token savings (tree) | 93% |
| Token savings (tree + 1 section) | 91% |
| Fuzzy tests passed | 14/14 |
| Cache speedup | 2.9x |
| Vault search (162 files) | 31ms |
| Parse time (14 files total) | 1.9ms |

### Files changed
- `src/index.ts` — Parallel reads, error handling, version bump
- `src/cache.ts` — Disk persistence, cache stats export
- `src/parser.ts` — Fuzzy matcher word-boundary/acronym support
- `src/graph.ts` — Parallel subdirectory traversal, node_modules exclusion
- `src/benchmark.ts` — v2.0 with 5 test phases
- `package.json` — Version 1.1.0
