# Whole-table read validation — 1.3.4

## What changed

The earlier analysis considered only `/blocks/{id}/children`. A live check of
`GET /blocks/{tableId}` found a complete `table_content` matrix and table settings.
This makes one request per supported table possible; it does not turn an entire
page sync into one request or bypass quotas.

## Evidence and boundaries

- Baseline page log: 592 child-list requests (2 page batches, 22 tables, 564 cells,
  4 other nested blocks). Authentication, images and revision checks are separate.
- Deterministic offline test uses the same counts and verifies every cell's rich
  content: 592 requests with traversal, 28 with detail reads. No private content is
  stored in the test fixture.
- A live 7-row/6-column table detail returned all 42 cell values. Parsing the
  generated Markdown yielded the same 42 text values. One selected cell was also
  compared with its separate children response and matched.
- Live diagnostics used 15 requests in total: an initial 2-request schema probe,
  a broader probe stopped immediately at HTTP 429 on request 10, and a later
  3-request paced verification (maximum one request/second, zero retries). These
  standalone diagnostics were not a synchronization run and did not modify notes
  or the installed plugin's counters. There was no whole-page live benchmark.
- Offline formula tests compare MathJax glyph sequences and bounding boxes before
  and after table-safe conversion. They cover fractions, sums, absolute value,
  norms, conditional probability and scalable delimiters. This is not a claim
  that every possible custom TeX macro is supported.

## Safety

Only rectangular, complete matrices with supported text/equation cells use the
fast path. Unknown cell structures, media, missing cells or multiline inline
math fall back. A different table revision aborts the read rather than mixing
versions. Root-version verification and resumable journals remain in place.

Legacy notes with a known unchanged content baseline receive an exact backup
before table formatting is replaced. Missing baselines, edits during backup and
concurrent changes never authorize overwrite. Unchanged ordinary notes keep the
existing fast-skip path. Outbound writes involving imported tables are blocked
until structured table editing is separately implemented.

## Rendering limitations

Markdown cannot reproduce every Wolai style. Column widths, colors, merged cells
and special embeds are not certified as equivalent. Headerless data receives an
empty Markdown header. Supported numerical strings are never parsed as numbers.
For formula pipes, equivalent TeX commands preserve mathematical glyphs without
accidentally splitting the Markdown row.

Nested tables are rendered at page level in reading order; tab indentation would
turn them into Markdown code blocks. Unsupported-table fallback adds one detail
probe over the original traversal. A mocked transport integration checks that the
quota hook counts each real HTTP attempt, including retries, and that complete
tables never trigger per-cell requests.

Run `npm run check` for lint, offline regression tests and the production build.
GFM and MathJax are test-only dependencies. The existing esbuild development-server
advisory remains unrelated to this feature; the checks do not run a dev server.
