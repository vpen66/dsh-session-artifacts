/**
 * Open-target resolution: which path a clicked folder hands to the application
 * the reader chose.
 *
 * Most applications open a folder as a folder, so the clicked folder is exactly
 * the right thing to hand over — Finder raises its own window, and a new window
 * there is the expected result. The IntelliJ-platform IDEs are the exception:
 * they open a directory as a *project*, so handing one `artisan/target` asks for
 * a new project window built from a build-output directory, even when the IDE
 * already holds the project that directory belongs to. For those applications
 * the folder's project root is the honest target: an IDE already holding that
 * project reuses and raises its existing window, and one that does not still
 * opens the right project instead of a junk one.
 *
 * The project root is the nearest directory at or above the clicked path that
 * holds a populated `.idea` directory — the marker the IntelliJ platform writes
 * into its project directories. The home directory and the filesystem root are
 * never candidates: a marker there is not a project anyone asked to open.
 * @module dsh-session-artifacts/open-target
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Catalog ids whose launcher opens a directory as an IntelliJ-platform project.
 *
 * These are the chosen-application ids of the Host's `open-in-app` catalog; a
 * deployment that renames them simply stops rerouting rather than misrouting.
 */
export const JETBRAINS_APPLICATION_IDS: readonly string[] = [
  'intellij',
  'pycharm',
  'webstorm',
  'phpstorm',
  'goland',
  'rider',
  'rustrover',
  'androidstudio',
]

/** Project-directory marker the IntelliJ platform writes. */
const PROJECT_MARKER = '.idea'

/** Filesystem facts the resolver needs; a test supplies its own. */
export interface OpenTargetProbe {
  /** Whether the path names a directory. */
  isDirectory(path: string): Promise<boolean>
  /** Whether the directory holds at least one entry. */
  hasEntries(path: string): Promise<boolean>
}

/** The Host's own filesystem, which is the only probe production uses. */
const hostProbe: OpenTargetProbe = {
  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      // Swallows ENOENT/ENOTDIR/EACCES: none of them is a directory to inspect.
      return false
    }
  },
  async hasEntries(path: string): Promise<boolean> {
    try {
      return (await readdir(path)).length > 0
    } catch {
      // Swallows an unreadable marker: a project this process cannot read is
      // not evidence of a project, so the walk keeps looking upward.
      return false
    }
  },
}

/**
 * Whether one directory holds a populated IntelliJ project marker.
 *
 * An empty `.idea` proves no project: the platform writes its settings files
 * into the directory as it initializes one, and a bare directory of that name
 * is left behind by enough unrelated tooling that treating it as a project
 * would reroute a reader's click away from the folder they picked.
 * @param directory - candidate project directory.
 * @param probe - filesystem facts.
 * @returns true when the marker directory exists and holds something.
 */
async function holdsProject(directory: string, probe: OpenTargetProbe): Promise<boolean> {
  const marker = join(directory, PROJECT_MARKER)
  return await probe.isDirectory(marker) && await probe.hasEntries(marker)
}

/**
 * The path the chosen application receives for one clicked folder.
 *
 * The returned path is always absolute and normalized; it is the clicked path
 * itself unless the chosen application is an IntelliJ-platform IDE and an
 * ancestor of that path is an IntelliJ project.
 * @param app - chosen application id (the header's remembered `open-in-app` choice).
 * @param path - absolute folder or file the reader clicked.
 * @param probe - filesystem facts; production omits it and gets the real filesystem.
 * @param home - home directory, which never counts as a project root.
 * @returns the absolute path to hand to the Host's open endpoint.
 */
export async function resolveOpenTarget(
  app: string,
  path: string,
  probe: OpenTargetProbe = hostProbe,
  home: string = homedir(),
): Promise<string> {
  const target = resolve(path)
  if (!JETBRAINS_APPLICATION_IDS.includes(app)) return target

  let candidate = target
  while (candidate !== home) {
    const parent = dirname(candidate)
    // The filesystem root is no candidate either: reaching it ends the walk.
    if (parent === candidate) break
    if (await holdsProject(candidate, probe)) return candidate
    candidate = parent
  }
  return target
}
