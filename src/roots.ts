/**
 * Artifact roots outside the workspace: which paths a Session's own tool calls
 * name, and which of them may become a root.
 *
 * The ledger cannot see every write a Session causes — a user-space plugin only
 * has the filesystem and the Session's own events. What it can do is read the
 * write paths the Session itself named (`cd`, output flags, redirections, file
 * tools) and the filesystem seam's write intents, then watch those roots. The
 * rejection rules here are what keep one hallucinated path from turning a turn
 * into a whole-home walk.
 * @module dsh-session-artifacts/roots
 */

import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Where one root came from; the report names it so a reader can judge the row. */
export type RootOrigin =
  | 'workspace'
  | 'working-directory'
  | 'tool-argument'
  | 'fs-intent'
  | 'declared'
  | 'configured'

/** One path a Session named, before the filesystem says what it is. */
export interface RootCandidate {
  /** Absolute path as named; canonicalization happens at registration. */
  readonly path: string
  /**
   * How to read the path: a directory the Session writes into, or a file it
   * writes. A file's root is its parent; a directory's root is itself, even
   * before it exists — that is the pending case, and taking the parent instead
   * would turn `mkdir -p /tmp/exp` into a scan of all of `/tmp`.
   */
  readonly kind: 'directory' | 'file'
  readonly origin: RootOrigin
}

/** System trees that are never one Session's artifact, whatever a command names. */
const SYSTEM_PREFIXES = [
  '/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/dev',
  '/opt/homebrew', '/private/etc', '/private/var/db', '/private/var/root', '/private/var/log',
] as const

/** Devices and streams that look like paths but hold no artifact. */
const DEVICE_PATHS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])

/** Commands whose own operands name a place something is written. */
const WRITE_COMMANDS = new Set(['cd', 'pushd', 'mkdir', 'install', 'mktemp', 'cp', 'mv', 'ln', 'rsync', 'tar'])

/**
 * Commands that write somewhere of their own choosing.
 *
 * Their output directory is a build system's default and is not always named,
 * but the paths they do name (`--manifest-path`, a script argument, a config
 * file) locate the tree that output lands in — and that tree is the root a
 * reader wants. The bare absolute paths on their command line are therefore
 * collected, while a pure reader (`cat`, `grep`) still contributes nothing.
 */
const BUILD_COMMANDS = new Set([
  'go', 'cargo', 'rustc', 'make', 'cmake', 'npm', 'pnpm', 'yarn', 'mvn', 'gradle', 'gradlew',
  'python', 'python3', 'node', 'deno', 'bun', 'docker', 'gcc', 'g++', 'clang', 'cc', 'javac', 'dotnet',
])

/** Flags whose value is a directory the command writes into. */
const DIRECTORY_FLAGS = new Set([
  '--target-dir', '--out-dir', '--output-dir', '--prefix', '--root', '-t',
])

/** Flags whose value is a file the command produces. */
const FILE_FLAGS = new Set(['-o', '--output', '--out', '--dest', '--destination'])

/** Redirect operators; the token after one is the file it writes. */
const REDIRECT = /(?:^|\s)(?:\d?>>?|&>)\s*([^\s;&|]+)/gu

/** Split a command into the segments a shell would run one after another. */
function segments(command: string): string[] {
  return command.split(/&&|\|\||[;|\n]/u).map(segment => segment.trim()).filter(segment => segment !== '')
}

/**
 * Split one segment into shell words, keeping quoted paths in one piece.
 * Operators become their own words so an operand scan never mistakes `>` or
 * `&&` for a path.
 */
function tokenize(segment: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  const flush = (): void => {
    if (current !== '') {
      words.push(current)
      current = ''
    }
  }
  for (const char of segment) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ' ' || char === '\t') {
      flush()
      continue
    }
    if ('&|;()<>'.includes(char)) {
      flush()
      words.push(char)
      continue
    }
    current += char
  }
  flush()
  return words
}

/**
 * Expand one named path to an absolute one, or refuse it.
 *
 * Variable and glob references are refused rather than guessed: `$TMPDIR/x`
 * names a different directory per process, and a guessed root would be a wrong
 * reading dressed as a measurement.
 */
