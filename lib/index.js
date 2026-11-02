// 插件入口：引擎侧的按需加载门禁 + dsh-go 原生界面的四个面板。
//
// 没有网页设置页，没有 HTTP 路由。界面只有 dsh-go 手机 App 这一处。
import {
  MAX_NOTE,
  argsOf,
  readLazyServers,
  readServerNotes,
  hidesTool,
  loaderTool,
  liveLazyServers,
  readRows,
  buildState,
  compact,
  toggleEnabled,
  toggleLazy,
  saveNote,
  addByForm,
  addByJson,
} from './core.js'

export const name = 'dsh-go-mcp'

/** 工具与系统提示是引擎侧必需的服务。 */
export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  const lazy = new Set(readLazyServers(config))
  const notes = readServerNotes(config)

  /** 会话级加载记录：agent 对象 → 它已经能看到哪些服务器的工具。 */
  const loadedByAgent = new WeakMap()

  // 按需加载的门禁。next() 返回其他监听器都认同的那份装配结果；返回一个不同
  // 的对象是改写它的受支持方式。
  ctx.effect(
    () => ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      if (lazy.size === 0) return assembled
      const tools = assembled?.tools
      if (!Array.isArray(tools)) return assembled
      const agent = context?.agent
      // 没有 agent 对象就没有可「按需」的会话（复合分发、run_code 嵌套）；
      // 这种情况下放开，而不是对着一个永远加载不回来的调用方藏工具。
      if (agent === undefined || agent === null) return assembled
      const loaded = loadedByAgent.get(agent)
      const kept = tools.filter((schema) => !hidesTool(schema?.name, lazy, loaded))
      if (kept.length === tools.length) return assembled
      return { ...assembled, tools: kept }
    }),
    'dsh-go-mcp: session-lazy tool gate',
  )

  // 已结束会话的记录本来会随 agent 对象一起消失；这个监听器防止一个被复用的
  // 对象继承上一次的加载状态。
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent !== undefined && agent !== null) loadedByAgent.delete(agent)
  })

  // 只有在真的有按需服务器时才注册 mcp_tools：一个永远加载不到东西的工具
  // 纯粹是模型工具块里的噪音。
  //
  // 它的描述里列着当前挂着的按需服务器，而这个集合会变化：在面板里启停一行是
  // 管理器操作，不是对本插件的配置编辑，所以 apply 不会再跑一次。每当管理器
  // 报告变化就重建一次——先销毁，因为同一层里两个同名注册是硬错误。
  if (lazy.size > 0) {
    let disposeLoader = null

    const unmountLoader = () => {
      if (disposeLoader === null) return
      const dispose = disposeLoader
      disposeLoader = null
      try {
        dispose()
      } catch {
        // 已经没了，没什么好收的。
      }
    }

    const mountLoader = () => {
      if (disposeLoader !== null) return
      // 现在什么都没挂：与其发一个加载不到任何东西的描述，不如不要这个工具。
      if (liveLazyServers(ctx, lazy).size === 0) return
      disposeLoader = ctx.tools.register(loaderTool(ctx, lazy, loadedByAgent, notes))
    }

    ctx.effect(() => {
      mountLoader()
      return unmountLoader
    }, 'dsh-go-mcp: mcp_tools loader')

    // 刻意不监听 tools/change：注册 loader 本身就会 emit 它，监听会形成回环。
    // 管理器操作才是我们要的那个粗粒度信号。
    ctx.on('plugin-manager/changed', () => {
      unmountLoader()
      mountLoader()
    })
  }

  /* ── dsh-go 原生界面 ─────────────────────────────────────────────── */

  /** 详情面板当前看的是哪个服务器（按服务器名）。 */
  let selected = ''

  const pick = (state, id) => state.rows.find((row) => row.serverName === id || row.id === id)
  const stateOf = () => buildState(ctx, lazy, notes)

  ctx.inject(['dshGo'], (ctx) => {
    const dshGo = ctx.dshGo

    // 胶囊：一处就能点到面板，不用翻「全部功能」。
    dshGo.on('open-servers', () => ({ open: 'panel:servers' }))

    /* 服务器列表 ---------------------------------------------------- */

    dshGo.panel('servers', {
      view: (_scope, caps) => {
        const zh = !String(caps?.locale ?? 'zh').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        const state = stateOf()
        const { totals } = state

        const items = state.rows.map((row) => {
          const bits = [`${row.tools.length} ${t('工具', 'tools')}`]
          if (row.chars > 0) bits.push(`~${compact(row.tokens)} tokens`)
          if (row.lazy) bits.push(t('按需', 'lazy'))
          if (!row.enabled) bits.push(t('已停用', 'disabled'))
          return {
            title: row.serverName,
            subtitle: bits.join(' · '),
            trailing: row.enabled ? t('启用', 'on') : t('停用', 'off'),
            tone: row.enabled ? (row.lazy ? 'info' : 'good') : 'muted',
            icon: 'server',
            action: { id: 'select', args: { server: row.serverName } },
          }
        })

        return {
          type: 'stack',
          v: 2,
          title: t('MCP 管理', 'MCP manager'),
          children: [
            {
              type: 'metric',
              label: t('MCP 工具', 'MCP tools'),
              value: String(totals.tools),
              caption: `${t('占全部工具 schema 的', 'share of all tool schema bytes')} ${totals.share}%`,
            },
            {
              type: 'keyValue',
              items: [
                [t('服务器', 'Servers'), `${totals.enabled}/${totals.rows}`],
                [t('schema 占用', 'Schema cost'), `~${compact(totals.tokens)} tokens`],
                [t('按需加载', 'Lazy'), totals.lazy === 0 ? t('未开启', 'off') : `${totals.lazy} · ~${compact(totals.lazyTokens)} tokens`],
              ],
            },
            items.length === 0
              ? {
                type: 'callout',
                tone: 'info',
                text: t('还没有 MCP 服务器。点「添加服务器」粘贴一份配置。', 'No MCP server yet. Tap "Add server" to paste a config.'),
              }
              : { type: 'list', items },
            {
              type: 'actions',
              items: [
                { label: t('刷新', 'Refresh'), action: 'refresh', icon: 'refresh', style: 'plain' },
                { label: t('工具清单', 'Tools'), action: 'openTools', icon: 'tool', style: 'plain' },
                { label: t('添加服务器', 'Add server'), action: 'openAdd', icon: 'add', style: 'primary' },
              ],
            },
          ],
        }
      },
      actions: {
        refresh: () => ({ toast: '已刷新', refresh: true }),
        openTools: () => ({ open: 'panel:tools' }),
        openAdd: () => ({ open: 'panel:add' }),
        select: (_scope, event) => {
          const raw = argsOf(event)
          const server = typeof raw.server === 'string' ? raw.server : ''
          if (server === '') return { toast: '没拿到服务器名' }
          selected = server
          return { open: 'panel:detail' }
        },
      },
    })

    /* 单个服务器 ---------------------------------------------------- */

    dshGo.panel('detail', {
      view: (_scope, caps) => {
        const zh = !String(caps?.locale ?? 'zh').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        const state = stateOf()
        const row = pick(state, selected)

        if (row === undefined) {
          return {
            type: 'stack',
            v: 2,
            title: t('服务器详情', 'Server'),
            children: [
              { type: 'callout', tone: 'info', text: t('回上一页点一个服务器。', 'Pick a server on the previous page.') },
              { type: 'actions', items: [{ label: t('返回列表', 'Back'), action: 'back', style: 'plain' }] },
            ],
          }
        }

        const toolRows = row.tools
          .slice()
          .sort((a, b) => b.chars - a.chars)
          .slice(0, 20)
          .map((tool) => [tool.name, `~${compact(Math.round(tool.chars / 4))}`])

        return {
          type: 'stack',
          v: 2,
          title: row.serverName,
          children: [
            {
              type: 'keyValue',
              items: [
                [t('状态', 'State'), row.enabled ? t('已启用', 'enabled') : t('已停用', 'disabled')],
                [t('传输', 'Transport'), row.transport],
                [t('工具', 'Tools'), String(row.tools.length)],
                [t('schema 占用', 'Schema cost'), row.chars > 0 ? `~${compact(row.tokens)} tokens` : '—'],
                [t('按需加载', 'Lazy'), row.lazy ? t('开', 'on') : t('关', 'off')],
              ],
            },
            {
              type: 'actions',
              items: [
                {
                  label: row.enabled ? t('停用', 'Disable') : t('启用', 'Enable'),
                  action: { id: 'toggleEnabled', args: { id: row.id, enabled: !row.enabled } },
                  icon: row.enabled ? 'pause' : 'play',
                  style: 'plain',
                },
                {
                  label: row.lazy ? t('关掉按需', 'Lazy off') : t('按需加载', 'Lazy on'),
                  action: { id: 'toggleLazy', args: { server: row.serverName, lazy: !row.lazy } },
                  icon: 'refresh',
                  style: 'plain',
                },
              ],
            },
            {
              type: 'form',
              v: 2,
              label: t('这个服务器是干什么的', 'What this server is for'),
              submit: { id: 'saveNote', args: { note: { $: 'data.note' } } },
              submitLabel: t('保存备注', 'Save note'),
              children: [
                {
                  type: 'textField',
                  label: t('备注', 'Note'),
                  bind: 'data.note',
                  multiline: true,
                  maxLines: 4,
                  maxLength: 200,
                  placeholder: t('按需加载时模型只能看到这句', 'The model only sees this when lazy'),
                },
              ],
            },
            toolRows.length === 0
              ? {
                type: 'callout',
                tone: 'info',
                text: t('这个服务器现在没有注册工具，可能启动失败了。', 'No tool registered right now — startup may have failed.'),
              }
              : {
                type: 'table',
                columns: [t('工具', 'Tool'), 'tokens'],
                rows: toolRows,
                caption: row.tools.length > 20
                  ? t(`只列占用最大的 20 个，共 ${row.tools.length} 个`, `Top 20 of ${row.tools.length}`)
                  : undefined,
              },
            {
              type: 'actions',
              items: [
                { label: t('返回列表', 'Back'), action: 'back', style: 'plain' },
                { label: t('刷新', 'Refresh'), action: 'refresh', icon: 'refresh', style: 'plain' },
              ],
            },
          ],
        }
      },
      data: (_scope, emit) => {
        const state = stateOf()
        emit({ note: pick(state, selected)?.note ?? '' })
        return () => {}
      },
      actions: {
        back: () => ({ open: 'panel:servers' }),
        refresh: () => ({ toast: '已刷新', refresh: true }),
        toggleEnabled: (_scope, event) => toggleEnabled(ctx, event),
        toggleLazy: (_scope, event) => toggleLazy(ctx, lazy, notes, event),
        saveNote: (scope, event) => saveNote(ctx, scope, lazy, notes, () => selected, event),
      },
    })

    /* 添加服务器 ---------------------------------------------------- */

    dshGo.panel('add', {
      view: (_scope, caps) => {
        const zh = !String(caps?.locale ?? 'zh').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        return {
          type: 'stack',
          v: 2,
          title: t('添加 MCP 服务器', 'Add MCP server'),
          children: [
            {
              type: 'callout',
              tone: 'info',
              text: t(
                'stdio 服务器填命令（如 npx）和参数；远程服务器只填 url。',
                'For stdio fill a command such as npx plus args; for a remote server fill the url only.',
              ),
            },
            {
              type: 'form',
              v: 2,
              label: t('本地命令服务器（stdio）', 'Local command server (stdio)'),
              submit: {
                id: 'addByForm',
                args: {
                  name: { $: 'data.name' },
                  command: { $: 'data.command' },
                  args: { $: 'data.args' },
                },
              },
              submitLabel: t('添加', 'Add'),
              children: [
                { type: 'textField', label: t('名字', 'Name'), bind: 'data.name', placeholder: 'filesystem', maxLength: 32, required: true },
                { type: 'textField', label: t('命令', 'Command'), bind: 'data.command', placeholder: 'npx', maxLength: 60 },
                { type: 'textField', label: t('参数', 'Args'), bind: 'data.args', placeholder: '-y @modelcontextprotocol/server-filesystem', maxLength: 150 },
              ],
            },
            {
              type: 'form',
              v: 2,
              label: t('远程服务器（http）', 'Remote server (http)'),
              submit: {
                id: 'addByForm',
                args: {
                  name: { $: 'data.rname' },
                  url: { $: 'data.url' },
                },
              },
              submitLabel: t('添加', 'Add'),
              children: [
                { type: 'textField', label: t('名字', 'Name'), bind: 'data.rname', placeholder: 'exa', maxLength: 32, required: true },
                { type: 'textField', label: 'url', bind: 'data.url', placeholder: 'https://mcp.exa.ai/mcp', maxLength: 200 },
              ],
            },
            {
              type: 'form',
              v: 2,
              label: t('粘贴 JSON 配置', 'Paste JSON config'),
              submit: { id: 'addByJson', args: { json: { $: 'data.json' } } },
              submitLabel: t('添加', 'Add'),
              children: [
                {
                  type: 'textField',
                  label: 'JSON',
                  bind: 'data.json',
                  multiline: true,
                  maxLines: 8,
                  maxLength: 300,
                  placeholder: '{"mcpServers":{"exa":{"url":"https://mcp.exa.ai/mcp"}}}',
                },
              ],
            },
            {
              type: 'callout',
              tone: 'info',
              text: t(
                'JSON 框最多 300 字（超了表单会坏）。配置更长就直接改 profile 的 cordis.patch.yml。',
                'The JSON box is capped at 300 chars (longer breaks the form). Edit cordis.patch.yml for anything bigger.',
              ),
            },
            { type: 'actions', items: [{ label: t('返回列表', 'Back'), action: 'back', style: 'plain' }] },
          ],
        }
      },
      data: (_scope, emit) => {
        emit({ name: '', command: '', args: '', rname: '', url: '', json: '' })
        return () => {}
      },
      actions: {
        back: () => ({ open: 'panel:servers' }),
        addByForm: (_scope, event) => addByForm(ctx, event),
        addByJson: (_scope, event) => addByJson(ctx, event),
      },
    })

    /* 工具清单 ------------------------------------------------------ */

    dshGo.panel('tools', {
      view: (_scope, caps) => {
        const zh = !String(caps?.locale ?? 'zh').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        const state = stateOf()
        const rows = []
        for (const row of state.rows) {
          if (row.tools.length === 0) continue
          rows.push([
            row.serverName,
            String(row.tools.length),
            `~${compact(row.tokens)}`,
            row.lazy ? (row.enabled ? t('按需', 'lazy') : t('停用', 'off')) : t('常驻', 'always'),
          ])
          if (rows.length >= 50) break
        }
        return {
          type: 'stack',
          v: 2,
          title: t('工具清单', 'Tool inventory'),
          children: [
            {
              type: 'metric',
              label: t('全部 MCP 工具', 'MCP tools'),
              value: String(state.totals.tools),
              caption: `~${compact(state.totals.tokens)} tokens`,
            },
            rows.length === 0
              ? { type: 'callout', tone: 'info', text: t('还没有服务器注册工具。', 'No server registered any tool yet.') }
              : {
                type: 'table',
                columns: [t('服务器', 'Server'), t('工具数', 'Tools'), 'tokens', t('加载', 'Load')],
                rows,
              },
            {
              type: 'actions',
              items: [
                { label: t('返回', 'Back'), action: 'back', style: 'plain' },
                { label: t('刷新', 'Refresh'), action: 'refresh', icon: 'refresh', style: 'plain' },
              ],
            },
          ],
        }
      },
      actions: {
        back: () => ({ open: 'panel:servers' }),
        refresh: () => ({ toast: '已刷新', refresh: true }),
      },
    })
  })
}
