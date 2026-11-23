# mend

A command-line patch tool: it reads a patch in one of four formats and applies
its edits to the files under the current directory, atomically — either every
edit lands, or nothing is written.

Built for the [hidden-spec-cli bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
on make.fun.

![hidden-spec-cli bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
![mend rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dukundigidaw/mend/rank.svg)
![mend reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dukundigidaw/mend/reward.svg)

## Usage

```
mend [options] PATCH
```

`PATCH` is a patch file, or `-` for stdin. Options and the patch may come in
any order; `--` ends the options.

| Option | Meaning |
| --- | --- |
| `--format=json\|unified\|search-replace\|v4a\|auto` | Patch format (`auto` detects it, the default) |
| `--strict` | Match lines exactly only (tier 0); no whitespace tolerance |
| `--check` | Report what would change, write nothing |

Exit codes: `0` all edits applied, `1` one or more edits failed (nothing
written, every failure reported), `2` usage, missing patch, unknown format or
parse error.

On success it prints one line per changed file — `A` added, `D` deleted,
`M` modified, `R old -> new` renamed — then `ok: <n> file(s)`.

## Patch formats

`mend` accepts the four formats AI coding tools actually emit:

- **JSON** — one edit per line (`{"command": "create"|"str_replace"|"insert"|"delete"|"move", ...}`), or a JSON array of edits.
- **Unified diff** — `diff --git` sections, `---`/`+++` headers, `@@` hunks,
  including creation, deletion and rename. A hunk applies at the occurrence
  nearest its stated line, and `\ No newline at end of file` lines are
  honoured.
- **SEARCH/REPLACE** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks, each applying exactly once or failing as ambiguous.
- **V4A** — `*** Begin Patch` / `*** End Patch` patches with `Add File`,
  `Delete File` and `Update File` sections, `@@` anchors, a cursor that
  advances through the file, and `*** End of File` chunks.

## Matching

Lines match in three tiers, best tier first: exact (tier 0), ignoring trailing
whitespace (tier 1), ignoring leading and trailing whitespace (tier 2). At
tier 2, new lines are re-indented to the indentation of the lines they
replace, and context lines are always written as the file's own lines.
`--strict` restricts matching to tier 0.

## Safety

- Paths are checked before anything else: no `..`, no absolute paths, no
  empty segments, no backslashes, no `.` segments.
- CRLF files keep CRLF; a file without a final line break keeps that too,
  unless a hunk explicitly changes it.
- Directories are created as files need them.
- Node 22 standard library only — no dependencies, no network, no model
  calls, fully deterministic.
