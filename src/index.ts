/**
 * Session artifact size ledger: observe what a Session leaves in its workspace
 * and report the total by folder.
 *
 * The plugin deliberately reports measurements only. It does not decide what a
 * user should keep or reclaim; an assistant can use the folder paths and byte
 * counts to decide what to do when cleanup is requested.
 * @module dsh-session-artifacts
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as dshSessionModule from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { scanWorkspace, takeBaseline, type InventoryBaseline, type ScanBounds } from './inventory.js'
import { resolveOpenTarget } from './openTarget.js'
import {
  canonicalize, coverPath, isForbiddenRoot, rootPathFor, toolCandidates,
  type RootCandidate, type RootOrigin,
} from './roots.js'
import type { ArtifactScan, FolderEntry, ObservedEntry, RootShare, ScanCoverage, ScanTruncation } from './types.js'

/** Whether the runtime exposes the durable plugin-record API. */
export function recordCapability(host: unknown): boolean {
  return typeof host === 'object' && host !== null
    && typeof (host as { appendPluginRecord?: unknown }).appendPluginRecord === 'function'
}

/** A note included in text reports when the runtime cannot persist per-turn records. */
const NO_RECORD_API = 'Per-turn card unavailable: this runtime exposes no plugin record API, so the Host '
  + 'cannot record one scan per turn. The scan itself still runs, and this report is unaffected.'

export type FolderShare = FolderEntry

/**
 * The records one turn wrote, from their own write times.
 *
 * The scan's records are the Session's footprint, which a rebuilt `target/`
 * contributes to on every later scan; so the difference between two scans is not
 * a difference of records, and only the write times separate this turn's work
 * from what was already there.
 * @param entries - the scan's records.
 * @param since - the previous turn's end, epoch milliseconds.
 * @returns the entries written at or after `since`, largest first.
 */
export function turnEntries(entries: readonly ObservedEntry[], since: number): ObservedEntry[] {
  return entries.filter(entry => entry.mtimeMs >= since).sort((left, right) => right.bytes - left.bytes)
}

/** The bytes one turn wrote; the total of {@link turnEntries}. */
export function turnDelta(entries: readonly ObservedEntry[], since: number): number {
  return turnEntries(entries, since).reduce((total, entry) => total + entry.bytes, 0)
}

/** One turn's durable record payload: what both cards read. */
export interface ScanRecordData {
  turn: number | null
  root?: string
  /** What the Session holds in the workspace, in bytes: the footprint. */
  bytes: number
  /** What this turn wrote, in bytes. */
  turnBytes: number
  truncated: boolean
  /** The bound that stopped the scan, when one did; absent on a complete scan. */
  truncation?: ScanTruncation
  folders: readonly FolderShare[]
  foldersTotal: number
  /** The turn's own folders, largest first: what the per-message reading opens. */
  turnFolders: readonly FolderShare[]
  turnFoldersTotal: number
  /** Every root the scan covered, workspace included; absent when only the workspace was covered. */
  roots?: readonly RootShare[]
  /** Bytes the workspace root alone contributed, beside {@link roots}. */
  workspaceBytes?: number
}

/**
 * The durable record one scan commits.
 *
 * A truncated reading carries the bound it hit and how far the scan got, so the
 * card can say which limit stopped it instead of one sentence that reads the
 * same whether the scan missed a few records or half the tree.
 * @param scan - the scan just taken.
 * @param folderLimit - how many folder shares the record may carry.
 * @returns the record payload.
 */
export function scanRecordData(scan: ArtifactScan, folderLimit: number): ScanRecordData {
  const { folders, total: foldersTotal } = recordFolders(scan.records, folderLimit, scan.roots)
  const external = scan.roots !== undefined && scan.roots.length > 1
  return {
    turn: scan.turn,
    ...(scan.root === undefined ? {} : { root: scan.root }),
    bytes: scan.bytes,
    turnBytes: scan.turnBytes,
    truncated: scan.coverage.truncated,
    ...(scan.coverage.truncation === undefined ? {} : { truncation: scan.coverage.truncation }),
    folders,
    foldersTotal,
    turnFolders: scan.turnFolders,
    turnFoldersTotal: scan.turnFoldersTotal,
    // A workspace-only scan keeps the record exactly as an older Host wrote it;
    // the roots a reader can act on appear only when there is more than one.
    ...(external && scan.roots !== undefined ? { roots: scan.roots } : {}),
    ...(external && scan.workspaceBytes !== undefined ? { workspaceBytes: scan.workspaceBytes } : {}),
  }
}

/**
 * The report's one truncation sentence.
 *
 * The prefix stays fixed because the browser half recognises a partial list by
 * it; what follows names the bound and the scale, which is the part a reader —
 * or the model reading this report — needs to judge whether to raise a limit or
 * trust the numbers.
 * @param truncation - the bound that stopped the scan.
 * @returns one line of report text.
 */
