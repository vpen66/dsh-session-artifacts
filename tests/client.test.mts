import assert from 'node:assert/strict'
import { test } from 'node:test'

/** One minimal element tree node, which is all `createElement` has to produce. */
interface Element {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/** Whether the React stand-in reports every disclosure as expanded. */
let expandAll = false
let recordedEffects: Array<() => (() => void) | void> = []
let stateSetter: ((value: unknown) => void) | null = null

/** A React stand-in: elements are plain objects and `useState` is inert. */
const React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element {
    return { type, props: props ?? {}, children }
  },
  useState<T>(initial: T | (() => T)): [T, (value: T) => void] {
    const value = typeof initial === 'function' ? (initial as () => T)() : initial
    return [expandAll ? (true as T) : value, (v) => { if (stateSetter) stateSetter(v) }]
  },
  // Refs and effects are inert here: the suite renders one tree by hand rather than
  // re-rendering through a host, so there is nothing for an effect to hook into.
  useRef<T>(initial: T): { current: T } {
    return { current: initial }
  },
  useEffect(effect: () => (() => void) | void): void {
    recordedEffects.push(effect)
  },
}

/** The platform module table's id for the shell's primitive components. */
const PLATFORM_PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The shell's `Switch`, stood in for.
 *
 * The real one renders a `role="switch"` button from the props it is given; this
 * one renders a sentinel carrying those same props, so a test can read what the
 * row passed without depending on the shell's markup or CSS modules. It stays a
 * function component because that is how the bundle receives it.
 * @param props - the props the row passed: `checked`, `onChange`, `label`.
 * @returns a sentinel element carrying those props.
 */
function HostSwitchStandIn(props: Record<string, unknown>): Element {
  return React.createElement('i', {
    'data-host-switch': 'yes',
    checked: props.checked,
    onChange: props.onChange,
    label: props.label,
  })
}

/**
 * Find the first element matching a predicate, invoking function components.
 * @param node - element tree to walk.
 * @param match - predicate over one element.
 * @returns the match, or undefined.
 */
function findElement(node: unknown, match: (element: Element) => boolean): Element | undefined {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match)
      if (found !== undefined) return found
    }
    return undefined
  }
  const element = node as Element
  if (match(element)) return element
  if (typeof element.type === 'function') {
    const component = element.type as (props: Record<string, unknown>) => unknown
    return findElement(component({ ...element.props, children: element.children }), match)
  }
  return findElement(element.children, match)
}

/** Every registration the bundle made. */
interface Registration {
  id: string
  factory: (require: (name: string) => unknown) => { apply: (ctx: unknown) => void }
}

/** What the stub client context recorded. */
interface Captured {
  slots: { name: string; key?: string; id?: string }[]
  components: ((props: Record<string, unknown>) => unknown)[]
  dictionaries: Record<string, Record<string, string>>
  effects: string[]
  definitions: ScanDefinition[]
}

/** The turn-data definition the bundle registers with the conversation engine. */
interface ScanDefinition {
  kind: string
  match(event: { type: string; data: Record<string, unknown> }): { id: string; role: string } | null
  start(context: unknown, match: unknown): { turn: number; scan: ScanTotals | null; messageId?: string | undefined }
  update(
    context: { state: { turn: number; scan: ScanTotals | null; messageId?: string | undefined } },
    match: { event: { type: string; seq: number; data: unknown } },
  ): { turn: number; scan: ScanTotals | null; messageId?: string | undefined }
  buildLocationData(context: { state: { turn: number; scan: ScanTotals | null } }, scope: string, previous: unknown): unknown
  /** The Chat node the Turn publishes, which is what a session-scoped surface reads. */
  buildViewNode(context: unknown): { data: Record<string, unknown> } | null
}

/** The registered scan definition of a fresh context. */
function scanDefinitionOf(captured: Captured): ScanDefinition {
  const definition = captured.definitions[0]
  assert.ok(definition !== undefined, 'the bundle must register its scan definition')
  return definition
}

/** Totals one scan record carries. */
interface ScanTotals {
  seq: number
  bytes: number
  folders: unknown[]
  foldersTotal: number
  truncated: boolean
}

/** The single registration the bundle made, resolved once. */
let loaded: Promise<Registration> | undefined

/** Load the browser bundle and return its registration plus a fresh stub context. */
async function loadBundle(): Promise<{ registration: Registration; captured: Captured }> {
  // A module executes once per process, so capture its registration on the first
  // import and hand the same one to every test.
  loaded ??= (async () => {
    const registrations: Registration[] = []
    ;(globalThis as { window?: unknown }).window = {
      __ModuleLoader__: { load: (entry: Registration) => { registrations.push(entry) } },
    }
    await import('../client/client.js')
    const registration = registrations[0]
    assert.ok(registration !== undefined, 'the bundle must register itself with __ModuleLoader__')
    return registration
  })()
  return {
    registration: await loaded,
    captured: { slots: [], components: [], dictionaries: {}, effects: [], definitions: [] },
  }
}

/**
 * Apply the bundle against a stub context and capture what it registered.
 * @param registration - the bundle registration under test.
 * @param captured - sink for what the stub context recorded.
 * @param primitives - what the frozen platform table answers for
 *   `@deepseek-ai/dsh-client-ui-primitives`; `null` stands for a deployment that
 *   shares no such module, which the bundle has to survive.
 */
function applyBundle(
  registration: Registration,
  captured: Captured,
  primitives: unknown | null = { Switch: HostSwitchStandIn },
): void {
  const ctx = {
    effect: (body: () => unknown, label?: string) => {
      captured.effects.push(label ?? 'effect')
      body()
    },
    locale: {
      register: (ns: string, dict: Record<string, Record<string, string>>) => {
        captured.dictionaries = dict
        return () => undefined
      },
      bind: () => (key: string, params?: Record<string, string>) => {
        const template = captured.dictionaries.en?.[key] ?? key
        return params === undefined
          ? template
          : template.replace(/\{(\w+)\}/g, (_match, name: string) => params[name] ?? `{${name}}`)
      },
    },
    slots: {
      inject: (_name: string, run: () => unknown) => run(),
      register: (definition: { name: string; key?: string; id?: string }, component: (props: Record<string, unknown>) => unknown) => {
        captured.slots.push(definition)
        captured.components.push(component)
        return () => undefined
      },
    },
    // Optional services resolve through `ctx.get`. The stub answers the two the
    // bundle asks for: the conversation registry, and — throwing — a settings
    // namespace an out-of-tree plugin is not guaranteed to have, which is the
    // fallback path both must survive.
    get: (name: string) => (name === 'uiConversation'
      ? {
        events: {
          register: (definition: ScanDefinition) => {
            captured.definitions.push(definition)
            return () => undefined
          },
        },
      }
      : { get: () => { throw new Error('no namespace') } }),
  }
  registration.factory((name: string) => {
    if (name === 'react') return React
    if (name === PLATFORM_PRIMITIVES) {
      if (primitives === null) throw new Error('platform module table has no primitives')
      return primitives
    }
    assert.fail(`the bundle must only ask the host table for React and the primitives; it asked for ${name}`)
  }).apply(ctx)
}

