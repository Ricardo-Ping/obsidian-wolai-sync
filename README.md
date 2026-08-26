# Obsidian Wolai Sync

[简体中文](README.md) | [English](README_EN.md)

在 Obsidian 与 Wolai（我来）之间同步 Markdown 页面、数据库记录、子页面和图片的社区插件。

> 本项目基于 [MarswayRed/obsidian-wolai-sync](https://github.com/MarswayRed/obsidian-wolai-sync) 继续开发，保留原项目的版权与许可证，并由 [Ricardo-Ping](https://github.com/Ricardo-Ping) 维护增强版本。感谢原作者 Li Wei 和原项目提供的基础实现。

## 主要功能

- 完整双向同步：Obsidian → Wolai 与 Wolai → Obsidian。
- 增量双向同步：基于页面版本、编辑时间、内容指纹和图片状态跳过未变化内容。
- 普通页面同步：除数据库外，可直接配置一个或多个 Wolai 页面 URL/ID，并递归同步子页面。
- 页面层级映射：Wolai 子页面保存为父页面同名目录下的独立 Markdown 文件。
- 图片增量同步：图片保存到对应页面目录的 `pictures/` 中，只更新新增或变化的图片。
- 断点检查点：每个页面及其图片成功后立即保存状态；暂停或失败后可由增量同步继续。
- API 配额保护：本地统计滚动一小时调用量，可按 Wolai 套餐额度慢速等待并自动续传。
- 任务控制：支持暂停、继续和停止完整/增量同步。
- 安全清理：仅在完整同步成功后，将插件生成且未被手动修改的过期文件移至系统废纸篓。
- 实时日志与进度：流式展示页面进度、API 调用、429 重试、成功和错误信息。
- 自动同步与文件监听：均可选，新安装默认关闭，避免意外消耗 API 额度。
- 仅同步到 Wolai：保留原有单向写入能力，不删除 Wolai 内容。

## 安装

### 从源码构建

需要 Node.js 18 或更高版本。

```bash
git clone https://github.com/Ricardo-Ping/obsidian-wolai-sync.git
cd obsidian-wolai-sync
npm install
npm run build
```

然后将以下文件复制到你的 Obsidian 库：

```text
<你的库>/.obsidian/plugins/obsidian-wolai-sync/
├── main.js
├── manifest.json
└── styles.css
```

重启 Obsidian，在“设置 → 社区插件”中启用 **Wolai Sync**。

## Wolai 配置

1. 在 [Wolai 开发者中心](https://www.wolai.com/developers) 创建应用。
2. 获取 App ID 和 App Secret，并让应用拥有目标页面/数据库的访问权限。
3. 在插件设置中填写：
   - 数据库 ID（使用数据库同步时填写）；
   - App ID；
   - App Secret；
   - Wolai 普通页面（可选，每行一个：`标题 | 页面 URL 或页面 ID`）；
   - 与当前套餐匹配的每小时 API 额度。
4. 设置 Obsidian 同步文件夹，并先点击“测试连接”。

配置仅保存在本地 Obsidian 插件数据中。请勿提交 `data.json`、日志或状态文件。

## 数据库字段

数据库同步沿用原项目的数据模型，至少需要：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| 标题 | 标题/文本 | Obsidian 文件标题 |
| 同步状态 | 单选 | 使用 `Pending`、`Synced` 等状态 |

普通页面递归同步不要求建立数据库。

## 同步模式

### 完整双向同步

重新读取配置的页面和数据库记录，写入页面及图片。只有整次成功后才提交最终状态并执行安全清理。

### 增量双向同步

先读取轻量元数据，未变化页面直接跳过；发生变化时再读取内容，并按图片版本分别处理新增、修改和删除。页面成功后会立刻保存检查点。

### 仅同步到 Wolai

只将 Obsidian 中待同步的文件写入 Wolai，不执行 Wolai → Obsidian，也不会因为本地缺少文件而删除 Wolai 页面。

## 文件结构

例如 Wolai 中有父页面 `数据库查询重写` 和子页面 `GRewriter`：

```text
Wolai/
├── 数据库查询重写.md
└── 数据库查询重写/
    ├── pictures/
    ├── GRewriter.md
    └── GRewriter/
        └── pictures/
```

每个页面的图片放在该页面自己的 `pictures/` 目录中。

## API 限制与慢速同步

插件在真正发送 Wolai API 请求前记录本地时间戳，以滚动 60 分钟窗口控制额度。达到所选套餐额度后，任务会保留并等待旧请求释放额度。等待提示本身是本地检查，不消耗 API。

Wolai 服务端仍可能返回 HTTP 429；插件会读取 `Retry-After`（如果存在）并退避重试。月度额度无法通过延迟绕过。

## 安全策略

- `App Secret`、插件设置、同步日志、API 计数和增量状态均已列入 `.gitignore`。
- 自动同步和文件监听默认关闭。
- 失败或取消的完整同步不会触发过期文件清理。
- 清理只处理插件清单中记录且未被用户手动修改的文件，并优先移动到系统废纸篓。
- 双向同步有覆盖风险，首次运行前请备份 Obsidian 库与 Wolai 页面。

## 开发与验证

```bash
npm install
npm run lint
npm test
npm run build
# 或一次执行全部检查
npm run check
```

仓库提交源代码，不提交 `node_modules/`、本地配置、日志、同步状态或构建产物 `main.js`。发布插件时需附带 `main.js`、`manifest.json` 和 `styles.css`。

## 已知限制

- Wolai 与 Markdown 的块模型不同，复杂嵌套、部分数据库属性或特殊富文本可能无法完全无损转换。
- 网络中断、服务端限流和套餐月度额度仍可能使任务暂停或失败。
- 同一页面不建议在两端同时编辑；发生冲突前请保留备份。
- 本项目尚未进入 Obsidian 官方社区插件市场，当前需手动安装。

## 来源与许可证

本项目是 [MarswayRed/obsidian-wolai-sync](https://github.com/MarswayRed/obsidian-wolai-sync) 的衍生改进版本。原仓库基于 Obsidian Sample Plugin，并使用 0BSD 风格许可证文本。

版权和许可详情见 [LICENSE](LICENSE)。原项目版权声明继续保留，2026 年后的增强修改版权归 Ricardo_PING 所有。

## 贡献

欢迎提交 Issue 和 Pull Request。报告同步问题时，请先移除日志中的 App ID、App Secret、页面 ID、页面标题和本地路径等敏感信息。
