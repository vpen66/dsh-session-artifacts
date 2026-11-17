/**
 * Tests for workspace folder-level observation and aggregation.
 * @module dsh-session-artifacts/tests/scan.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { scanWorkspace, takeBaseline, type ScanBounds } from '../lib/inventory.js'
import { folderRows, recordFolders } from '../lib/index.js'

const BOUNDS: ScanBounds = {
  maxDirectories: 10_000,
  maxRecords: 500,
  timeoutMs: 30_000,
  exclude: ['.git', 'node_modules_exclude'],
}

/** Give one path, and every directory above it inside `root`, a fresh mtime. */
function rewrite(root: string, path: string): void {
  const stamp = new Date()
  let current = path
  while (current.startsWith(root)) {
    utimesSync(current, stamp, stamp)
    if (current === root) break
    current = dirname(current)
  }
}

test('incremental scan attributes space to folders without double counting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-test-'))
  try {
    // 1. Establish baseline
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'existing.ts'), 'original content\n')
    const { baseline } = await takeBaseline(root, BOUNDS)

    // Ensure mtime will be strictly newer
    await new Promise((resolve) => setTimeout(resolve, 50))

    // 2. Perform Session mutations:
    // a) New directory with nested subfolder
    await mkdir(join(root, 'build', 'sub'), { recursive: true })
    await writeFile(join(root, 'build', 'output.js'), Buffer.alloc(1000, 'a'))
    await writeFile(join(root, 'build', 'sub', 'extra.js'), Buffer.alloc(2000, 'b'))

    // b) New file in existing directory
    await writeFile(join(root, 'src', 'new.ts'), Buffer.alloc(500, 'c'))

    // c) Rewritten file in existing directory
    await writeFile(join(root, 'src', 'existing.ts'), Buffer.alloc(800, 'd'))

    // d) Root file
    await writeFile(join(root, 'notes.txt'), Buffer.alloc(100, 'e'))

    // 3. Scan workspace
    const { entries, coverage } = await scanWorkspace(baseline, BOUNDS)
    assert.equal(coverage.truncated, false)

    // 4. Verify observed entries
    // Total bytes should be exactly 1000 + 2000 + 500 + 800 + 100 = 4400
    const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0)
    assert.equal(totalBytes, 4400, 'total bytes must match sum of new/modified files without double counting')

    // A directory the session created is recorded one level at a time: `build`
    // itself (the file directly in it) and each directory under it that holds
    // files. That is what lets the panel expand `build` and then `sub`.
    const buildEntry = entries.find(e => e.display === 'build')
    assert.ok(buildEntry !== undefined, 'build directory should be recorded')
    assert.equal(buildEntry.kind, 'directory')
    assert.equal(buildEntry.bytes, 1000, 'its own files, not the subtree')
    assert.equal(buildEntry.files, 1)
    const buildSub = entries.find(e => e.display === 'build/sub')
    assert.ok(buildSub !== undefined, 'a directory inside it is its own record')
    assert.equal(buildSub.bytes, 2000)
    assert.equal(buildSub.files, 1)

    // 5. Aggregate into folders
    const { folders, total } = recordFolders(entries, 10)
    assert.equal(total, 3)

    // Folders should be ranked: build (3000), src (1300), notes.txt (100)
    assert.deepEqual(folders.map(f => f.path), ['build', 'src', 'notes.txt'])
    assert.equal(folders[0]?.bytes, 3000)
    assert.equal(folders[0]?.files, 2)
    // The level the panel expands is named, with its own subtree total.
    assert.deepEqual(
      folders[0]?.subfolders?.map(folder => [folder.path, folder.parent, folder.bytes]),
      [['build/sub', 'build', 2000]],
    )
    assert.equal(folders[1]?.bytes, 1300)
    assert.equal(folders[1]?.files, 2)
    assert.equal(folders[2]?.bytes, 100)
    assert.equal(folders[2]?.files, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('excluded directories are never measured or traversed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-test-'))
  try {
    const { baseline } = await takeBaseline(root, BOUNDS)

    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'dist', 'bundle.js'), Buffer.alloc(500, 'x'))

    const { entries } = await scanWorkspace(baseline, BOUNDS)
    const { folders } = recordFolders(entries, 10)

    assert.equal(folders.length, 1)
    assert.equal(folders[0]?.path, 'dist')
    assert.equal(folders[0]?.bytes, 500)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('every nested level is reported, each naming the level above it', () => {
  // The panel shows one level per disclosure, like a file manager, so the rows
  // have to carry every level between a top folder and a file deep inside it —
  // and each row has to name its own parent, because that is what the panel
  // rebuilds the tree from.
  const file = (display: string, bytes: number) => ({
    display, kind: 'file' as const, bytes, files: 1,
  })

  const { folders, total } = recordFolders([
    file('artisan/target/artisan.jar', 151_000_000),
    file('artisan/target/sub/extra.jar', 1_000_000),
    file('core/target/app.jar', 1_400_000),
    file('core/target/classes/com/aasp/core/dtos/iam/UserDto.class', 190_000),
    file('core/target/classes/com/aasp/core/services/impl/order/OrderService.class', 189_000),
  ], 10)

  // Only the 2 top-level folders: artisan/target and core/target!
  assert.equal(total, 2)
  assert.deepEqual(folders.map(folder => folder.path), ['artisan/target', 'core/target'])
  assert.equal(folders[0]?.bytes, 152_000_000)
  assert.equal(folders[0]?.files, 2)

  // One level under artisan/target, and it is the jar's own directory.
  assert.deepEqual(
    folders[0]?.subfolders?.map(folder => [folder.path, folder.parent, folder.bytes]),
    [['artisan/target/sub', 'artisan/target', 1_000_000]],
  )

  // core/target: its own 1.4M jar, then the chain down to the two class files,
  // every level present and totalled over what it contains.
  assert.equal(folders[1]?.bytes, 1_779_000)
  assert.equal(folders[1]?.files, 3)
  const levels = new Map((folders[1]?.subfolders ?? []).map(folder => [folder.path, folder]))
  assert.equal(levels.size, 9, 'every level between the top folder and the files')
  assert.equal(levels.get('core/target/classes')?.parent, 'core/target')
  assert.equal(levels.get('core/target/classes')?.bytes, 379_000)
  assert.equal(levels.get('core/target/classes/com')?.parent, 'core/target/classes')
  assert.equal(levels.get('core/target/classes/com/aasp/core')?.bytes, 379_000)
  assert.deepEqual(
    [levels.get('core/target/classes/com/aasp/core/dtos/iam')?.bytes,
      levels.get('core/target/classes/com/aasp/core/dtos/iam')?.parent],
    [190_000, 'core/target/classes/com/aasp/core/dtos'],
  )
  assert.equal(levels.get('core/target/classes/com/aasp/core/services/impl/order')?.bytes, 189_000)

  // The report rows say the same thing in the same grammar.
  assert.deepEqual(folderRows(folders[0]!), [
    'folder\t152000000\t2\tartisan/target',
    'subfolder\t1000000\t1\tartisan/target/sub\tartisan/target',
  ])
})