/** Flatten an element tree into its visible text, invoking function components. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const element = node as Element
  if (typeof element.type === 'function') {
    const component = element.type as (props: Record<string, unknown>) => unknown
    return textOf(component({ ...element.props, children: element.children }))
  }
  const own = textOf(element.children)
  const title = element.props.title
  return typeof title === 'string' ? `${own} ${title}` : own
}

/**
 * A stand-in for the seam's selector hook.
 *
 * `useTurnCard` is a `SnapshotSelectorHook`: the seam wraps the injected store in
 * `useSyncExternalStoreWithSelector` with whatever selector the component passed,
 * so a zero-argument call throws `selector is not a function`. A render that
 * throws takes the whole slot entry with it — the row leaves the page leaving only
 * one console error, which is exactly how this plugin's settings row went missing
 * in a real page. This stub refuses a missing selector for that reason.
 * @param value - the snapshot the injected store holds.
 * @returns a hook that requires a selector, as the seam's does.
 */
function selectorHook<T>(value: T): (selector: (snapshot: T) => unknown) => unknown {
  return (selector) => {
    if (typeof selector !== 'function') throw new TypeError('selector is not a function')
    return selector(value)
  }
}

/** The report tool's recorded content for one classified entry set. */
const REPORT = [
  '3 folders, 2516582 bytes',
  'folder\t2097152\t3\t/ws/build',
  'folder\t2048\t1\t/ws/node_modules',
  'folder\t420352\t1\t/ws/notes',
].join('\n')

test('the bundle registers itself and requires only React from the host table', async () => {
  const { registration, captured } = await loadBundle()
  assert.equal(registration.id, 'dsh-session-artifacts')
  applyBundle(registration, captured)
})

test('apply registers both cards, the settings row, and the locale namespace', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)

  assert.deepEqual(captured.slots.map(slot => slot.name), [
    'tool.call.toolview',
    'conversation.chat.assistant-actions',
    'settings.general.item',
    'conversation.composer.dock',
  ])
  assert.equal(captured.slots[0]?.key, 'session_artifacts_report')
  assert.equal(captured.slots[1]?.id, 'session-artifacts-turn')
  assert.equal(captured.slots[2]?.id, 'session-artifacts')
  assert.equal(captured.slots[3]?.id, 'session-artifacts')
  assert.equal(captured.effects.length, 2)
  assert.deepEqual(Object.keys(captured.dictionaries).sort(), ['en', 'zh'])
  assert.deepEqual(captured.definitions.map(definition => definition.kind), ['session-artifacts'])
})

test('the card renders folder totals and sizes from the report rows', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)

  const card = captured.components[0]
  assert.ok(card !== undefined)
  const text = textOf(card({
    phase: 'settled',
    block: { content: [{ type: 'text', text: REPORT }] },
  }))

  assert.match(text, /Workspace artifacts/u)
  assert.match(text, /3 folders · 2\.4 MB/u)
  assert.match(text, /\/ws\/node_modules/u)
  assert.match(text, /\/ws\/build/u)
  assert.match(text, /3 files/u)
  assert.match(text, /Ask the assistant to reclaim/u)
  assert.doesNotMatch(text, /ignored|build-directory|tool-authored/u)
})

test('the card does not render verdict or evidence columns', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  expandAll = true
  try {
    const text = textOf(captured.components[0]?.({
      phase: 'settled',
      block: { content: [{ type: 'text', text: REPORT }] },
    }))
    assert.match(text, /\/ws\/build/u)
    assert.doesNotMatch(text, /\b(?:keep|review)\b|ignored|tool-authored/u)
  } finally {
    expandAll = false
  }
})

test('the card names the reason it is not a complete list when the scan was bounded', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const text = textOf(captured.components[0]?.({
    phase: 'settled',
    block: { content: [{ type: 'text', text: `The scan stopped at a configured bound, so this list is partial.\n${REPORT}` }] },
  }))
  assert.match(text, /this list is partial/u)
})

test('the card shows an empty message when the scan found no folders', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const text = textOf(captured.components[0]?.({
    phase: 'settled',
    block: { content: [{ type: 'text', text: '0 folders, 0 bytes' }] },
  }))
  assert.match(text, /did not leave any new artifact folders/u)
})

test('a streaming call shows the reading placeholder rather than an empty card', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const text = textOf(captured.components[0]?.({ phase: 'preparing' }))
  assert.match(text, /Reading the workspace/u)
})

test('the Chinese dictionary covers every key the English one does', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const en = Object.keys(captured.dictionaries.en ?? {}).sort()
  const zh = Object.keys(captured.dictionaries.zh ?? {}).sort()
  assert.deepEqual(zh, en)
})

test('the scan definition claims turn starts and only this plugin record', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const definition = captured.definitions[0]
  assert.ok(definition !== undefined)

  assert.deepEqual(definition.match({ type: 'turn/start', data: { turn: 4 } }), { id: '4', role: 'start' })
  assert.deepEqual(definition.match({ type: 'plugin:session-artifacts/scan', data: { turn: 4 } }), { id: '4', role: 'update' })
  for (const type of ['turn/end', 'tool/call', 'plugin:other/record', 'workspace/changes']) {
    assert.equal(definition.match({ type, data: { turn: 4 } }), null, `${type} must not be claimed`)
  }
})

test('the scan definition folds one record into the turn and republishes only on change', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const definition = captured.definitions[0]
  assert.ok(definition !== undefined)

  const started = definition.start({}, {
    event: { type: 'turn/start', seq: 1, data: { turn: 7 } },
  }) as { turn: number; scan: ScanTotals | null }
  assert.deepEqual(started, { turn: 7, scan: null, messageId: undefined })

  const updated = definition.update({ state: started }, {
    event: {
      type: 'plugin:session-artifacts/scan', seq: 9,
      data: { turn: 7, bytes: 1024, folders: [], foldersTotal: 0, truncated: false },
    },
  })
  assert.equal(updated.scan?.bytes, 1024)
  assert.equal(updated.scan?.foldersTotal, 0)
  assert.equal(updated.scan?.seq, 9)

  // A record whose totals are not numbers is ignored rather than published as garbage.
  const ignored = definition.update({ state: started }, {
    event: { type: 'plugin:session-artifacts/scan', seq: 10, data: { turn: 7, bytes: 'lots' } },
  })
  assert.equal(ignored.scan, null)

  // A record carrying a head keeps it in the folded state, where the dock pill reads it.
  const withHead = definition.update({ state: started }, {
    event: {
      type: 'plugin:session-artifacts/scan', seq: 11,
      data: {
        turn: 7, bytes: 4096, folders: [{ path: 'target', bytes: 4096, files: 1 }], foldersTotal: 1, truncated: false,
      },
    },
  })
  assert.deepEqual((withHead.scan as { folders?: unknown }).folders, [
    { path: 'target', bytes: 4096, files: 1 },
  ])

  const published = definition.buildLocationData({ state: updated as never }, 'turn', null) as {
    kind: string; turn: number; key: string; value: ScanTotals
  }
  assert.equal(published.kind, 'turn')
  assert.equal(published.turn, 7)
  // The engine refuses a key that is not the Definition's own kind, and it throws
  // out of the flush that draws the transcript when it refuses: publishing a
  // friendlier spelling of the kind once blanked a whole Turn.
  assert.equal(published.key, definition.kind)
  assert.equal(published.value.bytes, 1024)

  // The same value republishes the previous object, so the engine keeps identity.
  const again = definition.buildLocationData({ state: updated as never }, 'turn', published)
  assert.equal(again, published)

  // A State whose Turn is not a publishable number produces no Location data at
  // all: the engine throws on `turn` it cannot use, and that throw lands in the
  // flush that draws the transcript.
  assert.equal(definition.buildLocationData({ state: { turn: null, scan: null } } as never, 'turn', null), null)
  assert.equal(definition.buildLocationData({ state: { turn: -1, scan: null } } as never, 'turn', null), null)
  // Step scope is not this Definition's business.
  assert.equal(definition.buildLocationData({ state: updated as never }, 'step', null), null)
})