export function truncationSentence(truncation: ScanTruncation): string {
  switch (truncation.reason) {
    case 'maxRecords':
      return 'The scan stopped at its record bound: '
        + `${truncation.observed} records against ${truncation.limit}, so this list is partial.`
    case 'maxDirectories':
      return 'The scan stopped at its directory bound: '
        + `${truncation.observed} directories visited against ${truncation.limit}, so this list is partial.`
    case 'timeoutMs':
      return 'The scan stopped at its deadline: '
        + `${truncation.observed} ms against ${truncation.limit} ms, so this list is partial.`
    case 'maxRoots':
      return 'The scan stopped at its root bound: '
        + `${truncation.observed} roots against ${truncation.limit}, so this list is partial.`
    /* v8 ignore next -- closed union */
    default: return assertNeverTruncation(truncation.reason)
  }
}

/* v8 ignore next 3 -- closed union; only reached if a forged reason arrives */
function assertNeverTruncation(reason: never): never {
  throw new Error(`unhandled scan truncation reason: ${String(reason)}`)
}

/**
 * Narrow the tool's free-text reason back to the closed bound union.
 * @param value - the truncation the tool's own output schema carries.
 * @returns the bound, or undefined when the reason is not one this build knows.
 */
export function boundOf(
  value: { readonly reason: string; readonly limit: number; readonly observed: number },
): ScanTruncation | undefined {
  const { reason } = value
  if (reason !== 'maxRecords' && reason !== 'maxDirectories' && reason !== 'timeoutMs' && reason !== 'maxRoots') return undefined
  return { reason, limit: value.limit, observed: value.observed }
}

/**
 * The machine row the report carries beside that sentence.
 *
 * The report text is the wire between the tool and the card that draws it, and
 * its rows are tab-separated for exactly this: a card that can localise the
 * sentence needs the reason and the numbers, not an English one it would have
 * to parse out of prose. A card that does not know the row ignores it.
 * @param truncation - the bound that stopped the scan.
 * @returns one `truncated` row.
 */
export function truncationRow(truncation: ScanTruncation): string {
  return ['truncated', truncation.reason, String(truncation.limit), String(truncation.observed)].join('\t')
}

/** Commit one measurement record when the running runtime supports it. */
function appendRecord(session: Session, type: 'plugin:session-artifacts/scan', data: ScanRecordData): boolean {
  if (!recordCapability(dshSessionModule)) return false
  const host = dshSessionModule as unknown as { appendPluginRecord: (...args: unknown[]) => unknown }
  host.appendPluginRecord(session, type, data)
  return true
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** One folder-level measurement committed after a completed turn. */
    'plugin:session-artifacts/scan': {
      turn: number | null
      root?: string
      bytes: number
      truncated: boolean
      /** Which bound stopped the scan and how far it got, when one did. */
      truncation?: ScanTruncation
      folders: readonly FolderShare[]
      foldersTotal: number
      /** The turn's own folders, largest first. */
      turnFolders: readonly FolderShare[]
      turnFoldersTotal: number
      /** Every root the scan covered, workspace included; present only when there is more than one. */
      roots?: readonly RootShare[]
      /** Bytes the workspace root alone contributed, beside `roots`. */
      workspaceBytes?: number
    }
  }
}

/**
 * Attribute one observed entry to the folder whose size it belongs to.
 * Files use their parent folder; a newly created directory is already a complete
 * subtree measurement and therefore uses its own path.
 */
const KNOWN_ARTIFACT_DIRS = new Set([
  'target',
  'build',
  'dist',
  'out',
  'output',
  '.next',
  '.nuxt',
  '.output',
  'node_modules',
  '.cache',
  'coverage',
  '.turbo',
  'tmp',
  'temp',
  'bin',
  'obj',
  'pkg',
])

/**
 * One directory while its tree is built: what the scan recorded directly in it,
 * and the directories underneath it.
 */
interface FolderNode {
  path: string
  /** Bytes and files the scan attributed to this directory itself. */
  own: { bytes: number; files: number }
  children: Map<string, FolderNode>
}

/**
 * Attribute one observed entry to a top-level artifact folder and optional subfolder.
 */
function splitFolder(
  entry: Pick<ObservedEntry, 'display' | 'kind'>,
  owner?: RootShare,
): { top: string; sub?: string } {
  // A root outside the workspace is already the boundary a reader asked for.
  // Running the workspace heuristic below on it would collapse
  // `/private/tmp/exp` into `/private/tmp`, because `tmp` is a known artifact
  // component — the one place where the guess is reliably wrong.
  if (owner !== undefined && owner.label !== '') {
    return entry.display === owner.label
      ? { top: owner.label }
      : { top: owner.label, sub: entry.display }
  }

  const parts = entry.display.split('/')

  // 1. If any component is a known artifact directory, that component is the boundary
  for (let i = 0; i < parts.length; i++) {
    if (KNOWN_ARTIFACT_DIRS.has(parts[i]!)) {
      const top = parts.slice(0, i + 1).join('/')
      const rest = entry.kind === 'file' ? parts.slice(i + 1, -1) : parts.slice(i + 1)
      const sub = rest.length > 0 ? `${top}/${rest.join('/')}` : undefined
      return sub !== undefined ? { top, sub } : { top }
    }
  }

  // 2. Newly created directory outside known artifact directories is already a complete top-level directory
  if (entry.kind === 'directory') {
    return { top: entry.display }
  }

  // 3. Top-level file (e.g. notes.txt)
  if (parts.length <= 1) {
    return { top: entry.display }
  }

  // 4. File in regular directory: parent folder is top
  const cut = entry.display.lastIndexOf('/')
  const top = cut <= 0 ? entry.display : entry.display.slice(0, cut)
  return { top }
}

