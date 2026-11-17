/**
 * Tests for root discovery: which paths a call names, and which of them may
 * become an artifact root.
 * @module dsh-session-artifacts/tests/roots.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalize, commandCandidates, coverPath, isForbiddenRoot, rootPathFor, toolCandidates,
  type RootCandidate,
} from '../lib/roots.js'

/** The paths one candidate list names, for a readable assertion. */
function paths(candidates: readonly RootCandidate[]): string[] {
  return candidates.map(candidate => candidate.path)
}

test('a command names the directories it writes into', () => {
  assert.ok(paths(commandCandidates('cd /tmp/memcmp && go build -o /tmp/memcmp/app .', '/work')).includes('/tmp/memcmp'))
  assert.ok(paths(commandCandidates('cd /tmp/memcmp && go build -o /tmp/memcmp/app .', '/work')).includes('/tmp/memcmp/app'))

  const target = commandCandidates('cargo build --target-dir /tmp/memcmp/target', '/work')
  assert.ok(target.some(candidate => candidate.path === '/tmp/memcmp/target' && candidate.kind === 'directory'))

  const redirect = commandCandidates('echo hi > /tmp/memcmp/out.log', '/work')
  assert.ok(redirect.some(candidate => candidate.path === '/tmp/memcmp/out.log' && candidate.kind === 'file'))

  const created = commandCandidates('mkdir -p /tmp/memcmp/src', '/work')
  assert.ok(created.some(candidate => candidate.path === '/tmp/memcmp/src' && candidate.kind === 'directory'))

  const copied = commandCandidates('cp -r dist /tmp/memcmp/dist', '/work')
  assert.ok(copied.some(candidate => candidate.path === '/tmp/memcmp/dist'))

  // The `--flag=value` spelling names the value in the same word.
  const flagged = commandCandidates('cargo build --target-dir=/tmp/memcmp/target', '/work')
  assert.ok(flagged.some(candidate => candidate.path === '/tmp/memcmp/target' && candidate.kind === 'directory'))

  // A build command's named input locates the tree its output lands in.
  const manifest = commandCandidates('cargo build --manifest-path /tmp/memcmp/Cargo.toml', '/work')
  assert.ok(manifest.some(candidate => candidate.path === '/tmp/memcmp/Cargo.toml'))
})

test('a command that only reads names no root', () => {
  assert.deepEqual(commandCandidates('cat /etc/hosts', '/work'), [])
  assert.deepEqual(commandCandidates('grep -rn foo /tmp', '/work'), [])
  assert.deepEqual(commandCandidates('ls /tmp/memcmp', '/work'), [])
})

test('variable, glob and quoted paths are expanded or refused, never guessed', () => {
  assert.deepEqual(commandCandidates('mkdir -p $TMPDIR/exp', '/work'), [])
  assert.deepEqual(commandCandidates('mkdir -p /tmp/exp*', '/work'), [])
  assert.deepEqual(commandCandidates('mkdir -p "/tmp/with space"', '/work'), [
    { path: '/tmp/with space', kind: 'directory', origin: 'tool-argument' },
  ])
  assert.deepEqual(commandCandidates('cd ../scratch', '/work/project'), [
    { path: '/work/scratch', kind: 'directory', origin: 'tool-argument' },
  ])
})

test('a tool call names its own write target', () => {
  assert.deepEqual(
    toolCandidates('write', { file_path: '/tmp/memcmp/src/a.rs' }, '/work').map(candidate => [candidate.path, candidate.kind]),
    [['/tmp/memcmp/src/a.rs', 'file']],
  )
  assert.deepEqual(paths(toolCandidates('working_directory', { cd: '/tmp/memcmp' }, '/work')), ['/tmp/memcmp'])
  assert.deepEqual(paths(toolCandidates('bash', { command: 'ls', workdir: '/tmp/memcmp' }, '/work')), ['/tmp/memcmp'])
  // A read tool's path is not a write, and a relative path stays inside the workspace.
  assert.deepEqual(toolCandidates('read', { file_path: '/etc/hosts' }, '/work'), [])
  assert.deepEqual(paths(toolCandidates('write', { file_path: 'src/a.rs' }, '/work')), ['/work/src/a.rs'])
})

test('the machine, the home directory and its ancestors are never roots', () => {
  const home = '/Users/reader'
  assert.equal(isForbiddenRoot('/', home), true)
  assert.equal(isForbiddenRoot(home, home), true)
  assert.equal(isForbiddenRoot('/Users', home), true)
  assert.equal(isForbiddenRoot('/System/Library', home), true)
  assert.equal(isForbiddenRoot('/private/tmp', home), true)
  assert.equal(isForbiddenRoot('/private/tmp/memcmp', home), false)
  assert.equal(isForbiddenRoot('/Users/reader/scratch', home), false)
})

test('a pending path canonicalizes through its deepest existing ancestor', async () => {
  const canonical = await canonicalize('/tmp/dsh-roots-test-missing/child')
  assert.ok(canonical !== undefined)
  assert.ok(canonical.endsWith('/dsh-roots-test-missing/child'))
  assert.ok(coverPath(canonical, canonical))
})

test('a file root is its parent; a missing directory stays itself', async () => {
  const file = await rootPathFor({ path: '/tmp', kind: 'file', origin: 'tool-argument' })
  assert.equal(file, '/tmp')
  const missing = await rootPathFor({ path: '/tmp/dsh-roots-test-missing/dir', kind: 'directory', origin: 'tool-argument' })
  assert.equal(missing, '/tmp/dsh-roots-test-missing/dir')
})
