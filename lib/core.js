// dsh-go-mcp — MCP 服务器管理，专为 dsh-go 手机 App 的原生界面而写。
//
// 一个包同时做两件事：
//   1. 引擎侧：按需加载（lazy）的门禁与 mcp_tools 工具，决定一次会话里
//      哪些 MCP 工具真正进入模型的工具块。
//   2. 界面侧：dsh-go 原生的服务器列表、详情、添加、工具清单四个面板。
//
// 所有状态都存在本插件自己的 profile 行上（config.lazyServers /
// config.serverNotes），所以配置文件就是唯一事实来源，面板只是它的一个视图。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'

/** 本包自己的 profile 行 id。读写配置时用它定位。 */
const SELF_PATCH_ID = 'dsh-go-mcp'
const SELF_PACKAGE = 'dsh-go-mcp'

/** 工具名形如 `mcp__<server>__<tool>`。 */
const TOOL_PREFIX = 'mcp__'

/** 这些行由本插件管理。 */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** 粗略的 token 换算，与面板脚注一致。 */
const CHARS_PER_TOKEN = 4

/** 把按需服务器的工具拉进当前会话的那个工具。 */
const LOADER_TOOL_NAME = 'mcp_tools'

/** 让模型自己安装服务器的入口；常驻注册，与按需列表无关。 */
const INSTALL_TOOL_NAME = 'mcp_install'

/** 持久化列表的合理上限；面板不会真的写到这么多。 */
const MAX_LAZY = 64

/** 单条手写备注的字数上限。 */
const MAX_NOTE = 600

/** 服务器名的合法形状；不合规的名字会让写入后的校验失败，留下坏行。 */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** 一次粘贴最多带几个服务器。 */
const MAX_NEW_ROWS = 16

/* ── 配置 ─────────────────────────────────────────────────────────────── */

/**
 * 持久化的按需列表。
 *
 * 刻意不做严格校验：手改过的 profile 行里出现一个坏字符串，不该让整个插件
 * 连界面一起垮掉——丢掉那一条就好。
 */
function readLazyServers(config) {
  const raw = config?.lazyServers
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (value === '' || value.length > 64 || out.includes(value)) continue
    out.push(value)
    if (out.length >= MAX_LAZY) break
  }
  return out
}

function normaliseNote(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_NOTE)
}

/** 持久化的备注，按服务器名索引。空备注等于没写，直接不出现。 */
function readServerNotes(config) {
  const raw = config?.serverNotes
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const server = String(key).trim()
    if (server === '' || server.length > 64) continue
    const note = normaliseNote(value)
    if (note === '') continue
    out[server] = note
    if (Object.keys(out).length >= MAX_LAZY) break
  }
  return out
}

/* ── 工具名 ───────────────────────────────────────────────────────────── */

/** `mcp__<server>__<tool>` 里的服务器段；不是 MCP 工具就是 null。 */
function serverOfToolName(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith(TOOL_PREFIX)) return null
  const rest = toolName.slice(TOOL_PREFIX.length)
  const split = rest.indexOf('__')
  if (split <= 0) return null
  return rest.slice(0, split)
}

/**
 * 一个工具是否必须挡在这次会话的工具块之外。
 *
 * 按需服务器在会话加载它之前一个工具都不给；常驻服务器、非 MCP 工具、以及
 * 本次会话已经加载过的服务器全部放行。
 */
function hidesTool(toolName, lazy, loaded) {
  const server = serverOfToolName(toolName)
  if (server === null || !lazy.has(server)) return false
  return !(loaded !== undefined && loaded.has(server))
}

/** 这个 agent 的加载记录，第一次写入时创建。 */
function loadedSetOf(loadedByAgent, agent) {
  let loaded = loadedByAgent.get(agent)
  if (loaded === undefined) {
    loaded = new Set()
    loadedByAgent.set(agent, loaded)
  }
  return loaded
}

/* ── Loader ───────────────────────────────────────────────────────────── */

function loaderEntries(ctx) {
  try {
    return [...(ctx.get('loader')?.entries?.() ?? [])]
  } catch {
    return []
  }
}

/** 每个 mcp-client 行：id、服务器名、传输方式、是否启用。 */
function readRows(ctx) {
  const rows = []
  for (const entry of loaderEntries(ctx)) {
    const options = entry?.options
    if (!options || options.name !== MCP_CLIENT_PACKAGE) continue
    const config = options.config ?? {}
    rows.push({
      id: String(options.id ?? ''),
      serverName: String(config.serverName ?? options.id ?? ''),
      transport: String(config.transport ?? 'stdio'),
      enabled: !entry.disabled,
    })
  }
  return rows.sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || a.id.localeCompare(b.id))
}

/** 此刻真正挂着的按需服务器（既按需又启用）。每次现读，不缓存。 */
function liveLazyServers(ctx, lazy) {
  const live = new Set()
  for (const row of readRows(ctx)) {
    if (row.enabled && lazy.has(row.serverName)) live.add(row.serverName)
  }
  return live
}

