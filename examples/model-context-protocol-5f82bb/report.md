# MCP 的发现、授权与传输机制侦察

> **调研问题**：Model Context Protocol 用什么机制解决工具发现、授权与传输？  
> **用途**：判断是否值得在自己的插件体系里借鉴它的发现与授权模型  
> **读者**：负责平台插件与工具接入的工程师  
> **规模**：27 个来源 · 7 条证据 · 4 条断言 · 2/8 类来源  
> **Generated**: 2026-10-28 09:21 UTC

## 方法与边界

每一页按顺序单独读取，读一份、记一份，再进入下一页；全部页面文本都已存为快照，正文中的【E##】对应附录 A 中逐字引文。

广度按 8 类来源角色衡量，已覆盖 2 类；深度按八级阶梯衡量，每条断言的完成度写在正文里。

本报告的结论只到证据支持的位置为止：证据不足的断言不会出现在"发现"里，而是列在"尚未回答"。

## 来源地图

| 角色 | 来源 | 状态 |
| --- | --- | --- |
| 一手官方 | 0 | EMPTY |
| 技术文档 | 4 | ok |
| 发布与路线 | 1 | ok |
| 工程深潜 | 0 | EMPTY |
| 独立分析 | 0 | EMPTY |
| 社区摩擦 | 0 | EMPTY |
| 对照基线 | 0 | EMPTY |
| 量化数据 | 0 | EMPTY |

## 发现


### 1. MCP 把"发现"从可选握手变成了一条强制的前置 RPC：server/discover 由服务端必须实现，客户端因此在发任何业务请求之前就能确定版本与能力。


证据【E01】【E02】 · 深度 8/8


- **机制**：客户端在发 tools/list 或 tools/call 之前先发 server/discover；服务端返回 supportedVersions、capabilities 与 identity，客户端据此选定协议版本，之后每个请求都在 _meta 里重复声明版本与能力。
- **前提**：服务端必须实现该 RPC 并在响应里列出 supportedVersions；客户端必须先调用它再发业务请求。版本不匹配时规范要求返回 UnsupportedProtocolVersionError。
- **替代解释**：另一种解释是这只是把 initialize 改了个名字。但 changelog 同时删除了 initialize 与 notifications/initialized 握手，并把版本/能力搬进每个请求的 _meta，说明是去状态化而不是重命名。
- **反证**：若服务端只支持单一版本、客户端也只用该版本，discover 的收益接近于零——此时它更像兼容性探针。规范本身也承认可用它做 backward-compatibility probe。
- **边界**：对 STDIO 传输，discover 的定位是向后兼容探测；在版本已由部署约定的私有环境里，前置发现的价值显著下降。
- **二阶后果**：发现前置后，网关与注册表可以据此自动生成能力清单，接入方不必读文档猜能力；反过来，任何不实现 discover 的服务端都会被判为不合规。


> server/discover lets a client query a server’s supported protocol versions, capabilities, and identity before sending any other requests. Servers MUST implement it.
> — E01, H1 Discovery, first paragraph
>
> Make MCP stateless: remove the initialize / notifications/initialized handshake. Every request now carries its protocol version and client capabilities in _meta
> — E02, H2 Major changes, second bullet


## 张力与不确定

- C02 授权在 MCP 里是可选层而不是准入门槛：规范只把 OAuth 2.1 的一个子集绑在 HTTP 传输上，STDIO 传输被明确排除、凭据改由环境提供。 — 仅一个来源，未做交叉验证
- C03 这次修订用"无状态"换可扩展性：去掉会话与初始化握手，每次请求自带版本与能力，跨调用状态改为由服务端自造句柄当普通参数传。 — 仅一个来源，未做交叉验证
- C04 工具由模型自主发现与调用，而协议只用 SHOULD 要求"人在环可拒绝"，因此治理强度实际由实现方决定，不是协议保证。 — 仅一个来源，未做交叉验证

## 对我们的含义

- 自建插件体系若要统一的工具发现，应把能力声明做成可探测的强制端点并允许缓存，而不是靠文档约定；先验证现有工具注册表能否承担这个角色。
- 如果我们要接入外部 MCP 服务器，不能假设协议提供了治理，必须在客户端或网关侧自己实现工具白名单与二次确认；先做一次真实的工具调用拦截验证。

## 尚未回答

- 无

**未覆盖的来源类型**：一手官方、工程深潜、独立分析、社区摩擦、对照基线、量化数据

**仅单一来源的判断**：C02, C03, C04

## 附录 A：证据清单

