# 网站深度侦察 · Website Deep Recon

一个 DeepSeek Harness 插件。把「帮我上网查一下」变成一套**可检验**的侦察流程：宽度按来源角色衡量，深度按八级证据阶梯衡量，每一条写进报告的断言都必须能追到一句**逐字存在**的原文。

它不替你写报告，它让「没查到」这件事无法伪装成「查到了」。

```
recon_init → recon_search → recon_fetch / recon_map → recon_evidence
          → recon_claim → recon_probe → recon_gaps → recon_report → recon_audit
```

---

## 为什么需要它

普通的"深度调研"通常这样结束：读了七八个页面，写出一篇结构漂亮、引用了很多链接的报告，其中若干结论其实是模型自己的常识，链接只是恰好相关。读者无法分辨哪一句有据、哪一句是推测。

这个框架把三个东西变成**账本里的状态**，而不是写作时的自觉：

| | 变成什么 | 谁在检查 |
|---|---|---|
| 信息宽度 | 11 类来源角色，每类至少要有一页**真正读进来** | `recon_gaps` / `recon_audit` |
| 思考深度 | 每条断言 8 级阶梯，答了几级就记几分 | `recon_probe` / 报告正文 |
| 证据可信 | 引文必须能在已保存的页面快照里逐字找到 | `recon_evidence` 当场拒收 |

---

## 安装

插件是一个普通的 Cordis bundle，纯 Node、零依赖。

```bash
# 在 DeepSeek Harness 里
plugin_manager install_bundle  target=/绝对路径/site-recon
```

安装后 profile 里多一行 `site-recon`，同时出现 11 个 `recon_*` 工具和 `site-recon` 技能。卸载：

```bash
plugin_manager remove_bundle  target=dsh-site-recon
```

在别的 Harness 里复用时，把 `skill/SKILL.md` 当作普通技能文件、把 `lib/` 当作纯 JS 库调用也可以——工具层只依赖 `node:` 内置模块。

---

## 十一个工具

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `recon_init` | 为一个问题建工作区，定下宽度角色、子问题、预算 | 只调一次；问题原话入库，报告里不改写 |
| `recon_search` | 多角度扫面，按 URL 猜来源角色 | 只登记候选，**不算覆盖** |
| `recon_fetch` | 读一页并存快照，返回标题/大纲/正文/同站链接 | 一次一页，按 host 限速 |
| `recon_map` | 顺着入口页自己的链接画出页面树 | 有页数预算，不整站爬 |
| `recon_evidence` | 记一条逐字引文 + 位置 + 强度 | **引文不在快照里就拒收**，并回最近的原文段落 |
| `recon_claim` | 立一条断言，挂证据 | 状态由账本算，不接受手写 |
| `recon_probe` | 对断言过八级阶梯 | 少于 50% 会在缺口里被点名 |
| `recon_gaps` | 还缺什么，按"会改变报告的程度"排序 | 每读几页就该调一次 |
| `recon_report` | 由账本生成 report.md（含 `【E##】` 引用与附录） | 无证据的断言**不进"发现"**，只进"尚未回答" |
| `recon_audit` | 交付前过闸 | 引文漂移、快照丢失、角色空缺都会报 |
| `recon_capture` | 用本机 Chrome 按元素取景截图并自检 | 量不到、被遮挡、疑似空白都不落盘 |

---

## 两条设计主线

### 宽度：按角色，不按页数

"读了 20 个页面"不是宽度。11 类角色里覆盖了几类才是：

`一手官方 · 技术文档 · 价格条款 · 发布与路线 · 工程深潜 · 独立分析 · 社区摩擦 · 落地案例 · 法规标准 · 对照基线 · 量化数据`

默认取其中 8 类（适合技术产品类问题），可以按题目换。关键差异：**登记了但没读进来，覆盖率不算**。这条规则专门用来戳破"搜索结果里看起来什么都有"的幻觉。

### 深度：八级阶梯

每条断言要回答这八问，答不上的地方就是报告的边界：

