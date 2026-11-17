/**
 * The observation layer: one baseline walk of the workspace, then a per-turn
 * incremental walk that descends only into directories whose own `mtime`
 * changed.
 *
 * Git cannot answer this question. `git add --all` skips ignored paths, and
 * build output is usually ignored, so a build the model ran through a shell
 * command leaves git no trace at all. Walking the filesystem sees it, and the
 * incremental walk keeps that affordable: on a 190k-entry checkout the baseline
 * costs about 750ms and every later scan about 150ms.
 *
 * The walk is sound for what the ledger needs. Creating or removing an entry
 * updates its parent directory's `mtime`, so an unchanged directory listing is
 * unchanged, and the walk uses the recorded child names instead of re-reading
 * the directory. Deciding to walk directories rather than files is what makes
 * the cost proportional to directory count.
 * @module dsh-session-artifacts/inventory
 */

import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { ObservedEntry, ScanCoverage, ScanTruncation } from './types.js'

/** One directory's baseline record. */
export interface DirectoryBaseline {
  /** `dev:ino:mtimeMs` identity; an unchanged value means the listing is unchanged. */
  readonly key: string
  /** Child names, files and directories alike. */
  readonly names: readonly string[]
  /** The subset of {@link names} that are directories. */
  readonly dirs: readonly string[]
}

/** The workspace as it stood when the Session began. */
export interface InventoryBaseline {
  /** Canonical workspace root. */
  readonly root: string
  readonly dirs: ReadonlyMap<string, DirectoryBaseline>
  /**
   * When the baseline walk started, epoch milliseconds.
   *
   * A file whose own `mtime` is newer than this was written during the Session, which
   * is how the scan recognises a path the Session rewrote rather than created.
   */
  readonly takenAt: number
}

/** Bounds that keep one scan from spending unbounded time or memory. */
export interface ScanBounds {
  /** Directories one walk may visit before it stops and reports truncation. */
  readonly maxDirectories: number
  /** Records one scan may report before the remainder collapses into aggregate entries. */
  readonly maxRecords: number
  /** Milliseconds one walk may run before it stops and reports truncation. */
  readonly timeoutMs: number
  /** Directory names the walk never enters. */
  readonly exclude: readonly string[]
}

/** How one root's results differ from the workspace root's. */
export interface ScanOptions {
  /**
   * Display prefix for every entry: '' inside the workspace, the root's own
   * absolute path for a root outside it, so a row names a path a reader can open.
   */
  readonly displayPrefix?: string
  /**
   * Oldest write that counts, epoch milliseconds, for a root outside the
   * workspace. A strict root cannot tell "already there" from "added" by listing
   * alone — it was discovered after the Session started, possibly after its
   * files were written — so every candidate file is filtered by this watermark
   * instead. The workspace root omits it: its baseline predates the Session.
   */
  readonly since?: number
}

/** One walk's outcome. */
export interface ScanResult {
  /** Newly created entries, before classification. */
  readonly entries: ObservedEntry[]
  readonly coverage: ScanCoverage
}

/** The `dev:ino:mtimeMs` identity the walk compares against. */
async function identity(path: string): Promise<{ key: string; mtimeMs: number } | undefined> {
  try {
    const info = await stat(path)
    return { key: `${info.dev}:${info.ino}:${info.mtimeMs}`, mtimeMs: info.mtimeMs }
  } catch {
    // A directory that vanished mid-walk is simply absent from this scan; the
    // next scan sees the removal through its parent's changed listing.
    return undefined
  }
}

/** Recompute the workspace-relative display path and the ancestor components. */
function locate(
  root: string,
  path: string,
  displayPrefix = '',
): { display: string; ancestors: readonly string[] } {
  const rel = relative(root, path)
  if (rel === '' || rel.startsWith('..')) return { display: path, ancestors: [] }
  const parts = rel.split(sep)
  return { display: displayPrefix === '' ? parts.join('/') : `${displayPrefix}/${parts.join('/')}`, ancestors: parts.slice(0, -1) }
}

/**
 * Take the Session's baseline by walking every directory once.
 *
 * The walk records directory identities and child names only, plus the moment it
 * started. It never stats a file, because a file's own metadata matters only when a
 * later scan finds its directory re-listed, and that is what keeps the baseline
 * inexpensive enough to take per Session.
 * @param root - canonical workspace root.
 * @param bounds - walk bounds.
 * @param signal - aborts the walk.
 * @returns the baseline, plus the coverage the walk achieved.
 */