/** One settled directory: its own subtree total, and the rows under it. */
interface SettledFolder {
  path: string
  bytes: number
  files: number
  children: SettledFolder[]
}

/** Finish one directory: rank its children and add their totals to its own. */
function settleFolder(node: FolderNode): SettledFolder {
  const children = [...node.children.values()]
    .map(settleFolder)
    .sort((left, right) => right.bytes - left.bytes || (left.path < right.path ? -1 : 1))
  return {
    path: node.path,
    bytes: node.own.bytes + children.reduce((total, child) => total + child.bytes, 0),
    files: node.own.files + children.reduce((total, child) => total + child.files, 0),
    children,
  }
}

/** Project one settled tree into the flat rows a folder share carries. */
function flattenFolder(root: SettledFolder): FolderShare {
  const subfolders: FolderShare[] = []
  const walk = (node: SettledFolder): void => {
    for (const child of node.children) {
      subfolders.push({ path: child.path, bytes: child.bytes, files: child.files, parent: node.path })
      walk(child)
    }
  }
  walk(root)
  return {
    path: root.path,
    bytes: root.bytes,
    files: root.files,
    ...(subfolders.length > 0 ? { subfolders } : {}),
  }
}

/**
 * Roll observed entries up into one tree per top-level artifact folder.
 *
 * The row a reader expands is a file manager's level, not a flat list of full
 * paths: a folder shows the directories directly inside it, and each of those can
 * be expanded in turn. Levels the scan never recorded are materialized from their
 * descendants — a directory holding only other directories has no record of its
 * own, because this ledger records a directory for the files written into it —
 * so the tree has no gaps and every row's total covers everything under it.
 * @param records - the scan's records.
 * @param limit - how many top-level folders to report.
 * @param roots - the roots the scan covered, so an outside row keeps its own
 * absolute path instead of being folded by the workspace heuristic.
 * @returns the folder trees, largest first, and how many exist.
 */
export function recordFolders(
  records: readonly (Pick<ObservedEntry, 'display' | 'kind' | 'bytes' | 'files'> & { readonly path?: string })[],
  limit: number,
  roots?: readonly RootShare[],
): { readonly folders: FolderShare[]; readonly total: number } {
  /** Bytes each exact path was recorded with, and the top folder it belongs to. */
  const own = new Map<string, { bytes: number; files: number }>()
  const candidates = new Set<string>()
  /** Absolute root behind each top-level row, so a panel can group by root. */
  const topOwner = new Map<string, string>()

  /** The root an entry was recorded under: the longest root that contains it. */
  const ownerOf = (path: string | undefined): RootShare | undefined => {
    if (path === undefined || roots === undefined) return undefined
    let found: RootShare | undefined
    for (const root of roots) {
      if (!coverPath(root.path, path)) continue
      if (found === undefined || root.path.length > found.path.length) found = root
    }
    return found
  }

  for (const record of records) {
    const owner = ownerOf(record.path)
    const { top, sub } = splitFolder(record, owner)
    const path = sub ?? top
    const cell = own.get(path) ?? { bytes: 0, files: 0 }
    cell.bytes += record.bytes
    cell.files += record.files
    own.set(path, cell)
    candidates.add(top)
    if (owner !== undefined && !topOwner.has(top)) topOwner.set(top, owner.path)
  }

  // A top folder inside another top folder belongs to the outer one: the reader
  // asked for artifacts by module, not for two overlapping rows.
  const tops = [...candidates]
    .filter(candidate => ![...candidates].some(other => other !== candidate && candidate.startsWith(`${other}/`)))
    .sort((left, right) => left.length - right.length || (left < right ? -1 : 1))

  /** The top folder one path belongs to: the longest candidate that contains it. */
  const topOf = (path: string): string | undefined => {
    let found: string | undefined
    for (const candidate of tops) {
      if (path !== candidate && !path.startsWith(`${candidate}/`)) continue
      if (found === undefined || candidate.length > found.length) found = candidate
    }
    return found
  }

  const trees = new Map<string, FolderNode>()
  for (const [path, cell] of own) {
    const top = topOf(path)
    if (top === undefined) continue
    let node = trees.get(top)
    if (node === undefined) {
      node = { path: top, own: { bytes: 0, files: 0 }, children: new Map() }
      trees.set(top, node)
    }
    const root = node
    // Every level between the top and this path exists, whether or not the scan
    // recorded it: that is what makes expanding one row show one level.
    const rest = path === top ? [] : path.slice(top.length + 1).split('/')
    let cursor = root
    let prefix = top
    for (const part of rest) {
      prefix = `${prefix}/${part}`
      let child = cursor.children.get(prefix)
      if (child === undefined) {
        child = { path: prefix, own: { bytes: 0, files: 0 }, children: new Map() }
        cursor.children.set(prefix, child)
      }
      cursor = child
    }
    cursor.own.bytes += cell.bytes
    cursor.own.files += cell.files
  }

  const ranked = [...trees.values()]
    .map((node) => {
      const folder = flattenFolder(settleFolder(node))
      const root = topOwner.get(folder.path)
      return root === undefined ? folder : { ...folder, root }
    })
    .sort((left, right) => right.bytes - left.bytes || (left.path < right.path ? -1 : 1))

  return { folders: limit <= 0 ? [] : ranked.slice(0, limit), total: ranked.length }
}