test('a rebuilt directory is one record, so a build no longer reads as a truncated scan', async () => {
  // The case behind the "scan hit a bound" notice: `mvn clean verify` recreates
  // the *contents* of a `target/` the baseline already knew, so every rebuilt
  // file counts as rewritten — 799 of them in one real Maven module, against a
  // default bound of 200, which is why every build turn reported itself as a
  // partial list. The ledger's unit is the directory the space arrived in, so one
  // rewritten directory is one record.
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-test-'))
  try {
    const chunks = 300
    await mkdir(join(root, 'dist'), { recursive: true })
    for (let i = 0; i < chunks; i++) {
      await writeFile(join(root, 'dist', `chunk-${i}.js`), Buffer.alloc(100, 'x'))
    }
    const { baseline } = await takeBaseline(root, BOUNDS)
    await new Promise(resolve => setTimeout(resolve, 50))
    for (let i = 0; i < chunks; i++) rewrite(root, join(root, 'dist', `chunk-${i}.js`))

    const { entries, coverage } = await scanWorkspace(baseline, { ...BOUNDS, maxRecords: 200 })

    assert.equal(coverage.truncated, false, 'a rebuilt directory must not trip the record bound')
    assert.equal(coverage.recordsObserved, 1, 'one directory is one record')
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.display, 'dist')
    assert.equal(entries[0]?.kind, 'directory')
    assert.equal(entries[0]?.rewritten, true, 'every name in it predates the Session')
    assert.equal(entries[0]?.files, chunks)
    assert.equal(entries[0]?.bytes, chunks * 100)

    // The row a reader sees is the one per-file records produced as well.
    const { folders } = recordFolders(entries, 10)
    assert.deepEqual(folders.map(f => f.path), ['dist'])
    assert.equal(folders[0]?.files, chunks)
    assert.equal(folders[0]?.bytes, chunks * 100)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a file directly in the workspace root keeps its own record', async () => {
  // The root is not a folder name a reader wants a row for, so the one place
  // file-level detail is drawn keeps it: a top-level file is its own entry.
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-test-'))
  try {
    const { baseline } = await takeBaseline(root, BOUNDS)
    await new Promise(resolve => setTimeout(resolve, 50))
    await writeFile(join(root, 'notes.txt'), Buffer.alloc(10, 'n'))

    const { entries, coverage } = await scanWorkspace(baseline, BOUNDS)
    assert.equal(coverage.recordsObserved, 1)
    assert.deepEqual(entries.map(entry => [entry.display, entry.kind, entry.files]), [['notes.txt', 'file', 1]])
    assert.deepEqual(recordFolders(entries, 10).folders.map(folder => folder.path), ['notes.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a tree too large to list level by level stays one subtree record', async () => {
  // Detail costs a record per directory that holds files, so it is spent only
  // while the scan has room. Something like a package manager's tree — thousands
  // of directories — collapses back to the one reading instead of eating the
  // whole record budget.
  const root = await mkdtemp(join(tmpdir(), 'session-artifacts-wide-'))
  try {
    await mkdir(join(root, 'mod'), { recursive: true })
    // The default record bound: the detail allowance is half of what is left of it.
    const bounds = { ...BOUNDS, maxRecords: 200 }
    const { baseline } = await takeBaseline(root, bounds)
    const wide = join(root, 'mod', 'node_modules')
    for (let index = 0; index < 120; index += 1) {
      await mkdir(join(wide, `pkg-${index}`), { recursive: true })
      await writeFile(join(wide, `pkg-${index}`, 'index.js'), Buffer.alloc(10, 'a'))
    }

    const { entries } = await scanWorkspace(baseline, bounds)
    const recorded = entries.filter(entry => entry.display.startsWith('mod/node_modules'))
    assert.equal(recorded.length, 1, 'one record for the whole tree')
    assert.equal(recorded[0]?.display, 'mod/node_modules')
    assert.equal(recorded[0]?.bytes, 1_200)
    assert.equal(recorded[0]?.files, 120)
    assert.deepEqual(recordFolders(entries, 10).folders.map(folder => folder.path), ['mod/node_modules'])
    assert.equal(recordFolders(entries, 10).folders[0]?.subfolders, undefined, 'and no levels to expand')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the record bound still stops a scan that changed more directories than it allows', async () => {
  // Collapsing per directory moved the bound onto directories, so it can still
  // stop a scan — and when it does, the reason and both numbers have to travel
  // with the coverage, because that is what a card needs to name the limit.
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-test-'))
  try {
    const modules = 250
    for (let i = 0; i < modules; i++) {
      await mkdir(join(root, `mod-${i}`, 'target'), { recursive: true })
      await writeFile(join(root, `mod-${i}`, 'target', 'app.jar'), Buffer.alloc(10, 'j'))
    }
    const { baseline } = await takeBaseline(root, BOUNDS)
    await new Promise(resolve => setTimeout(resolve, 50))
    for (let i = 0; i < modules; i++) rewrite(root, join(root, `mod-${i}`, 'target', 'app.jar'))

    const { entries, coverage } = await scanWorkspace(baseline, { ...BOUNDS, maxRecords: 200 })
    assert.equal(coverage.truncated, true)
    assert.deepEqual(coverage.truncation, { reason: 'maxRecords', limit: 200, observed: modules })
    assert.equal(coverage.recordsObserved, modules)
    // Folding keeps the total: a reader must never see less than the workspace grew by.
    assert.equal(entries.reduce((sum, entry) => sum + entry.bytes, 0), modules * 10)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('every record carries when it was last written', async () => {
  // The turn reading is a filter over these times, so each record has to answer
  // "when" as well as "how much": a file's own mtime, a measured directory's
  // newest file, and a directory record's newest file in its group.
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-test-'))
  try {
    await mkdir(join(root, 'target'), { recursive: true })
    await writeFile(join(root, 'target', 'app.jar'), Buffer.alloc(100, 'a'))
    const { baseline } = await takeBaseline(root, BOUNDS)
    await new Promise(resolve => setTimeout(resolve, 50))

    const stamp = new Date()
    await writeFile(join(root, 'target', 'app.jar'), Buffer.alloc(120, 'b'))
    utimesSync(join(root, 'target', 'app.jar'), stamp, stamp)
    utimesSync(join(root, 'target'), stamp, stamp)
    mkdirSync(join(root, 'fresh'))
    writeFileSync(join(root, 'fresh', 'out.txt'), Buffer.alloc(30, 'c'))

    const { entries } = await scanWorkspace(baseline, BOUNDS)
    const rebuilt = entries.find(entry => entry.display === 'target')
    const measured = entries.find(entry => entry.display === 'fresh')
    assert.ok(rebuilt !== undefined, 'the rebuilt directory is one record')
    assert.ok(measured !== undefined, 'the new directory is one record')
    assert.equal(rebuilt.mtimeMs, statSync(join(root, 'target', 'app.jar')).mtimeMs)
    assert.equal(measured.mtimeMs, statSync(join(root, 'fresh', 'out.txt')).mtimeMs)
    assert.ok(rebuilt.mtimeMs > baseline.takenAt, 'a write after the baseline is newer than it')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a root outside the workspace counts only files written since the Session began', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-strict-'))
  try {
    const old = join(root, 'already-there.bin')
    await writeFile(old, Buffer.alloc(800, 'o'))
    const past = new Date(Date.now() - 60_000)
    utimesSync(old, past, past)
    utimesSync(root, past, past)

    const startedAt = Date.now()
    const { baseline } = await takeBaseline(root, BOUNDS)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await writeFile(join(root, 'new.bin'), Buffer.alloc(500, 'n'))

    const { entries } = await scanWorkspace(baseline, BOUNDS, { displayPrefix: root, since: startedAt })
    assert.deepEqual(entries.map(entry => entry.display), [`${root}/new.bin`])
    assert.equal(entries[0]?.bytes, 500)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