/** 按名字去重后的全部可见 schema。 */
function collectSchemas(ctx) {
  const tools = (() => {
    try {
      return ctx.get('tools')
    } catch {
      return undefined
    }
  })()
  if (!tools || typeof tools.schemas !== 'function') return { schemas: [], scopes: 0 }

  const seen = new Set()
  const schemas = []
  const push = (list) => {
    for (const schema of list ?? []) {
      const toolName = schema?.name
      if (typeof toolName !== 'string' || seen.has(toolName)) continue
      seen.add(toolName)
      schemas.push(schema)
    }
  }

  try {
    push(tools.schemas())
  } catch {
    // 只有作用域视图的组合在这里什么也拿不到，属正常。
  }

  let agents = []
  try {
    agents = ctx.get('agents')?.list?.() ?? []
  } catch {
    agents = []
  }
  for (const agent of agents) {
    try {
      push(tools.schemas(agent))
    } catch {
      // 一个作用域读不了不该连累其他作用域。
    }
  }
  return { schemas, scopes: agents.length }
}

/** 某个 agent 当前能看到的每个服务器的工具数与 schema 字节。 */
function serverStats(ctx, agent) {
  let schemas = []
  try {
    schemas = ctx.get('tools')?.schemas?.(agent) ?? []
  } catch {
    schemas = []
  }
  if (schemas.length === 0) {
    try {
      schemas = ctx.get('tools')?.schemas?.() ?? []
    } catch {
      schemas = []
    }
  }
  const stats = new Map()
  for (const schema of schemas) {
    const server = serverOfToolName(schema?.name)
    if (server === null) continue
    let chars = 0
    try {
      chars = JSON.stringify(schema).length
    } catch {
      chars = 0
    }
    const bucket = stats.get(server) ?? { tools: 0, chars: 0 }
    bucket.tools += 1
    bucket.chars += chars
    stats.set(server, bucket)
  }
  return stats
}

/* ── mcp_tools ────────────────────────────────────────────────────────── */

function loaderDescription(live, notes = {}) {
  const names = [...live].sort()
  const listed = names.map((server) => {
    const note = notes[server]
    return note ? `${server} — ${note}` : `${server} — (no description configured)`
  })
  return [
    'Load MCP tools into THIS session.',
    `Lazy MCP servers are configured for session-lazy startup: their tools (${TOOL_PREFIX}<server>__<tool>)`,
    'are registered but are deliberately kept OUT of your tool block until you load them here.',
    names.length === 0
      ? 'No lazy MCP server is mounted right now — being lazy is not enough, the server also has to be enabled in the MCP manager, so there is nothing to load at the moment.'
      : `Lazy servers: ${listed.join('; ')}.`,
    'The text after each name is the user\'s description of what that server is for —',
    'read it to decide which server the current task needs.',
    'Call with no `servers` to list what can be loaded (name, description, tool count, token cost).',
    'Call with `servers: ["<name>"]` — or ["*"] for all — to load them for this session;',
    'they become callable from your NEXT step on, and only in this session.',
    'Load everything you need in ONE call: each load changes the tool list, so batching beats loading one server at a time.',
  ].join(' ').replace(/\s+/g, ' ')
}

/** 规范化 `servers` 参数；`'*'` 是一个开关，不是服务器名。 */
function readServersArg(value) {
  const list = []
  let star = false
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue
      const server = item.trim()
      if (server.length === 0) continue
      if (server === '*') {
        star = true
        continue
      }
      if (!list.includes(server)) list.push(server)
    }
  }
  return { list, star }
}

/**
 * mcp_tools —— 按需会话唯一能先拿到的 MCP 相关工具。
 *
 * 它不注册任何东西：工具本来就在，它只是在会话记录里翻一个标记，让装配阶段
 * 停止过滤它们。
 */