function expandPath(value: string, cwd: string, home: string): string | undefined {
  if (value === '' || value === '.' || value === '..') return undefined
  if (value.startsWith('-') || value.startsWith('&') || value.startsWith('<') || value.startsWith('>')) return undefined
  if (value.includes('$') || value.includes('`') || /[*?[\]{}]/u.test(value)) return undefined
  if (value.includes('XXXX')) return undefined
  let expanded = value
  if (expanded === '~') expanded = home
  else if (expanded.startsWith('~/')) expanded = join(home, expanded.slice(2))
  if (DEVICE_PATHS.has(expanded)) return undefined
  if (isAbsolute(expanded)) return expanded
  return resolve(cwd, expanded)
}

/** The last operand of a copy-like command: where the files land. */
function lastOperand(words: readonly string[]): string | undefined {
  for (let index = words.length - 1; index > 0; index -= 1) {
    const word = words[index]
    if (word === undefined || word.startsWith('-') || '&|;()<>'.includes(word)) continue
    return word
  }
  return undefined
}

/**
 * The write paths one shell command names.
 *
 * Only write contexts are read. `cat /etc/hosts` names an absolute path too, but
 * nothing in it writes, and treating every path a command mentions as a root
 * would drag the system into every turn's scan. A line that does write still
 * contributes its bare absolute paths, which is how `go build -o /tmp/exp/app`
 * and `RUST_LOG=debug cargo run` land on the same root.
 * @param command - the shell command text.
 * @param cwd - the directory the command runs in.
 * @param home - home directory, for `~` expansion.
 * @returns the candidate roots the command names.
 */
export function commandCandidates(command: string, cwd: string, home: string = homedir()): RootCandidate[] {
  const candidates: RootCandidate[] = []
  const add = (value: string | undefined, kind: 'directory' | 'file'): void => {
    if (value === undefined) return
    const absolute = expandPath(value, cwd, home)
    if (absolute === undefined) return
    candidates.push({ path: absolute, kind, origin: 'tool-argument' })
  }

  for (const segment of segments(command)) {
    const words = tokenize(segment)
    if (words.length === 0) continue
    const commandName = basename(words[0] ?? '')
    let writes = WRITE_COMMANDS.has(commandName) || BUILD_COMMANDS.has(commandName)

    for (let index = 0; index < words.length; index += 1) {
      const raw = words[index]
      if (raw === undefined) continue
      // `--target-dir=/tmp/x` names its value inside the same word; splitting on
      // the original spelling keeps the value's case intact.
      const equals = raw.indexOf('=')
      if (equals > 0) {
        const flag = raw.slice(0, equals).toLowerCase()
        const value = raw.slice(equals + 1)
        if (DIRECTORY_FLAGS.has(flag)) {
          add(value, 'directory')
          writes = true
        } else if (FILE_FLAGS.has(flag)) {
          add(value, 'file')
          writes = true
        }
        continue
      }
      const word = raw.toLowerCase()
      if (DIRECTORY_FLAGS.has(word)) {
        add(words[index + 1], 'directory')
        writes = true
      } else if (FILE_FLAGS.has(word)) {
        add(words[index + 1], 'file')
        writes = true
      }
    }
    for (const match of segment.matchAll(REDIRECT)) {
      add(match[1], 'file')
      writes = true
    }

    if (commandName === 'cd' || commandName === 'pushd') {
      add(words[1], 'directory')
    } else if (commandName === 'mkdir') {
      for (const word of words.slice(1)) add(word, 'directory')
    } else if (commandName === 'install') {
      const flag = words.indexOf('-d')
      if (flag !== -1) for (const word of words.slice(flag + 1)) add(word, 'directory')
    } else if (commandName === 'mktemp') {
      for (const word of words.slice(1)) if (word.includes('/')) add(word, 'directory')
    } else if (commandName === 'tar') {
      const flag = words.indexOf('-C')
      if (flag !== -1) add(words[flag + 1], 'directory')
    } else if (commandName === 'cp' || commandName === 'mv' || commandName === 'ln' || commandName === 'rsync') {
      // The destination may be a file or a directory; either way it is the place
      // this Session writes, and `rootPathFor` settles which it is.
      add(lastOperand(words), 'directory')
    }

    if (writes) {
      for (const word of words) {
        if (word.startsWith('/') || word.startsWith('~/')) add(word, 'directory')
      }
    }
  }
  return dedupe(candidates)
}

/** Read one property off an unknown tool-arguments value. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * The write paths one tool call names, by tool name.
 *
 * The filesystem tools' paths are exact; the shell tools' are read from their
 * command text; everything else contributes nothing rather than a guess.
 * @param name - the tool name the model called.
 * @param args - the call's parsed arguments.
 * @param cwd - the directory relative paths resolve against.
 * @param home - home directory, for `~` expansion.
 * @returns the candidate roots the call names.
 */