| 级 | 问题 | 卡住什么 |
|---|---|---|
| 机制 | 输入什么、经过什么、输出什么 | 说不清机制 = 还没读懂 |
| 证据 | 哪一句原文支撑它 | 区分"提到过"与"说过这件事" |
| 前提 | 成立要什么条件、谁付成本 | 把宣传还原成交易 |
| 替代解释 | 还有什么解释同样成立 | 防止把相关当因果 |
| 反证 | 什么材料能推翻它 | 主动找反面，别等读者找 |
| 边界 | 什么情况下失效 | 适用范围就是可信度 |
| 二阶后果 | 会连锁引发什么 | 从"它是什么"到"它带来什么" |
| 我方含义 | 对提问者意味着什么 | 报告的价值落点 |

经验：**机制**和**反证**最常改变结论。少于 4 级的断言，在 `recon_gaps` 里会被标出来。

---

## 工作区

```
recon/<问题-slug>/
├── recon.json        工作区标记
├── brief.json        问题原话、宽度角色、子问题、预算
├── sources.json      来源账本（角色 / 状态 / 快照路径）
├── evidence.json     证据账本（引文 / 位置 / 级别 / 是否核到）
├── claims.json       断言账本（证据链接 + 八级答案）
├── artifacts.json    截图产物
├── pages/            页面正文快照 ← 引文核对的唯一依据
├── captures/         PNG + 同名 .json 校验记录
└── report.md         由账本生成的报告
```

快照是整套东西的地基。`recon_evidence` 和 `recon_audit` 都拿引文去快照里 `indexOf`；网页后来改了，审计会说"引文已与快照不符"，而不是继续引用一句已经不存在的话。

---

## 一次真实运行

`examples/model-context-protocol-5f82bb/` 是一次完整的侦察产物（MCP 的发现/授权/传输机制）。它的价值不在于结论，而在于它**承认了什么**：

- 4 条断言里只有 1 条达到 `supported`，其余 3 条被标为 `single-source`——因为它们虽然引了规范原文，但都出自同一个页面。
- 那条 `supported` 的断言把八级阶梯答满（8/8），因此成为唯一进入"发现"的结论。
- 8 类来源只覆盖了 2 类，`recon_audit` 直接列出六个空角色，并把它们写进报告的"尚未回答"。
- 三条来自同一页的引文没有被当成三个独立来源——这是"孤证"判定最常见的误判来源。

审计结果：

```
PASS · 0 errors · 8 warnings
- C02 depth 0/8
- C03 depth 0/8
- source role "独立分析" has no page actually read
...
```

**PASS 不代表完美，代表没有站不住的断言。** 警告就是这份报告诚实的边界。

---

## 开发与验证

```bash
node test/smoke.mjs     # 13 项端到端检查，离线运行，带假网络
```

测试覆盖：工作区幂等、来源归类、快照落盘、**伪造引文被拒**、逐字引文通过、状态推导（孤证→已支持）、深度计分、缺口排序、报告引用、严格审计失败、无浏览器时截图明确报错。

代码结构：

```
index.js          apply()：注册工具 + 技能
lib/model.js      宽度角色、证据级别、八级阶梯、状态推导
lib/html.js       HTML → 可读结构（无依赖，引文归一化）
lib/store.js      工作区持久化（原子写、稳定 ID）
lib/net.js        礼貌抓取（按 host 限速）
lib/capture.js    CDP 截图 + 测量/复测/遮挡/像素校验
lib/tools.js      11 个工具的 schema 与实现
skill/SKILL.md    方法论技能（装进 Harness 的技能目录）
docs/methodology.md  这套方法是从哪次实践里长出来的
```

---

## 兼容性

- Node.js ≥ 20（`AbortSignal.timeout`、全局 `fetch`）。
- 联网走 Harness 的 `ctx.web`（搜索/抓取 provider），没有该服务时退回全局 `fetch`。
- `recon_capture` 需要本机 Chrome 带 `--remote-debugging-port`，例如：

  ```bash
  chrome.exe --remote-debugging-port=9222 --user-data-dir=<空目录>
  ```

  没有浏览器时它明确报错，不会假装截到了一张图。

---

## 许可

MIT。`docs/methodology.md` 记录了这套方法在一次真实调研中的来源与代价。
