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
  removeServer,
  liveState,
} from './core.js'

export const name = 'dsh-go-mcp'

/** 工具与系统提示是引擎侧必需的服务。 */
export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  const lazy = new Set(readLazyServers(config))
  const notes = readServerNotes(config)

  /** 会话级加载记录：agent 对象 → 它已经能看到哪些服务器的工具。 */
  const loadedByAgent = new WeakMap()

  /** 面板改完按需列表后重挂 mcp_tools；下面注册时赋上真正的实现。 */
  let refreshLoader = () => {}

  // 按需加载的门禁。next() 返回其他监听器都认同的那份装配结果；返回一个不同
  // 的对象是改写它的受支持方式。
  ctx.effect(
    () => ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const live = liveState(ctx).lazy
      if (live.size === 0) return assembled
      const tools = assembled?.tools
      if (!Array.isArray(tools)) return assembled
      const agent = context?.agent
      // 没有 agent 对象就没有可「按需」的会话（复合分发、run_code 嵌套）；
      // 这种情况下放开，而不是对着一个永远加载不回来的调用方藏工具。
      if (agent === undefined || agent === null) return assembled
      const loaded = loadedByAgent.get(agent)
      const kept = tools.filter((schema) => !hidesTool(schema?.name, live, loaded))
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
  // 无条件挂上：这个插件装好时可能一个按需服务器都没有，用户在面板里打开
  // 按需之后才会有。若在 apply 时就用 if 把整块跳过，那个开关永远不会有反应。
  {
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
      const live = liveState(ctx)
      // 现在什么都没挂：与其发一个加载不到任何东西的描述，不如不要这个工具。
      if (liveLazyServers(ctx, live.lazy).size === 0) return
      disposeLoader = ctx.tools.register(loaderTool(ctx, live.lazy, loadedByAgent, live.notes))
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

    // 面板里改按需列表不会经过管理器事件，这里主动重挂一次，让 mcp_tools 的
    // 描述与可加载集合立刻跟上。
    refreshLoader = () => {
      unmountLoader()
      mountLoader()
    }
  }

  /* ── dsh-go 原生界面 ─────────────────────────────────────────────── */

  /** 详情面板当前看的是哪个服务器（按服务器名）。 */
  let selected = ''
  // 多个入口（状态条 / 全部功能 / 插件页签）各有一份详情面板，共用一个
  // selected 会互相覆盖。这里给每份订阅一个自己的选择。
  const perFeedSelected = new WeakMap()

  /** 等待二次确认删除的服务器名；空串表示没有。 */
  let pendingDelete = ''

  const pick = (state, id) => state.rows.find((row) => row.serverName === id || row.id === id)
  const confirmTarget = () => pendingDelete
  // 每次现读配置：面板里改完后 Loader 会重新装配，闭包里那份随即过期。
  const stateOf = () => {
    const live = liveState(ctx)
    return buildState(ctx, live.lazy, live.notes)
  }

  ctx.inject(['dshGo'], (ctx) => {
    const dshGo = ctx.dshGo

    /* 面板数据广播 --------------------------------------------------
     *
     * 面板的 data 函数只在 App 打开它时被调用一次；之后我们改了状态，
     * 同一个面板不会自己重取数据，看起来就像「没生效」。用户换一个入口
     * 进来（重新订阅）才看到新值，这正是「同一入口看不到变化」的原因。
     *
     * 所以这里记住每个面板的 emit 和它的界面语言，改完主动推一遍。
     * App 拿着同一个面板对比新旧数据，画面就跟着更新。
     */
    // 同一个面板可能被打开多份（状态条、全部功能、插件页签各算一个入口），
    // 每份都是独立的订阅。只记住最后一个的话，其余几份就永远不更新——
    // 这正是「换个入口才看到新数据」的来源。所以按面板 id 存一组。
    const emitters = new Map()
    const subscribeFeed = (id, locale, emit) => {
      let list = emitters.get(id)
      if (list === undefined) {
        list = new Set()
        emitters.set(id, list)
      }
      const entry = { emit, zh: isZh(locale) }
      list.add(entry)
      return entry
    }
    const releaseFeed = (id, entry) => {
      const list = emitters.get(id)
      if (list === undefined) return
      list.delete(entry)
      if (list.size === 0) emitters.delete(id)
    }

    /** 状态变了：把每一份还开着、还活着的面板都推一遍新数据。 */
    const broadcast = () => {
      for (const [id, list] of emitters) {
        for (const entry of [...list]) {
          try {
            entry.emit(payloadOf(id, entry.zh, entry))
          } catch {
            // 某一份推失败不该连累其他面板。
          }
        }
      }
    }

    /** 每个面板要推的数据，按 id 取。 */
    const payloadOf = (id, zh, entry) => {
      if (id === 'servers') return serversData(zh)
      if (id === 'detail') return detailData(zh, perFeedSelected.get(entry) ?? selected)
      if (id === 'tools') return toolsData(zh)
      if (id === 'add') return { name: '', command: '', args: '', rname: '', url: '', json: '' }
      return {}
    }

    /* 公共：状态 → 面板数据 ---------------------------------------- */

    const zhOf = (caps) => !String(caps?.locale ?? 'zh').startsWith('en')
    const isZh = (locale) => !String(locale ?? 'zh').startsWith('en')

    /** 三态文案与色调。停用优先，其次按需，最后才是普通启用。 */
    const badgeOf = (row, t) => {
      if (!row.enabled) return { text: t('停用', 'off'), tone: 'muted' }
      if (row.lazy) return { text: t('按需', 'lazy'), tone: 'info' }
      return { text: t('启用', 'on'), tone: 'good' }
    }

    /** 一行服务器 → 列表项。 */
    const listItemOf = (row, t) => {
      const badge = badgeOf(row, t)
      const bits = [`${row.tools.length} ${t('工具', 'tools')}`]
      if (row.chars > 0) bits.push(`~${compact(row.tokens)}`)
      return {
        title: row.serverName,
        subtitle: bits.join(' · '),
        trailing: badge.text,
        tone: badge.tone,
        icon: 'server',
        action: { id: 'select', args: { server: row.serverName } },
      }
    }

    /** 列表面板推给 App 的完整数据。 */
    const serversData = (zh) => {
      const t = (a, b) => (zh ? a : b)
      const state = stateOf()
      const { totals } = state
      return {
        tools: String(totals.tools),
        caption: `${t('占全部工具 schema 的', 'share of all tool schema bytes')} ${totals.share}%`,
        servers: `${totals.enabled}/${totals.rows}`,
        cost: `~${compact(totals.tokens)} tokens`,
        lazy: totals.lazy === 0 ? t('未开启', 'off') : `${totals.lazy} · ~${compact(totals.lazyTokens)} tokens`,
        rows: state.rows.map((row) => listItemOf(row, t)),
        emptyText: state.rows.length === 0
          ? t('还没有 MCP 服务器。点「添加服务器」粘贴一份配置。', 'No MCP server yet. Tap "Add server" to paste a config.')
          : '',
      }
    }

    /** 详情面板推给 App 的完整数据。 */
    const detailData = (zh, name) => {
      const t = (a, b) => (zh ? a : b)
      const state = stateOf()
      const row = pick(state, name ?? selected)
      if (row === undefined) {
        // 没选中、或者刚被删掉：给一份能安全渲染的空数据，别让按钮区出现「—」。
        return {
          found: false,
          title: t('服务器详情', 'Server'),
          state: '—',
          transport: '—',
          count: '—',
          cost: '—',
          lazyState: '—',
          mainActions: [],
          deleteActions: [],
          confirmText: '',
          note: '',
          tools: [],
          caption: '',
        }
      }
      const badge = badgeOf(row, t)
      const toolRows = row.tools
        .slice()
        .sort((a, b) => b.chars - a.chars)
        .slice(0, 20)
        .map((tool) => [tool.name, `~${compact(Math.round(tool.chars / 4))}`])
      return {
        found: true,
        title: row.serverName,
        rowId: row.id,
        serverName: row.serverName,
        wantEnabled: !row.enabled,
        wantLazy: !row.lazy,
        deleteActions: confirmTarget() === row.serverName
          ? [
            {
              label: t('确认删除', 'Confirm delete'),
              action: { id: 'deleteServer', args: { confirmed: true } },
              icon: 'delete',
              style: 'plain',
            },
            {
              label: t('取消', 'Cancel'),
              action: { id: 'cancelDelete' },
              style: 'plain',
            },
          ]
          : [
            {
              label: t('删除这个服务器', 'Delete this server'),
              action: { id: 'confirmDelete', args: { server: row.serverName } },
              icon: 'delete',
              style: 'plain',
            },
          ],
        confirmText: confirmTarget() === row.serverName
          ? t(`删除 ${row.serverName}？这一段会从配置文件里移除，不能撤销。`, `Delete ${row.serverName}? Its block is removed from the config file; this cannot be undone.`)
          : '',
        state: badge.text,
        stateTone: badge.tone,
        transport: row.transport,
        count: String(row.tools.length),
        cost: row.chars > 0 ? `~${compact(row.tokens)} tokens` : '—',
        lazyState: row.lazy ? t('开', 'on') : t('关', 'off'),
        // 注意：这些由 data 函数推过去，里面的 { $: … } 不会被解析，
        // 所以参数一律算成字符串再放进来。
        mainActions: [
          {
            label: row.enabled ? t('停用', 'Disable') : t('启用', 'Enable'),
            icon: 'power',
            style: 'plain',
            action: { id: 'toggleEnabled', args: { id: row.id, enabled: !row.enabled } },
          },
          {
            label: row.lazy ? t('关掉按需', 'Lazy off') : t('按需加载', 'Lazy on'),
            icon: 'refresh',
            style: 'plain',
            action: { id: 'toggleLazy', args: { server: row.serverName, lazy: !row.lazy } },
          },
        ],
        note: row.note,
        tools: toolRows,
        missing: t('这个服务器现在没有注册工具，可能启动失败了。', 'No tool registered right now — startup may have failed.'),
        caption: row.tools.length > 20
          ? t(`只列占用最大的 20 个，共 ${row.tools.length} 个`, `Top 20 of ${row.tools.length}`)
          : '',
        canDelete: true,
      }
    }

    /** 工具清单面板推给 App 的数据。 */
    const toolsData = (zh) => {
      const t = (a, b) => (zh ? a : b)
      const state = stateOf()
      const rows = []
      for (const row of state.rows) {
        if (row.tools.length === 0) continue
        rows.push([
          row.serverName,
          String(row.tools.length),
          `~${compact(row.tokens)}`,
          badgeOf(row, t).text,
        ])
        if (rows.length >= 50) break
      }
      return {
        tools: String(state.totals.tools),
        cost: `~${compact(state.totals.tokens)} tokens`,
        rows,
        emptyText: rows.length === 0 ? t('还没有服务器注册工具。', 'No server registered any tool yet.') : '',
      }
    }

    /* 服务器列表 ---------------------------------------------------- */

    dshGo.panel('servers', {
      view: (_scope, caps) => {
        const zh = zhOf(caps)
        const t = (a, b) => (zh ? a : b)
        return {
          type: 'stack',
          v: 2,
          title: t('MCP 管理', 'MCP manager'),
          children: [
            { type: 'metric', label: t('MCP 工具', 'MCP tools'), value: { $: 'data.tools' }, caption: { $: 'data.caption' } },
            {
              type: 'keyValue',
              items: [
                [t('服务器', 'Servers'), { $: 'data.servers' }],
                [t('schema 占用', 'Schema cost'), { $: 'data.cost' }],
                [t('按需加载', 'Lazy'), { $: 'data.lazy' }],
              ],
            },
            { type: 'list', items: { $: 'data.rows' } },
            { type: 'text', text: { $: 'data.emptyText' }, tone: 'muted' },
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
      data: (_scope, emit, caps) => {
        const entry = subscribeFeed('servers', caps?.locale, emit)
        emit(serversData(entry.zh))
        return () => releaseFeed('servers', entry)
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
          // 刚点进来的那份详情还不知道该看谁，这里标一下所有已知的详情实例。
          for (const entry of emitters.get('detail') ?? []) {
            if (perFeedSelected.get(entry) === undefined) perFeedSelected.set(entry, server)
          }
          return { open: 'panel:detail' }
        },
      },
    })

    /* 单个服务器 ---------------------------------------------------- */

    dshGo.panel('detail', {
      view: (_scope, caps) => {
        const zh = zhOf(caps)
        const t = (a, b) => (zh ? a : b)
        return {
          type: 'stack',
          v: 2,
          title: { $: 'data.title' },
          children: [
            {
              type: 'keyValue',
              items: [
                [t('状态', 'State'), { $: 'data.state' }],
                [t('传输', 'Transport'), { $: 'data.transport' }],
                [t('工具', 'Tools'), { $: 'data.count' }],
                [t('schema 占用', 'Schema cost'), { $: 'data.cost' }],
                [t('按需加载', 'Lazy'), { $: 'data.lazyState' }],
              ],
            },
            // 这两个按钮的 label 与参数都来自 data，但 action 写在视图里，
            // 所以 App 会解析绑定——数据载荷里的绑定它是不解析的。
            { type: 'actions', items: { $: 'data.mainActions' } },
            // 未确认时显示「删除这个服务器」，点了之后这块换成确认条 + 确认按钮。
            {
              type: 'actions',
              items: { $: 'data.deleteActions' },
            },
            { type: 'text', text: { $: 'data.confirmText' }, tone: 'muted' },
            {
              type: 'form',
              v: 2,
              label: t('这个服务器是干什么的', 'What this server is for'),
              submit: { id: 'saveNote', args: { server: { $: 'data.serverName' }, note: { $: 'data.note' } } },
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
            { type: 'table', columns: [t('工具', 'Tool'), 'tokens'], rows: { $: 'data.tools' }, caption: { $: 'data.caption' } },
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
      data: (_scope, emit, caps) => {
        const entry = subscribeFeed('detail', caps?.locale, emit)
        // 没有选择时沿用全局那个，保证首次进入也能看到刚点的那台。
        emit(detailData(entry.zh, perFeedSelected.get(entry) ?? selected))
        return () => releaseFeed('detail', entry)
      },
      actions: {
        back: () => ({ open: 'panel:servers' }),
        refresh: () => ({ toast: '已刷新', refresh: true }),
        // 启停要等 Loader 重新装配，往往超过面板点按的 3 秒上限。先回 pending
        // 让 App 显示等待，真正做完再回一条 toast；操作本身早就成功了。
        toggleEnabled: (_scope, event) => ({
          pending: { label: '正在切换', timeoutMs: 30_000 },
          result: async () => {
            const r = await toggleEnabled(ctx, event)
            refreshLoader()
            broadcast()
            // 延后结果不允许 refresh，只能用 patch 把新状态推回去。
            // 一个对象里可以并列写多个效果；来源面板就是 detail，patch 会推给它。
            return {
              ...(r?.toast ? { toast: r.toast } : {}),
              patch: detailData(isZh(event.locale)),
            }
          },
        }),
        toggleLazy: async (_scope, event) => {
          // 只写配置、不重启进程，很快就返回，不必延后。
          const r = await toggleLazy(ctx, event)
          refreshLoader()
          broadcast()
          return r
        },
        saveNote: async (scope, event) => {
          const r = await saveNote(ctx, scope, event, () => selected)
          broadcast()
          return r
        },
        // 第一次点「删除」只是把确认条亮出来，真正删是 deleteServer。
        confirmDelete: (_scope, event) => {
          const raw = argsOf(event)
          const server = typeof raw.server === 'string' ? raw.server : ''
          if (server === '') return { toast: '没拿到服务器名' }
          pendingDelete = server
          broadcast()
          return { refresh: true }
        },
        deleteServer: (_scope, event) => {
          const raw = argsOf(event)
          const server = pendingDelete
          pendingDelete = ''
          if (raw.confirmed !== true) return { toast: '已取消', refresh: true }
          if (server === '') return { toast: '没拿到服务器名', refresh: true }
          return {
            pending: { label: '正在删除', timeoutMs: 30_000 },
            result: async () => {
              const r = await removeServer(ctx, { value: { server } })
              refreshLoader()
              selected = ''
              broadcast()
              // 延后结果不能 open 面板，这里直接把详情换成「已删除」后的样子。
              return { toast: r?.toast ?? '已删除', patch: detailData(isZh(event.locale)) }
            },
          }
        },
        cancelDelete: () => {
          pendingDelete = ''
          broadcast()
          return { refresh: true }
        },
      },
    })

    /* 添加服务器 ---------------------------------------------------- */

    dshGo.panel('add', {
      view: (_scope, caps) => {
        const zh = zhOf(caps)
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
                args: { name: { $: 'data.name' }, command: { $: 'data.command' }, args: { $: 'data.args' } },
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
                args: { name: { $: 'data.rname' }, url: { $: 'data.url' } },
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
      data: (_scope, emit, caps) => {
        const entry = subscribeFeed('add', caps?.locale, emit)
        emit({ name: '', command: '', args: '', rname: '', url: '', json: '' })
        return () => releaseFeed('add', entry)
      },
      actions: {
        back: () => ({ open: 'panel:servers' }),
        // 添加要启动新进程，同样会超过 3 秒，用延后结果。
        addByForm: (_scope, event) => ({
          pending: { label: '正在启动', timeoutMs: 45_000 },
          result: async () => {
            const r = await addByForm(ctx, event)
            refreshLoader()
            broadcast()
            // 延后结果只能带 toast / patch，这里清空表单让用户可以接着加下一个。
            return {
              ...(r?.toast ? { toast: r.toast } : {}),
              patch: { name: '', command: '', args: '', rname: '', url: '', json: '' },
            }
          },
        }),
        addByJson: (_scope, event) => ({
          pending: { label: '正在启动', timeoutMs: 45_000 },
          result: async () => {
            const r = await addByJson(ctx, event)
            refreshLoader()
            broadcast()
            return {
              ...(r?.toast ? { toast: r.toast } : {}),
              patch: { name: '', command: '', args: '', rname: '', url: '', json: '' },
            }
          },
        }),
      },
    })

    /* 工具清单 ------------------------------------------------------ */

    dshGo.panel('tools', {
      view: (_scope, caps) => {
        const zh = zhOf(caps)
        const t = (a, b) => (zh ? a : b)
        return {
          type: 'stack',
          v: 2,
          title: t('工具清单', 'Tool inventory'),
          children: [
            { type: 'metric', label: t('全部 MCP 工具', 'MCP tools'), value: { $: 'data.tools' }, caption: { $: 'data.cost' } },
            { type: 'table', columns: [t('服务器', 'Server'), t('工具数', 'Tools'), 'tokens', t('加载', 'Load')], rows: { $: 'data.rows' } },
            { type: 'text', text: { $: 'data.emptyText' }, tone: 'muted' },
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
      data: (_scope, emit, caps) => {
        const entry = subscribeFeed('tools', caps?.locale, emit)
        emit(toolsData(entry.zh))
        return () => releaseFeed('tools', entry)
      },
      actions: {
        back: () => ({ open: 'panel:servers' }),
        refresh: () => ({ toast: '已刷新', refresh: true }),
      },
    })
  })
}
