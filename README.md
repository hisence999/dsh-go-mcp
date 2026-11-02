# dsh-go-mcp

MCP 服务器管理，**专为 [dsh-go](https://github.com/hisence999/dsh-go) 手机 App 开发**。

管理面板直接画成手机原生界面，没有网页设置页——不需要浏览器，也不需要刷新页面。

## 功能

- **服务器列表** — 每台服务器的工具数、schema 占用的 token、是否按需加载
- **单个服务器** — 启用 / 停用、开关按需加载、填写用途备注、查看占用最大的工具
- **添加服务器** — 手工填命令或 url，也可以直接粘贴一段 `mcpServers` JSON
- **工具清单** — 所有服务器的工具数与开销汇总

**按需加载（lazy）** 是这个插件的主要特性：开启后，那台服务器的工具不会进入模型每次请求的工具块，只有模型调用 `mcp_tools` 时才临时加载进当前会话。服务器多的时候能省下可观的 token。

## 安装

```sh
dsh plugin --profile web add https://github.com/hisence999/dsh-go-mcp
```

重启一次引擎（App 的「引擎」页），插件才会生效。

## 使用

聊天页输入框上方会出现「MCP 管理」胶囊，点一下就是面板。也可以在「全部功能」或对话详情页的「插件」页签里找到。

添加的服务器写进当前 profile 的 `cordis.patch.yml`，和手动编辑那份文件是同一个效果：

```yaml
- insert:
    - id: filesystem
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: filesystem
        transport: stdio
        command: npx
        args:
          - -y
          - '@modelcontextprotocol/server-filesystem'
          - /root
        failOnStartupError: false
```

## 配置

存在本插件自己的 profile 行上：

```yaml
- id: dsh-go-mcp
  name: dsh-go-mcp
  config:
    lazyServers:        # 按需加载的服务器名
      - filesystem
    serverNotes:        # 每台服务器的用途，按需加载时会给模型看
      filesystem: 读写 /root 下的文件
```

面板只是这份配置的一个视图，手改这份配置和用面板改效果一样。

## 要求

- dsh-go App，且桥接版本 ≥ 0.4.0（原生面板需要视图 v2 的输入控件）
- DSH ≥ 0.2.1-rc.2
- 需要宿主上有 `@deepseek-ai/dsh-mcp-client`

## 许可

MIT