export function toolCandidates(
  name: string,
  args: unknown,
  cwd: string,
  home: string = homedir(),
): RootCandidate[] {
  const record = asRecord(args)
  if (record === undefined) return []
  const candidates: RootCandidate[] = []
  const add = (value: unknown, kind: 'directory' | 'file', origin: RootOrigin = 'tool-argument'): void => {
    if (typeof value !== 'string' || value.trim() === '') return
    const absolute = expandPath(value, cwd, home)
    if (absolute === undefined) return
    candidates.push({ path: absolute, kind, origin })
  }

  switch (name) {
    case 'write':
    case 'edit':
    case 'str_replace_editor':
      add(record['file_path'], 'file')
      add(record['filePath'], 'file')
      add(record['path'], 'file')
      break
    case 'present': {
      add(record['path'], 'file')
      for (const key of ['paths', 'files']) {
        const list = record[key]
        if (!Array.isArray(list)) continue
        for (const item of list) {
          if (typeof item === 'string') add(item, 'file')
          else if (asRecord(item) !== undefined) add(asRecord(item)?.['path'], 'file')
        }
      }
      break
    }
    case 'working_directory':
      add(record['cd'], 'directory', 'working-directory')
      break
    case 'bash':
    case 'pwsh': {
      const workdir = typeof record['workdir'] === 'string'
        ? expandPath(record['workdir'], cwd, home)
        : undefined
      if (workdir !== undefined) candidates.push({ path: workdir, kind: 'directory', origin: 'tool-argument' })
      if (typeof record['command'] === 'string') {
        candidates.push(...commandCandidates(record['command'], workdir ?? cwd, home))
      }
      break
    }
    default:
      break
  }
  return dedupe(candidates)
}

/** The same path named twice by one call is one candidate. */
function dedupe(candidates: readonly RootCandidate[]): RootCandidate[] {
  const seen = new Set<string>()
  const unique: RootCandidate[] = []
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.path}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(candidate)
  }
  return unique
}

/** Whether `outer` is `inner` or a directory above it. */
export function coverPath(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer}${sep}`)
}

/**
 * Whether a path may never be an artifact root.
 *
 * The volume root, the home directory and its ancestors, and the system trees
 * are all rejected: a root is a place one Session wrote into, and these are
 * places the machine and every other process wrote into.
 * @param path - a canonical absolute path.
 * @param home - the home directory to keep off limits.
 * @returns true when the path must not be registered.
 */
export function isForbiddenRoot(path: string, home: string = homedir()): boolean {
  const compact = path.length > 1 ? path.replace(/\/+$/u, '') : path
  if (compact === '/' || compact === '') return true
  if (compact === home || coverPath(compact, home)) return true
  for (const prefix of SYSTEM_PREFIXES) {
    if (compact === prefix || compact.startsWith(`${prefix}${sep}`)) return true
  }
  // `/private/tmp` is the volume's shared scratch space; a root has to name
  // something narrower than a directory every process on the machine shares.
  return compact.split(sep).filter(part => part !== '').length < 3
}

/**
 * Resolve a symlinked path, keeping the part that does not exist yet.
 *
 * `/tmp` is a symlink to `/private/tmp` on macOS, so a pending `/tmp/exp` and a
 * later `/private/tmp/exp` must be the same root — but the path may not exist
 * yet, which `realpath` refuses. Canonicalizing the deepest existing ancestor
 * and re-appending the rest keeps both identities one.
 * @param path - an absolute path, existing or not.
 * @returns the canonical path, or undefined when no ancestor resolves.
 */
export async function canonicalize(path: string): Promise<string | undefined> {
  let current = path
  const missing: string[] = []
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const real = await realpath(current)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      missing.push(basename(current))
      current = parent
    }
  }
  return undefined
}

/**
 * Turn one candidate into the directory to watch.
 *
 * A file's root is its parent. A directory's root is itself: if it does not
 * exist yet it stays the pending root, because watching its parent would count
 * every unrelated file that shares the parent.
 * @param candidate - one named path.
 * @returns the directory to watch.
 */
export async function rootPathFor(candidate: RootCandidate): Promise<string> {
  const path = resolve(candidate.path)
  try {
    const info = await stat(path)
    return info.isDirectory() ? path : dirname(path)
  } catch {
    return candidate.kind === 'directory' ? path : dirname(path)
  }
}
