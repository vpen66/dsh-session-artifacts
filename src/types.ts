/**
 * Types for observing and reporting Session artifact space by folder.
 *
 * The plugin reports disk space measurements only, grouped by folder.
 * It deliberately does not classify files into keep vs reclaim.
 * @module dsh-session-artifacts/types
 */

import type { RootOrigin } from './roots.js'

/** One file or directory observed as newly created or modified during the Session. */
export interface ObservedEntry {
  /** Absolute path. */
  readonly path: string
  /** Workspace-relative path when inside the root, else the absolute path. */
  readonly display: string
  readonly kind: 'file' | 'directory'
  /** Bytes; the recursive total for a directory. */
  readonly bytes: number
  /** How many files the entry covers; `1` for a file. */
  readonly files: number
  /** Path components between the workspace root and this entry, excluding its own name. */
  readonly ancestors: readonly string[]
  /** True when the baseline already had this path and its own mtime is newer than the baseline. */
  readonly rewritten?: boolean
  /**
   * When this entry was last written, epoch milliseconds: a file's own `mtime`, a
   * newly measured directory's own `mtime`, and the newest `mtime` inside a
   * directory record's group.
   *
   * This is what answers "what did *this* turn write", which no byte total can: a
   * rebuilt `target/` reports its whole size on every later scan, so size alone
   * cannot tell a quiet turn from a busy one.
   */
  readonly mtimeMs: number
}

/** One folder's aggregated footprint. */
export interface FolderEntry {
  /** Display path, relative to the workspace for everything inside it. */
  readonly path: string
  /** This folder's whole subtree, including every child. */
  readonly bytes: number
  /** Files this folder's subtree covers. */
  readonly files: number
  /** Immediate parent for a descendant row; absent on a top-level folder. */
  readonly parent?: string
  /** Absolute root a top-level row belongs to: the workspace, or an external artifact root. */
  readonly root?: string
  /**
   * Every directory below this folder, flat, each covering its own subtree.
   *
   * Flat rather than nested so one row grammar serves the record, the report text,
   * and the panel: `parent` names the level above, and the panel rebuilds the
   * disclosure tree from it, one level at a time.
   */
  readonly subfolders?: FolderEntry[]
}

/** What one scan covered, so a reader can tell truncation from absence. */
export interface ScanCoverage {
  /** Directories the walk visited. */
  readonly directoriesVisited: number
  /** True when a configured bound stopped the walk before the tree was exhausted. */
  readonly truncated: boolean
  /**
   * What stopped the walk, when something did.
   *
   * A reader that says only "a bound was hit" cannot tell a healthy scan of a
   * busy build from one that never reached the end of the tree, and neither can
   * the person reading the card. The reason and the two numbers travel together.
   */
  readonly truncation?: ScanTruncation
  /**
   * Records the comparison found before folding them into the bound.
   *
   * This is what the record bound is compared against, so it is the number a
   * truncation notice has to show: the folded list a reader gets is not.
   */
  readonly recordsObserved?: number
  /** Wall-clock milliseconds the scan took. */
  readonly elapsedMs: number
  /** True when this scan took the Session baseline rather than comparing against one. */
  readonly baseline: boolean
}

/** One root's share of a scan, when the Session produced outside its workspace. */
export interface RootShare {
  /** Absolute root path. */
  readonly path: string
  /** Display prefix for rows under it: '' for the scanned Session's own workspace, else its absolute path. */
  readonly label: string
  /** Where the root came from, so a reader can judge the row. */
  readonly origin: RootOrigin
  /** Bytes the scan recorded under this root. */
  readonly bytes: number
  /** Files those records cover. */
  readonly files: number
}

/** The bound that stopped one scan, and how far the scan had got when it did. */
export interface ScanTruncation {
  /** Which bound stopped the walk. */
  readonly reason: 'maxRecords' | 'maxDirectories' | 'timeoutMs' | 'maxRoots'
  /** That bound's configured value: records, directories, or milliseconds. */
  readonly limit: number
  /** What the walk reached, in the reason's own unit: records, directories, or milliseconds. */
  readonly observed: number
}

/** The result of one scan. */
export interface ArtifactScan {
  readonly sessionId: string
  /** The turn whose mutations the scan attributed, or null for a baseline-only scan. */
  readonly turn: number | null
  readonly root: string
  /** Every newly observed entry, largest first. */
  readonly records: readonly ObservedEntry[]
  /**
   * What the Session has left in the workspace and still holds: total bytes.
   *
   * This is the footprint, not the delta: it counts a rebuilt `target/` on every
   * scan, because the file is still there and still this Session's doing.
   */
  readonly bytes: number
  /**
   * What the turn being recorded wrote, in bytes.
   *
   * Derived from the same records by their own write times: only the entries
   * written after the previous turn ended. A quiet turn is 0 here while `bytes`
   * still reports the whole footprint — which is the difference the two readings
   * are for.
   */
  readonly turnBytes: number
  /**
   * The turn's own folders, largest first: what the turn's reading opens.
   *
   * The panel behind the per-message reading answers "where did *this* turn put
   * it", so it cannot show the Session's folder shares — those are the footprint,
   * which every later scan reports again.
   */
  readonly turnFolders: readonly FolderEntry[]
  /** Folders the turn touched before the per-record bound trimmed the list. */
  readonly turnFoldersTotal: number
  readonly coverage: ScanCoverage
  /** Every root the scan covered, workspace included; present only when it covered more than the workspace. */
  readonly roots?: readonly RootShare[]
  /** Bytes the workspace root alone contributed; present only beside {@link roots}. */
  readonly workspaceBytes?: number
}
