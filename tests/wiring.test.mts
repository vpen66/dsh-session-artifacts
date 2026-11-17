/**
 * Wiring checks: `apply` registers exactly the ledger's surface, and unloading
 * it releases what it holds.
 *
 * These run against a stub context, so they prove registration rather than
 * behaviour; the open-target route is exercised at the wire here too, because
 * it is the one surface that answers a request. The scan behaviour is covered
 * by the scenario tests in `scan.test.mts` and the rule behind the route by
 * `openTarget.test.mts`.
 * @module dsh-session-artifacts/tests/wiring.test
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  apply, boundOf, Config, inject, name, OPEN_TARGET_PATH, OPEN_TARGET_ROUTE, recordCapability, recordFolders,
  scanRecordData, truncationRow, truncationSentence, turnDelta,
} from '../lib/index.js'
import type { ArtifactScan } from '../lib/types.js'

/** One registered tool, as `defineTool` hands it to the registry. */
interface RegisteredTool {
  name: string
  description: string
  output?: {
    schema: unknown
    render: (args: unknown, value: Record<string, unknown>) => { type: string; text: string }[]
  }
}

/** One route the stub web server was handed. */
interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => unknown
}

/** Everything the plugin registered on the stub context. */
interface Registered {
  tools: RegisteredTool[]
  listeners: string[]
  disposed: boolean
  /** Service names each `ctx.inject` asked for, in call order. */
  injected: string[][]
  routes: RegisteredRoute[]
  /** Effect labels, which is how a route registration is named. */
  effectLabels: string[]
  /** Cleanups the effects returned, as the runtime would call them on unload. */
  cleanups: (() => void)[]
  /** Event handlers by event name, so a test can dispatch one. */
  handlers: Record<string, ((...args: never[]) => unknown)[]>
}

/** A stub web server that records routes and hands back their disposer. */
function stubWebServer(registered: Registered): { register: (route: RegisteredRoute) => () => void } {
  return {
    register: (route) => {
      registered.routes.push(route)
      return () => {
        registered.routes = registered.routes.filter(entry => entry !== route)
        registered.disposed = true
      }
    },
  }
}

/**
 * A context recording registrations, with just enough shape for `apply`.
 * @param options - `web` stands in for a deployment with the Host's web server
 *   and connection services; `rejection` is what that server's trust fence answers.
 * @returns the context and what it recorded.
 */
function stubContext(
  options: { web?: boolean; rejection?: 401 | 403 | undefined } = {},
): { ctx: never; registered: Registered } {
  const registered: Registered = {
    tools: [], listeners: [], disposed: false, injected: [], routes: [], effectLabels: [], cleanups: [], handlers: {},
  }
  // An effect body runs now and whatever it returns is the cleanup the runtime
  // would call on unload — the disposal half of a route registration.
  const effect = (body: () => (() => void) | void, label?: string): void => {
    if (label !== undefined) registered.effectLabels.push(label)
    const cleanup = body()
    if (typeof cleanup === 'function') registered.cleanups.push(cleanup)
  }
  const routes = {
    webServer: stubWebServer(registered),
    connection: { requestRejection: () => options.rejection },
  }
  const ctx = {
    tools: { register: (tool: RegisteredTool) => { registered.tools.push(tool) } },
    on: (event: string, handler: (...args: never[]) => unknown) => {
      registered.listeners.push(event)
      registered.handlers[event] = [...(registered.handlers[event] ?? []), handler]
    },
    effect,
    inject: (deps: string[], callback: (child: unknown) => void) => {
      registered.injected.push(deps)
      // Cordis runs the callback only once every required service is available;
      // a deployment without a web server is the case this models.
      if (options.web !== false) callback({ ...routes, effect })
      return { dispose: () => undefined }
    },
  }
  return { ctx: ctx as never, registered }
}