/**
 * A chat snapshot in which one Turn published one reading, closing on one message.
 *
 * The payload is built by the Definition's own view-node builder rather than
 * hand-written here: the reading reads exactly what the assembler would publish,
 * so a field the builder drops cannot pass in this suite while failing in a page.
 * @param definition - the registered scan definition.
 * @param scan - the record payload the Turn's scan event carried.
 * @param turn - the Turn the message closed.
 * @param messageId - the finalized message the action row belongs to.
 * @returns the snapshot the reading resolves through.
 */
function snapshotForMessage(
  definition: ScanDefinition,
  scan: Record<string, unknown> | null,
  turn: number,
  messageId: string,
): unknown {
  let state = definition.start({}, { event: { type: 'turn/start', seq: 1, data: { turn } } })
  if (messageId !== '') {
    state = definition.update({ state }, {
      event: { type: 'assistant/message', seq: 2, data: { turn, message: { id: messageId } } },
    })
  }
  let published
  if (scan !== null) {
    state = definition.update({ state }, { event: { type: 'plugin:session-artifacts/scan', seq: 3, data: { turn, ...scan } } })
    published = definition.buildViewNode({
      state,
      key: `${turn}:session-artifacts`,
      id: String(turn),
      start: { event: { seq: 1 }, location: { kind: 'turn', turn } },
      matches: [],
    })
  }
  return {
    legacy: { turnEnds: new Map([[turn, 10]]), turnTimings: new Map() },
    nodes: {
      turnDataSource: (requested: number, kind: string) => {
        assert.equal(kind, 'session-artifacts')
        const data = published !== null && published !== undefined ? [published.data] : []
        return { getSnapshot: () => (requested === turn ? data : []) }
      },
    },
  }
}

test('the message reading reports what the turn wrote, not the Session footprint', async () => {
  // It sits beside that message's own usage line, so it answers one question —
  // how much did this turn write — and says only that: whether the space could be
  // reclaimed is the report tool's answer, asked for when the space matters.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const reading = captured.components[1]
  assert.ok(reading !== undefined)

  const quiet = textOf(reading({
    messageId: 'msg-1',
    useChat: selectorHook(snapshotForMessage(scanDefinitionOf(captured), { seq: 9, bytes: 162_529_280, turnBytes: 0, folders: [], foldersTotal: 0, truncated: false }, 4, 'msg-1')),
  }))
  assert.match(quiet, /Artifacts 0 B/u)
  assert.doesNotMatch(quiet, /reclaimable|regenerable|reclaim/u)

  const built = textOf(reading({
    messageId: 'msg-2',
    useChat: selectorHook(snapshotForMessage(scanDefinitionOf(captured), { seq: 10, bytes: 162_529_280, turnBytes: 3145728, folders: [], foldersTotal: 0, truncated: false }, 5, 'msg-2')),
  }))
  assert.match(built, /Artifacts 3\.0 MB/u)

  // A record from a Host older than the turn reading has only the footprint, and
  // the reading keeps printing something rather than disappearing.
  const legacy = textOf(reading({
    messageId: 'msg-3',
    useChat: selectorHook(snapshotForMessage(scanDefinitionOf(captured), { seq: 11, bytes: 3145728, folders: [], foldersTotal: 0, truncated: false }, 6, 'msg-3')),
  }))
  assert.match(legacy, /Artifacts 3\.0 MB/u)
})

test('the message reading opens the turn\'s own folders, not the Session footprint', async () => {
  // Both readings are the same disclosure over the same panel; what differs is the
  // list behind it. The dock opens the footprint, the reading opens what this turn
  // wrote — a footprint's `target/` would answer the wrong question.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const reading = captured.components[1]
  assert.ok(reading !== undefined)

  const rendered = reading({
    messageId: 'msg-1',
    useChat: selectorHook(snapshotForMessage(scanDefinitionOf(captured), {
      seq: 9,
      bytes: 162_529_280,
      turnBytes: 4_096,
      folders: [{ path: 'core/target', bytes: 162_529_280, files: 900 }],
      foldersTotal: 1,
      turnFolders: [{ path: 'artisan/target', bytes: 4_096, files: 3 }],
      turnFoldersTotal: 1,
      truncated: false,
    }, 4, 'msg-1')),
  })

  const trigger = findElement(rendered, element => element.props['data-session-artifacts'] === 'turn')
  assert.ok(trigger !== undefined, 'the reading is its own trigger')
  assert.equal(trigger.props['aria-haspopup'], 'dialog')
  assert.equal(trigger.props['aria-expanded'], false)

  // Closed, the panel is not in the tree: the number is all a reader sees until asked.
  assert.doesNotMatch(textOf(rendered), /artisan\/target/u)
  assert.equal(typeof trigger.props.onClick, 'function')
  ;(trigger.props.onClick as () => void)()

  expandAll = true
  try {
    const opened = reading({
      messageId: 'msg-1',
      useChat: selectorHook(snapshotForMessage(scanDefinitionOf(captured), {
        seq: 9,
        bytes: 162_529_280,
        turnBytes: 4_096,
        folders: [{ path: 'core/target', bytes: 162_529_280, files: 900 }],
        foldersTotal: 1,
        turnFolders: [{ path: 'artisan/target', bytes: 4_096, files: 3 }],
        turnFoldersTotal: 1,
        truncated: false,
      }, 4, 'msg-1')),
    })
    const panel = findElement(opened, element => element.props.role === 'dialog')
    assert.ok(panel !== undefined, 'the trigger must render the panel')
    const text = textOf(panel)
    assert.match(text, /artisan\/target/u, 'the turn\'s own folder')
    assert.doesNotMatch(text, /core\/target/u, 'and not the Session footprint\'s')
    assert.match(text, /1 folders · 4\.0 KB/u, 'the panel totals the turn, not the Session')
    assert.match(text, /本回合产生的产物|Artifacts this turn/u)
  } finally {
    expandAll = false
  }
})

