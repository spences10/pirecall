# pirecall

## 0.1.3

### Patch Changes

- Backfill names and metadata from unchanged session files once while
  preserving fast incremental synchronization afterward.

## 0.1.2

### Patch Changes

- e9ba3e5: Derive CLI version metadata from package.json so published
  command help always matches the installed release version.

## 0.1.1

### Patch Changes

- 0c119e2: Move embedded SQLite schema into packaged SQL files with
  transactional migrations and legacy database compatibility.
- da40d25: Add SQLite-backed resumable session indexing with archive
  preservation, source liveness, search, pagination, and typed APIs.

## 0.1.0

### Minor Changes

- f295264: pirecall: sync pi.dev agent sessions to SQLite for search,
  analytics, and recall