function loaderTool(ctx, lazy, loadedByAgent, notes = {}) {
  const availableFor = (loaded, agent) => {
    const live = liveLazyServers(ctx, lazy)
    const stats = serverStats(ctx, agent)
    return [...live]
      .filter((server) => !loaded.has(server))
      .sort()
      .map((server) => {
        const bucket = stats.get(server)
        const row = {
          server,
          tools: bucket?.tools ?? 0,
          tokens: Math.round((bucket?.chars ?? 0) / CHARS_PER_TOKEN),
        }
        if (notes[server]) row.note = notes[server]
        return row
      })
  }

  return {
    name: LOADER_TOOL_NAME,
    description: loaderDescription(liveLazyServers(ctx, lazy), notes),
    parameters: {
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Server names to load into this session, or ["*"] for every lazy server. Omit to list what can be loaded.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          loaded: { type: 'array', items: { type: 'string' } },
          activated: { type: 'array', items: { type: 'string' } },
          already: { type: 'array', items: { type: 'string' } },
          unknown: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
          available: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                server: { type: 'string' },
                tools: { type: 'number' },
                tokens: { type: 'number' },
                note: { type: 'string' },
              },
              required: ['server', 'tools', 'tokens'],
            },
          },
          note: { type: 'string' },
        },
        required: ['loaded', 'activated', 'already', 'unknown', 'scope'],
      },
      render: (_args, value) => {
        const lines = []
        if (value.note !== undefined) lines.push(value.note)
        if (value.activated.length > 0) {
          lines.push(`Loaded for this session: ${value.activated.join(', ')} — callable from your next step on.`)
          for (const server of value.activated) {
            if (notes[server]) lines.push(`- ${server}: ${notes[server]}`)
          }
        }
        if (value.already.length > 0) lines.push(`Already loaded: ${value.already.join(', ')}.`)
        if (value.unknown.length > 0) {
          lines.push(`Nothing loaded for these: ${value.unknown.join(', ')} — either the name is wrong or that server is disabled; call with no \`servers\` to see what is loadable right now.`)
        }
        if (value.available !== undefined && value.available.length > 0) {
          lines.push(`Lazy servers not loaded in this session (${value.available.length}):`)
          for (const row of value.available) {
            const purpose = row.note === undefined ? '' : ` — ${row.note}`
            lines.push(`- ${row.server} — ${row.tools} tools, ~${row.tokens} tokens${purpose}`)
          }
          lines.push('Load with mcp_tools {servers: [...]} — exact names or "*".')
        } else if (value.available !== undefined) {
          lines.push('Nothing left to load in this session — every mounted lazy server is already loaded, or none is mounted.')
        }
        if (lines.length === 0) lines.push('Loaded:', value.loaded.length === 0 ? 'none' : value.loaded.join(', '))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const wanted = readServersArg(args?.servers)
      const agent = exec?.agent
      const nothing = {
        loaded: [],
        activated: [],
        already: [],
        unknown: [...wanted.list],
        scope: 'none',
        available: availableFor(new Set(), undefined),
        note: 'This call had no session scope (exec.agent), so nothing could be loaded. Run mcp_tools from an ordinary agent turn.',
      }
      if (agent === undefined || agent === null) return nothing

      const loaded = loadedSetOf(loadedByAgent, agent)

      if (wanted.list.length === 0 && !wanted.star) {
        return {
          loaded: [...loaded].sort(),
          activated: [],
          already: [],
          unknown: [],
          scope: 'session',
          available: availableFor(loaded, agent),
        }
      }

      const live = liveLazyServers(ctx, lazy)
      const target = wanted.star ? new Set(live) : new Set(wanted.list.filter((server) => live.has(server)))
      const unknown = wanted.star ? [] : wanted.list.filter((server) => !live.has(server))
      const activated = []
      const already = []
      for (const server of [...target].sort()) {
        if (loaded.has(server)) already.push(server)
        else {
          loaded.add(server)
          activated.push(server)
        }
      }
      return {
        loaded: [...loaded].sort(),
        activated,
        already,
        unknown,
        scope: 'session',
        available: availableFor(loaded, agent),
      }
    },
  }
}

/**
 * 给模型用的安装入口。
 *
 * 面板是给人点的；模型要加一台服务器得有个能直接动手的入口，否则它只知道
 * 「让用户去设置里加」。这个工具写的就是面板写的那份配置，两条路径完全等价。
 *
 * 描述刻意写得短：它的 schema 每个请求都要付一次 token，而这件事本身并不
 * 复杂，三句话足够说清。
 */