test('the message reading stays out when the Host recorded no scan', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const reading = captured.components[1]
  assert.ok(reading !== undefined)
  // No seat, no snapshot, a message the transcript has no Turn tail for, and a
  // Turn that published nothing all render as no reading rather than as a throw.
  assert.equal(textOf(reading({ messageId: 'msg-1' })), '')
  assert.equal(textOf(reading({ messageId: 'msg-1', useChat: selectorHook(undefined) })), '')
  assert.equal(textOf(reading({ messageId: 'msg-1', useChat: selectorHook({ order: [], nodes: { get: () => undefined } }) })), '')
  assert.equal(textOf(reading({
    messageId: 'msg-1',
    useChat: selectorHook(snapshotForMessage(scanDefinitionOf(captured), null, 4, 'msg-1')),
  })), '')
})

test('turning the preference off removes the message reading', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const text = textOf(captured.components[1]?.({
    messageId: 'msg-1',
    useTurnCard: selectorHook(false),
    useChat: selectorHook(snapshotForMessage(scanDefinitionOf(captured), { seq: 9, bytes: 4096, turnBytes: 4096, folders: [], foldersTotal: 0, truncated: false }, 4, 'msg-1')),
  }))
  assert.equal(text, '')
})

/** The published payload the pill reads: totals plus the folders behind them. */
function publishedScan(bytes = 347780015): Record<string, unknown> {
  return {
    turn: 2, bytes, foldersTotal: 12, truncated: true,
    folders: [
      { path: 'artisan/target', bytes, files: 2 },
      {
        path: 'core/target', bytes: 1_400_000, files: 30,
        // The nested rows the Host writes: every level, each naming its parent.
        subfolders: [
          { path: 'core/target/classes', bytes: 89_000, files: 4, parent: 'core/target' },
          { path: 'core/target/classes/com', bytes: 89_000, files: 4, parent: 'core/target/classes' },
          { path: 'core/target/classes/com/aasp', bytes: 89_000, files: 4, parent: 'core/target/classes/com' },
        ],
      },
      { path: 'daemon/target', bytes: 7286400, files: 48 },
    ],
  }
}

/** A chat snapshot carrying one published scan under the given Turn. */
function snapshotWithScan(scan: unknown | undefined, turn = 2): unknown {
  const published = scan === undefined ? [] : [scan]
  return {
    legacy: { turnEnds: new Map([[1, 10], [turn, 20]]), turnTimings: new Map() },
    nodes: {
      turnDataSource: (requestedTurn: number, kind: string) => {
        assert.equal(kind, 'session-artifacts')
        return { getSnapshot: () => (requestedTurn === turn ? published : []) }
      },
    },
  }
}

test('the dock pill reads the newest scan the Session published', async () => {
  // The composer dock is session-scoped, so the pill reads the Session's Chat
  // snapshot through the seat that dock declares, and the totals this plugin
  // published as a Chat node for the newest Turn.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const pill = captured.components[3]
  assert.ok(pill !== undefined)

  const scan = publishedScan()
  const text = textOf(pill({ useChat: selectorHook(snapshotWithScan(scan)), useTurnCard: selectorHook(true) }))
  assert.match(text, /332 MB total/u)
  // The pill is one reading: how much was produced. Whether any of it can be
  // reclaimed is not shown here at all.
  assert.doesNotMatch(text, /reclaim/u)

  // Before any Turn published a scan there is nothing to read, so nothing renders.
  assert.equal(textOf(pill({ useChat: selectorHook(snapshotWithScan(undefined)), useTurnCard: selectorHook(true) })), '')
  // A seat with no Turn yet, or no seat at all, costs only the pill.
  assert.equal(textOf(pill({ useChat: selectorHook({ legacy: { turnEnds: new Map(), turnTimings: new Map() }, nodes: {} }), useTurnCard: selectorHook(true) })), '')
  assert.equal(textOf(pill({ useTurnCard: selectorHook(true) })), '')
  // The same switch hides the pill.
  assert.equal(textOf(pill({ useChat: selectorHook(snapshotWithScan(scan)), useTurnCard: selectorHook(false) })), '')

  // When a new Turn has started but has not yet finished scanning, the pill retains the newest available scan
  const inProgressSnapshot = {
    legacy: { turnEnds: new Map([[1, 10], [2, 20]]), turnTimings: new Map([[3, 30]]) },
    nodes: {
      turnDataSource: (requestedTurn: number, kind: string) => {
        assert.equal(kind, 'session-artifacts')
        return { getSnapshot: () => (requestedTurn === 2 ? [scan] : []) }
      },
    },
  }
  assert.match(textOf(pill({ useChat: selectorHook(inProgressSnapshot), useTurnCard: selectorHook(true) })), /332 MB total/u)
})

test('the pill is a dialog trigger, and its panel lists the folders behind the totals', async () => {
  // "0 B" with no way to see why is what made a reader distrust the reading. The
  // trigger opens the folders the bytes went to, largest first, with the file count
  // each folder's share covers — and no verdict, because the question here is only
  // how much was produced.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const pill = captured.components[3]
  assert.ok(pill !== undefined)

  // Closed, the panel is not in the tree: the summary is all a reader sees until asked.
  const rendered = pill({ useChat: selectorHook(snapshotWithScan(publishedScan())), useTurnCard: selectorHook(true) })
  const trigger = findElement(rendered, element => element.props['aria-haspopup'] === 'dialog')
  assert.ok(trigger !== undefined, 'a pill carrying folders must open a dialog')
  assert.equal(trigger.props['aria-expanded'], false)
  assert.doesNotMatch(textOf(rendered), /artisan\/target/u)
  assert.equal(typeof trigger.props.onClick, 'function')

  // The stand-in reports every disclosure as expanded, which is how this suite opens
  // one: the same pill then renders the folders behind its totals.
  expandAll = true
  try {
    const opened = pill({ useChat: selectorHook(snapshotWithScan(publishedScan())), useTurnCard: selectorHook(true) })
    const panel = findElement(opened, element => element.props.role === 'dialog')
    assert.ok(panel !== undefined, 'the trigger must render the panel')
    const text = textOf(panel)
    assert.match(text, /artisan\/target/u)
    assert.match(text, /core\/target/u)
    assert.match(text, /332 MB/u)
    assert.match(text, /2 files/u)
    assert.doesNotMatch(text, /\b(?:keep|review)\b/u)
  } finally {
    expandAll = false
  }
})

