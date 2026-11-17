/**
 * Open-target checks: which path a clicked folder hands to the chosen
 * application.
 *
 * The rule exists because the IntelliJ-platform IDEs open a directory as a
 * project. Handing one `artisan/target` asks for a project window built from a
 * build-output directory, even while the IDE already holds the project that
 * directory belongs to; handing it the project root raises the window that is
 * already there. Finder and every application that opens a folder as a folder
 * keep the clicked path — a new window there is the expected result.
 * @module dsh-session-artifacts/tests/open-target.test
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  JETBRAINS_APPLICATION_IDS, resolveOpenTarget, type OpenTargetProbe,
} from '../lib/openTarget.js'

/**
 * A probe over an explicit tree: directories that exist, and `.idea` markers
 * with the number of entries each holds.
 * @param markers - marker directory path to its entry count; zero is an empty marker.
 * @param directories - every directory the probe treats as existing.
 * @returns the probe.
 */
function markerProbe(
  markers: Readonly<Record<string, number>>,
  directories: readonly string[],
): OpenTargetProbe {
  const known = new Set(directories)
  return {
    isDirectory: async (path: string) => Object.hasOwn(markers, path) || known.has(path),
    hasEntries: async (path: string) => (markers[path] ?? 0) > 0,
  }
}

test('an application that opens a folder as a folder keeps the clicked path', async () => {
  // Finder, VS Code, a terminal: the clicked folder is the target, and a new
  // window is what a reader expects from it.
  const probe = markerProbe({ '/ws/project/.idea': 3 }, ['/ws', '/ws/project'])
  for (const app of ['finder', 'vscode', 'terminal', '']) {
    assert.equal(
      await resolveOpenTarget(app, '/ws/project/target', probe, '/Users/nobody'),
      '/ws/project/target',
    )
  }
})

test('an IntelliJ IDE receives the project root that holds the clicked folder', async () => {
  // The case this rule exists for: the IDE already has `/ws/project` open, so
  // asking it to open `/ws/project/target` builds a second, junk project
  // window instead of raising the window the reader wants.
  const probe = markerProbe({ '/ws/project/.idea': 3 }, ['/ws', '/ws/project'])
  for (const app of JETBRAINS_APPLICATION_IDS) {
    assert.equal(await resolveOpenTarget(app, '/ws/project/target', probe, '/Users/nobody'), '/ws/project')
  }
  // A nested folder walks up more than one level, and a file starts from its parent.
  assert.equal(
    await resolveOpenTarget('intellij', '/ws/project/core/target/classes', probe, '/Users/nobody'),
    '/ws/project',
  )
  assert.equal(await resolveOpenTarget('intellij', '/ws/project/notes.txt', probe, '/Users/nobody'), '/ws/project')
  // The project root itself is already the target, trailing slash included.
  assert.equal(await resolveOpenTarget('intellij', '/ws/project/', probe, '/Users/nobody'), '/ws/project')
})

test('the nearest project wins when projects nest', async () => {
  const probe = markerProbe(
    { '/ws/.idea': 2, '/ws/app/.idea': 5 },
    ['/ws', '/ws/app', '/ws/app/src'],
  )
  assert.equal(await resolveOpenTarget('intellij', '/ws/app/src', probe, '/Users/nobody'), '/ws/app')
  assert.equal(await resolveOpenTarget('intellij', '/ws/other', probe, '/Users/nobody'), '/ws')
})