function installTool(ctx) {
  return {
    name: INSTALL_TOOL_NAME,
    description: 'Add an MCP server: writes the profile config and hot-reloads it, nothing left to do by hand. Needs `server` plus either `command` (local stdio) or `url` (remote HTTP). Installs lazy by default — call mcp_tools afterwards to use its tools now; `lazy: false` loads them on every request.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['server'],
      properties: {
        server: { type: 'string', description: 'Name; also the tool prefix mcp__<server>__<tool>. Max 32 chars.' },
        command: { type: 'string', description: 'Executable for a local server, e.g. "npx" — arguments go in `args`.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments for `command`.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables.' },
        url: { type: 'string', description: 'Remote endpoint. Excludes `command`.' },
        lazy: { type: 'boolean', description: 'Hide its tools until mcp_tools loads them. Default true.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'message'],
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const name = typeof args?.server === 'string' ? args.server.trim() : ''
      const command = typeof args?.command === 'string' ? args.command.trim() : ''
      const url = typeof args?.url === 'string' ? args.url.trim() : ''
      const list = Array.isArray(args?.args) ? args.args.filter((a) => typeof a === 'string' && a.trim() !== '') : []
      const env = stringRecord(args?.env)
      const lazy = args?.lazy !== false

      const no = (message) => ({ ok: false, message })

      if (name === '') return no('Needs a `server` name. Letters, digits, `_`, `-`; max 32 characters.')
      if (command === '' && url === '') return no('Needs either `command` (local stdio server) or `url` (remote HTTP server).')
      if (command !== '' && url !== '') return no('`command` and `url` are mutually exclusive — give one of them, not both.')
      if (!SERVER_NAME.test(name)) return no(`"${name}" is not a usable server name: letters, digits, \`_\`, \`-\` only, max 32 characters.`)
      if (/\s/.test(command)) return no('`command` is only the executable. Put arguments in `args` instead.')
      if (readRows(ctx).some((row) => row.serverName === name || row.id === name)) {
        return no(`A server named "${name}" already exists. Pick another name, or manage the existing one in the MCP manager panel.`)
      }

      const spec = command !== '' ? { command, args: list } : { url }
      if (Object.keys(env).length > 0) spec.env = env

      let row
      try {
        row = rowFromSpec(name, spec)
      } catch (error) {
        return no(toastOf(error).toast ?? 'That server spec is not usable.')
      }

      // 先记按需，再写行：这样按下第一次装配起，这些工具就已经被门禁挡住，
      // 不会有一瞬间全量涌进工具块。
      if (lazy) {
        try {
          const live = liveState(ctx)
          const next = [...new Set([...live.lazy, name])].slice(0, MAX_LAZY)
          await serializeWrite(() => persistSettings(ctx, { lazyServers: next }))
        } catch {
          // 按需没记上不影响安装本身，下面照常写明；最多是这些工具全量加载。
        }
      }

      try {
        await appendRows(ctx, [row])
      } catch (error) {
        if (lazy) {
          try {
            const live = liveState(ctx)
            await serializeWrite(() => persistSettings(ctx, {
              lazyServers: [...live.lazy].filter((item) => item !== name),
            }))
          } catch {
            // 回滚按需失败只会留下一个指向不存在服务器的条目，无害。
          }
        }
        // 不用 toastOf：它按面板提示的 40 字上限截断，模型看到的错误会缺关键信息。
        return no(`Install failed and nothing was written: ${error instanceof Error ? error.message : String(error)}`)
      }

      const transport = row.config.transport
      const how = lazy
        ? `It is lazy, so its tools are not in your tool block yet — call mcp_tools with {"servers": ["${name}"]} to load them into this session.`
        : 'Its tools load on every request from now on.'
      return { ok: true, message: `Added "${name}" (${transport}) and hot-reloaded the profile. ${how}` }
    },
  }
}

/* ── 状态 ─────────────────────────────────────────────────────────────── */

function readTools(collected) {
  const byServer = new Map()
  let allChars = 0
  for (const schema of collected.schemas) {
    let chars = 0
    try {
      chars = JSON.stringify(schema).length
    } catch {
      chars = 0
    }
    // 每一个工具都计入分母，不只是 MCP 的。
    allChars += chars
    const server = serverOfToolName(schema?.name)
    if (server === null) continue
    const rest = schema.name.slice(TOOL_PREFIX.length)
    const split = rest.indexOf('__')
    let bucket = byServer.get(server)
    if (bucket === undefined) {
      bucket = { chars: 0, tools: [] }
      byServer.set(server, bucket)
    }
    bucket.chars += chars
    bucket.tools.push({ name: rest.slice(split + 2), chars })
  }
  return { byServer, allChars }
}

function buildState(ctx, lazy, notes) {
  const collected = collectSchemas(ctx)
  const { byServer, allChars } = readTools(collected)
  const rows = readRows(ctx).map((row) => {
    const bucket = byServer.get(row.serverName)
    const chars = bucket?.chars ?? 0
    const isLazy = lazy.has(row.serverName)
    return {
      ...row,
      lazy: isLazy,
      // 三态：停用 > 按需 > 启用。面板靠它决定徽标文字和颜色。
      state: !row.enabled ? 'off' : (isLazy ? 'lazy' : 'on'),
      note: notes[row.serverName] ?? '',
      chars,
      tokens: Math.round(chars / CHARS_PER_TOKEN),
      tools: bucket?.tools ?? [],
    }
  })

  const chars = rows.reduce((total, row) => total + row.chars, 0)
  const lazyRows = rows.filter((row) => row.lazy)
  return {
    rows,
    totals: {
      rows: rows.length,
      enabled: rows.filter((row) => row.enabled).length,
      tools: rows.reduce((total, row) => total + row.tools.length, 0),
      chars,
      tokens: Math.round(chars / CHARS_PER_TOKEN),
      share: allChars > 0 ? Math.round((chars / allChars) * 100) : 0,
      lazy: lazyRows.length,
      lazyTokens: lazyRows.reduce((total, row) => total + row.tokens, 0),
      described: rows.filter((row) => row.note.length > 0).length,
      scopes: collected.scopes,
    },
  }
}

function compact(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 10_000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/* ── 实时配置 ─────────────────────────────────────────────────────────── */

/** 此刻的按需集合与备注，永远现读。 */
function liveState(ctx) {
  const settings = loadSettings(ctx)
  return { lazy: new Set(settings.lazy), notes: { ...settings.notes } }
}

/* ── 写配置 ───────────────────────────────────────────────────────────── */

/** profile 文档是带写锁原子写的，两次连点会撞上写锁；一次只写一个。 */
let writeQueue = Promise.resolve()

function serializeWrite(task) {
  const run = writeQueue.then(task, task)
  writeQueue = run.then(() => undefined, () => undefined)
  return run
}

const WRITE_RETRY_DELAYS = [250, 600, 1200]

function fail(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' ? value : {}
}

function patchIdOf(entry) {
  const record = plainRecord(entry)
  const options = plainRecord(record.options)
  const value = record.patchId ?? record.id ?? options.id
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nameOf(entry) {
  const options = plainRecord(plainRecord(entry).options)
  const value = options.name
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function editWithRetry(editor, entry, produce) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await editor.edit(entry, produce)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const contended = /writer lock|EBUSY|timed out waiting/i.test(message)
      if (!contended) throw error
      if (attempt >= WRITE_RETRY_DELAYS.length) throw fail('另一个写入正在进行，请稍后再试', 409)
      await new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_DELAYS[attempt]))
    }
  }
}