export async function takeBaseline(
  root: string,
  bounds: ScanBounds,
  signal?: AbortSignal,
): Promise<{ baseline: InventoryBaseline; coverage: ScanCoverage }> {
  const started = Date.now()
  const deadline = started + bounds.timeoutMs
  const dirs = new Map<string, DirectoryBaseline>()
  const queue: string[] = [root]
  let truncation: ScanTruncation | undefined

  while (queue.length > 0) {
    if (signal?.aborted === true) break
    if (dirs.size >= bounds.maxDirectories) {
      truncation = { reason: 'maxDirectories', limit: bounds.maxDirectories, observed: dirs.size }
      break
    }
    if (Date.now() > deadline) {
      truncation = { reason: 'timeoutMs', limit: bounds.timeoutMs, observed: Date.now() - started }
      break
    }
    const dir = queue.pop()
    if (dir === undefined) break
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const info = await identity(dir)
    if (info === undefined) continue
    const names: string[] = []
    const childDirs: string[] = []
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      names.push(entry.name)
      if (entry.isDirectory() && !bounds.exclude.includes(entry.name)) childDirs.push(entry.name)
    }
    dirs.set(dir, { key: info.key, names, dirs: childDirs })
    for (const name of childDirs) queue.push(join(dir, name))
  }

  return {
    baseline: { root, dirs, takenAt: started },
    coverage: {
      directoriesVisited: dirs.size,
      truncated: truncation !== undefined,
      ...(truncation === undefined ? {} : { truncation }),
      elapsedMs: Date.now() - started,
      baseline: true,
    },
  }
}

/** Running totals for a subtree measurement. */
interface Measure {
  bytes: number
  files: number
  /** Newest `mtime` seen inside the subtree, epoch milliseconds. */
  mtimeMs: number
}

/** One directory a subtree measurement walked, with the files directly inside it. */
interface MeasuredDirectory {
  path: string
  /** Bytes of the files directly in it, not of its subtree. */
  bytes: number
  files: number
  /** Newest write directly inside it, epoch milliseconds. */
  mtimeMs: number
}

/** What one subtree measurement found. */
interface SubtreeMeasure {
  /** Every directory visited, with its own files. */
  directories: MeasuredDirectory[]
  /** The whole subtree, including every directory. */
  bytes: number
  files: number
  /** Newest write anywhere inside it. */
  mtimeMs: number
}

/**
 * Measure one subtree's total size, and the files each directory in it holds.
 *
 * Only newly created directories are measured, so the cost is proportional to
 * what the Session produced rather than to the workspace. A directory the model
 * generated is exactly the thing whose size the reader wants, so the walk is not
 * optional here — and a directory *inside* it is a level the reader can expand,
 * which is why the walk reports each one instead of only its total.
 * @param root - directory to measure.
 * @param bounds - walk bounds, applied so one runaway directory cannot stall a scan.
 * @param deadline - millisecond deadline shared with the enclosing scan.
 * @returns the directories walked, and the subtree's own totals.
 */
async function measureSubtree(
  root: string,
  bounds: ScanBounds,
  deadline: number,
  since?: number,
): Promise<SubtreeMeasure> {
  const directories: MeasuredDirectory[] = []
  const totals: Measure = { bytes: 0, files: 0, mtimeMs: 0 }
  const queue: string[] = [root]
  let visited = 0
  while (queue.length > 0) {
    const dir = queue.pop()
    if (dir === undefined) break
    if (visited >= bounds.maxDirectories || Date.now() > deadline) break
    visited += 1
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const own: MeasuredDirectory = { path: dir, bytes: 0, files: 0, mtimeMs: 0 }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(path)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(path)
        // A strict root counts only writes this Session could have made: a tree
        // that appeared after the root was registered may still hold files that
        // were already there, and those are not this Session's artifact.
        if (since !== undefined && info.mtimeMs < since) continue
        own.bytes += info.size
        own.files += 1
        own.mtimeMs = Math.max(own.mtimeMs, info.mtimeMs)
      } catch {
        // A file that disappeared between listing and stat contributes nothing.
      }
    }
    directories.push(own)
    totals.bytes += own.bytes
    totals.files += own.files
    totals.mtimeMs = Math.max(totals.mtimeMs, own.mtimeMs)
  }
  return { directories, bytes: totals.bytes, files: totals.files, mtimeMs: totals.mtimeMs }
}

