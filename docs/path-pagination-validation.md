# Path ownership and legacy pagination repair — 1.3.5

## Scope

Persistent page-ID reservations prevent distinct same-title pages from sharing a
Markdown file. Existing ownership comes from the file's `wolai_id`, not its title.
Short-ID suffixes extend on collision. Parent links, child directories and image
folders use the resolved path. A damaged registry fails closed instead of silently
assigning a new owner. Reservations are saved before note writes and are not
deleted by ordinary generated-file cleanup.

## Evidence-based migration

The block reader exposes the exact old pagination sequence only when identical
leaf text/heading blocks repeat by ID at the boundary of successive batches in a
flat root list. Repetition within a batch is not migration evidence. The normal output
remains deduplicated. Nested/shared references are outside automatic migration.
The sync manager requires the historical complete fingerprint, original-body
equality, matching page ownership and an unchanged remote revision. Existing
Conflict/Modified flags alone cannot defeat this content proof, but an actual
extra edit does. The remote revision is checked again before migration, the
complete original file is backed up, and the local content is rechecked before
writing. No existing conflict copies or user data are deleted by the migration.

Generated-link upgrades use equivalent ownership, fingerprint, revision and
exact old-body checks, with a separate backup folder. Unrelated pages retain the
normal fast-skip path. Unchanged pictures use their existing image checkpoints.

## Verification

- Offline regression fixtures cover duplicate-title ownership, reordered
  traversal, reloaded reservations, ID-prefix collisions, sanitized/case-equivalent
  names, unsafe paths, reservation write failures, links, descendants and images.
  A shared page referenced by multiple parents retains one canonical file; later
  references link to it rather than reassigning its path.
- Pagination tests cover fresh and cached evidence, exact backups, baseline
  updates, local/remote edits, missing baselines, backup failures and concurrent
  edits. No test sends actual Wolai requests.
- One affected real note was replayed from existing local read-journal data into
  an in-memory vault: the original 229-block sequence became 228 unique blocks,
  the exact original note was retained in the simulated backup, and the stale
  conflict was cleared. The real file's SHA-256 was unchanged. This verification
  used zero network requests and did not migrate the user's actual note.
- Bidirectional failure counts deduplicate by known page ID. Reconciliation and
  deferred migrations do not increment outbound upload counts.

Run `npm run check` for lint, regression tests and the production build. Runtime
path maps and backups are intentionally excluded from source control.