test('an empty marker, an unreadable one, and no marker at all keep the clicked path', async () => {
  // A bare directory named `.idea` is left behind by enough unrelated tooling
  // that treating it as a project would reroute a click away from the folder
  // the reader picked. The platform fills the directory as it initializes a project.
  const empty = markerProbe({ '/ws/project/.idea': 0 }, ['/ws', '/ws/project'])
  assert.equal(
    await resolveOpenTarget('intellij', '/ws/project/target', empty, '/Users/nobody'),
    '/ws/project/target',
  )
  const unreadable: OpenTargetProbe = { isDirectory: async () => true, hasEntries: async () => false }
  assert.equal(
    await resolveOpenTarget('intellij', '/ws/project/target', unreadable, '/Users/nobody'),
    '/ws/project/target',
  )
  const none: OpenTargetProbe = { isDirectory: async () => false, hasEntries: async () => false }
  assert.equal(await resolveOpenTarget('intellij', '/ws/project', none, '/Users/nobody'), '/ws/project')
})

test('home and the filesystem root are never project roots', async () => {
  // A marker in the home directory or at the root is not a project anyone asked
  // to open, and rerouting every artifact beneath one there would open the wrong
  // thing — silently, since all the reader sees is their IDE coming forward.
  const probe = markerProbe(
    { '/Users/nobody/.idea': 4, '/.idea': 4 },
    ['/', '/Users', '/Users/nobody', '/Users/nobody/work', '/Users/nobody/work/lib', '/Users/nobody/work/lib/x', '/x'],
  )
  assert.equal(
    await resolveOpenTarget('intellij', '/Users/nobody/work/lib/x', probe, '/Users/nobody'),
    '/Users/nobody/work/lib/x',
  )
  assert.equal(await resolveOpenTarget('intellij', '/Users/nobody', probe, '/Users/nobody'), '/Users/nobody')
  assert.equal(await resolveOpenTarget('intellij', '/x/y', probe, '/Users/nobody'), '/x/y')

  // A project between the clicked folder and home still wins.
  const closer = markerProbe({ '/Users/nobody/work/.idea': 4 }, ['/Users/nobody/work', '/Users/nobody/work/lib'])
  assert.equal(await resolveOpenTarget('intellij', '/Users/nobody/work/lib', closer, '/Users/nobody'), '/Users/nobody/work')
})

test('the walk stops at the first project above the click', async () => {
  const probe = markerProbe({ '/a/.idea': 1, '/.idea': 1 }, ['/', '/a', '/a/b', '/a/b/c'])
  // `/a` is close enough that the root above it is never consulted.
  assert.equal(await resolveOpenTarget('intellij', '/a/b/c', probe, '/Users/nobody'), '/a')
  // With the root as the only marker, the walk ends there without proposing it.
  const rootOnly = markerProbe({ '/.idea': 1 }, ['/', '/a'])
  assert.equal(await resolveOpenTarget('intellij', '/a', rootOnly, '/Users/nobody'), '/a')
})

test('the default probe reads a real project directory', async () => {
  // The rule above is stated over an injected probe; this runs the same walk
  // against a real tree, which is the only way to prove the marker check itself
  // (`.idea` present, readable, and non-empty).
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-target-'))
  const home = join(root, 'home')
  try {
    await mkdir(join(root, 'project', '.idea'), { recursive: true })
    await writeFile(join(root, 'project', '.idea', 'misc.xml'), '<project />\n')
    await mkdir(join(root, 'project', 'target', 'classes'), { recursive: true })
    await mkdir(join(root, 'plain'), { recursive: true })
    await mkdir(join(root, 'bare', '.idea'), { recursive: true })
    await mkdir(home, { recursive: true })

    assert.equal(
      await resolveOpenTarget('intellij', join(root, 'project', 'target'), undefined, home),
      join(root, 'project'),
    )
    assert.equal(await resolveOpenTarget('intellij', join(root, 'plain'), undefined, home), join(root, 'plain'))
    // An empty `.idea` is not a project, so the walk keeps looking upward.
    assert.equal(await resolveOpenTarget('intellij', join(root, 'bare'), undefined, home), join(root, 'bare'))
    // Finder never consults the filesystem at all.
    assert.equal(
      await resolveOpenTarget('finder', join(root, 'project', 'target'), undefined, home),
      join(root, 'project', 'target'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