/**
 * Compare the workspace against the Session baseline and report what appeared.
 *
 * Directories are visited whether or not they changed, because a change three
 * levels down does not update an ancestor's `mtime`. What the `mtime` check buys
 * is skipping `readdir` and every per-entry `stat` for a directory whose listing
 * is unchanged, which is the overwhelming majority on a normal turn.
 * @param baseline - the Session baseline.
 * @param bounds - walk bounds.
 * @param signal - aborts the scan.
 * @returns the newly created entries and what the walk covered.
 */
export async function scanWorkspace(
  baseline: InventoryBaseline,
  bounds: ScanBounds,
  options: ScanOptions = {},
  signal?: AbortSignal,
): Promise<ScanResult> {
  const { displayPrefix = '', since } = options
  const started = Date.now()
  const deadline = started + bounds.timeoutMs
  const entries: ObservedEntry[] = []
  const seen = new Set<string>()
  const queue: string[] = [baseline.root]
  let truncation: ScanTruncation | undefined

  while (queue.length > 0) {
    if (signal?.aborted === true) break
    if (seen.size >= bounds.maxDirectories) {
      truncation = { reason: 'maxDirectories', limit: bounds.maxDirectories, observed: seen.size }
      break
    }
    if (Date.now() > deadline) {
      truncation = { reason: 'timeoutMs', limit: bounds.timeoutMs, observed: Date.now() - started }
      break
    }
    const dir = queue.pop()
    if (dir === undefined) break
    seen.add(dir)
    const info = await identity(dir)
    if (info === undefined) continue
    const recorded = baseline.dirs.get(dir)

    if (recorded !== undefined && recorded.key === info.key) {
      // The listing is unchanged, so the recorded children are still the
      // children; descend without re-reading the directory.
      for (const name of recorded.dirs) queue.push(join(dir, name))
      continue
    }

    let listing
    try {
      listing = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const known = new Set(recorded?.names ?? [])
    // Files sitting directly in one directory are one record, not one per file.
    // The ledger's unit is the directory the space arrived in: a build rewrites
    // thousands of files under one `target/`, and every reader of these records
    // aggregates them by folder anyway, so per-file records only inflated the
    // record bound until a healthy build reported itself as a truncated scan.
    // The workspace root is the exception — a file directly in it has no folder
    // of its own, and the panel lists it as its own row.
    const direct = dir === baseline.root
    let addedBytes = 0
    let addedFiles = 0
    let rewrittenBytes = 0
    let rewrittenFiles = 0
    let written = 0
    for (const entry of listing) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (bounds.exclude.includes(entry.name)) continue
        if (!known.has(entry.name)) {
          const measured = await measureSubtree(path, bounds, deadline, since)
          // A directory the Session created is a level the reader can expand, so
          // each directory inside it that holds files is its own record — one per
          // directory, files included, exactly like the re-listed case. Two cases
          // still collapse to the one subtree record: a tree too large to list
          // level by level without eating the record bound, and a tree with no
          // files at all, where the row itself is the whole reading.
          const held = measured.directories.filter(inside => inside.files > 0)
          // The detail costs one record per directory that holds files, so it is
          // spent only while the scan has room for it: a tree gets at most half of
          // what is left, and anything larger stays the one subtree record. A
          // `node_modules`-shaped tree therefore collapses, a Maven `target/`
          // expands level by level, and a turn that builds many modules degrades
          // from the last tree backwards instead of tripping the record bound.
          const room = Math.max(0, bounds.maxRecords - entries.length)
          const records = held.length > 0 && held.length <= Math.max(16, Math.floor(room / 2))
            ? held
            : [{ path, bytes: measured.bytes, files: measured.files, mtimeMs: measured.mtimeMs }]
          for (const record of records) {
            entries.push({
              path: record.path,
              kind: 'directory',
              bytes: record.bytes,
              files: record.files,
              mtimeMs: record.mtimeMs,
              ...locate(baseline.root, record.path, displayPrefix),
            })
          }
          continue
        }
        queue.push(path)
        continue
      }
      if (!entry.isFile()) continue
      // A name the baseline already had used to be invisible here, because this
      // ledger reports what the Session *added*. A build that overwrites its own
      // output adds nothing, though — `mvn verify` rewrites `target/app.jar` and
      // only the bytes change — so a file whose own mtime is newer than the
      // baseline counts as rewritten. This stats the files of a directory that
      // was re-listed, never the workspace.
      const rewritten = known.has(entry.name)
      try {
        const fileInfo = await stat(path)
        if (!fileInfo.isFile()) continue
        // A strict root was discovered after the Session began, so its baseline
        // cannot tell an old file from a new one by name; the write time does.
        if (since !== undefined && fileInfo.mtimeMs < since) continue
        if (rewritten && fileInfo.mtimeMs <= baseline.takenAt) continue
        written = Math.max(written, fileInfo.mtimeMs)
        if (direct) {
          entries.push({
            path,
            kind: 'file',
            bytes: fileInfo.size,
            files: 1,
            mtimeMs: fileInfo.mtimeMs,
            ...(rewritten ? { rewritten: true } : {}),
            ...locate(baseline.root, path, displayPrefix),
          })
          continue
        }
        if (rewritten) {
          rewrittenBytes += fileInfo.size
          rewrittenFiles += 1
        } else {
          addedBytes += fileInfo.size
          addedFiles += 1
        }
      } catch {
        // Vanished between listing and stat; the next scan will not report it.
      }
    }
    if (direct || addedFiles + rewrittenFiles === 0) continue
    entries.push({
      path: dir,
      kind: 'directory',
      bytes: addedBytes + rewrittenBytes,
      files: addedFiles + rewrittenFiles,
      mtimeMs: written,
      // Overwritten rather than added: every name in this directory predates the
      // Session, so nothing about it grew.
      ...(addedFiles === 0 ? { rewritten: true } : {}),
      ...locate(baseline.root, dir, displayPrefix),
    })
  }

  const recordsObserved = entries.length
  if (recordsObserved > bounds.maxRecords) {
    truncation = { reason: 'maxRecords', limit: bounds.maxRecords, observed: recordsObserved }
  }

  // The bound is compared against directories and earlier events now, so what
  // remains for folding is a workspace with more changed directories than the
  // bound allows.
  const bounded = truncateToLargest(entries, bounds.maxRecords, baseline.root, displayPrefix)

  return {
    entries: bounded,
    coverage: {
      directoriesVisited: seen.size,
      truncated: truncation !== undefined,
      ...(truncation === undefined ? {} : { truncation }),
      recordsObserved,
      elapsedMs: Date.now() - started,
      baseline: false,
    },
  }
}