| 编号 | 级别 | 来源 | 原文 | 位置 |
| --- | --- | --- | --- | --- |
| E01 | L1 一手原文 | https://modelcontextprotocol.io/specification/2026-07-28/server/discover | server/discover lets a client query a server’s supported protocol versions, capabilities, and identity before sending a… | H1 Discovery, first paragraph |
| E02 | L1 一手原文 | https://modelcontextprotocol.io/specification/2026-07-28/changelog | Make MCP stateless: remove the initialize / notifications/initialized handshake. Every request now carries its protocol… | H2 Major changes, second bullet |
| E03 | L1 一手原文 | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization | Authorization is OPTIONAL for MCP implementations. | H3 Protocol Requirements, first line |
| E04 | L1 一手原文 | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization | The Model Context Protocol provides authorization capabilities at the transport level, enabling MCP clients to make req… | H3 Purpose and Scope, first paragraph |
| E05 | L1 一手原文 | https://modelcontextprotocol.io/specification/2026-07-28/server/tools | For trust & safety and security, there SHOULD always be a human in the loop with the ability to deny tool invocations. | H2 User Interaction Model, security paragraph |
| E06 | L1 一手原文 | https://modelcontextprotocol.io/specification/2026-07-28/changelog | Servers that need cross-call state use explicit, server-minted handles passed as ordinary tool arguments | H2 Major changes, first bullet |
| E07 | L1 一手原文 | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization | Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from th… | H3 Protocol Requirements, STDIO bullet |

## 附录 B：来源清单

| ID | 角色 | 状态 | 标题 | URL |
| --- | --- | --- | --- | --- |
| S01 | release | fetched | Key Changes - Model Context Protocol | https://modelcontextprotocol.io/specification/2026-07-28/changelog |
| S02 | primary | seen | Overview - Model Context Protocol | https://modelcontextprotocol.io/specification/2025-11-25/basic |
| S03 | docs | fetched | Specification - Model Context Protocol | https://modelcontextprotocol.io/specification/2026-07-28/index |
| S04 | primary | seen | 规范 – Model Context Protocol （MCP） | https://modelcontextprotocol.info/zh-cn/specification/2025-11-25/ |
| S05 | primary | seen | MCP server – Plugins \| OpenAI Developers | https://developers.openai.com/plugins/concepts/mcp-server |
| S06 | primary | seen | — | https://developers.openai.com/plugins/concepts/mcp-server.md |
| S07 | primary | seen | Model Context Protocol (MCP): Conceptual Guide | https://raw.githubusercontent.com/ai-infra-curriculum/ai-agent-guidebook/c1edd52e1b4af9d2f6ccf03a280ca7bffde8732b/guides/mcp-servers/guide.md#1 |
| S08 | primary | seen | What Is MCP (Model Context Protocol)? A Developer's Guide | https://www.promptise.com/learning-paths/agentic-engineering-promptise-foundry/start?module=what-is-model-context-protocol |
| S09 | primary | seen | — | https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization.md |
| S10 | primary | seen | Authorization - Model Context Protocol | https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization?utm_source=chatgpt.com&trk=article-ssr-frontend-pulse_little-text-block |
| S11 | community | seen | server - server | https://pkg.go.dev/github.com/giantswarm/muster/v5@v5.39.2-rc.2/internal/server#1 |
| S12 | primary | seen | — | https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization.md |
| S13 | primary | seen | plain.oauthserver - plain.oauthserver | https://pypi.org/project/plain.oauthserver/0.1.3/#1 |
| S14 | community | seen | oauth - Report security vulnerabilities privately via GitHu… | https://pkg.go.dev/github.com/giantswarm/mcp-oauth@v0.1.23#2 |
| S15 | primary | seen | — | https://developers.openai.com/plugins/build/auth.md |
| S16 | primary | seen | Authentication – Plugins \| OpenAI Developers | https://developers.openai.com/plugins/build/auth |
| S17 | primary | seen | MCP is Limiting Agentic AI in Enterprises | https://zenodo.org/records/20368424#1 |
| S18 | primary | seen | We Urgently Need Privilege Management in MCP: A Measurement… | https://ieeexplore.ieee.org/abstract/document/11206219#1 |
| S19 | primary | seen | A Systematic Security Analysis of Model Context Protocol: V… | https://ieeexplore.ieee.org/abstract/document/11395848#1 |
| S20 | primary | seen | Enterprise Agentic AI Should Use Real-Time Discovery & Self… | https://zenodo.org/records/20482270#1 |
| S21 | primary | seen | Systematization of Knowledge: Security and Safety in the Mo… | https://export.arxiv.org/abs/2512.08290 |
| S22 | primary | seen | Addressing Security Gaps in MCP: Design of a Resilient Refe… | https://ieeexplore.ieee.org/abstract/document/11236877#1 |
| S23 | primary | seen | Model Context Protocol (MCP): Landscape, Security Threats, … | https://dl.acm.org/doi/full/10.1145/3796519#3 |
| S24 | regulatory | seen | NSA Releases Security Design Considerations for AI-Driven A… | https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/4496698/nsa-releases-security-design-considerations-for-ai-driven-automation-leveraging/ |
| S25 | docs | fetched | Discovery - Model Context Protocol | https://modelcontextprotocol.io/specification/2026-07-28/server/discover |
| S26 | docs | fetched | Authorization - Model Context Protocol | https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization |
| S27 | docs | fetched | Tools - Model Context Protocol | https://modelcontextprotocol.io/specification/2026-07-28/server/tools |