test('a panel separates the workspace from the roots outside it', async () => {
  // One total is not enough once a Session writes outside its workspace: the
  // reader has to see which part is the workspace and which part is a root the
  // Session named, or two rows named `target` look like the same folder.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const pill = captured.components[3]
  assert.ok(pill !== undefined)
  const scan = {
    ...publishedScan(1_500),
    root: '/ws',
    bytes: 1_500,
    workspaceBytes: 1_000,
    foldersTotal: 2,
    roots: [
      { path: '/ws', label: '', origin: 'workspace', bytes: 1_000, files: 2 },
      { path: '/tmp/memcmp', label: '/tmp/memcmp', origin: 'tool-argument', bytes: 500, files: 1 },
    ],
    folders: [
      { path: 'target', bytes: 1_000, files: 2, root: '/ws' },
      { path: '/tmp/memcmp', bytes: 500, files: 1, root: '/tmp/memcmp' },
    ],
  }
  expandAll = true
  try {
    const panel = findElement(
      pill({ useChat: selectorHook(snapshotWithScan(scan)), useTurnCard: selectorHook(true) }),
      element => element.props.role === 'dialog',
    )
    assert.ok(panel !== undefined)
    const text = textOf(panel)
    assert.match(text, /Workspace 1000 B · outside 500 B/u)
    assert.match(text, /Outside the workspace · \/tmp\/memcmp/u)
    assert.match(text, /target/u)
  } finally {
    expandAll = false
  }
})

test('the pill dismisses the panel when clicking outside or pressing Escape', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const pill = captured.components[3]
  assert.ok(pill !== undefined)

  const listeners: Record<string, Array<(event: unknown) => void>> = {}
  const fakeDoc = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = listeners[type] ?? []
      listeners[type].push(fn)
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = listeners[type]?.filter(f => f !== fn) ?? []
    },
    body: {},
  }
  const originalDoc = (globalThis as unknown as Record<string, unknown>).document
  ;(globalThis as unknown as Record<string, unknown>).document = fakeDoc

  try {
    expandAll = true
    recordedEffects = []
    let closedWith: unknown = null
    stateSetter = (v) => { closedWith = v }

    const opened = pill({ useChat: selectorHook(snapshotWithScan(publishedScan())), useTurnCard: selectorHook(true) })
    findElement(opened, () => false)
    assert.equal(recordedEffects.length, 1)

    const cleanup = recordedEffects[0]()
    assert.ok(typeof cleanup === 'function')
    assert.equal(listeners['keydown']?.length, 1)
    assert.equal(listeners['pointerdown']?.length, 1)

    // Escape closes the panel
    listeners['keydown'][0]({ key: 'Escape' })
    assert.equal(closedWith, false)

    // Outside pointerdown closes the panel
    closedWith = null
    const outsideTarget = { contains: () => false }
    listeners['pointerdown'][0]({ target: outsideTarget })
    assert.equal(closedWith, false)

    // Unregistering removes the listeners
    cleanup()
    assert.equal(listeners['keydown']?.length, 0)
    assert.equal(listeners['pointerdown']?.length, 0)
  } finally {
    expandAll = false
    stateSetter = null
    recordedEffects = []
    if (originalDoc !== undefined) {
      ;(globalThis as unknown as Record<string, unknown>).document = originalDoc
    } else {
      delete (globalThis as unknown as Record<string, unknown>).document
    }
  }
})

test('a pill with no entries behind it stays a plain reading', async () => {
  // Totals with no rows would open an empty dialog, so the control stays static.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const pill = captured.components[3]
  assert.ok(pill !== undefined)

  const empty = { ...publishedScan(0), folders: [], foldersTotal: 0 }
  const rendered = pill({ useChat: selectorHook(snapshotWithScan(empty)), useTurnCard: selectorHook(true) })
  assert.equal(findElement(rendered, element => element.props['aria-haspopup'] === 'dialog'), undefined)
  assert.match(textOf(rendered), /0 B/u)
})

test('the definition records the turn\'s closing message so the reading can find it', async () => {
  // The action row hands its entries a message id and nothing else, so the
  // published payload has to be findable by that id: the Definition notes the
  // Turn's own `assistant/message` and carries it into the record it publishes.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const definition = captured.definitions[0]
  assert.ok(definition !== undefined)
  assert.deepEqual(
    definition.match({ type: 'assistant/message', data: { turn: 7, message: { id: 'msg-7' } } } as never),
    { id: '7', role: 'update' },
  )

  const started = definition.start({}, { event: { type: 'turn/start', seq: 1, data: { turn: 7 } } }) as Record<string, unknown>
  const messaged = definition.update({ state: started }, {
    event: { type: 'assistant/message', seq: 8, data: { turn: 7, message: { id: 'msg-7' } } },
  }) as Record<string, unknown>
  assert.equal(messaged.messageId, 'msg-7')

  const recorded = definition.update({ state: messaged }, {
    event: {
      type: 'plugin:session-artifacts/scan', seq: 9,
      data: { turn: 7, bytes: 1024, turnBytes: 1024, folders: [], foldersTotal: 0, truncated: false },
    },
  }) as { scan: Record<string, unknown> | null }
  assert.equal(recorded.scan?.messageId, 'msg-7', 'the published payload carries the message it belongs to')

  // A turn that never reported a message publishes without the key rather than
  // with a null one, so the reading simply finds nothing for it.
  const plain = definition.update({ state: started }, {
    event: {
      type: 'plugin:session-artifacts/scan', seq: 10,
      data: { turn: 7, bytes: 8, folders: [], foldersTotal: 0, truncated: false },
    },
  }) as { scan: Record<string, unknown> | null }
  assert.equal('messageId' in (plain.scan ?? {}), false)
})

test('the definition publishes a hidden Chat node for a Turn that has a scan', async () => {
  // This node is what makes the totals readable outside their own Turn: the Chat
  // view files it under the Turn that opened the Context, and any entry in the
  // Session reads it back through `nodes.turnDataSource`.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const definition = captured.definitions[0]
  assert.ok(definition !== undefined)
  assert.equal(definition.target, 'chat')

  const state = { turn: 4, scan: { seq: 9, bytes: 2048, folders: [], foldersTotal: 0, truncated: true } }
  const context = {
    key: '17:session-artifacts4',
    id: '4',
    state,
    matches: [],
    start: { event: { seq: 7 }, location: { kind: 'turn', turn: 4 } },
  }
  const node = (definition as unknown as { buildViewNode(context: unknown): Record<string, unknown> | null }).buildViewNode(context)
  assert.ok(node !== null)
  assert.equal(node['kind'], 'session-artifacts')
  assert.equal(node['target'], 'chat')
  assert.equal(node['key'], context.key)
  assert.equal(node['anchorSeq'], 7)
  assert.deepEqual(node['location'], { kind: 'turn', turn: 4 })
  // Hidden: it is a reading, not a message.
  assert.equal(node['visibility'], 'hidden')
  assert.deepEqual(node['data'], {
    // A scan with no bound fact carries `truncation: null` rather than dropping
    // the key, so every reader sees one shape from a record and from a Chat node.
    // The turn's own folder list travels the same way, because the per-message
    // reading opens it and the published data is what that reading reads.
    turn: 4, root: undefined, bytes: 2048, folders: [], foldersTotal: 0,
    turnFolders: [], turnFoldersTotal: 0, truncated: true, truncation: null,
  })

  // Folder rows travel with the totals because the dock pill opens them.
  const withHead = { turn: 4, scan: { ...state.scan, folders: [
    { path: 'target', bytes: 150_000_000, files: 42 },
  ], foldersTotal: 1 } }
  const carried = (definition as unknown as { buildViewNode(context: unknown): Record<string, unknown> | null })
    .buildViewNode({ ...context, state: withHead })
  assert.ok(carried !== null)
  assert.deepEqual((carried['data'] as Record<string, unknown>)['folders'], withHead.scan.folders)

  // A Turn with no scan yet, or a Turn the engine cannot publish, produces no node.
  const build = (state: unknown, start: unknown) => (definition as unknown as {
    buildViewNode(context: unknown): unknown
  }).buildViewNode({ key: 'k', id: '1', state, matches: [], start })
  assert.equal(build({ turn: 4, scan: null }, context.start), null)
  assert.equal(build({ turn: null, scan: state.scan }, context.start), null)
  assert.equal(build(state, undefined), null)
})