/**
 * Dispatch one lifecycle event the way the runtime would.
 * @param registered - what the stub context recorded.
 * @param event - the event name the plugin listened for.
 * @param args - the event's own arguments.
 * @returns the handlers' return values.
 */
function dispatch(registered: Registered, event: string, ...args: unknown[]): unknown[] {
  const handlers = registered.handlers[event] ?? []
  assert.ok(handlers.length > 0, `the plugin must listen for ${event}`)
  return handlers.map(handler => (handler as (...eventArgs: unknown[]) => unknown)(...args))
}

/** A request that streams one JSON body, plus the response it recorded. */
interface Call {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Call the registered route directly, the way the server would.
 * @param registered - what the stub context recorded.
 * @param options - method, content type, and raw body text.
 * @returns the recorded response.
 */
async function callRoute(
  registered: Registered,
  options: { method?: string; contentType?: string; body?: string },
): Promise<Call> {
  const route = registered.routes[0]
  assert.ok(route !== undefined, 'the route must be registered')
  const text = options.body ?? ''
  const chunks = text === '' ? [] : [Buffer.from(text, 'utf8')]
  const req: Record<string, unknown> = {
    method: options.method ?? 'POST',
    headers: options.contentType === undefined ? {} : { 'content-type': options.contentType },
    resume: () => undefined,
    [Symbol.asyncIterator]: () => {
      let index = 0
      return { next: async () => (index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true }) }
    },
  }
  const call: Call = { status: 0, headers: {}, body: '' }
  const res: Record<string, unknown> = {
    setHeader: (name: string, value: string) => { call.headers[name.toLowerCase()] = value },
    end: (chunk?: string) => { call.body = chunk ?? '' },
    set statusCode(value: number) { call.status = value },
    get statusCode() { return call.status },
  }
  await route.handler(req, res)
  return call
}

/** The validated default configuration, as the loader would hand it over. */
function defaultConfig() {
  return Config({})
}

test('the plugin identifies itself and declares its one service dependency', () => {
  assert.equal(name, 'session-artifacts')
  assert.deepEqual(inject, ['tools'])
})

test('apply registers the report tool and the explicit root declaration', () => {
  const { ctx, registered } = stubContext()
  apply(ctx, defaultConfig())
  // Two tools, one job: the report reads what the Session left, and `watch`
  // lets the model name a place its own writes will land before they happen.
  assert.deepEqual(registered.tools.map(tool => tool.name), [
    'session_artifacts_report',
    'session_artifacts_watch',
  ])
})

test('apply subscribes to the lifecycle points the ledger depends on', () => {
  const { ctx, registered } = stubContext()
  apply(ctx, defaultConfig())
  // The scan trigger is the durable `turn/end` branch of `session/event`, not the
  // live `agent/turn-stopping` hook, which a runtime older than this checkout
  // does not have. `session/created` starts the baseline walk before the first
  // turn, and the `turn/start` branch covers a plugin mounted after it.
  for (const event of ['session/created', 'session/event', 'session/disposed']) {
    assert.ok(registered.listeners.includes(event), `expected a listener for ${event}`)
  }
  assert.ok(!registered.listeners.includes('agent/turn-stopping'))
})