/**
 * Keep the largest entries and fold the remainder into one entry per directory.
 *
 * Folding preserves the total rather than dropping it: a reader must never see a
 * smaller byte total than the workspace actually grew by, because that would
 * make the ledger understate the thing it exists to explain.
 * @param entries - every entry the walk found.
 * @param maxRecords - how many records a scan may report.
 * @param root - the workspace root used to derive display paths.
 * @returns at most `maxRecords` entries, plus one folded entry per directory.
 */
function truncateToLargest(
  entries: readonly ObservedEntry[],
  maxRecords: number,
  root: string,
  displayPrefix = '',
): ObservedEntry[] {
  if (entries.length <= maxRecords) return [...entries]
  const sorted = [...entries].sort((left, right) => right.bytes - left.bytes)
  const kept = sorted.slice(0, maxRecords)
  const folded = new Map<string, Measure>()
  for (const entry of sorted.slice(maxRecords)) {
    const cut = entry.path.lastIndexOf('/')
    const parent = cut === -1 ? root : entry.path.slice(0, cut)
    const running = folded.get(parent) ?? { bytes: 0, files: 0, mtimeMs: 0 }
    running.bytes += entry.bytes
    running.files += entry.files
    // The group keeps its newest write, so a turn's own contribution survives
    // folding: dropping it would make a busy turn read as a quiet one.
    running.mtimeMs = Math.max(running.mtimeMs, entry.mtimeMs)
    folded.set(parent, running)
  }
  for (const [parent, totals] of folded) {
    kept.push({
      path: parent,
      kind: 'directory',
      bytes: totals.bytes,
      files: totals.files,
      mtimeMs: totals.mtimeMs,
      ...locate(root, parent, displayPrefix),
    })
  }
  return kept
}