/**
 * Flatten one folder tree into the report's tab-separated rows.
 *
 * The report text is the wire between the tool and the card that draws it, so a
 * tree travels as rows that name their immediate parent: the card rebuilds the
 * levels from that, and a reader of the raw report sees every directory.
 * @param folder - one top-level folder.
 * @returns its row, then one row per descendant, in depth-first order.
 */
export function folderRows(folder: FolderShare): string[] {
  return [
    `folder\t${folder.bytes}\t${folder.files}\t${folder.path}`,
    ...(folder.subfolders ?? []).map(
      sub => `subfolder\t${sub.bytes}\t${sub.files}\t${sub.path}\t${sub.parent ?? folder.path}`,
    ),
  ]
}

export const name = 'session-artifacts'

/**
 * The report tool needs nothing but `tools`. The panel's open button uses one
 * more surface when the deployment has it — the Host's web server and its
 * request trust fence — and asks for that pair on its own fiber, so a headless
 * profile keeps the tool and simply never grows the route.
 */
export const inject = ['tools']

/** Configuration for the size-only scanner. */
export interface Config {
  maxDirectories: number
  maxRecords: number
  timeoutMs: number
  exclude: string[]
  scanOnTurnEnd: boolean
  recordFolders: number
  /** Most roots one Session may watch, the workspace included. */
  maxRoots: number
  /** Whether tool calls and write intents may add roots of their own. */
  discoverRoots: boolean
  /** Roots registered when the Session starts, for places no tool call names. */
  extraRoots: string[]
}

export const Config: z<Config> = z.object({
  maxDirectories: z.number().default(50_000),
  // Room for one record per changed directory *and* for the levels a newly
  // created tree reports one at a time: a full multi-module build already lands
  // near 200 records, which left a large `target/` no room to be detailed.
  maxRecords: z.number().default(600),
  timeoutMs: z.number().default(5_000),
  exclude: z.array(z.string()).default(['.git', '.hg', '.svn']),
  scanOnTurnEnd: z.boolean().default(true),
  recordFolders: z.number().default(12),
  // A Session that writes outside its workspace usually writes into a handful
  // of places: one scratch tree, one external build directory, one output
  // volume. Eight leaves room for those and keeps the per-turn walk bounded.
  maxRoots: z.number().default(8),
  discoverRoots: z.boolean().default(true),
  extraRoots: z.array(z.string()).default([]),
})

/** POST route naming the path the chosen application receives for one folder. */
export const OPEN_TARGET_PATH = '/session-artifacts/open-target'

/** Browser-relative form of {@link OPEN_TARGET_PATH}, which is what the bundle posts to. */
export const OPEN_TARGET_ROUTE = OPEN_TARGET_PATH.slice(1)

/** Open-target request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * The composition's route table, typed locally for the same reason the trust
 * surface below is: `@deepseek-ai/dsh-host-webserver` is a Host dependency this
 * plugin does not carry, and its service arrives through `ctx.inject`.
 */
interface RouteTable {
  /** Register one exact-path route; returns the disposer that removes it. */
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Trust surface consumed here; the browser-side connection package owns the full type. */
interface RouteConnection {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** JSON response (no-store: the answer depends on the filesystem right now). */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained). */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  // http server streams without setEncoding always yield Buffer chunks.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** Validate one request body at the wire: JSON object with string app/path. */
function parseOpenTargetBody(text: string): { app: string; path: string } | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Swallows the parse error: a non-JSON body is exactly the null case.
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { app, path } = body as { app?: unknown; path?: unknown }
  return typeof app === 'string' && typeof path === 'string' ? { app, path } : null
}

/**
 * Register the open-target route on the Host's web server.
 *
 * The route answers one question for the browser half: given the application a
 * reader chose and a folder they clicked, which path does that application
 * receive? `openTarget.ts` owns the rule; this module owns the wire — the same
 * shape the Host's `open-in-app/open` route applies to its own body (that
 * package publishes no reusable validator, so the two validate independently):
 * the composition's trust fence first, then `application/json`, a 64 KiB
 * ceiling, string fields, and an absolute path.
 *
 * The route launches nothing and reads nothing but the ancestors of the path it
 * is given, so the panel falls back to the clicked path when this route is
 * absent — an older Host build, a headless composition, or a rejected request.
 * @param ctx - the injected child context carrying `webServer` and `connection`.
 */