/** Collect every `button` element in a rendered tree, invoking function components. */
function buttons(node: unknown, found: Element[] = []): Element[] {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    node.forEach(child => buttons(child, found))
    return found
  }
  const element = node as Element
  if (typeof element.type === 'function') {
    const component = element.type as (props: Record<string, unknown>) => unknown
    return buttons(component({ ...element.props, children: element.children }), found)
  }
  if (element.type === 'button') found.push(element)
  buttons(element.children, found)
  return found
}

/** Collect every element in a rendered tree, invoking function components. */
function allElements(node: unknown, found: Element[] = []): Element[] {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    node.forEach(child => allElements(child, found))
    return found
  }
  const element = node as Element
  if (typeof element.type === 'function') {
    const component = element.type as (props: Record<string, unknown>) => unknown
    return allElements(component({ ...element.props, children: element.children }), found)
  }
  found.push(element)
  allElements(element.children, found)
  return found
}

test('the settings row names the feature and renders the shell switch', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const row = captured.components[2]
  assert.ok(row !== undefined)

  const props = { useTurnCard: selectorHook(true), setTurnCard: () => undefined }
  const text = textOf(row(props))
  assert.match(text, /Session artifacts/u)
  assert.match(text, /Show what each turn writes in the workspace/u)

  // The control is the shell's own switch, not a button pair of this bundle's
  // invention: the row passes it the state, the writer, and an accessible name.
  const control = findElement(row(props), element => element.props['data-host-switch'] === 'yes')
  assert.ok(control !== undefined, 'the row must render the shell switch')
  assert.equal(control.props.checked, true)
  assert.equal(control.props.label, 'Session artifacts')
  assert.equal(typeof control.props.onChange, 'function')
})

test('the switch writes the value the click asks for', async () => {
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const row = captured.components[2]
  assert.ok(row !== undefined)

  const wrote: boolean[] = []
  const setTurnCard = (value: boolean): void => { wrote.push(value) }
  const change = (checked: boolean): ((next: boolean) => void) => {
    const control = findElement(row({ useTurnCard: selectorHook(checked), setTurnCard }),
      element => element.props['data-host-switch'] === 'yes')
    assert.ok(control !== undefined)
    return control.props.onChange as (next: boolean) => void
  }

  // The switch reports the state it wants next, never the state it holds.
  change(true)(false)
  change(false)(true)
  assert.deepEqual(wrote, [false, true])
})

test('a deployment sharing no primitives still gets a switch', async () => {
  // The platform module table is the shell's, and an older shell may not share
  // this module. The row then draws its own switch: a control of the same shape
  // and role, not two text buttons and not nothing.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured, null)
  const row = captured.components[2]
  assert.ok(row !== undefined)

  const wrote: boolean[] = []
  const rendered = row({ useTurnCard: selectorHook(true), setTurnCard: (value: boolean) => { wrote.push(value) } })
  const control = findElement(rendered, element => element.props.role === 'switch')
  assert.ok(control !== undefined, 'the fallback must still be a switch')
  assert.equal(control.props['aria-checked'], true)
  assert.equal(control.props['aria-label'], 'Session artifacts')
  ;(control.props.onClick as () => void)()
  assert.deepEqual(wrote, [false])
})

test('the settings row states that the card reads a plugin record', async () => {
  // The card cannot tell whether the running runtime exposes the plugin-record
  // API, so the row is the one place a reader can learn why no card appears on a
  // runtime that does not. Both dictionaries have to say it.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const row = captured.components[2]
  assert.ok(row !== undefined)

  const text = textOf(row({ useTurnCard: selectorHook(true), setTurnCard: () => undefined }))
  assert.match(text, /plugin record written by the Host/u)
  assert.match(captured.dictionaries.zh?.['settings.detail'] ?? '', /插件记录/u)
})

test('a report note about the missing record API changes nothing the card renders', async () => {
  // The Host adds that line only on a runtime without the plugin-record API. The
  // card parses four-column rows, so the note must pass through it unnoticed.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const card = captured.components[0]
  assert.ok(card !== undefined)

  const [totals, ...rows] = REPORT.split('\n')
  const note = 'Per-turn card unavailable: this runtime exposes no plugin record API, '
    + 'so the Host cannot record one scan per turn. The scan itself still runs, and this report is unaffected.'
  const text = textOf(card({
    phase: 'settled',
    block: { content: [{ type: 'text', text: [totals, note, ...rows].join('\n') }] },
  }))

  assert.match(text, /3 folders · 2\.4 MB/u)
  assert.match(text, /\/ws\/node_modules/u)
  assert.match(text, /\/ws\/build/u)
})

test('no button pair is left over from the text-button control', async () => {
  // The row used to offer 开/关 as two buttons. Nothing should render them now:
  // the switch is the only control, in either deployment shape.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const row = captured.components[2]
  assert.ok(row !== undefined)

  const props = { useTurnCard: selectorHook(true), setTurnCard: () => undefined }
  assert.equal(buttons(row(props)).length, 0)
  assert.equal(textOf(row(props)).includes('Off'), false)
})

test('the turn definition never throws at the engine that folds the transcript', async () => {
  // The assembler folds every registered Definition while it materializes a Turn,
  // so a Definition that throws fails the fold that draws the transcript — a blank
  // conversation while the Host keeps streaming. Hostile inputs stand in for a
  // runtime whose event shapes differ from this build's expectations.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const definition = captured.definitions[0]
  assert.ok(definition !== undefined)

  const hostile = [{}, { type: 'turn/start' }, { type: 'plugin:session-artifacts/scan' }, { data: {} }]
  for (const event of hostile) {
    assert.equal(definition.match(event as never), null)
  }
  assert.deepEqual(definition.start({}, {} as never), { turn: null, scan: null, messageId: undefined })
  assert.deepEqual(definition.update({ state: { turn: 2, scan: null } }, {} as never), { turn: 2, scan: null })
  assert.equal(definition.buildLocationData({} as never, 'turn', null), null)
  assert.equal(definition.buildLocationData({ state: undefined } as never, 'turn', null), null)
})