/**
 * 按需列表与备注存在 profile 目录下的一个独立 JSON 文件里。
 *
 * 一开始它们写在插件自己的 profile 行上，用 configEditor.edit 保存。那样每
 * 存一次都会让 Loader 重新装配本插件：面板当场消失、App 报「插件已停用或找
 * 不到」，得点重试才回来。换成独立文件后写配置不再牵动任何插件。
 */
const STATE_FILE = 'dsh-go-mcp.json'

/** 进程内的一份，避免每次渲染都读盘。 */
let stateCache = null

function stateFilePath(ctx) {
  const editor = ctx.get('configEditor')
  const documentPath = editor?.documentPath
  if (typeof documentPath !== 'string' || documentPath === '') return ''
  return join(dirname(documentPath), STATE_FILE)
}

/** 旧版本写在插件行 config 里的那两份，用作首次迁移的来源。 */
function legacySettings(ctx) {
  for (const entry of loaderEntries(ctx)) {
    const options = entry?.options
    if (options === undefined || options === null) continue
    if (String(options.id ?? '') !== SELF_PATCH_ID) continue
    const config = options.config
    if (config === null || typeof config !== 'object') break
    return { lazy: readLazyServers(config), notes: readServerNotes(config) }
  }
  return { lazy: [], notes: {} }
}

/** 读一份设置；没有文件就退回旧位置，顺手写过去。 */
function loadSettings(ctx) {
  if (stateCache !== null) return stateCache
  const path = stateFilePath(ctx)
  if (path === '') {
    stateCache = legacySettings(ctx)
    return stateCache
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    stateCache = { lazy: readLazyServers(raw), notes: readServerNotes(raw) }
    return stateCache
  } catch {
    // 没有文件（或文件坏了）：迁移旧值并写一份，以后就走文件。
    stateCache = legacySettings(ctx)
    try {
      writeFileSync(path, `${JSON.stringify({ lazyServers: stateCache.lazy, serverNotes: stateCache.notes }, null, 2)}\n`)
    } catch {
      // 写不进去也不影响本次会话，下次再试。
    }
    return stateCache
  }
}

/**
 * 存一份设置。只动那个 JSON 文件，不碰 profile patch，所以不会触发任何
 * 插件重新装配，面板也就不会中途消失。
 */
async function persistSettings(ctx, next) {
  const path = stateFilePath(ctx)
  if (path === '') throw fail('找不到可写的 profile 目录', 501)
  const current = loadSettings(ctx)
  const lazy = next.lazyServers !== undefined ? next.lazyServers : current.lazy
  const notes = next.serverNotes !== undefined ? next.serverNotes : current.notes
  const text = `${JSON.stringify({ lazyServers: lazy, serverNotes: notes }, null, 2)}\n`
  const temporary = `${path}.${Date.now().toString(36)}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, path)
  // 写完立刻同步内存缓存，紧接着的渲染就会看到新值。
  stateCache = { lazy: readLazyServers({ lazyServers: lazy }), notes: readServerNotes({ serverNotes: notes }) }
  return { saved: true }
}

/* ── 添加服务器 ───────────────────────────────────────────────────────── */

function argumentList(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : String(value).split(/\s+/)
  return list.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => String(item).trim())
}

function stringRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[String(key)] = item
  }
  return out
}

/**
 * Trae 风格的服务器配置 → 一个 Loader 行。
 *
 * Trae 是大家剪贴板里普遍的格式：`command` 意味着 stdio，`url` 意味着 http。
 * 认不出的东西直接报错而不是悄悄丢掉——粘进来的配置静悄悄少了 env 是最糟的结果。
 */
function rowFromSpec(id, spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw fail(`「${id}」不是对象`)
  }
  if (!SERVER_NAME.test(id)) throw fail('名字只能用字母数字 _ -，最多 32 个字符')

  const command = typeof spec.command === 'string' ? spec.command.trim() : ''
  const url = typeof spec.url === 'string' ? spec.url.trim() : ''
  if (command === '' && url === '') throw fail(`「${id}」需要 command 或 url`)
  if (command !== '' && url !== '') throw fail(`「${id}」同时写了 command 和 url`)

  const config = { serverName: id, transport: command !== '' ? 'stdio' : 'streamable-http' }

  if (command !== '') {
    // 带空格的命令是经典的 npx 误用（`npx -y pkg`），mcp-client 会把它当成
    // 一个可执行文件名去 spawn，然后失败得莫名其妙。
    if (/\s/.test(command)) throw fail('command 只写可执行文件，参数放 args')
    config.command = command
    config.args = argumentList(spec.args)
    const env = stringRecord(spec.env)
    if (Object.keys(env).length > 0) config.env = env
    const cwd = typeof spec.cwd === 'string' ? spec.cwd.trim() : ''
    if (cwd.length > 0) config.cwd = cwd
  } else {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw fail(`「${id}」的 url 不是合法地址`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw fail(`「${id}」的 url 只支持 http/https`)
    config.url = url
    const headers = stringRecord(spec.headers)
    if (Object.keys(headers).length > 0) config.headers = headers
  }

  // 刚粘进来的服务器最可能启动失败，不该把会话带下水。
  config.failOnStartupError = false
  const timeout = Number(spec.toolCallTimeoutMs)
  if (Number.isFinite(timeout) && timeout >= 1000) config.toolCallTimeoutMs = Math.trunc(timeout)

  return { id, name: MCP_CLIENT_PACKAGE, config }
}

/**
 * YAML 里一个标量的安全写法。
 *
 * 只有在不需要引号时保持不引（配置更好读），其余一律加单引号。要注意的是
 * plain scalar **不能以** `@` 或 `` ` `` 开头，`%!&*#[]{}|>'"-,?:` 也不行；
 * 写成 `name: @deepseek-ai/dsh-mcp-client` 会让整个 patch 文件解析失败。
 */
// 不加引号时要求以字母或下划线开头：任何以数字开头的东西（12306、0x10、
// 1e3）都交给引号处理，省得猜 YAML 会把它读成什么类型。
const YAML_PLAIN = /^[A-Za-z_][A-Za-z0-9_./@+:-]*$/

function yamlScalar(value) {
  // 数字和布尔原样写出去：`failOnStartupError: 'false'` 是个非空字符串，在
  // JS 里为真，DSH 会把它当成「启动失败要中断」，正好和本意相反。
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : "''"
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = String(value)
  if (text === '') return "''"
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(text)) return `'${text}'`
  if (YAML_PLAIN.test(text)) return text
  return `'${text.replace(/'/g, "''")}'`
}