function registerOpenTargetRoute(ctx: Context): void {
  const webServer = Reflect.get(ctx, 'webServer') as RouteTable
  const connection = Reflect.get(ctx, 'connection') as RouteConnection

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: OPEN_TARGET_PATH,
    handler: async (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      // Body-format validation: the essence must be exactly application/json.
      // String(undefined) is 'undefined', which never matches.
      const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
      if (essence !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text: string | null
      try {
        text = await readBoundedBody(req)
      } catch {
        // Swallows connection errors mid-body: there is nothing left to answer precisely.
        sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
        return
      }
      const parsed = parseOpenTargetBody(text)
      if (parsed === null) {
        sendJson(res, 400, { code: 'bad-request', message: 'request body must be JSON with string "app" and "path"' })
        return
      }
      if (parsed.path === '' || !isAbsolute(parsed.path)) {
        sendJson(res, 400, { code: 'bad-request', message: 'path must be an absolute path' })
        return
      }
      sendJson(res, 200, { path: await resolveOpenTarget(parsed.app, parsed.path) })
    },
  }), `session-artifacts: POST ${OPEN_TARGET_PATH}`)
}

/** One directory the Session's artifacts live in, whether or not it is the workspace. */
interface RootState {
  readonly path: string
  readonly origin: RootOrigin
  /**
   * Strict attribution: every file the scan counts must have been written after
   * {@link since}. A root discovered mid-Session has no baseline that predates
   * the Session, so its listing cannot tell old files from new ones.
   */
  readonly strict: boolean
  /** Oldest write that counts for a strict root, epoch milliseconds. */
  readonly since: number
  /** The walk taken when the root was registered; `undefined` when unreadable. */
  readonly baseline: Promise<InventoryBaseline | undefined>
}

interface SessionState {
  root: string
  /**
   * The workspace root with symlinks resolved, in flight or finished.
   *
   * `header.cwd` may name a symlinked path (`/var/...` on macOS); entries the
   * filesystem reports are canonical, so containment against the raw path would
   * miss every one of them and register the workspace's own files a second time.
   */
  readonly canonicalRoot: Promise<string>
  /**
   * Every root the Session watches, the workspace included, by canonical path.
   *
   * A map rather than one baseline because a Session writes outside its
   * workspace too, and the paths it names change from turn to turn: `cd
   * /tmp/exp` today, `/var/tmp/build` tomorrow.
   */
  roots: Map<string, RootState>
  /**
   * When the previous turn ended, epoch milliseconds: the watermark that decides
   * which of the current scan's records this turn wrote.
   *
   * It starts as the Session's own start, so the first turn is measured from
   * there rather than from its own end.
   */
  since: number
  /** When the Session was first seen; a late root attributes writes from here. */
  readonly startedAt: number
  scan: ArtifactScan | undefined
  scanning: boolean
  /** Roots the root bound refused, so the report can say the scan was partial. */
  limitedRoots: number
}