test('a reading that cannot build renders nothing instead of throwing', async () => {
  // Both surfaces live inside the conversation. A failure in either must cost the
  // reader that reading, not the transcript or the composer row.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)

  const broken = { t: () => { throw new Error('no locale') }, messageId: 'msg-1' } as Record<string, unknown>
  assert.equal(textOf(captured.components[0]?.(broken) ?? null), '')
  assert.equal(textOf(captured.components[1]?.(broken) ?? null), '')
  assert.equal(textOf(captured.components[3]?.(broken) ?? null), '')

  // An entry whose seam supplies no preference seat still renders the reading, and
  // the message's own Turn answers the value this Definition published.
  const reading = captured.components[1]
  assert.ok(reading !== undefined)
  const rendered = reading({
    messageId: 'msg-1',
    useChat: selectorHook(snapshotForMessage(scanDefinitionOf(captured), { seq: 1, bytes: 2048, turnBytes: 2048, folders: [], foldersTotal: 0, truncated: false }, 3, 'msg-1')),
  })
  assert.match(textOf(rendered), /Artifacts 2\.0 KB/u)
})

/** One request the bundle made to the Host. */
interface HostCall {
  url: string
  app: string
  path: string
}

/** Let the open path's two awaits settle: the route answer, then the open post. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Stand in for the browser's `fetch`, answering the two routes the open path uses.
 * @param target - what `session-artifacts/open-target` answers; `undefined` answers 404.
 * @param fails - whether that route rejects instead, as an unreachable Host would.
 * @returns the recorded calls and a restore.
 */
function stubFetch(target?: unknown, fails = false): { calls: HostCall[]; restore: () => void } {
  const calls: HostCall[] = []
  const globals = globalThis as unknown as Record<string, unknown>
  const original = globals.fetch
  globals.fetch = async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { app: string; path: string }
    calls.push({ url, app: body.app, path: body.path })
    if (url !== 'session-artifacts/open-target') return { ok: true, json: async () => ({ ok: true }) }
    if (fails) throw new Error('host unreachable')
    return target === undefined
      ? { ok: false, json: async () => ({ code: 'not-found' }) }
      : { ok: true, json: async () => target }
  }
  return {
    calls,
    restore: () => {
      if (original === undefined) delete globals.fetch
      else globals.fetch = original
    },
  }
}

/**
 * Stand in for the remembered application choice the header's Open In control stores.
 * @param app - the remembered catalog id; `undefined` stores nothing.
 * @returns a restore.
 */
function stubChoice(app?: string): () => void {
  const globals = globalThis as unknown as Record<string, unknown>
  const original = globals.localStorage
  globals.localStorage = { getItem: () => (app === undefined ? null : JSON.stringify(app)) }
  return () => {
    if (original === undefined) delete globals.localStorage
    else globals.localStorage = original
  }
}

/** Click the first folder row's open control and let the handler finish. */
async function clickOpen(component: (props: Record<string, unknown>) => unknown): Promise<void> {
  const rendered = component({ useChat: selectorHook(snapshotWithScan({ ...publishedScan(), root: '/ws' })), useTurnCard: selectorHook(true) })
  const button = findElement(rendered, element =>
    typeof element.props.title === 'string' && element.props.title.startsWith('Open in default application'))
  assert.ok(button !== undefined, 'a folder row must offer the open control')
  ;(button.props.onClick as (event: unknown) => void)({ stopPropagation: () => undefined })
  await settle()
}

test('the open control hands the host the path the chosen application receives', async () => {
  // The Host owns the rule that an IntelliJ IDE receives the clicked folder's
  // project root, because only the Host can read the filesystem. The bundle asks
  // and then posts that answer to the open endpoint.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const pill = captured.components[3]
  assert.ok(pill !== undefined)

  const fetcher = stubFetch({ path: '/ws/project' })
  const choice = stubChoice('intellij')
  expandAll = true
  try {
    await clickOpen(pill)
    assert.deepEqual(fetcher.calls, [
      { url: 'session-artifacts/open-target', app: 'intellij', path: '/ws/artisan/target' },
      { url: 'open-in-app/open', app: 'intellij', path: '/ws/project' },
    ])
  } finally {
    expandAll = false
    choice()
    fetcher.restore()
  }
})

test('a host that cannot answer the open-target route opens the clicked folder', async () => {
  // A runtime older than this plugin, a headless deployment, a rejected request
  // and an unreachable Host all look the same from the browser: no usable answer.
  // The click then has to mean exactly what it meant before the route existed.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const pill = captured.components[3]
  assert.ok(pill !== undefined)

  const shapes: { target?: unknown; fails?: boolean }[] = [
    { target: undefined },
    { target: undefined, fails: true },
    { target: {} },
    { target: { path: '' } },
    { target: { path: 7 } },
  ]
  for (const shape of shapes) {
    const fetcher = stubFetch(shape.target, shape.fails ?? false)
    const choice = stubChoice('intellij')
    expandAll = true
    try {
      await clickOpen(pill)
      assert.deepEqual(fetcher.calls, [
        { url: 'session-artifacts/open-target', app: 'intellij', path: '/ws/artisan/target' },
        { url: 'open-in-app/open', app: 'intellij', path: '/ws/artisan/target' },
      ], `shape ${JSON.stringify(shape)} must keep the clicked folder`)
    } finally {
      expandAll = false
      choice()
      fetcher.restore()
    }
  }
})