function yamlLines(value, indent) {
  const pad = ' '.repeat(indent)
  const lines = []
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${pad}${key}: []`)
      } else {
        lines.push(`${pad}${key}:`)
        for (const element of item) lines.push(`${pad}  - ${yamlScalar(element)}`)
      }
    } else if (item !== null && typeof item === 'object') {
      lines.push(`${pad}${key}:`)
      lines.push(...yamlLines(item, indent + 2))
    } else {
      lines.push(`${pad}${key}: ${yamlScalar(item)}`)
    }
  }
  return lines
}

function renderInsertBlock(rows) {
  const lines = ['# ── Added by dsh-go-mcp; delete this block to remove these servers ──', '- insert:']
  for (const row of rows) {
    lines.push(`    - id: ${yamlScalar(row.id)}`)
    lines.push(`      name: ${yamlScalar(row.name)}`)
    lines.push('      config:')
    lines.push(...yamlLines(row.config, 8))
  }
  return `${lines.join('\n')}\n`
}

/** 原子替换：写到一半被读到的 patch 文件会让整个 profile 加载失败。 */
async function writeProfilePatch(path, text) {
  const temporary = join(dirname(path), `.${Date.now().toString(36)}-${process.pid}.patch.tmp`)
  await writeFile(temporary, text, { mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      // 临时文件已经不在了，正是想要的状态。
    }
    throw error
  }
}

async function reconcile(ctx, addedIds, before, path) {
  const hmr = ctx.get('hmr')
  if (hmr === undefined || typeof hmr.reconcileProfile !== 'function') {
    throw fail('已写入但无法热加载，重启引擎后生效', 202)
  }
  try {
    await hmr.runExclusive(() => hmr.reconcileProfile(addedIds))
  } catch (error) {
    await writeProfilePatch(path, before)
    try {
      await hmr.runExclusive(() => hmr.reconcileProfile())
    } catch {
      // 回滚的文件已经写了；第二次重载失败只会盖掉真正要看的那条报告。
    }
    throw fail(`新服务器没起来，改动已回滚：${error instanceof Error ? error.message : String(error)}`, 500)
  }
}

/**
 * 往 profile patch 尾部追加新的 mcp-client 行。
 *
 * 新行只能诞生在 patch 层（一个没有 insert 的 `- id:` 只能覆盖已有的行），
 * 所以这里用文本插入而不是重新序列化整份文件——后者会把用户手写的每一行都
 * 重新排版并加引号。
 */
async function appendRows(ctx, rows) {
  const editor = ctx.get('configEditor')
  const settings = ctx.get('settings')
  let path
  if (editor !== undefined && typeof editor.documentPath === 'string') path = editor.documentPath
  else if (settings !== undefined && typeof settings.prepareDocument === 'function') {
    path = await settings.prepareDocument()
  }
  if (typeof path !== 'string' || path.length === 0) throw fail('找不到可写的 profile 文件', 501)

  let before
  try {
    before = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    before = ''
  }

  const existing = readRows(ctx)
  const takenIds = new Set(existing.map((row) => row.id))
  const takenNames = new Set(existing.map((row) => row.serverName))
  for (const row of rows) {
    if (takenIds.has(row.id)) throw fail(`已经有一行叫「${row.id}」`, 409)
    if (takenNames.has(row.config.serverName)) throw fail(`已经有服务器叫「${row.config.serverName}」`, 409)
  }

  const block = renderInsertBlock(rows)
  const separator = before.length === 0 ? '' : (before.endsWith('\n') ? (before.endsWith('\n\n') ? '' : '\n') : '\n\n')
  const next = `${before}${separator}${block}`

  await serializeWrite(async () => {
    await writeProfilePatch(path, next)
    await reconcile(ctx, rows.map((row) => row.id), before, path)
  })
  return rows.map((row) => row.id)
}

/**
 * 从 profile patch 里删掉一行 MCP 服务器。
 *
 * 用 yaml 库解析、改 AST、再整份写回，而不是正则删文本：patch 里可能有块标量、
 * 注释、锚点，靠字符串匹配很容易删错地方或者留下半截。写回之后 reconcile 让
 * Loader 重新装配，进程自然就退了。
 */
async function removeServer(ctx, event) {
  const raw = argsOf(event)
  const server = typeof raw.server === 'string' ? raw.server.trim() : ''
  if (server === '') return { toast: '没拿到服务器名' }

  const row = readRows(ctx).find((item) => item.serverName === server || item.id === server)
  if (row === undefined) return { toast: '没有这个服务器' }

  const editor = ctx.get('configEditor')
  let path
  if (editor !== undefined && typeof editor.documentPath === 'string') path = editor.documentPath
  if (typeof path !== 'string' || path === '') return { toast: '找不到可写的 profile 文件' }

  let before
  try {
    before = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') return toastOf(error)
    return { toast: 'profile 文件是空的' }
  }

  let document
  try {
    document = parseDocument(before)
  } catch {
    return { toast: '配置文件解析失败，没敢动' }
  }
  if (document.errors.length > 0) return { toast: '配置文件有语法错误，没敢动' }
  if (!isSeq(document.contents)) return { toast: '配置文件不是列表，没敢动' }

  let removed = 0
  // 倒着走，删除时下标不会错位。
  for (let index = document.contents.items.length - 1; index >= 0; index -= 1) {
    const item = document.contents.items[index]
    if (!isMap(item)) continue
    // 行内 id / name 直接命中（普通的 `- id: xxx` 写法）。
    const directId = document.getIn([index, 'id'])
    const directName = document.getIn([index, 'name'])
    if ((directId === row.id || directName === MCP_CLIENT_PACKAGE) && !item.has('insert')) {
      // 只有确实是这个服务器的行才删；同 id 不同服务器不常见，保守一点确认一次。
      const config = document.getIn([index, 'config'])
      const configName = isMap(config) ? document.getIn([index, 'config', 'serverName']) : undefined
      if (configName === undefined || String(configName) === row.serverName) {
        document.delete(index)
        removed += 1
        continue
      }
    }
    // `- insert: [...]` 里可能有若干行，逐个看。
    if (!item.has('insert')) continue
    const list = document.getIn([index, 'insert'])
    if (!isSeq(list)) continue
    for (let inner = list.items.length - 1; inner >= 0; inner -= 1) {
      const rowNode = list.items[inner]
      if (!isMap(rowNode)) continue
      const innerId = rowNode.get('id')
      const innerName = rowNode.get('name')
      if (innerId !== row.id && innerName !== MCP_CLIENT_PACKAGE) continue
      const innerConfig = rowNode.get('config')
      const innerServer = isMap(innerConfig) ? innerConfig.get('serverName') : undefined
      if (innerServer !== undefined && String(innerServer) !== row.serverName) continue
      list.items.splice(inner, 1)
      removed += 1
    }
    if (list.items.length === 0) document.delete(index)
  }

  if (removed === 0) return { toast: '没在配置里找到这一行' }

  try {
    await serializeWrite(async () => {
      await writeProfilePatch(path, String(document))
      await reconcile(ctx, [row.id], before, path)
    })
  } catch (error) {
    return toastOf(error)
  }

  // 删掉的服务器如果还在按需列表里，一并清掉，别留下指向不存在服务器的条目。
  try {
    const live = liveState(ctx)
    const lazy = [...live.lazy]
    const notes = live.notes
    const keepLazy = lazy.filter((name) => name !== row.serverName)
    const { [row.serverName]: _dropped, ...keepNotes } = notes
    if (keepLazy.length !== lazy.length || Object.keys(keepNotes).length !== Object.keys(notes).length) {
      await serializeWrite(() => persistSettings(ctx, { lazyServers: keepLazy, serverNotes: keepNotes }))
    }
  } catch {
    // 主删除已经成功；清理按需列表失败只会留下一个空条目，不值得反过来报错。
  }

  return { toast: `已删除 ${row.serverName}`, refresh: true }
}

/* ── 解析动作参数 ─────────────────────────────────────────────────────── */

/** 面板动作带回的值。表单提交的包法不唯一，这里把两种都摊平。 */
function valuesOf(event) {
  const raw = event?.value
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const nested = raw.data !== null && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : null
  return nested === null ? { ...raw } : { ...nested, ...raw }
}

function textOf(values, ...keys) {
  for (const key of keys) {
    const value = values[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function argsOf(event) {
  const raw = event?.value ?? event?.args ?? {}
  return raw !== null && typeof raw === 'object' ? raw : {}
}

function toastOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  return { toast: message.slice(0, 40) }
}

/* ── 动作 ─────────────────────────────────────────────────────────────── */

/** 启停一行。setPluginEnabled 认的是 Loader 行的 entryId，不是 patch id。 */
async function toggleEnabled(ctx, event) {
  const raw = argsOf(event)
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id === '') return { toast: '没拿到行 id' }
  const enabled = raw.enabled === true

  const manager = ctx.get('pluginManager')
  if (typeof manager?.setPluginEnabled !== 'function') return { toast: '这台主机不能启停插件' }
  try {
    const plugins = await manager.listPlugins()
    const row = (plugins ?? []).find((plugin) => plugin.patchId === id)
    if (!row) return { toast: '找不到这一行' }
    if (row.readOnlyReason) return { toast: '这一行不能改' }
    await manager.setPluginEnabled(row.entryId, enabled)
    return { toast: enabled ? '已启用' : '已停用', refresh: true }
  } catch (error) {
    return toastOf(error)
  }
}

/** 开/关按需加载。 */
async function toggleLazy(ctx, event) {
  const raw = argsOf(event)
  const server = typeof raw.server === 'string' ? raw.server.trim() : ''
  if (server === '') return { toast: '没拿到服务器名' }
  const wantLazy = raw.lazy === true

  if (!readRows(ctx).some((row) => row.serverName === server)) return { toast: '没有这个服务器' }

  // 现读配置：闭包里那份可能在面板里已经被改过。
  const live = liveState(ctx)
  const next = new Set(live.lazy)
  if (wantLazy) next.add(server)
  else next.delete(server)
  try {
    await serializeWrite(() => persistSettings(ctx, {
      lazyServers: [...next].sort(),
      serverNotes: live.notes,
    }))
    return { toast: wantLazy ? '已开启按需加载' : '已关闭按需加载', refresh: true }
  } catch (error) {
    return toastOf(error)
  }
}

/** 保存备注。 */
async function saveNote(ctx, scope, event, selected) {
  const values = valuesOf(event)
  const server = textOf(values, 'server') || (typeof selected === 'function' ? selected() : '')
  if (server === '') return { toast: '先选一个服务器' }
  if (!readRows(ctx).some((row) => row.serverName === server)) return { toast: '没有这个服务器' }

  let note = textOf(values, 'note')
  if (note === '') {
    const clip = typeof scope?.clipboard === 'string' ? scope.clipboard.trim() : ''
    if (clip === '') return { toast: '备注是空的' }
    note = clip
  }
  if (note.length > MAX_NOTE) note = note.slice(0, MAX_NOTE)

  const live = liveState(ctx)
  try {
    await serializeWrite(() => persistSettings(ctx, {
      lazyServers: [...live.lazy],
      serverNotes: { ...live.notes, [server]: note },
    }))
    return { toast: '备注已保存', refresh: true }
  } catch (error) {
    return toastOf(error)
  }
}

/** 表单里的四个字段 → 一个新行。 */
async function addByForm(ctx, event) {
  const values = valuesOf(event)
  const serverName = textOf(values, 'name', 'rname', 'serverName')
  const command = textOf(values, 'command')
  const url = textOf(values, 'url')
  const argsText = textOf(values, 'args')
  if (serverName === '') return { toast: '先填个名字' }
  if (command === '' && url === '') return { toast: '命令和 url 至少填一个' }
  if (command !== '' && url !== '') return { toast: '命令和 url 只能填一个' }

  try {
    const spec = command !== ''
      ? { command, args: argsText === '' ? [] : argsText.split(/\s+/) }
      : { url }
    const row = rowFromSpec(serverName, spec)
    await appendRows(ctx, [row])
    return { toast: `已添加 ${serverName}`, refresh: true }
  } catch (error) {
    return toastOf(error)
  }
}

/**
 * 整段 `{"mcpServers": {...}}` 粘进来。
 *
 * 表单提交的参数硬上限是 1 KiB（按 JSON 序列化后的字节算，中文每字 3 字节），
 * 而且一旦超了，整个表单会变成错误占位、输入框直接消失。所以输入框在视图里
 * 就限死在 300 字；这里再兜一次底，超长宁可报错也不要写出一份坏配置。
 */
async function addByJson(ctx, event) {
  const values = valuesOf(event)
  const text = textOf(values, 'json')
  if (text === '') return { toast: '没读到 JSON' }
  if (Buffer.byteLength(text, 'utf8') > 900) return { toast: 'JSON 太长，请精简或直接改配置' }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { toast: 'JSON 解析失败' }
  }
  const servers = parsed?.mcpServers ?? parsed
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return { toast: 'JSON 里没有服务器配置' }
  const entries = Object.entries(servers)
  if (entries.length === 0) return { toast: 'JSON 里没有服务器配置' }
  if (entries.length > MAX_NEW_ROWS) return { toast: '一次最多加 16 个' }

  try {
    const rows = entries.map(([id, spec]) => rowFromSpec(String(id).trim(), spec))
    const added = await appendRows(ctx, rows)
    return { toast: `已添加 ${added.length} 个服务器`, refresh: true }
  } catch (error) {
    return toastOf(error)
  }
}

/* ── 供插件主体使用 ───────────────────────────────────────────────────── */

export {
  MAX_NOTE,
  argsOf,
  valuesOf,
  textOf,
  toastOf,
  readLazyServers,
  readServerNotes,
  hidesTool,
  loaderTool,
  installTool,
  liveLazyServers,
  readRows,
  buildState,
  compact,
  toggleEnabled,
  toggleLazy,
  saveNote,
  addByForm,
  addByJson,
  removeServer,
  liveState,
}