/** Register the scanner, lifecycle hooks, and the ledger's tools. */
export function apply(ctx: Context, config: Config): void {
  const sessions = new Map<Session, SessionState>()
  /** Every known Session by id, so a delegate's roots can be folded into its parent's. */
  const sessionsById = new Map<string, Session>()
  const bounds: ScanBounds = {
    maxDirectories: config.maxDirectories,
    maxRecords: config.maxRecords,
    timeoutMs: config.timeoutMs,
    exclude: config.exclude,
  }

  /**
   * Register one root, unless it is covered, forbidden, or over the bound.
   *
   * Every refusal is a return rather than a throw: a tool call that names a path
   * this ledger cannot use must not fail the tool.
   * @param state - the Session that named the path.
   * @param candidate - the named path.
   * @returns the canonical root path once registered, or the covering root.
   */
  const registerRoot = async (state: SessionState, candidate: RootCandidate): Promise<string | undefined> => {
    try {
      if (candidate.origin !== 'workspace' && !config.discoverRoots
        && candidate.origin !== 'declared' && candidate.origin !== 'configured') return undefined
      const target = await rootPathFor(candidate)
      const canonical = await canonicalize(target)
      if (canonical === undefined || !isAbsolute(canonical)) return undefined
      if (state.roots.has(canonical)) return canonical
      if (isForbiddenRoot(canonical)) return undefined
      // An ancestor of the workspace would count the workspace twice, and a path
      // inside it is already what the workspace scan measures. Both comparisons
      // use the canonical workspace, because the filesystem reports canonical
      // paths even when `header.cwd` names a symlink.
      const workspace = await state.canonicalRoot
      if (coverPath(canonical, workspace)) return undefined
      if (coverPath(workspace, canonical)) return state.root
      if (state.roots.size >= config.maxRoots) {
        state.limitedRoots += 1
        return undefined
      }
      for (const [path, root] of [...state.roots]) {
        if (root.origin === 'workspace') continue
        if (coverPath(path, canonical)) return path
        // A new outer root supersedes an inner one.
        if (coverPath(canonical, path)) state.roots.delete(path)
      }
      state.roots.set(canonical, {
        path: canonical,
        origin: candidate.origin,
        strict: true,
        since: state.startedAt,
        baseline: takeBaseline(canonical, bounds).then(result => result.baseline, () => undefined),
      })
      return canonical
    } catch {
      // A path the filesystem refuses is not a root; the scan is unaffected.
      return undefined
    }
  }

  /**
   * Start the Session's roots, once.
   *
   * Synchronous and throw-free on purpose: it is also the `session/created`
   * listener, and a synchronous throw there vetoes the Session's publication.
   * Whatever a walk hits is carried inside its promise.
   * @param session - the Session to baseline.
   * @returns the Session's scan state, or undefined when it has no workspace.
   */
  const ensure = (session: Session): SessionState | undefined => {
    const cwd = session.header.cwd
    if (cwd === undefined) return undefined
    const existing = sessions.get(session)
    if (existing !== undefined) return existing
    const startedAt = Date.now()
    const state: SessionState = {
      root: cwd,
      canonicalRoot: canonicalize(cwd).then(value => value ?? cwd, () => cwd),
      roots: new Map(),
      // The Session starts now, so the first turn is measured from here: files
      // written before the plugin ever saw the Session are the baseline's, not
      // the first turn's.
      since: startedAt,
      startedAt,
      scan: undefined,
      scanning: false,
      limitedRoots: 0,
    }
    state.roots.set(cwd, {
      path: cwd,
      origin: 'workspace',
      strict: false,
      since: startedAt,
      baseline: takeBaseline(cwd, bounds).then(result => result.baseline, () => undefined),
    })
    sessions.set(session, state)
    sessionsById.set(session.id, session)
    for (const extra of config.extraRoots) {
      if (isAbsolute(extra)) void registerRoot(state, { path: extra, kind: 'directory', origin: 'configured' })
    }
    return state
  }

  /** Fold one call's named paths into its Session's roots. */
  const discover = (session: Session | undefined, candidates: readonly RootCandidate[]): void => {
    if (session === undefined || candidates.length === 0) return
    const state = ensure(session)
    if (state === undefined) return
    for (const candidate of candidates) void registerRoot(state, candidate)
  }

  /**
   * The Sessions delegated from one Session.
   *
   * A delegate's artifacts are the parent's: the reader asked what this Session
   * produced, and a subagent is how this Session produced it.
   */
  const descendants = (session: Session): Session[] => {
    const found: Session[] = []
    for (const candidate of sessionsById.values()) {
      if (candidate === session) continue
      let cursor: Session | undefined = candidate
      for (let depth = 0; depth < 8 && cursor !== undefined; depth += 1) {
        const parentId = cursor.header.parentSession
        if (parentId === undefined) break
        const parent = sessionsById.get(parentId)
        if (parent === undefined) break
        if (parent === session) {
          found.push(candidate)
          break
        }
        cursor = parent
      }
    }
    return found
  }

  /** Every root of a Session and its delegates, deduplicated by canonical path. */
  const familyRoots = (session: Session): { root: RootState; owner: Session }[] => {
    const seen = new Set<string>()
    const roots: { root: RootState; owner: Session }[] = []
    for (const member of [session, ...descendants(session)]) {
      const state = ensure(member)
      if (state === undefined) continue
      for (const root of state.roots.values()) {
        if (seen.has(root.path)) continue
        seen.add(root.path)
        roots.push({ root, owner: member })
      }
    }
    return roots
  }

  /** One coverage reading for a scan that walked several roots. */
  const mergeCoverage = (parts: readonly ScanCoverage[], limitedRoots: number): ScanCoverage => {
    const rootBound: ScanTruncation | undefined = limitedRoots > 0
      ? { reason: 'maxRoots', limit: config.maxRoots, observed: config.maxRoots + limitedRoots }
      : undefined
    const truncating = parts.find(part => part.truncated)
    const truncation = rootBound ?? truncating?.truncation
    return {
      directoriesVisited: parts.reduce((total, part) => total + part.directoriesVisited, 0),
      truncated: truncation !== undefined,
      ...(truncation === undefined ? {} : { truncation }),
      recordsObserved: parts.reduce((total, part) => total + (part.recordsObserved ?? 0), 0),
      elapsedMs: parts.reduce((total, part) => total + part.elapsedMs, 0),
      baseline: false,
    }
  }

  const runScan = async (
    session: Session,
    turn: number | null,
    advance = true,
  ): Promise<ArtifactScan | undefined> => {
    const state = ensure(session)
    if (state === undefined) return undefined
    if (state.scanning) return state.scan
    state.scanning = true
    // The watermark is read before the walk: everything the walk reports as
    // written at or after it belongs to the turn being recorded now.
    const since = state.since
    try {
      const entries: ObservedEntry[] = []
      const shares: RootShare[] = []
      const coverages: ScanCoverage[] = []
      let workspaceBytes = 0
      for (const { root, owner } of familyRoots(session)) {
        const baseline = await root.baseline
        if (baseline === undefined) continue
        // Only this Session's own workspace reads as the workspace; a delegate's
        // workspace is another root, and its rows carry its absolute path.
        const ownWorkspace = owner === session && root.origin === 'workspace'
        const displayPrefix = root.origin === 'workspace' && ownWorkspace ? '' : root.path
        const result = await scanWorkspace(baseline, bounds, {
          displayPrefix,
          ...(root.strict ? { since: root.since } : {}),
        })
        entries.push(...result.entries)
        coverages.push(result.coverage)
        const bytes = result.entries.reduce((total, entry) => total + entry.bytes, 0)
        const files = result.entries.reduce((total, entry) => total + entry.files, 0)
        shares.push({ path: root.path, label: displayPrefix, origin: root.origin, bytes, files })
        if (ownWorkspace) workspaceBytes += bytes
      }
      // This turn's own records, and the folders they belong to: the per-message
      // reading opens that list, so it has to be the turn's and not the footprint's.
      const written = turnEntries(entries, since)
      const turnShares = recordFolders(written, config.recordFolders, shares)
      const scan: ArtifactScan = {
        sessionId: session.id,
        turn,
        root: state.root,
        records: entries,
        bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        turnBytes: written.reduce((total, entry) => total + entry.bytes, 0),
        turnFolders: turnShares.folders,
        turnFoldersTotal: turnShares.total,
        coverage: mergeCoverage(coverages, state.limitedRoots),
        ...(shares.length > 1 ? { roots: shares, workspaceBytes } : {}),
      }
      state.scan = scan
      if (advance) state.since = Date.now()
      return scan
    } finally {
      state.scanning = false
    }
  }

  const recordScan = (session: Session, turn: number): void => {
    void runScan(session, turn).then((scan) => {
      if (scan === undefined) return
      appendRecord(session, 'plugin:session-artifacts/scan', scanRecordData(scan, config.recordFolders))
    }).catch(() => {
      // A failed scan leaves the previous record in place; the next turn retries.
    })
  }

  // The baseline has to predate the Session's first turn. Taken lazily at the
  // first turn's end, it already contained that turn's own build, so a Session
  // whose first turn built a module reported 0 B — the same reading as one that
  // built nothing. Announcing is the earliest a Session is visible here at all;
  // a turn start covers the plugin mounted (or reloaded) after that
  // announcement. The walk itself is asynchronous and unbounded in wall clock by
  // the turn, so a build started inside its window would land in the baseline;
  // the window is the walk's own cost (tens to hundreds of ms) and a turn's
  // first tool call comes seconds later, and `runScan` waits on the walk rather
  // than skipping the turn.
  ctx.on('session/created', (session) => {
    ensure(session)
  })

  ctx.on('session/event', (session, event) => {
    // A mid-Session `cd` moves the place later writes land, so it is a root in
    // its own right; the old working directory keeps its roots too.
    const changed = event as unknown as { type: string; data?: { cwd?: unknown } }
    if (changed.type === 'working-directory/change' && typeof changed.data?.cwd === 'string') {
      const state = ensure(session)
      if (state !== undefined) {
        void registerRoot(state, { path: changed.data.cwd, kind: 'directory', origin: 'working-directory' })
      }
      return
    }
    if (event.type === 'turn/start') {
      ensure(session)
      return
    }
    if (event.type === 'turn/end' && config.scanOnTurnEnd) recordScan(session, event.data.turn)
  })

  // A path a tool call names is where this Session may write next: `cd`, an
  // output flag, a redirection, or a file tool's target. The listener only
  // records and forwards the call; a path it cannot use is dropped.
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const session = exec.agent?.session
      discover(session, toolCandidates(exec.name, exec.arguments, session?.header.cwd ?? process.cwd()))
    } catch {
      // Harvesting never decides whether a tool call runs.
    }
    return next()
  })

  // Write intents are the one precise source: they carry the resolved target of
  // every file the filesystem seam mutates, wherever that file lives. The fiber
  // is optional, so a composition without a filesystem keeps both tools.
  ctx.inject(['fs'], (fsCtx: Context) => {
    const fs = Reflect.get(fsCtx, 'fs') as { processPath(target: unknown): string } | undefined
    const listen = Reflect.get(fsCtx, 'on') as
      | ((event: string, handler: (...args: never[]) => unknown) => unknown)
      | undefined
    if (fs === undefined || listen === undefined) return
    const handle = async (target: unknown, actor: unknown, next: () => Promise<unknown>): Promise<unknown> => {
      const decision = await next()
      try {
        const session = (actor as { agent?: { session?: Session } } | undefined)?.agent?.session
        if (session !== undefined) {
          const path = fs.processPath(target)
          if (isAbsolute(path)) discover(session, [{ path, kind: 'file', origin: 'fs-intent' }])
        }
      } catch {
        // A target this ledger cannot map is not a root; the write goes ahead.
      }
      return decision
    }
    for (const event of ['fs/write-intent', 'fs/edit-intent', 'fs/delete-intent']) {
      listen.call(fsCtx, event, handle)
    }
  })

  ctx.on('session/disposed', (session) => {
    sessions.delete(session)
    sessionsById.delete(session.id)
  })

  ctx.effect(() => () => {
    sessions.clear()
    sessionsById.clear()
  })

  // The panel's open button asks this route which path the chosen application
  // receives, so an IDE that already holds the clicked folder's project reuses
  // its window (see `openTarget.ts`). It rides on its own fiber: a composition
  // with no web server keeps the report tool and never grows the route, and the
  // browser half falls back to the clicked path.
  ctx.inject(['webServer', 'connection'], (routeCtx: Context) => {
    registerOpenTargetRoute(routeCtx)
  })

  ctx.tools.register(defineTool({
    name: 'session_artifacts_report',
    description: 'Report how much space this Session left in its workspace, grouped by folder. '
      + 'It returns measurements only: total bytes, folder paths, and file counts. '
      + 'The report never changes any file.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          /** The workspace's own share, when the scan covered roots outside it. */
          workspaceBytes: { type: 'integer' },
          /** Every root the scan covered, present only beside `workspaceBytes`. */
          roots: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                origin: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                files: { type: 'integer', required: true },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
          truncation: {
            type: 'object', additionalProperties: false,
            properties: {
              reason: { type: 'string', required: true },
              limit: { type: 'integer', required: true },
              observed: { type: 'integer', required: true },
            },
          },
          foldersTotal: { type: 'integer', required: true },
          folders: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                files: { type: 'integer', required: true },
                subfolders: {
                  type: 'array',
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      path: { type: 'string', required: true },
                      bytes: { type: 'integer', required: true },
                      files: { type: 'integer', required: true },
                      parent: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        // The schema carries the reason as free text; narrow it back to the
        // closed union before naming the bound in copy.
        const truncation = value.truncation === undefined ? undefined : boundOf(value.truncation)
        return [{
          type: 'text',
          text: [
            ...(truncation === undefined
              ? (value.truncated ? ['The scan stopped at a configured bound, so this list is partial.'] : [])
              : [truncationSentence(truncation), truncationRow(truncation)]),
            `${value.folders.length} folders, ${value.bytes} bytes`,
            ...(value.workspaceBytes === undefined ? [] : [`split\t${value.workspaceBytes}\t${value.bytes}`]),
            ...(value.root ? [`root\t${value.root}`] : []),
            ...(recordCapability(dshSessionModule) ? [] : [NO_RECORD_API]),
            ...value.folders.flatMap(folder => folderRows(folder)),
          ].join('\n'),
        }]
      },
    },
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('session_artifacts_report needs an agent Session')
      const session = exec.agent.session
      const state = ensure(session)
      if (state === undefined) throw new Error('this Session has no workspace directory to scan')
      const scan = await runScan(session, null)
      if (scan === undefined) throw new Error('this Session has no workspace directory to scan')
      const { folders, total: foldersTotal } = recordFolders(scan.records, config.maxRecords, scan.roots)
      return {
        root: scan.root,
        bytes: scan.bytes,
        ...(scan.workspaceBytes === undefined ? {} : { workspaceBytes: scan.workspaceBytes }),
        truncated: scan.coverage.truncated,
        ...(scan.coverage.truncation === undefined ? {} : { truncation: scan.coverage.truncation }),
        foldersTotal,
        folders,
        ...(scan.roots === undefined ? {} : {
          roots: scan.roots.map(({ path, origin, bytes, files }) => ({ path, origin, bytes, files })),
        }),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'session_artifacts_watch',
    description: 'Start counting a directory as an artifact root of this Session, even outside the workspace, '
      + 'so what this Session writes under it is reported by session_artifacts_report. '
      + 'Use it when you already know where output will land. It measures only and never changes a file.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path, or one relative to the workspace root.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          counted: { type: 'boolean', required: true },
          bytes: { type: 'integer', required: true },
          files: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.counted ? 'Watching' : 'Cannot watch'} ${value.path}: ${value.bytes} bytes, ${value.files} files`,
      }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('session_artifacts_watch needs an agent Session')
      const session = exec.agent.session
      const state = ensure(session)
      if (state === undefined) throw new Error('this Session has no workspace directory to scan')
      const path = isAbsolute(args.path) ? args.path : resolve(state.root, args.path)
      const canonical = await registerRoot(state, { path, kind: 'directory', origin: 'declared' })
      // A declaration is not the end of a turn: the reading is recorded without
      // moving the watermark the turn card measures from.
      const scan = await runScan(session, null, false)
      const share = scan?.roots?.find(root => root.path === canonical)
      return {
        path: canonical ?? path,
        counted: canonical !== undefined,
        bytes: share?.bytes ?? 0,
        files: share?.files ?? 0,
      }
    },
  }))
}