test('each folder row asks about the path it names', async () => {
  // One control per row, at every level: the question is about that row's own
  // path, so a nested row opens the nested directory rather than the top folder
  // the reader started from.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const pill = captured.components[3]
  assert.ok(pill !== undefined)

  const fetcher = stubFetch({ path: '/ws/project' })
  const choice = stubChoice('intellij')
  expandAll = true
  try {
    const rendered = pill({ useChat: selectorHook(snapshotWithScan({ ...publishedScan(), root: '/ws' })), useTurnCard: selectorHook(true) })
    const controls = allElements(rendered).filter(element =>
      typeof element.props.title === 'string' && element.props.title.startsWith('Open in default application'))
    // Every rendered row carries one: the three top folders and every level under
    // them, since this suite's stand-in reports every disclosure as expanded.
    assert.ok(controls.length > publishedScan().folders.length, 'nested rows carry controls too')
    // Row titles carry the workspace-relative path; the click resolves it against
    // the root, which is what the Host is asked to open.
    const nested = controls.find(control => String(control.props.title).includes('core/target/classes/com/'))
    assert.ok(nested !== undefined, 'a nested row carries its own control')
    ;(nested.props.onClick as (event: unknown) => void)({ stopPropagation: () => undefined })
    await settle()
    assert.match(String(fetcher.calls[0]?.path), /^\/ws\/core\/target\/classes\/com\//u)
  } finally {
    expandAll = false
    choice()
    fetcher.restore()
  }
})

/** The turn card's rendered reading for one scan record. */
function turnCardText(component: (props: Record<string, unknown>) => unknown, scan: Record<string, unknown>): string {
  return textOf(component({ turn: { data: { get: () => scan } } }))
}

test('the tool card takes the bound from the report row the Host wrote', async () => {
  // The tool card draws the Host's own report, so the bound arrives as the
  // `truncated` row beside the sentence; a Host that wrote only the sentence
  // leaves the card with the generic line.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const card = captured.components[0]
  assert.ok(card !== undefined)

  const rows = [
    'The scan stopped at its record bound: 799 records against 200, so this list is partial.',
    'truncated\tmaxRecords\t200\t799',
    '3 folders, 2516582 bytes',
    'folder\t2097152\t3\t/ws/build',
  ].join('\n')
  const named = textOf(card({ phase: 'settled', block: { content: [{ type: 'text', text: rows }] } }))
  assert.match(named, /The scan stopped at its 200-record bound after 799 records/u)

  const legacy = textOf(card({
    phase: 'settled',
    block: { content: [{ type: 'text', text: ['The scan stopped at a configured bound, so this list is partial.', '3 folders, 2516582 bytes'].join('\n') }] },
  }))
  assert.match(legacy, /The scan stopped at a configured bound/u)
})


test('the tool card reads the root bound and the workspace split', async () => {
  // Two rows the Host writes for a scan that left the workspace: the bound that
  // stopped it, and how much of the total belongs to the workspace itself.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const card = captured.components[0]
  assert.ok(card !== undefined)
  const rows = [
    'truncated\tmaxRoots\t8\t10',
    'split\t1000\t1500',
    '2 folders, 1500 bytes',
    'folder\t1000\t2\ttarget',
    'folder\t500\t1\t/tmp/memcmp',
  ].join('\n')
  const text = textOf(card({ phase: 'settled', block: { content: [{ type: 'text', text: rows }] } }))
  assert.match(text, /8-root bound after 10 roots/u)
  assert.match(text, /Workspace 1000 B · outside 500 B/u)
})

test('the reading is labelled 产物 in both dictionaries, without the turn wording', async () => {
  // The row already reads as this message's own metadata, so the label does not
  // spend two characters saying "this turn": it names the subject, like the
  // Session total in the dock does.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  assert.equal(captured.dictionaries.zh?.['turn.pill'], '产物 {total}')
  assert.equal(captured.dictionaries.en?.['turn.pill'], 'Artifacts {total}')
  assert.equal(captured.dictionaries.zh?.['pill.total'], '总产物 {total}')
})

test('a partial scan says so in the reading it cannot fit a notice into', async () => {
  // The row is icons and glyphs, so the reading carries no room for a banner: the
  // sentence the turn card used to print now lives in its tooltip, named bound and
  // all, and the reading itself stays exactly as wide as its number.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const reading = captured.components[1]
  assert.ok(reading !== undefined)

  const truncated = reading({
    messageId: 'msg-1',
    useChat: selectorHook(snapshotForMessage(scanDefinitionOf(captured), {
      seq: 9, bytes: 162_529_280, turnBytes: 162_529_280, folders: [], foldersTotal: 2, truncated: true,
      truncation: { reason: 'maxRecords', limit: 200, observed: 799 },
    }, 4, 'msg-1')),
  })
  const element = findElement(truncated, node => node.props['data-session-artifacts'] === 'turn')
  assert.ok(element !== undefined)
  assert.match(String(element.props.title), /The scan stopped at its 200-record bound after 799 records/u)
  // The reading itself stays exactly as wide as its number: the notice lives only
  // in the tooltip, which this suite's text helper folds in after the label.
  assert.match(textOf(truncated), /^Artifacts 155 MB/u)

  const complete = reading({
    messageId: 'msg-2',
    useChat: selectorHook(snapshotForMessage(scanDefinitionOf(captured), { seq: 10, bytes: 1_024, turnBytes: 1_024, folders: [], foldersTotal: 0, truncated: false }, 5, 'msg-2')),
  })
  const plain = findElement(complete, node => node.props['data-session-artifacts'] === 'turn')
  assert.equal(plain?.props.title, 'What this turn wrote in the workspace')
})

test('expanding a folder shows its own directories, each labelled with its own name', async () => {
  // The reader asked for a file manager's levels, not one flat list of full paths:
  // expanding `core/target` must show `classes`, and expanding that must show `com`
  // — each row carrying its own name, with the full path left in the tooltip.
  const { registration, captured } = await loadBundle()
  applyBundle(registration, captured)
  const pill = captured.components[3]
  assert.ok(pill !== undefined)

  const scan = {
    turn: 1,
    root: '/ws',
    bytes: 1_779_000,
    foldersTotal: 1,
    truncated: false,
    folders: [{
      path: 'core/target',
      bytes: 1_779_000,
      files: 3,
      subfolders: [
        { path: 'core/target/classes', bytes: 379_000, files: 2, parent: 'core/target' },
        { path: 'core/target/classes/com', bytes: 379_000, files: 2, parent: 'core/target/classes' },
        { path: 'core/target/classes/com/aasp', bytes: 379_000, files: 2, parent: 'core/target/classes/com' },
        { path: 'core/target/classes/com/aasp/order', bytes: 189_000, files: 1, parent: 'core/target/classes/com/aasp' },
      ],
    }],
  }

  expandAll = true
  try {
    const panel = findElement(
      pill({ useChat: selectorHook(snapshotWithScan(scan)), useTurnCard: selectorHook(true) }),
      element => element.props.role === 'dialog',
    )
    assert.ok(panel !== undefined, 'the pill must render the panel')

    // Every level is its own row, and a row's label is its own directory name.
    const labels = allElements(panel)
      .filter(element => typeof element.props['data-folder-row'] === 'string')
      .map(element => element.props['data-folder-row'])
    assert.deepEqual(labels, ['core/target', 'classes', 'com', 'aasp', 'order'])

    // The full path travels in the tooltip and in the open button's title.
    const rows = allElements(panel).filter(element => typeof element.props['data-folder-row'] === 'string')
    assert.equal(rows[1]?.props.title, 'core/target/classes')
    const openButtons = allElements(panel)
      .filter(element => typeof element.props.title === 'string' && element.props.title.startsWith('Open in default application'))
    assert.ok(openButtons.some(button => button.props.title.includes('core/target/classes/com')), 'a deep row still opens its own directory')
    // Totals stay the directory's own subtree reading, not a re-summed one.
    assert.match(textOf(panel), /370 KB|379 KB|380 KB/u)

    // A record from a Host older than the parent column lists the same directories
    // without naming their level; the tree is then read off the paths, so those
    // rows still open one level at a time instead of arriving as one long path.
    const legacy = {
      ...scan,
      folders: [{
        path: 'core/target',
        bytes: 1_779_000,
        files: 3,
        subfolders: [{ path: 'core/target/classes/com/aasp/order', bytes: 189_000, files: 1 }],
      }],
    }
    const legacyPanel = findElement(
      pill({ useChat: selectorHook(snapshotWithScan(legacy)), useTurnCard: selectorHook(true) }),
      element => element.props.role === 'dialog',
    )
    assert.ok(legacyPanel !== undefined)
    assert.deepEqual(
      allElements(legacyPanel)
        .filter(element => typeof element.props['data-folder-row'] === 'string')
        .map(element => element.props['data-folder-row']),
      ['core/target', 'classes', 'com', 'aasp', 'order'],
    )
  } finally {
    expandAll = false
  }
})