test('the baseline is taken before the first turn, so its build is measured', async () => {
  // Taken lazily at the first turn's end, the baseline already contained that
  // turn's own build: a session whose first turn built a module reported 0 B,
  // and one whose first turn built nothing reported 0 B too. The baseline now
  // starts when the session is announced.
  const root = mkdtempSync(join(tmpdir(), 'dsh-artifacts-baseline-'))
  try {
    mkdirSync(join(root, 'target'), { recursive: true })
    writeFileSync(join(root, 'target', 'app.jar'), Buffer.alloc(500, 'j'))

    const { ctx, registered } = stubContext()
    apply(ctx, defaultConfig())
    const session = { id: 'session-1', header: { cwd: root } } as never

    // Announced: the walk starts, before any turn runs. It is asynchronous, and
    // a turn's own work begins seconds later in practice, so this waits for the
    // two-entry walk to finish before building.
    dispatch(registered, 'session/created', session)
    await new Promise((resolve) => { setTimeout(resolve, 200) })

    // The first turn then builds: the existing jar is rewritten and its
    // directory re-listed.
    dispatch(registered, 'session/event', session, { type: 'turn/start', data: { turn: 1 } })
    const stamp = new Date()
    utimesSync(join(root, 'target'), stamp, stamp)
    utimesSync(join(root, 'target', 'app.jar'), stamp, stamp)

    const tool = registered.tools[0]
    assert.ok(tool !== undefined)
    const report = await (tool as unknown as {
      execute: (args: unknown, exec: unknown) => Promise<{ bytes: number; folders: { path: string }[] }>
    }).execute({}, { agent: { session } })
    assert.equal(report.bytes, 500, 'the first turn must be measured against a baseline taken before it')
    assert.deepEqual(report.folders.map(folder => folder.path), ['target'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('defaults are usable without configuration and keep the DSH home off limits', () => {
  const config = defaultConfig()
  assert.equal(config.scanOnTurnEnd, true)
  assert.deepEqual(config.exclude, ['.git', '.hg', '.svn'])
})

test('the tool description tells the model the report has no side effect', () => {
  const { ctx, registered } = stubContext()
  apply(ctx, defaultConfig())
  const report = registered.tools[0]
  assert.ok(report !== undefined)
  assert.match(report.description, /never changes any file/u)
})

test('the plugin-record capability is read, never assumed', () => {
  // The packaged Desktop runtime (0.2.0-rc.2) exports no `appendPluginRecord`, so
  // the probe has to refuse every shape that is not the real function.
  assert.equal(recordCapability({}), false)
  assert.equal(recordCapability({ appendPluginRecord: undefined }), false)
  assert.equal(recordCapability({ appendPluginRecord: 'yes' }), false)
  assert.equal(recordCapability(null), false)
  assert.equal(recordCapability(undefined), false)
  assert.equal(recordCapability({ appendPluginRecord: () => 'seq' }), true)
})

test('the record rolls one scan up by folder, largest first and bounded', () => {
  // The reading this plugin is asked for is "how much did this turn put on disk, and
  // where". A rebuilt 150 MB jar inside `artisan/target` is one row for that folder,
  // not one row per class file beside it, and the total travels with the head so a
  // reader can tell "twelve folders grew" from "twelve of forty did".
  const file = (display: string, bytes: number) => ({
    path: `/ws/${display}`, display, kind: 'file' as const, bytes, files: 1,
  })
  const directory = (display: string, bytes: number, files: number) => ({
    path: `/ws/${display}`, display, kind: 'directory' as const, bytes, files,
  })

  const { folders, total } = recordFolders([
    file('artisan/target/artisan.jar', 150_000_000),
    file('artisan/target/artisan.jar.original', 64_390),
    directory('core/target', 1_400_000, 30),
    file('notes.txt', 10),
  ], 12)

  assert.equal(total, 3)
  assert.deepEqual(folders.map(folder => folder.path), ['artisan/target', 'core/target', 'notes.txt'])
  assert.equal(folders[0]?.bytes, 150_064_390)
  assert.equal(folders[0]?.files, 2)
  // A directory is attributed to itself, so a new `target/` reads as `target/`.
  assert.equal(folders[1]?.bytes, 1_400_000)
  assert.equal(folders[1]?.files, 30)
  // A top-level file has no folder of its own, so it stands as its own row.
  assert.equal(folders[2]?.path, 'notes.txt')

  // The bound trims the head without changing the total a reader sees.
  const bounded = recordFolders([file('a/x', 30), file('b/y', 20), file('c/z', 10)], 2)
  assert.equal(bounded.folders.length, 2)
  assert.equal(bounded.total, 3)
  // Zero carries no folders at all, which is what a quiet log asks for.
  assert.deepEqual(recordFolders([file('a/x', 30)], 0), { folders: [], total: 1 })
})

test('the client half injects only client modules the packaged runtime serves', () => {
  // `@deepseek-ai/dsh-client-ui-slots` is a module the checkout has and the
  // packaged runtime does not. The bundle loader skips an inject target that is
  // absent from its module graph instead of failing, so naming a module the
  // runtime cannot serve is a silent, hard-to-find mistake rather than an error.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dsh: { client: { inject: string[] } }
  }
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-tool',
  ])
})

test('the open-target route rides on its own fiber, so the tool needs no web server', () => {
  // The report tool is the plugin's contract with every runtime; the route only
  // exists where a browser does. Asking for the pair on a child fiber keeps a
  // headless profile from waiting on services it will never have.
  const { ctx, registered } = stubContext()
  apply(ctx, defaultConfig())
  assert.deepEqual(inject, ['tools'])
  // The filesystem seam rides its own optional fiber too: a composition without
  // one keeps both tools, and a filesystem lets write intents name roots.
  assert.deepEqual(registered.injected, [['fs'], ['webServer', 'connection']])
  assert.deepEqual(registered.routes.map(route => [route.kind, route.path]), [['exact', OPEN_TARGET_PATH]])
  assert.ok(registered.effectLabels.includes(`session-artifacts: POST ${OPEN_TARGET_PATH}`))
})

test('a deployment without a web server keeps the report tool and grows no route', () => {
  const { ctx, registered } = stubContext({ web: false })
  apply(ctx, defaultConfig())
  assert.deepEqual(registered.tools.map(tool => tool.name), ['session_artifacts_report', 'session_artifacts_watch'])
  assert.deepEqual(registered.routes, [])
})

test('unloading the plugin releases the route it registered', () => {
  const { ctx, registered } = stubContext()
  apply(ctx, defaultConfig())
  assert.equal(registered.routes.length, 1)
  for (const cleanup of registered.cleanups) cleanup()
  assert.deepEqual(registered.routes, [])
  assert.equal(registered.disposed, true)
})

test('the route answers with the path the chosen application receives', async () => {
  // One real project tree, because the route's whole answer depends on the
  // marker the IntelliJ platform leaves in a project directory.
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-route-'))
  try {
    await mkdir(join(root, 'project', '.idea'), { recursive: true })
    await writeFile(join(root, 'project', '.idea', 'misc.xml'), '<project />\n')
    await mkdir(join(root, 'project', 'target', 'classes'), { recursive: true })

    const { ctx, registered } = stubContext()
    apply(ctx, defaultConfig())

    const intellij = await callRoute(registered, {
      contentType: 'application/json',
      body: JSON.stringify({ app: 'intellij', path: join(root, 'project', 'target') }),
    })
    assert.equal(intellij.status, 200)
    assert.equal(intellij.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(intellij.headers['cache-control'], 'no-store')
    assert.deepEqual(JSON.parse(intellij.body), { path: join(root, 'project') })

    // Finder opens the folder itself, so the answer is the clicked path.
    const finder = await callRoute(registered, {
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ app: 'finder', path: join(root, 'project', 'target') }),
    })
    assert.deepEqual(JSON.parse(finder.body), { path: join(root, 'project', 'target') })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the route refuses every shape that is not its own', async () => {
  const { ctx, registered } = stubContext()
  apply(ctx, defaultConfig())

  const get = await callRoute(registered, { method: 'GET' })
  assert.equal(get.status, 405)
  assert.equal(get.headers.allow, 'POST')

  const wrongType = await callRoute(registered, { contentType: 'text/plain', body: '{}' })
  assert.equal(wrongType.status, 415)

  const notJson = await callRoute(registered, { contentType: 'application/json', body: 'not json' })
  assert.equal(notJson.status, 400)

  const wrongFields = await callRoute(registered, {
    contentType: 'application/json',
    body: JSON.stringify({ app: 'intellij', path: 7 }),
  })
  assert.equal(wrongFields.status, 400)

  const relative = await callRoute(registered, {
    contentType: 'application/json',
    body: JSON.stringify({ app: 'intellij', path: 'project/target' }),
  })
  assert.equal(relative.status, 400)

  const oversized = await callRoute(registered, {
    contentType: 'application/json',
    body: JSON.stringify({ app: 'intellij', path: '/tmp', pad: 'x'.repeat(70_000) }),
  })
  assert.equal(oversized.status, 413)
})

test('the route asks the connection trust fence before it answers anything', async () => {
  // The route reads the filesystem beside a caller-supplied path, so it sits
  // behind the same fence the Host's own routes use rather than answering
  // unauthenticated callers.
  const { ctx, registered } = stubContext({ rejection: 401 })
  apply(ctx, defaultConfig())
  const call = await callRoute(registered, {
    contentType: 'application/json',
    body: JSON.stringify({ app: 'intellij', path: '/tmp' }),
  })
  assert.equal(call.status, 401)
  assert.equal(call.body, '')
})

test('the browser half posts the route the host registered', () => {
  // The bundle is plain JavaScript served as a file, so it cannot import the
  // constant: both halves name the route, and this is the one place that makes
  // the two names one name.
  const bundle = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(bundle.includes(`'${OPEN_TARGET_ROUTE}'`), `the bundle must post ${OPEN_TARGET_ROUTE}`)
  assert.ok(bundle.includes("'open-in-app/open'"), 'the bundle must still hand the path to the host open endpoint')
})


/** One scan, as the ledger produces it, for the record and report contracts. */
function scanFixture(coverage: ArtifactScan['coverage'], turnBytes = 1_000, turnFolders = [{ path: 'artisan/target', bytes: 1_000, files: 4 }]): ArtifactScan {
  return {
    sessionId: 'session-1',
    turn: 7,
    root: '/ws',
    records: [
      { path: '/ws/artisan/target', display: 'artisan/target', kind: 'directory', bytes: 1_000, files: 4, mtimeMs: 1, ancestors: ['artisan'] },
    ],
    bytes: 1_000,
    turnBytes,
    turnFolders,
    turnFoldersTotal: turnFolders.length,
    coverage,
  }
}

test('the record one scan commits carries the bound that stopped it', () => {
  // The card can only name the limit if the record carries it: a boolean leaves
  // every reader with the one sentence that made a healthy build look broken.
  const complete = scanRecordData(scanFixture({
    directoriesVisited: 10, truncated: false, recordsObserved: 1, elapsedMs: 5, baseline: false,
  }, 512), 12)
  assert.deepEqual(complete, {
    turn: 7,
    root: '/ws',
    bytes: 1_000,
    turnBytes: 512,
    truncated: false,
    folders: [{ path: 'artisan/target', bytes: 1_000, files: 4 }],
    foldersTotal: 1,
    turnFolders: [{ path: 'artisan/target', bytes: 1_000, files: 4 }],
    turnFoldersTotal: 1,
  })
  assert.equal('truncation' in complete, false, 'a complete scan carries no bound')

  const partial = scanRecordData(scanFixture({
    directoriesVisited: 1_728,
    truncated: true,
    truncation: { reason: 'maxRecords', limit: 200, observed: 799 },
    recordsObserved: 799,
    elapsedMs: 32,
    baseline: false,
  }, 0, []), 12)
  assert.equal(partial.truncated, true)
  assert.equal(partial.turnBytes, 0, 'a quiet turn reads 0 beside the footprint')
  assert.deepEqual(partial.turnFolders, [], 'and its own folder list is empty, not the footprint\'s')
  assert.equal(partial.bytes, 1_000, 'and the footprint is unchanged')
  assert.deepEqual(partial.truncation, { reason: 'maxRecords', limit: 200, observed: 799 })
})

test('the turn reading counts only what was written since the previous turn', () => {
  // The footprint a rebuilt `target/` contributes to on every later scan is not a
  // turn's work; the entries' own write times are what separates them, and that
  // difference is the whole reason the two readings exist.
  const entry = (display: string, bytes: number, mtimeMs: number) => ({
    path: `/ws/${display}`, display, kind: 'file' as const, bytes, files: 1, mtimeMs, ancestors: [],
  })
  const entries = [
    entry('artisan/target/app.jar', 1_000, 5_000),
    entry('core/target/app.jar', 400, 900),
    entry('docs/readme.md', 50, 5_000),
  ]
  assert.equal(turnDelta(entries, 1_000), 1_050, 'everything written at or after the watermark counts')
  assert.equal(turnDelta(entries, 5_000), 1_050)
  assert.equal(turnDelta(entries, 5_001), 0, 'a quiet turn is zero, whatever the footprint is')
  assert.equal(turnDelta([], 0), 0)
})

test('the report names the bound that stopped the scan, in text and as a row', () => {
  // The report text is the tool card's wire, so the sentence stays recognisable
  // by its prefix while the row carries what a card needs to localise it.
  const records = truncationSentence({ reason: 'maxRecords', limit: 200, observed: 799 })
  assert.match(records, /^The scan stopped at its record bound: 799 records against 200/u)
  assert.match(truncationSentence({ reason: 'maxDirectories', limit: 50_000, observed: 50_000 }), /directory bound: 50000 directories/u)
  assert.match(truncationSentence({ reason: 'timeoutMs', limit: 5_000, observed: 5_120 }), /deadline: 5120 ms against 5000 ms/u)

  assert.equal(truncationRow({ reason: 'maxRecords', limit: 200, observed: 799 }), 'truncated\tmaxRecords\t200\t799')
  assert.equal(truncationRow({ reason: 'timeoutMs', limit: 5_000, observed: 5_120 }), 'truncated\ttimeoutMs\t5000\t5120')
})

test('the report tool renders the bound, and nothing when the scan was complete', () => {
  const { ctx, registered } = stubContext()
  apply(ctx, defaultConfig())
  const tool = registered.tools[0]
  assert.ok(tool?.output !== undefined)

  const schema = JSON.stringify(tool.output.schema)
  assert.ok(schema.includes('"truncation"'), 'the output schema must carry the bound')

  const partial = tool.output.render({}, {
    root: '/ws',
    bytes: 1_000,
    truncated: true,
    truncation: { reason: 'maxRecords', limit: 200, observed: 799 },
    foldersTotal: 1,
    folders: [{ path: 'artisan/target', bytes: 1_000, files: 4 }],
  })
  const lines = partial[0]?.text.split('\n') ?? []
  assert.match(lines[0] ?? '', /^The scan stopped at its record bound/u)
  assert.equal(lines[1], 'truncated\tmaxRecords\t200\t799')
  assert.equal(lines[2], '1 folders, 1000 bytes')

  const complete = tool.output.render({}, {
    root: '/ws', bytes: 0, truncated: false, foldersTotal: 0, folders: [],
  })
  assert.doesNotMatch(complete[0]?.text ?? '', /The scan stopped/u)

  // A reason this build does not know keeps the sentence a card can recognise
  // rather than naming a bound it cannot describe.
  const unknown = tool.output.render({}, {
    root: '/ws', bytes: 0, truncated: true,
    truncation: { reason: 'maxSomething', limit: 1, observed: 2 },
    foldersTotal: 0, folders: [],
  })
  assert.match(unknown[0]?.text ?? '', /^The scan stopped at a configured bound/u)
  assert.equal(boundOf({ reason: 'maxSomething', limit: 1, observed: 2 }), undefined)
  assert.deepEqual(boundOf({ reason: 'maxRecords', limit: 1, observed: 2 }), { reason: 'maxRecords', limit: 1, observed: 2 })
})

/** Wait for a fire-and-forget root registration to settle. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Run the report tool for one Session, as the model would. */
async function reportOf(tool: RegisteredTool, session: unknown): Promise<{
  root: string
  bytes: number
  workspaceBytes?: number
  folders: { path: string; root?: string; bytes: number; files: number }[]
  roots?: { path: string; origin: string; bytes: number; files: number }[]
  truncated: boolean
}> {
  const executable = tool as unknown as {
    execute: (args: unknown, exec: unknown) => Promise<{
      root: string
      bytes: number
      workspaceBytes?: number
      folders: { path: string; root?: string; bytes: number; files: number }[]
      roots?: { path: string; origin: string; bytes: number; files: number }[]
      truncated: boolean
    }>
  }
  return executable.execute({}, { agent: { session } })
}

test('a command that names an outside directory puts it in the report', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-artifacts-ws-'))
  const external = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-artifacts-ext-')))
  try {
    const { ctx, registered } = stubContext()
    apply(ctx, defaultConfig())
    const session = { id: 'session-external', header: { cwd: workspace } } as never
    dispatch(registered, 'session/created', session)
    await wait(100)

    // The model runs a build that writes outside the workspace, naming the tree
    // the way a shell command does.
    await dispatch(registered, 'tools/pre-execute', {
      name: 'bash',
      arguments: { command: `cd ${external} && make all` },
      agent: { session },
    }, async () => ({ kind: 'allow' }))
    await wait(150)
    writeFileSync(join(external, 'app.bin'), Buffer.alloc(4096, 'x'))

    const tool = registered.tools[0]
    assert.ok(tool !== undefined)
    const report = await reportOf(tool, session)
    assert.ok(report.bytes >= 4096, `expected the external bytes, got ${report.bytes}`)
    assert.equal(report.workspaceBytes, 0)
    assert.deepEqual(report.folders.map(folder => folder.path), [external])
    assert.equal(report.roots?.length, 2)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})

test('a file tool writing inside the workspace adds no root', async () => {
  // Every file tool call names a path; inside the workspace that path is already
  // what the workspace scan measures, and registering it again would count the
  // same bytes under two roots.
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-artifacts-ws-'))
  try {
    mkdirSync(join(workspace, 'src'), { recursive: true })
    const { ctx, registered } = stubContext()
    apply(ctx, defaultConfig())
    const session = { id: 'session-inside', header: { cwd: workspace } } as never
    dispatch(registered, 'session/created', session)
    await wait(100)

    await dispatch(registered, 'tools/pre-execute', {
      name: 'write',
      arguments: { file_path: join(workspace, 'src', 'a.ts') },
      agent: { session },
    }, async () => ({ kind: 'allow' }))
    await wait(100)
    writeFileSync(join(workspace, 'src', 'a.ts'), Buffer.alloc(256, 'a'))

    const tool = registered.tools[0]
    assert.ok(tool !== undefined)
    const report = await reportOf(tool, session)
    assert.equal(report.roots, undefined, 'the workspace stays the only root')
    assert.ok(report.bytes >= 256)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('a root discovered late counts only what this Session wrote', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-artifacts-ws-'))
  const external = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-artifacts-ext-')))
  const old = join(external, 'already-there.bin')
  writeFileSync(old, Buffer.alloc(8192, 'o'))
  const past = new Date(Date.now() - 60_000)
  utimesSync(old, past, past)
  utimesSync(external, past, past)
  try {
    const { ctx, registered } = stubContext()
    apply(ctx, defaultConfig())
    const session = { id: 'session-strict', header: { cwd: workspace } } as never
    dispatch(registered, 'session/created', session)
    await wait(100)
    await dispatch(registered, 'tools/pre-execute', {
      name: 'bash',
      arguments: { command: `cd ${external} && make all` },
      agent: { session },
    }, async () => ({ kind: 'allow' }))
    await wait(150)
    writeFileSync(join(external, 'new.bin'), Buffer.alloc(2048, 'n'))

    const tool = registered.tools[0]
    assert.ok(tool !== undefined)
    const report = await reportOf(tool, session)
    const share = report.roots?.find(root => root.path === external)
    assert.equal(share?.bytes, 2048, 'the file that predates the Session is not its artifact')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})

test('a delegate\'s workspace roots count as the parent Session\'s', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-artifacts-ws-'))
  const childDir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-artifacts-child-')))
  try {
    const { ctx, registered } = stubContext()
    apply(ctx, defaultConfig())
    const parent = { id: 'session-parent', header: { cwd: workspace } } as never
    const child = { id: 'session-child', header: { cwd: childDir, parentSession: 'session-parent' } } as never
    dispatch(registered, 'session/created', parent)
    dispatch(registered, 'session/created', child)
    await wait(150)
    writeFileSync(join(childDir, 'report.md'), Buffer.alloc(1024, 'r'))

    const tool = registered.tools[0]
    assert.ok(tool !== undefined)
    const report = await reportOf(tool, parent)
    assert.ok(report.roots?.some(root => root.path === childDir), 'the child workspace appears as a root')
    assert.ok(report.bytes >= 1024)
    assert.equal(report.workspaceBytes, 0, 'the child bytes are not the parent workspace\'s')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(childDir, { recursive: true, force: true })
  }
})

test('the watch tool makes a directory a root without a command naming it', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-artifacts-ws-'))
  const external = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-artifacts-watch-')))
  try {
    const { ctx, registered } = stubContext()
    apply(ctx, defaultConfig())
    const session = { id: 'session-watch', header: { cwd: workspace } } as never
    dispatch(registered, 'session/created', session)
    await wait(100)

    const watch = registered.tools[1]
    assert.ok(watch !== undefined)
    const declared = await (watch as unknown as {
      execute: (args: unknown, exec: unknown) => Promise<{ counted: boolean; path: string }>
    }).execute({ path: external }, { agent: { session } })
    assert.equal(declared.counted, true)
    writeFileSync(join(external, 'dump.bin'), Buffer.alloc(3000, 'd'))

    const tool = registered.tools[0]
    assert.ok(tool !== undefined)
    const report = await reportOf(tool, session)
    assert.ok(report.roots?.some(root => root.path === external && root.bytes >= 3000))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})

test('a record carries the roots once the scan left the workspace', () => {
  const scan: ArtifactScan = {
    sessionId: 'session-1',
    turn: 7,
    root: '/ws',
    records: [
      { path: '/ws/target/app.jar', display: 'target/app.jar', kind: 'file', bytes: 1_000, files: 1, mtimeMs: 1, ancestors: ['target'] },
      { path: '/tmp/memcmp/app.bin', display: '/tmp/memcmp/app.bin', kind: 'file', bytes: 500, files: 1, mtimeMs: 1, ancestors: [] },
    ],
    bytes: 1_500,
    turnBytes: 0,
    turnFolders: [],
    turnFoldersTotal: 0,
    coverage: { directoriesVisited: 2, truncated: false, recordsObserved: 2, elapsedMs: 1, baseline: false },
    roots: [
      { path: '/ws', label: '', origin: 'workspace', bytes: 1_000, files: 1 },
      { path: '/tmp/memcmp', label: '/tmp/memcmp', origin: 'tool-argument', bytes: 500, files: 1 },
    ],
    workspaceBytes: 1_000,
  }
  const data = scanRecordData(scan, 12)
  assert.equal(data.workspaceBytes, 1_000)
  assert.equal(data.roots?.length, 2)
  const external = data.folders.find(folder => folder.path === '/tmp/memcmp')
  assert.equal(external?.root, '/tmp/memcmp')
  assert.equal(external?.bytes, 500)
  // The workspace row keeps the relative path a reader already knows.
  assert.equal(data.folders.find(folder => folder.path === 'target')?.root, '/ws')
})

