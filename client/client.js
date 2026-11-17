/**
 * Browser half of the session artifact ledger.
 *
 * This is a plain-JS client bundle, not a compiled one: the Web page loads it
 * through `window.__ModuleLoader__`, and React arrives from the host's module
 * table. Nothing here reaches the model.
 *
 * Two surfaces share one dictionary: a turn card reading the durable
 * `plugin:session-artifacts/scan` record the Host commits at the end of each
 * turn, and a card for a finished `session_artifacts_report` call.
 *
 * The tool card reads the report tool's rendered rows rather than a structured
 * value, because a tool view receives the recorded content and not the tool's
 * return value. The row grammar is therefore fixed on both sides: a totals line,
 * then `folder<TAB>bytes<TAB>files<TAB>path` per folder.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-artifacts',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * The shell's switch, when the platform module table shares one.
     *
     * The table is frozen and small — React, the client store, the slot core and
     * the primitives — and it is the only thing a fetched bundle can require
     * besides its own graph rows. A deployment that shares no primitives module
     * leaves this undefined on purpose: the row then draws its own switch rather
     * than borrowing React for a hand-rolled button pair.
     */
    const primitives = (() => {
      try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return undefined }
    })()
    const HostSwitch = typeof primitives?.Switch === 'function' ? primitives.Switch : undefined
    /** The shell's portal, when it shares one; the panel falls back to its own anchor. */
    const createPortal = (() => {
      try {
        const reactDom = require('react-dom')
        return typeof reactDom?.createPortal === 'function' ? reactDom.createPortal : undefined
      } catch {
        return undefined
      }
    })()

    const NS = 'session-artifacts'

    /** Whether the dock pill already reported a seat it could not read. */
    let pillSeatReported = false

    const DICT = {
      en: {
        'report.title': 'Workspace artifacts',
        'report.totals': '{folders} folders · {total}',
        'report.split': 'Workspace {workspace} · outside {external}',
        'report.truncated.roots': 'The scan stopped at its {limit}-root bound after {observed} roots, so this list is partial.',
        'report.empty': 'This Session did not leave any new artifact folders.',
        'report.truncated': 'The scan stopped at a configured bound, so this list is partial.',
        'report.truncated.records': 'The scan stopped at its {limit}-record bound after {observed} records, so this list is partial.',
        'report.truncated.timeout': 'The scan stopped at its {limit} ms deadline after {observed} ms, so this list is partial.',
        'report.truncated.directories': 'The scan stopped at its {limit}-directory bound after {observed} directories, so this list is partial.',
        'report.hint': 'Ask the assistant to reclaim a folder when you want the space back.',
        'turn.pill': 'Artifacts {total}',
        'row.files': '{files} files',
        'row.preparing': 'Reading the workspace…',
        'settings.title': 'Session artifacts',
        'settings.detail': 'Show what each turn writes in the workspace, beside that message\u2019s own usage, and what the Session holds in the dock pill. Both read a plugin record written by the Host.',
        'pill.title': 'Space this Session has left in the workspace, from the latest scan',
        'turn.pill.title': 'What this turn wrote in the workspace',
        'panel.title': 'Workspace artifacts',
        'panel.turn.title': 'Artifacts this turn',
        'panel.totals': '{folders} folders · {total}',
        'panel.files': '{files} files',
        'panel.more': 'showing the {shown} largest folders of {total}',
        'panel.hint': 'Ask the assistant to reclaim a folder when you want the space back.',
        'pill.total': '{total} total',
        'panel.open': 'Open in default application: {path}',
        'panel.external': 'Outside the workspace · {path}',
      },
      zh: {
        'report.title': '本会话产生的产物',
        'report.totals': '{folders} 个文件夹 · {total}',
        'report.split': '工作区 {workspace} · 工作区外 {external}',
        'report.truncated.roots': '一次扫描最多登记 {limit} 个根，已尝试 {observed} 个，这份清单不完整。',
        'report.empty': '本会话没有产生新的产物文件夹。',
        'report.truncated': '扫描触发了上限，这份清单不完整。',
        'report.truncated.records': '一次扫描最多记录 {limit} 条，本回合已记录 {observed} 条，这份清单不完整。',
        'report.truncated.timeout': '一次扫描最长 {limit} 毫秒，本次已用 {observed} 毫秒，这份清单不完整。',
        'report.truncated.directories': '一次扫描最多访问 {limit} 个目录，已访问 {observed} 个，这份清单不完整。',
        'report.hint': '需要释放空间时，让助手根据文件夹大小决定如何回收。',
        'turn.pill': '产物 {total}',
        'row.files': '{files} 个文件',
        'row.preparing': '正在读取工作区…',
        'settings.title': '会话产物',
        'settings.detail': '在每条消息的用量旁显示本回合写入工作区的量，并在输入框下方的读数里显示本会话留下的总量。两者都读取宿主写出的插件记录。',
        'pill.title': '本会话在工作区留下的空间占用（最近一次扫描）',
        'turn.pill.title': '本回合在工作区写入的量',
        'panel.title': '本会话产生的产物',
        'panel.turn.title': '本回合产生的产物',
        'panel.totals': '{folders} 个文件夹 · {total}',
        'panel.files': '{files} 个文件',
        'panel.more': '仅显示最大的 {shown} 个文件夹（共 {total} 个）',
        'panel.hint': '需要释放空间时，让助手根据文件夹大小决定如何回收。',
        'pill.total': '总产物 {total}',
        'panel.open': '在默认应用中打开：{path}',
        'panel.external': '工作区外 · {path}',
      },
    }

    const CARD_STYLE = {
      border: '1px solid rgba(127,127,127,0.25)', borderRadius: 6,
      padding: '10px 12px', margin: '4px 0', fontSize: 12,
    }

    /** Render a byte count the way a reader expects to see disk usage. */
    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return String(value)
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let size = value
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
      return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
    }

    /** One number out of a Host field, as text; '?' when the field is not one. */
    function countText(candidate) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
      if (typeof candidate === 'string' && candidate !== '') return candidate
      return '?'
    }

    /**
     * The line a truncated reading carries.
     *
     * A scan that stopped has to say which bound stopped it: one sentence for a
     * record bound, a deadline, and a directory bound alike is what made a
     * healthy `mvn verify` read exactly like a broken scan. The numbers come
     * either from a record field (a number) or from the report's `truncated` row
     * (text), so both shapes land here. A Host that sent only the flag keeps the
     * generic sentence.
     * @param t - the locale binding.
     * @param truncation - `{ reason, limit, observed }` as the Host reported it.
     * @returns the sentence to render.
     */
    function truncationText(t, truncation) {
      const value = truncation !== null && typeof truncation === 'object' ? truncation : null
      const reason = value === null ? undefined : value.reason
      if (reason !== 'maxRecords' && reason !== 'timeoutMs' && reason !== 'maxDirectories' && reason !== 'maxRoots') {
        return t('report.truncated')
      }
      const bound = reason === 'maxRecords' ? 'records' : reason === 'timeoutMs' ? 'timeout' : reason === 'maxRoots' ? 'roots' : 'directories'
      return t(`report.truncated.${bound}`, {
        limit: countText(value.limit),
        observed: countText(value.observed),
      })
    }

    /**
     * The path the chosen application should receive for one clicked folder.
     *
     * The Host's `session-artifacts/open-target` route owns the rule: an
     * IntelliJ-platform IDE opens a directory as a *project*, so for those
     * applications the answer is the folder's project root — an IDE that
     * already holds that project raises its existing window instead of opening
     * a second one, and an IDE that does not still opens the right project.
     * Every other application, Finder included, keeps the clicked folder.
     *
     * The route is optional: an older Host build, a headless composition, or a
     * rejected request all leave the clicked path in place, which is exactly
     * what every build did before the route existed.
     * @param app - remembered application id.
     * @param absolutePath - the clicked folder as an absolute path.
     * @returns the path to hand to the Host's open endpoint.
     */
    async function openTarget(app, absolutePath) {
      try {
        const response = await fetch('session-artifacts/open-target', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app, path: absolutePath }),
        })
        if (!response.ok) return absolutePath
        const body = await response.json()
        const path = body && typeof body.path === 'string' ? body.path : undefined
        return path ? path : absolutePath
      } catch {
        // No route, no session, or no Host answer: the clicked folder remains the target.
        return absolutePath
      }
    }

    /**
     * Open a folder path in the user's chosen default application.
     *
     * Resolves relative paths against the workspace `root`, reads the user's
     * preference from `localStorage` key `dsh.open-in-app.choice`, asks the Host
     * which path that application receives, and POSTs it to the Host's
     * `open-in-app/open` endpoint. Falls back to 'finder' when no preference is
     * stored.
     * @param folderPath - the folder path (relative to root or absolute).
     * @param root - the workspace root to resolve against.
     * @returns a promise settling once the Host has been asked to open it.
     */
    async function openFolder(folderPath, root) {
      try {
        // Resolve relative path to absolute
        let absolutePath = folderPath
        if (root && typeof root === 'string' && !folderPath.startsWith('/')) {
          absolutePath = root.endsWith('/') ? `${root}${folderPath}` : `${root}/${folderPath}`
        }
        // Read user's default app preference
        let app = 'finder'
        try {
          const stored = localStorage.getItem('dsh.open-in-app.choice')
          if (stored) {
            const parsed = JSON.parse(stored)
            if (typeof parsed === 'string' && parsed.length > 0) app = parsed
          }
        } catch {
          // localStorage or JSON parse failure — use fallback
        }
        const path = await openTarget(app, absolutePath)
        fetch('open-in-app/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app, path }),
        }).catch(err => {
          console.error('[session-artifacts] open-in-app/open failed', err)
        })
      } catch (error) {
        console.error('[session-artifacts] openFolder failed', error)
      }
    }

    /**
     * Parse the report tool's rendered rows into the tree the panel walks.
     *
     * The row grammar is fixed on both sides: a totals line, then
     * `folder<TAB>bytes<TAB>files<TAB>path` per top folder followed by
     * `subfolder<TAB>bytes<TAB>files<TAB>path<TAB>parent` for every directory under
     * it. A Host older than the parent column wrote the top folder there instead,
     * which still nests correctly because the tree is rebuilt from paths as well.
     */
    function parseReport(text) {
      const tops = []
      const rows = []
      let total = 0
      let truncated = false
      let truncation = null
      let root = undefined
      let workspaceBytes = undefined
      for (const line of String(text).split('\n')) {
        if (line.startsWith('The scan stopped')) { truncated = true; continue }
        const totals = line.match(/^(\d+) folders, (\d+) bytes$/)
        if (totals) { total = Number(totals[2]); continue }
        const columns = line.split('\t')
        if (columns.length === 4 && columns[0] === 'truncated') {
          // The bound the Host named, as text: which limit stopped the scan and
          // how far it got. A Host that writes only the sentence above leaves
          // this row out, and the card falls back to the generic sentence.
          truncated = true
          truncation = { reason: columns[1], limit: columns[2], observed: columns[3] }
          continue
        }
        if (columns.length === 3 && columns[0] === 'split') {
          const value = Number(columns[1])
          if (Number.isFinite(value)) workspaceBytes = value
          continue
        }
        if (columns.length === 2 && columns[0] === 'root') {
          root = columns[1]
          continue
        }
        const bytes = Number(columns[1])
        const files = Number(columns[2])
        if (!Number.isFinite(bytes) || !Number.isFinite(files)) continue
        if (columns.length === 4 && columns[0] === 'folder') {
          tops.push({ path: columns[3], bytes, files })
        } else if (columns.length >= 4 && columns[0] === 'subfolder') {
          rows.push({ path: columns[3], bytes, files, parent: columns.length >= 5 ? columns[4] : undefined })
        }
      }
      return { folders: nestFolders(tops, rows), total, truncated, truncation, root, workspaceBytes }
    }

    /** The last path component: what a nested row is labelled with. */
    function baseName(path) {
      const cut = String(path).lastIndexOf('/')
      return cut === -1 ? String(path) : String(path).slice(cut + 1)
    }

    /** The path one level above another, or null at the top. */
    function parentPath(path) {
      const cut = String(path).lastIndexOf('/')
      return cut <= 0 ? null : String(path).slice(0, cut)
    }

    /**
     * Build the folder tree the panel walks, from the rows a payload carries.
     *
     * A payload lists every directory under each top folder, flat, and each row
     * names its own parent; a Host older than that names only the top folder, so
     * the level above is then read from the path itself. Levels nobody listed are
     * materialized and their totals summed from below, because the panel shows one
     * level per disclosure and a missing middle level would hide everything under
     * it. A row that *is* listed keeps its own totals: those are authoritative
     * subtree readings, and summing children into them would double count.
     * @param tops - one row per top-level folder.
     * @param rows - every descendant row, in any order.
     * @returns the tops, each carrying only its immediate children.
     */
    function nestFolders(tops, rows) {
      const nodes = new Map()
      const add = (path, listed) => {
        let node = nodes.get(path)
        if (node === undefined) {
          node = { path, bytes: 0, files: 0, children: [], synthetic: listed !== true }
          nodes.set(path, node)
        }
        if (listed === true) node.synthetic = false
        return node
      }
      for (const top of tops) {
        const node = add(top.path, true)
        node.bytes = typeof top.bytes === 'number' ? top.bytes : 0
        node.files = typeof top.files === 'number' ? top.files : 0
        if (typeof top.root === 'string') node.root = top.root
      }
      for (const row of rows) {
        if (row === null || row === undefined || typeof row.path !== 'string') continue
        const node = add(row.path, true)
        node.bytes = typeof row.bytes === 'number' ? row.bytes : node.bytes
        node.files = typeof row.files === 'number' ? row.files : node.files
      }
      // Every level between a top folder and a row exists, listed or not: the panel
      // shows one level per disclosure, so a missing middle level would hide
      // everything below it. A row that was listed twice is not re-created here; the
      // walk only fills the gaps down from the top folder that contains the row.
      const topPaths = (tops ?? []).map(top => top.path)
      for (const path of [...nodes.keys()]) {
        const top = topPaths
          .filter(candidate => path.length > candidate.length && path.startsWith(`${candidate}/`))
          .sort((left, right) => right.length - left.length)[0]
        if (top === undefined) continue
        let above = parentPath(path)
        while (above !== null && above !== top && !nodes.has(above)) {
          add(above, false)
          above = parentPath(above)
        }
      }
      for (const [path, node] of nodes) {
        const above = path === undefined ? null : parentPath(path)
        const parent = above === null ? undefined : nodes.get(above)
        if (parent === undefined) continue
        parent.children.push(node)
      }
      const settle = (node) => {
        for (const child of node.children) settle(child)
        if (node.synthetic === true) {
          node.bytes = node.children.reduce((total, child) => total + child.bytes, 0)
          node.files = node.children.reduce((total, child) => total + child.files, 0)
        }
        node.children.sort((left, right) => right.bytes - left.bytes || (left.path < right.path ? -1 : 1))
        return node
      }
      const byPath = new Map()
      for (const node of nodes.values()) byPath.set(node.path, node)
      return tops.map(top => {
        const node = byPath.get(top.path)
        return node === undefined ? { path: top.path, bytes: top.bytes, files: top.files, children: [] } : settle(node)
      })
    }

    /** The nested tree behind one payload's folder shares. */
    function folderTree(tops) {
      const rows = []
      for (const top of tops ?? []) {
        if (Array.isArray(top.subfolders)) rows.push(...top.subfolders)
      }
      return nestFolders(tops ?? [], rows)
    }

    /** One folder row from the size report with optional subfolder expansion. */
    function FolderRow(props) {
      const folder = props.folder
      const root = props.root
      const hasSub = Array.isArray(folder.subfolders) && folder.subfolders.length > 0
      const isExpanded = Boolean(props.isExpanded)

      return h('div', { key: folder.path }, [
        h('div', {
          style: {
            display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0',
            cursor: hasSub ? 'pointer' : 'default',
            userSelect: 'none',
          },
          onClick: hasSub ? () => props.onToggle(folder.path) : undefined,
        }, [
          hasSub
            ? h('span', {
                key: 'icon',
                style: {
                  width: 12, fontSize: 9, opacity: 0.7,
                  display: 'inline-block', textAlign: 'center', flex: '0 0 auto',
                },
              }, isExpanded ? '▼' : '▶')
            : null,
          h('span', { key: 's', style: { flex: '0 0 auto', opacity: 0.65, fontSize: 12, fontVariantNumeric: 'tabular-nums' } },
            formatBytes(folder.bytes)),
          h('span', {
            key: 'p', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
            title: folder.path,
          }, folder.path),
          h('span', { key: 'f', style: { flex: '0 0 auto', fontSize: 11, opacity: 0.55, whiteSpace: 'nowrap' } },
            props.t('row.files', { files: String(folder.files) })),
          root ? h('span', {
            key: 'open',
            title: props.t('panel.open', { path: folder.path }),
            style: {
              flex: '0 0 auto', cursor: 'pointer', opacity: 0.5, fontSize: 12,
              padding: '0 2px', transition: 'opacity 120ms',
            },
            onMouseEnter: (e) => { e.currentTarget.style.opacity = '1' },
            onMouseLeave: (e) => { e.currentTarget.style.opacity = '0.5' },
            onClick: (e) => { e.stopPropagation(); openFolder(folder.path, root) },
          }, '↗') : null,
        ]),
        isExpanded && hasSub
          ? h('div', {
              key: 'subs',
              style: {
                paddingLeft: 18, marginLeft: 6,
                borderLeft: '1px solid rgba(127,127,127,0.2)', marginBottom: 4,
              },
            }, folder.subfolders.map((sub, idx) => {
              const displayPath = sub.path.startsWith(`${folder.path}/`) ? sub.path.slice(folder.path.length + 1) : sub.path
              return h('div', {
                key: `${sub.path}:${idx}`,
                style: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 0', fontSize: 11 },
              }, [
                h('span', { key: 's', style: { flex: '0 0 auto', opacity: 0.55, fontSize: 11, fontVariantNumeric: 'tabular-nums' } },
                  formatBytes(sub.bytes)),
                h('span', { key: 'p', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, opacity: 0.85 }, title: sub.path },
                  displayPath),
                h('span', { key: 'f', style: { flex: '0 0 auto', fontSize: 10, opacity: 0.5, whiteSpace: 'nowrap' } },
                  props.t('row.files', { files: String(sub.files) })),
                root ? h('span', {
                  key: 'open',
                  title: props.t('panel.open', { path: sub.path }),
                  style: {
                    flex: '0 0 auto', cursor: 'pointer', opacity: 0.45, fontSize: 11,
                    padding: '0 2px', transition: 'opacity 120ms',
                  },
                  onMouseEnter: (e) => { e.currentTarget.style.opacity = '1' },
                  onMouseLeave: (e) => { e.currentTarget.style.opacity = '0.45' },
                  onClick: (e) => { e.stopPropagation(); openFolder(sub.path, root) },
                }, '↗') : null,
              ])
            }))
          : null,
      ])
    }

    /**
     * The card a finished `session_artifacts_report` call renders as.
     *
     * A card is a convenience, never a load-bearing part of the transcript: this
     * one renders inside the Tool call that is already on screen, so whatever it
     * cannot parse must cost the reader the card and nothing else.
     */
    function ReportCard(props) {
      try {
        return buildReportCard(props)
      } catch (error) {
        console.error('[session-artifacts] report card failed to render', error)
        return null
      }
    }

    /** Build the report card; {@link ReportCard} contains any failure it raises. */
    function buildReportCard(props) {
      const t = props.t
      const [expanded, setExpanded] = React.useState({})
      const toggleExpand = (path) => {
        setExpanded(prev => ({ ...prev, [path]: !prev[path] }))
      }
      if (props.phase === 'preparing') {
        return h('div', { style: { fontSize: 12, opacity: 0.6 } }, t('row.preparing'))
      }
      const content = props.block.content ?? []
      const text = content.map(item => (item.type === 'text' ? item.text : '')).join('\n')
      const parsed = parseReport(text)
      return h('div', { style: CARD_STYLE }, [
        h('div', { key: 'title', style: { fontWeight: 600, marginBottom: 4 } }, t('report.title')),
        h('div', { key: 'totals', style: { opacity: 0.75, marginBottom: 6 } }, t('report.totals', {
          folders: String(parsed.folders.length),
          total: formatBytes(parsed.total),
        })),
        parsed.workspaceBytes !== undefined && parsed.workspaceBytes < parsed.total
          ? h('div', { key: 'split', style: { opacity: 0.6, marginBottom: 6 } }, t('report.split', {
              workspace: formatBytes(parsed.workspaceBytes),
              external: formatBytes(parsed.total - parsed.workspaceBytes),
            }))
          : null,
        parsed.truncated ? h('div', { key: 'trunc', style: { color: '#a16207', marginBottom: 6 } },
          truncationText(t, parsed.truncation)) : null,
        parsed.folders.length === 0
          ? h('div', { key: 'empty', style: { opacity: 0.6 } }, t('report.empty'))
          : parsed.folders.map((folder, index) => h(FolderRow, {
              key: `${folder.path}:${index}`, folder, t,
              root: parsed.root,
              isExpanded: Boolean(expanded[folder.path]),
              onToggle: toggleExpand,
            })),
        parsed.folders.length > 0
          ? h('div', { key: 'hint', style: { marginTop: 8, opacity: 0.6 } }, t('report.hint'))
          : null,
      ])
    }

    /**
     * Fold the Host's durable per-turn scan record into Turn data.
     *
     * The record carries totals only — the per-entry list stays on the Host and is
     * served by the report tool — so this card summarizes and the tool card
     * itemizes.
     */
    /**
     * The Host's durable per-turn scan record, folded into Turn data.
     *
     * Every callback here is engine-facing: the conversation assembler folds each
     * registered Definition while it materializes a Turn, so a Definition that
     * throws fails the fold that draws the transcript — not merely its own card. A
     * card that cannot appear is a missing feature; a fold that throws is a blank
     * conversation while the Host keeps streaming. Each callback therefore reports
     * its own failure and returns something the engine can keep folding with.
     *
     * The record carries totals only — the per-entry list stays on the Host and is
     * served by the report tool — so this card summarizes and the tool card
     * itemizes.
     */
    const scanDefinition = {
      kind: 'session-artifacts',
      // Publishing into the Chat target is what makes these totals readable outside
      // the Turn that produced them: the Chat view turns each node below into one
      // payload per Turn, and `nodes.turnDataSource(turn, kind)` hands it back. That
      // is how the core's own out-of-tree cards read Turn-scoped business values.
      target: 'chat',
      match(event) {
        try {
          if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
          // The Turn's own finalized assistant message: the identity the per-message
          // reading is asked about. The action row hands its entries a message id and
          // nothing else, so this Definition records which Turn that id belongs to
          // rather than reading the transcript's nodes back — a published value here
          // is this plugin's own contract, while node internals are the host's.
          if (event.type === 'assistant/message') return { id: String(event.data.turn), role: 'update' }
          if (event.type === 'plugin:session-artifacts/scan') return { id: String(event.data.turn), role: 'update' }
          return null
        } catch (error) {
          console.error('[session-artifacts] scan definition match failed', error)
          return null
        }
      },
      start(_context, match) {
        try {
          if (match.event.type !== 'turn/start') throw new Error('session-artifacts start requires turn/start')
          return { turn: match.event.data.turn, scan: null, messageId: undefined }
        } catch (error) {
          console.error('[session-artifacts] scan definition start failed', error)
          return { turn: null, scan: null, messageId: undefined }
        }
      },
      update(context, match) {
        const state = context.state
        try {
          if (match.event.type === 'assistant/message') {
            const id = match.event.data?.message?.id
            return typeof id === 'string' && id !== state.messageId ? { ...state, messageId: id } : state
          }
          if (match.event.type !== 'plugin:session-artifacts/scan') return state
          const data = match.event.data
          if (typeof data !== 'object' || data === null) return state
          if (typeof data.bytes !== 'number') return state
          return {
            ...state,
            scan: {
              seq: match.event.seq,
              root: typeof data.root === 'string' ? data.root : undefined,
              bytes: data.bytes,
              ...(typeof data.turnBytes === 'number' ? { turnBytes: data.turnBytes } : {}),
              // The turn's closing message, so the reading beside that message can
              // find this payload by the id the action row hands it.
              ...(typeof state.messageId === 'string' ? { messageId: state.messageId } : {}),
              folders: Array.isArray(data.folders) ? data.folders : [],
              turnFolders: Array.isArray(data.turnFolders) ? data.turnFolders : [],
              turnFoldersTotal: typeof data.turnFoldersTotal === 'number' ? data.turnFoldersTotal : 0,
              foldersTotal: typeof data.foldersTotal === 'number' ? data.foldersTotal : 0,
              ...(Array.isArray(data.roots) ? { roots: data.roots } : {}),
              ...(typeof data.workspaceBytes === 'number' ? { workspaceBytes: data.workspaceBytes } : {}),
              truncated: data.truncated === true,
              truncation: data.truncation !== null && typeof data.truncation === 'object' ? data.truncation : null,
            },
          }
        } catch (error) {
          console.error('[session-artifacts] scan definition update failed', error)
          return state
        }
      },
      buildLocationData(context, scope, previous) {
        try {
          const state = context.state
          if (scope !== 'turn' || state === undefined || state === null) return null
          // The engine validates everything published here and throws out of the
          // flush that draws the transcript when it does not hold: the published
          // `key` must be this Definition's own `kind` (not a friendlier spelling of
          // it), and `turn` must be a non-negative safe integer. Publishing a
          // spelling of our own is what once blanked a Turn, so both rules are
          // checked here as well as in the tests.
          if (!Number.isSafeInteger(state.turn) || state.turn < 0) return null
          if (previous !== null && previous !== undefined
            && previous.kind === 'turn' && previous.turn === state.turn
            && previous.key === 'session-artifacts' && previous.value === state.scan) return previous
          return { kind: 'turn', turn: state.turn, key: 'session-artifacts', value: state.scan }
        } catch (error) {
          console.error('[session-artifacts] scan definition buildLocationData failed', error)
          return null
        }
      },
      /**
       * Publish this Turn's totals as a hidden Chat node.
       *
       * `anchorSeq` and `location` come from the `turn/start` match that opened the
       * Context, so the Chat view files the node under the Turn it belongs to and
       * `nodes.turnDataSource(turn, 'session-artifacts')` can hand it back to any
       * entry in that Session — which is the only path a session-scoped surface
       * such as the composer dock has. `hidden` keeps it out of the transcript: it
       * is a reading, not a message.
       */
      buildViewNode(context) {
        try {
          const state = context.state
          const start = context.start ?? (context.matches ?? [])[0]
          const scan = state === undefined || state === null ? undefined : state.scan
          if (scan === undefined || scan === null || start === undefined || start === null) return null
          if (!Number.isSafeInteger(state.turn) || state.turn < 0) return null
          if (start.event === undefined || start.location === undefined) return null
          return {
            key: context.key,
            kind: 'session-artifacts',
            id: context.id,
            target: 'chat',
            anchorSeq: start.event.seq,
            location: start.location,
            visibility: 'hidden',
            data: {
              turn: state.turn,
              root: typeof scan.root === 'string' ? scan.root : undefined,
              bytes: scan.bytes,
              ...(typeof scan.turnBytes === 'number' ? { turnBytes: scan.turnBytes } : {}),
              // The message this Turn closed on: the per-message reading is handed a
              // message id by the action row and finds its payload by this field, so
              // it has to survive into the published node data and not just the
              // folded state the two builders share.
              ...(typeof scan.messageId === 'string' ? { messageId: scan.messageId } : {}),
              folders: Array.isArray(scan.folders) ? scan.folders : [],
              turnFolders: Array.isArray(scan.turnFolders) ? scan.turnFolders : [],
              turnFoldersTotal: typeof scan.turnFoldersTotal === 'number' ? scan.turnFoldersTotal : 0,
              foldersTotal: typeof scan.foldersTotal === 'number' ? scan.foldersTotal : 0,
              ...(Array.isArray(scan.roots) ? { roots: scan.roots } : {}),
              ...(typeof scan.workspaceBytes === 'number' ? { workspaceBytes: scan.workspaceBytes } : {}),
              truncated: scan.truncated === true,
              truncation: scan.truncation !== null && typeof scan.truncation === 'object' ? scan.truncation : null,
            },
          }
        } catch (error) {
          console.error('[session-artifacts] scan definition buildViewNode failed', error)
          return null
        }
      },
    }

    /**
     * Read the card's enabled preference, tolerating a seam that supplies no seat.
     *
     * The preference is a nicety; losing it must not cost the reader the card, and
     * a throw raised here would land in the Turn tail's render — inside the
     * transcript. A missing seat therefore reads as "enabled".
     * @param props - the Turn tail entry's props.
     * @returns true unless the reader turned the card off.
     */
    function turnCardEnabled(props) {
      try {
        return props.useTurnCard(value => value) !== false
      } catch (error) {
        console.error('[session-artifacts] turn card preference unavailable', error)
        return true
      }
    }

    /**
     * The per-turn reading: one message's own artifact line.
     *
     * It renders in the assistant message's action row, beside the Turn usage
     * pile — the reading belongs to the message it follows, and putting it in the
     * dock beside the Session footprint made two different numbers look like one
     * row of duplicates. Like the dock pill it is incapable of taking the
     * transcript down with it: any failure costs the reader this reading alone.
     */
    function TurnArtifactPill(props) {
      try {
        return buildTurnArtifactPill(props)
      } catch (error) {
        console.error('[session-artifacts] turn reading failed to render', error)
        return null
      }
    }

    /** Build the per-message reading; {@link TurnArtifactPill} contains its failures. */
    function buildTurnArtifactPill(props) {
      // Called before any early return: the hook count has to match between renders.
      const scan = typeof props.useChat === 'function'
        ? props.useChat(snapshot => scanForMessage(snapshot, props.messageId))
        : undefined
      const disclosure = useArtifactDisclosure()
      if (props.pillEnabled === false) return null
      if (scan === null || scan === undefined) return null
      const t = props.t
      const total = formatBytes(typeof scan.turnBytes === 'number' ? scan.turnBytes : scan.bytes)
      const label = t('turn.pill', { total })
      // The turn's own folders, which is what this reading's panel answers with. A
      // Host older than that field published only the footprint's list; the reading
      // then opens that, which is also the number it fell back to showing.
      const published = Array.isArray(scan.turnFolders) ? scan.turnFolders : []
      const hasTurnReading = typeof scan.turnBytes === 'number'
      const folders = folderTree(
        published.length > 0 ? published : (Array.isArray(scan.folders) ? scan.folders : []),
      )
      const panelScan = {
        ...scan,
        bytes: typeof scan.turnBytes === 'number' ? scan.turnBytes : scan.bytes,
        foldersTotal: typeof scan.turnFoldersTotal === 'number' ? scan.turnFoldersTotal : scan.foldersTotal,
        // The workspace/outside split describes the Session's footprint, not this
        // turn's own bytes, so the turn panel must not show it.
        workspaceBytes: undefined,
      }
      const open = disclosure.open
      return h('span', {
        // The row is a flex strip: the plugin's only seat in it is where the
        // per-message actions go (before the branch control), so this reading asks
        // to be laid out last instead — after the usage pill, at the end of the
        // row. Nothing else can move it there without a host change.
        ref: disclosure.anchorRef,
        style: { display: 'inline-flex', minWidth: 0, order: 99 },
      }, [
        h('button', {
          key: 'trigger',
          type: 'button',
          style: {
            ...(folders.length === 0 ? PILL_STYLE : PILL_BUTTON_STYLE),
            // Exactly the usage pill's own declaration, so the two readings are
            // the same size in the same row (`MessageIconActions`' action strip is
            // `--dsh-content-font-size-secondary`, its metadata one pixel smaller).
            fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
            lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
          },
          // The row is icons and glyphs, so the reading gets no room for a notice:
          // a partial scan says so in the tooltip, where the same sentence the card
          // used to print now lives.
          title: scan.truncated ? `${t('turn.pill.title')} · ${truncationText(t, scan.truncation)}` : t('turn.pill.title'),
          'aria-label': label,
          ...(folders.length === 0 ? {} : { 'aria-haspopup': 'dialog', 'aria-expanded': open }),
          onClick: () => { disclosure.toggle(folders.length > 0) },
          'data-session-artifacts': 'turn',
        }, h('span', { key: 'label', style: PILL_LABEL_STYLE }, label)),
        open && folders.length > 0
          ? h(ArtifactPanel, {
              key: 'panel', scan: panelScan, folders, t,
              // A Host older than the turn reading falls back to the footprint for
              // both the number and the list, so the panel names that scope.
              titleKey: hasTurnReading ? 'panel.turn.title' : 'panel.title',
              anchor: disclosure.anchor, panelRef: disclosure.panelRef,
            })
          : null,
      ])
    }

    // The reading the composer's own pills wear: 12/20 tertiary text in a rounded
    // capsule, taken from the dock's styles so the row stays one row.
    const PILL_ANCHOR_STYLE = {
      display: 'inline-flex', minWidth: 0,
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
    }
    const PILL_STYLE = {
      display: 'inline-flex', alignItems: 'center', gap: 6, boxSizing: 'border-box', maxWidth: '100%',
      padding: '1px 8px', border: 'none', borderRadius: 999, background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary)', font: 'inherit',
      fontVariantNumeric: 'tabular-nums', lineHeight: 'inherit', whiteSpace: 'nowrap',
    }
    const PILL_LABEL_STYLE = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }
    const PILL_SEPARATOR_STYLE = { color: 'var(--dsw-alias-separator-primary)', margin: '0 6px' }
    // The trigger earns the pill's hover affordance only when it opens something;
    // the shipped pills do the same, so a static reading stays static.
    const PILL_BUTTON_STYLE = { ...PILL_STYLE, cursor: 'pointer' }

    // The panel wears the shipped stat-dialog skin: menu surface, prominent elevation,
    // 12/18 text, 16px padding, and a 12px viewport margin it is clamped to.
    const PANEL_MARGIN = 12
    const PANEL_STYLE = {
      position: 'fixed', zIndex: 1100, boxSizing: 'border-box',
      minWidth: 'min(300px, calc(100vw - 24px))',
      maxWidth: 'min(440px, calc(100vw - 24px))',
      maxHeight: 'min(60vh, 480px)', overflowY: 'auto',
      padding: 16, border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 'var(--dsw-radius-lg, 10px)',
      background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))',
      // The menu surface is translucent by design and earns its opacity from the
      // blur behind it: without this the panel reads as text floating on the page.
      backdropFilter: 'var(--dsw-menu-backdrop-filter, blur(12px))',
      boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, 0.18))',
      fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
    }
    const PANEL_TITLE_STYLE = {
      display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 8,
      color: 'var(--dsw-alias-label-primary)', fontWeight: 500,
      fontVariantNumeric: 'tabular-nums',
    }
    const PANEL_VALUE_STYLE = { color: 'var(--dsw-alias-label-tertiary)', fontWeight: 400 }
    const PANEL_RULE_STYLE = { marginBottom: 10, borderTop: '0.5px solid var(--dsw-alias-border-l2)' }
    const PANEL_ROW_STYLE = {
      display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0', flexWrap: 'nowrap',
    }
    const PANEL_SIZE_STYLE = {
      flex: '0 0 auto', opacity: 0.65, fontVariantNumeric: 'tabular-nums', minWidth: 56, textAlign: 'right',
    }
    const PANEL_PATH_STYLE = {
      flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }
    const PANEL_FILES_STYLE = { flex: '0 0 auto', fontSize: 11, opacity: 0.55, whiteSpace: 'nowrap' }
    const PANEL_FOOTER_STYLE = { marginTop: 8, opacity: 0.6, fontSize: 11 }
    const PANEL_SPLIT_STYLE = { marginBottom: 6, fontSize: 11, opacity: 0.6 }
    const PANEL_GROUP_STYLE = {
      marginTop: 8, marginBottom: 2, fontSize: 11, opacity: 0.6,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }

    /**
     * The newest Turn the Session's legacy slice knows about.
     *
     * The composer dock declares a `useChat` seat over the Chat snapshot, and the
     * shipped pills read its `legacy` slice, so this reads the same place. The
     * `timeline` field is deliberately avoided: on the build this was verified
     * against, reading it from a dock entry throws inside the seat itself.
    /**
     * Find the newest scan payload published by this Session across any known Turn.
     *
     * When a new turn starts, its scan has not run yet; searching backwards allows
     * the pill to keep showing the latest artifact totals without flickering or
     * disappearing during turn execution.
     * @param snapshot - the Session's chat snapshot.
     * @returns the newest scan payload, or null if no scan has been published yet.
     */
    function newestScan(snapshot) {
      for (const turn of publishedTurns(snapshot)) {
        const scan = scanForTurn(snapshot, turn)
        if (scan !== undefined && scan !== null) return scan
      }
      return null
    }

    /**
     * The scan payload this Definition published for one Turn.
     * @param snapshot - the Session's chat snapshot.
     * @param turn - the Turn whose payload is wanted.
     * @returns the payload, or undefined when that Turn published none.
     */
    function scanForTurn(snapshot, turn) {
      if (typeof turn !== 'number') return undefined
      const source = snapshot?.nodes?.turnDataSource?.(turn, 'session-artifacts')
      const published = source?.getSnapshot?.()
      return Array.isArray(published) ? published[published.length - 1] : undefined
    }

    /**
     * The Turns this Session has published a reading for, newest first.
     * @param snapshot - the Session's chat snapshot.
     * @returns Turn numbers the legacy slice knows an end for.
     */
    function publishedTurns(snapshot) {
      const legacy = snapshot?.legacy
      if (legacy === undefined || legacy === null) return []
      const turns = new Set()
      for (const map of [legacy.turnEnds, legacy.turnTimings]) {
        if (map === undefined || map === null || typeof map.keys !== 'function') continue
        for (const turn of map.keys()) {
          if (typeof turn === 'number') turns.add(turn)
        }
      }
      return [...turns].sort((a, b) => b - a)
    }

    /**
     * The scan payload for one finalized assistant message.
     *
     * The action row hands its entries a message id and nothing else, and this
     * plugin publishes per Turn — so the id has to name the Turn. It does: the
     * Definition records the Turn's closing `assistant/message` id in the payload
     * it publishes (`scan.messageId`), which is this plugin's own contract rather
     * than the transcript's node internals, and the lookup is the same walk over
     * published Turns that the dock pill already does.
     * @param snapshot - the Session's chat snapshot.
     * @param messageId - the message whose actions are being rendered.
     * @returns the payload, or undefined when no Turn published for that message.
     */
    function scanForMessage(snapshot, messageId) {
      if (typeof messageId !== 'string' && typeof messageId !== 'number') return undefined
      for (const turn of publishedTurns(snapshot)) {
        const scan = scanForTurn(snapshot, turn)
        if (scan !== null && scan !== undefined && scan.messageId === messageId) return scan
      }
      return undefined
    }

    /**
     * The composer pill beside the step and usage readings.
     *
     * The dock is session-scoped, so the entry reads the Session's own Chat snapshot
     * through the `useChat` seat the dock declares, and it reads the totals this
     * Session published for its newest Turn. Every read is guarded: a seat that
     * throws or a snapshot without the data must cost the reader this pill alone.
     * @param props - the dock entry's props: the chat selector seat and copy.
     * @returns the pill, or null when this Session has no scan to report.
     */
    function ArtifactPill(props) {
      try {
        return buildArtifactPill(props)
      } catch (error) {
        if (!pillSeatReported) {
          pillSeatReported = true
          console.error('[session-artifacts] dock pill could not read the Session snapshot', error)
        }
        return null
      }
    }

    /** Build the dock pill; {@link ArtifactPill} contains any failure it raises. */
    function buildArtifactPill(props) {
      // Every seat is called unconditionally and before any early return: the hook
      // count has to match between renders, or React raises "rendered more hooks than
      // during the previous render" the first time this pill's data appears or goes.
      // Each selector answers a primitive or a snapshot-stable reference, because the
      // seat compares with `Object.is` and a freshly built object would re-render on
      // every publication.
      const scan = props.useChat(snapshot => newestScan(snapshot))
      const enabled = turnCardEnabled(props)
      const disclosure = useArtifactDisclosure()
      if (scan === null || scan === undefined) return null
      if (enabled === false) return null
      const t = props.t
      // One reading, one row: the Session's footprint. What the turn itself wrote
      // sits beside that message's own usage line instead, where a reader can tell
      // the two apart.
      const label = t('pill.total', { total: formatBytes(scan.bytes) })
      const folders = folderTree(Array.isArray(scan.folders) ? scan.folders : [])
      const open = disclosure.open
      return h('span', {
        ref: disclosure.anchorRef, style: PILL_ANCHOR_STYLE, 'data-composer-stat': 'session-artifacts',
      }, [
        h('button', {
          key: 'trigger',
          type: 'button',
          style: folders.length === 0 ? PILL_STYLE : PILL_BUTTON_STYLE,
          title: t('pill.title'),
          'aria-label': label,
          ...(folders.length === 0 ? {} : { 'aria-haspopup': 'dialog', 'aria-expanded': open }),
          onClick: () => { disclosure.toggle(folders.length > 0) },
        }, h('span', { key: 'total', style: PILL_LABEL_STYLE }, label)),
        open && folders.length > 0
          ? h(ArtifactPanel, { key: 'panel', scan, folders, t, anchor: disclosure.anchor, panelRef: disclosure.panelRef })
          : null,
      ])
    }

    /**
     * The disclosure both readings share.
     *
     * One trigger, one panel, two ways out (Escape and a click outside), and the
     * anchor rectangle the panel grows upward from. Shared rather than written
     * twice because the two readings must behave identically — the turn reading
     * opens the same panel the Session reading does, over that turn's own folders.
     * @returns the open state, the refs to bind, and the toggle.
     */
    function useArtifactDisclosure() {
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const anchorRef = React.useRef(null)
      const panelRef = React.useRef(null)
      React.useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined') return undefined
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        const onPointerDown = (event) => {
          const target = event.target
          if (target && typeof target === 'object') {
            if (panelRef.current && typeof panelRef.current.contains === 'function' && panelRef.current.contains(target)) return
            if (anchorRef.current && typeof anchorRef.current.contains === 'function' && anchorRef.current.contains(target)) return
          }
          setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointerDown)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointerDown)
        }
      }, [open])
      // The panel is bottom-anchored to its trigger, so it never has to measure its
      // own height: it grows upward from just above the trigger and stays inside the
      // viewport.
      const toggle = (hasEntries) => {
        if (hasEntries !== true) return
        if (open) { setOpen(false); return }
        const element = anchorRef.current
        if (element !== null && typeof element.getBoundingClientRect === 'function') {
          const rect = element.getBoundingClientRect()
          const width = Math.min(440, window.innerWidth - 2 * PANEL_MARGIN)
          setAnchor({
            left: Math.max(PANEL_MARGIN, Math.min(rect.left, window.innerWidth - PANEL_MARGIN - width)),
            bottom: Math.max(PANEL_MARGIN, window.innerHeight - rect.top + 8),
          })
        }
        setOpen(true)
      }
      return { open, anchor, anchorRef, panelRef, toggle }
    }

    /**
     * Group top-level rows by the root they belong to.
     *
     * The workspace comes first and needs no heading: it is the default place a
     * reading is about. A row from a root outside it gets a heading naming that
     * root, because two rows named `target` under different roots must not read
     * as the same folder. A Host that published no root information keeps the
     * one flat list the panel always showed.
     * @param rows - the top-level rows.
     * @param scan - the published reading, whose `root` is the workspace.
     * @returns one group per root, the workspace's first.
     */
    function panelGroups(rows, scan) {
      const groups = []
      const byRoot = new Map()
      for (const row of rows) {
        const root = typeof row.root === 'string' ? row.root : undefined
        const key = root === undefined ? '' : root
        let group = byRoot.get(key)
        if (group === undefined) {
          group = { root, rows: [] }
          byRoot.set(key, group)
          groups.push(group)
        }
        group.rows.push(row)
      }
      const isWorkspace = group => group.root === undefined || group.root === scan.root
      return groups.filter(isWorkspace).concat(groups.filter(group => !isWorkspace(group)))
        .map(group => (isWorkspace(group) ? { rows: group.rows } : { rows: group.rows, heading: group.root }))
    }

    /**
     * The detail behind the pill: one row per folder, largest first.
     *
     * The reading this plugin exists to give is "how much did this turn put on disk,
     * and where" — a rebuilt jar is one line here, not one line among three hundred
     * class files. The panel stays at folder granularity so the reading remains useful
     * when a build produces thousands of files.
     * @param props.scan - the published totals.
     * @param props.folders - the published folders, largest first.
     * @param props.t - localized copy.
     * @returns the portaled panel, or the inline panel when the shell shares no portal.
     */
    function ArtifactPanel(props) {
      const t = props.t
      const scan = props.scan
      const rows = props.folders
      const anchor = props.anchor
      const panelRef = props.panelRef
      const [expanded, setExpanded] = React.useState({})
      const toggleExpand = (path) => {
        setExpanded(prev => ({ ...prev, [path]: !prev[path] }))
      }
      const titleKey = props.titleKey ?? 'panel.title'
      const body = h('div', {
        ref: panelRef,
        role: 'dialog',
        'aria-label': t(titleKey),
        style: anchor === null ? PANEL_STYLE : { ...PANEL_STYLE, left: anchor.left, bottom: anchor.bottom },
      }, [
        h('div', { key: 'title', style: PANEL_TITLE_STYLE }, [
          h('span', { key: 'label' }, t(titleKey)),
          h('span', { key: 'totals', style: PANEL_VALUE_STYLE },
            t('panel.totals', { folders: String(scan.foldersTotal ?? rows.length), total: formatBytes(scan.bytes) })),
        ]),
        h('div', { key: 'rule', style: PANEL_RULE_STYLE }),
        typeof scan.workspaceBytes === 'number' && scan.workspaceBytes < scan.bytes
          ? h('div', { key: 'split', style: PANEL_SPLIT_STYLE }, t('report.split', {
              workspace: formatBytes(scan.workspaceBytes),
              external: formatBytes(scan.bytes - scan.workspaceBytes),
            }))
          : null,
        ...panelGroups(rows, scan).flatMap((group, groupIndex) => [
          ...(group.heading === undefined ? [] : [h('div', {
            key: `group:${groupIndex}`,
            style: PANEL_GROUP_STYLE,
            title: group.heading,
          }, t('panel.external', { path: group.heading }))]),
          ...group.rows.map((entry, index) => h(PanelRow, {
            key: `${entry.path}:${groupIndex}:${index}`, entry, t,
            root: scan.root,
            expanded,
            onToggle: toggleExpand,
            depth: 0,
          })),
        ]),
        rows.length < (scan.foldersTotal ?? rows.length)
          ? h('div', { key: 'more', style: PANEL_FOOTER_STYLE },
            t('panel.more', { shown: String(rows.length), total: String(scan.foldersTotal ?? rows.length) }))
          : null,
        h('div', { key: 'hint', style: PANEL_FOOTER_STYLE }, t('panel.hint')),
      ])
      return createPortal === undefined ? body : createPortal(body, document.body)
    }

    /**
     * One folder row: its size, its own name, and its own directories under it.
     *
     * Expanding a row shows the directories directly inside it — one level, each
     * labelled with its own name, exactly as a file manager does — and each of
     * those can be expanded in turn. The full path stays in the tooltip, and the
     * open button still hands the Host that full path.
     */
    function PanelRow(props) {
      const t = props.t
      const entry = props.entry
      const root = props.root
      const depth = typeof props.depth === 'number' ? props.depth : 0
      const children = Array.isArray(entry.children) ? entry.children : []
      const expanded = props.expanded ?? {}
      const isExpanded = expanded === true || Boolean(expanded[entry.path])
      const nested = depth > 0
      const rowStyle = nested
        ? { display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 0', fontSize: 11, flexWrap: 'nowrap' }
        : { ...PANEL_ROW_STYLE, cursor: children.length > 0 ? 'pointer' : 'default', userSelect: 'none' }

      return h('div', { key: entry.path }, [
        h('div', {
          style: rowStyle,
          ...(nested ? {} : { onClick: children.length > 0 ? () => props.onToggle(entry.path) : undefined }),
        }, [
          h('span', {
            key: 'icon',
            style: {
              width: 12, fontSize: 9, opacity: 0.7,
              display: 'inline-block', textAlign: 'center', flex: '0 0 auto',
            },
          }, children.length === 0 ? '' : (isExpanded ? '▼' : '▶')),
          h('span', {
            key: 's',
            style: nested
              ? { ...PANEL_SIZE_STYLE, fontSize: 11, minWidth: 50, opacity: 0.55 }
              : PANEL_SIZE_STYLE,
          }, formatBytes(entry.bytes)),
          h('span', {
            key: 'p',
            'data-folder-row': nested ? baseName(entry.path) : entry.path,
            title: entry.path,
            style: nested
              ? { ...PANEL_PATH_STYLE, fontSize: 11, opacity: 0.85, cursor: children.length > 0 ? 'pointer' : 'default' }
              : { ...PANEL_PATH_STYLE, cursor: children.length > 0 ? 'pointer' : 'default' },
            ...(nested && children.length > 0
              ? { onClick: () => props.onToggle(entry.path) }
              : {}),
          }, nested ? baseName(entry.path) : entry.path),
          h('span', {
            key: 'f',
            style: nested ? { ...PANEL_FILES_STYLE, fontSize: 10, opacity: 0.5 } : PANEL_FILES_STYLE,
          }, t('panel.files', { files: String(entry.files ?? 0) })),
          root ? h('span', {
            key: 'open',
            title: t('panel.open', { path: entry.path }),
            style: {
              flex: '0 0 auto', cursor: 'pointer', opacity: nested ? 0.45 : 0.5,
              fontSize: nested ? 11 : 12,
              padding: '0 2px', transition: 'opacity 120ms',
            },
            onMouseEnter: (e) => { e.currentTarget.style.opacity = '1' },
            onMouseLeave: (e) => { e.currentTarget.style.opacity = nested ? '0.45' : '0.5' },
            onClick: (e) => { e.stopPropagation(); openFolder(entry.path, root) },
          }, '↗') : null,
        ]),
        isExpanded && children.length > 0
          ? h('div', {
              key: 'children',
              style: {
                paddingLeft: 18, marginLeft: 6,
                borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
                marginBottom: 4,
              },
            }, children.map((child, index) => h(PanelRow, {
              key: `${child.path}:${index}`, entry: child, t, root,
              expanded, onToggle: props.onToggle, depth: depth + 1,
            })))
          : null,
      ])
    }

    /**
     * A minimal observable in the shape a slot hook expects.
     *
     * The seam hands this to the component wrapped in its own selector hook, and
     * that hook requires a selector argument: it calls
     * `useSyncExternalStoreWithSelector` with whatever the component passed, so a
     * bare `useTurnCard()` throws `selector is not a function`, and a component
     * that throws during render takes its whole slot entry down with it — the row
     * simply disappears from the page with one console error and no other trace.
     * Every call site below therefore passes a selector.
     * @param initial - the starting value.
     * @returns a store whose `set` notifies every subscriber.
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * The preference control: the shell's own switch, or this bundle's stand-in.
     *
     * The shell hands every fetched bundle a frozen platform module table, and
     * `Switch` from `@deepseek-ai/dsh-client-ui-primitives` is what the core's
     * General rows render. Reading it from that table keeps this row's control
     * identical to theirs — same 36x20 capsule, same theme tokens, same
     * `role="switch"` semantics — instead of a control that merely looks similar.
     * A deployment that shares no primitives module still gets a switch rather
     * than two text buttons, so the row never falls back to a different control
     * shape.
     * @param props.checked - current value; the control is fully controlled.
     * @param props.onChange - called with the value the click asks for.
     * @param props.label - accessible name, owned by the row.
     * @returns the switch element.
     */
    function SwitchControl(props) {
      const label = props.label
      if (HostSwitch !== undefined) {
        return h(HostSwitch, { checked: props.checked, onChange: props.onChange, label })
      }
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked,
        'aria-label': label,
        style: {
          boxSizing: 'border-box', position: 'relative', flex: '0 0 auto',
          width: 36, height: 20, padding: 2, border: 0, borderRadius: 999,
          cursor: 'pointer', transition: 'background 120ms ease',
          background: props.checked
            ? 'var(--dsw-alias-brand-primary, #2f6feb)'
            : 'var(--dsw-alias-border-l3, rgba(127,127,127,0.45))',
        },
        onClick: () => { props.onChange(!props.checked) },
      }, h('span', {
        style: {
          display: 'block', width: 16, height: 16, borderRadius: '50%',
          transition: 'transform 120ms ease',
          background: props.checked
            ? 'var(--dsw-alias-label-primary-foreground, #fff)'
            : 'var(--dsw-alias-switch-thumb, #fff)',
          transform: props.checked ? 'translateX(16px)' : 'none',
        },
      }))
    }

    /**
     * The Settings → General row for the ledger.
     *
     * Persistence goes through the client settings service when the deployment
     * exposes a namespace for it, and falls back to this page's own store
     * otherwise, so the row always works even though an out-of-tree plugin is not
     * guaranteed a registered namespace.
     */
    function SettingsRow(props) {
      const enabled = props.useTurnCard(value => value)
      const t = props.t
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' } }, [
        h('div', { key: 'text', style: { flex: '1 1 auto' } }, [
          h('div', { key: 'title', style: { fontSize: 13 } }, t('settings.title')),
          h('div', { key: 'detail', style: { fontSize: 11, opacity: 0.6, marginTop: 2 } }, t('settings.detail')),
        ]),
        h('div', { key: 'controls', style: { display: 'flex', gap: 4 } }, [
          h(SwitchControl, {
            key: 'switch',
            checked: enabled,
            onChange: value => { props.setTurnCard(value) },
            label: t('settings.title'),
          }),
        ]),
      ])
    }

    /**
     * Resolve an optional client service without assuming `ctx.get` exists.
     *
     * A client context older than this bundle may not expose it, and an
     * unconditional call would throw before anything registers — taking every
     * surface down over one optional dependency.
     * @param ctx - the client plugin context.
     * @param name - service name.
     * @returns the service, or undefined when this runtime cannot supply it.
     */
    function optional(ctx, name) {
      try {
        return typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch {
        return undefined
      }
    }

    return {
      // `slots` and `locale` are required: without them nothing here can register or
      // name itself. `uiConversation` is required too, and for a sharper reason: the
      // Turn-data Definition below is registered *into* that service, and a service
      // probed for at apply time rather than declared is simply absent when this
      // plugin activates before it — the Definition then never registers, the engine
      // never folds a single event for it, and every surface that reads its data
      // (the Turn card, the dock pill) stays empty with nothing in the console to
      // say why. Declaring it makes the loader wait instead. `remote`, `sessions`
      // and the rest stay optional, because those only degrade a feature.
      inject: ['slots', 'locale', 'uiConversation'],
      apply(ctx) {
        /** Run one surface's registration; a failure here must not take the others down. */
        const ok = []
        const bad = []
        const surface = (label, run) => {
          try {
            run()
            ok.push(label)
          } catch (error) {
            bad.push(`${label}: ${error && error.message}`)
            console.error(`[session-artifacts] ${label} did not register`, error)
          }
        }
        // Text falls back to the key so a locale service that cannot bind still
        // leaves the cards readable rather than blank.
        let t = key => key
        surface('dictionaries', () => {
          ctx.effect(() => ctx.locale.register(NS, DICT), 'session-artifacts: dictionaries')
          t = ctx.locale.bind(NS)
        })

        // Turn data feeds the automatic per-turn card. Without the registry the
        // report card and the settings row still work.
        const conversation = optional(ctx, 'uiConversation')
        if (conversation !== undefined && conversation !== null && conversation.events !== undefined) {
          surface('scan definition', () => ctx.effect(
            () => conversation.events.register(scanDefinition),
            'session-artifacts: scan definition',
          ))
        }

        // Persistence is opportunistic: the row works for this page even when the
        // deployment registers no settings namespace for an out-of-tree plugin.
        const turnCard = createStore(true)
        let setTurnCard = value => { turnCard.set(value) }
        surface('settings', () => {
          const forms = optional(ctx, 'configForms')
          const handle = forms === undefined || forms === null ? undefined : forms.get(NS)
          if (handle === undefined || handle === null) return
          turnCard.set(handle.getSnapshot().value?.showTurnCard ?? true)
          ctx.effect(() => handle.subscribe(() => {
            turnCard.set(handle.getSnapshot().value?.showTurnCard ?? true)
          }), 'session-artifacts: settings subscription')
          setTurnCard = (value) => {
            turnCard.set(value)
            void handle.set('showTurnCard', value).catch(() => {
              // The page-local choice stays usable when persistence is unavailable.
            })
          }
        })
        const settingsFace = () => ({ hooks: { turnCard }, setTurnCard })

        surface('report card', () => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
          { name: 'tool.call.toolview', key: 'session_artifacts_report', locale: NS },
          props => h(ReportCard, { ...props, t }),
        )))
        surface('turn reading', () => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions', id: 'session-artifacts-turn', order: 90, locale: NS,
            inject: () => ({ hooks: { turnCard } }),
          },
          props => h(TurnArtifactPill, { ...props, t, pillEnabled: turnCardEnabled(props) }),
        )))
        surface('settings row', () => ctx.slots.inject('settings.general.item', () => ctx.slots.register(
          { name: 'settings.general.item', id: 'session-artifacts', order: 45, locale: NS, inject: settingsFace },
          props => h(SettingsRow, { ...props, t }),
        )))
        surface('dock pill', () => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          {
            name: 'conversation.composer.dock', id: 'session-artifacts', order: 2, locale: NS,
            inject: () => ({ hooks: { turnCard } }),
          },
          props => h(ArtifactPill, { ...props, t }),
        )))
        try {
          document.documentElement.setAttribute('data-session-artifacts', `ok=[${ok.join('|')}] bad=[${bad.join('|')}]`)
        } catch {}
      },
    }
  },
})
