# InkFlow 个人知识库（Local-First Knowledge Hub）

InkFlow 是一个**本地优先**的个人知识库：Markdown 文件是唯一事实来源（SSOT），
SQLite（WAL）只作为派生索引与全文搜索加速器。

- 前端：React 19 + TypeScript + Vite + Tailwind
- 后端：Express + Node.js 原生 `node:sqlite`
- 数据：`storage/documents/{docId}/index.md`、`storage/database/knowledge_hub.sqlite`、
  `storage/assets/`、`storage/revisions/`

---

## 🚀 本地开发

```bash
npm install
npm run dev          # http://localhost:3000
```

## ✅ 质量校验

```bash
npm run lint         # tsc --noEmit
npm test             # vitest（安全边界 / 初始化竞争 / 附件权限 / 发布包泄露）
npm run build        # 前端生产构建
npm run release      # 生成 release/ 生产部署包（含敏感数据自检）
```

## 🔐 首次初始化（SEC-006）

系统**没有**任何默认密码或固定恢复码。首次创建主理人账号必须提供一次性初始化密钥：

1. 在服务器环境（或 `.env`，切勿提交到 Git）配置：

   ```bash
   openssl rand -hex 32          # 生成随机密钥
   export INKFLOW_INIT_KEY="<粘贴上面生成的 64 位十六进制字符串>"
   ```

2. 启动服务后打开 http://localhost:3000 ，在初始化向导中填写该密钥与主理人密码。
3. 初始化成功后：
   - 服务端写入一次性标记 `system_settings.owner_initialized=1`；
   - **初始化入口永久关闭**，任何重复请求返回 `403 ALREADY_INITIALIZED`；
   - 系统生成一次性应急恢复密钥 `INK-XXXX-XXXX-XXXX-XXXX`，请离线保存。
4. 完成后建议**从环境变量中删除 `INKFLOW_INIT_KEY`** 并重启服务。

行为矩阵：

| 场景 | 结果 |
| --- | --- |
| 未配置 `INKFLOW_INIT_KEY` | `/auth/init` 返回 `403 INIT_DISABLED`，`/auth/status` 的 `canInitialize=false` |
| 未携带密钥 | `401 INVALID_INIT_KEY` |
| 密钥错误 | `403 INVALID_INIT_KEY` |
| 密钥正确（首次） | `201` 创建主理人 + 会话 + 恢复码 |
| 已初始化后再次请求 | `403 ALREADY_INITIALIZED`（不论密钥是否正确） |
| 并发初始化 | 事务 + Owner 唯一索引，仅一个成功 |
| 初始化中途失败 | 事务回滚，不留下半初始化状态（无用户/会话/标记） |

## 📄 文档可见性默认值（SEC-011）

- 新建文档默认 `visibility='private'`、`status='draft'`。
- 只有 Owner 在编辑器中显式选择「公开」+「已发布」后，访客才可见。
- 既有文档的状态不会被批量改写；未携带 `visibility/status` 的更新保持原有状态。
- Markdown 导入默认也是私有草稿（除非 frontmatter 显式声明）。

## 🖼️ 附件匿名访问（SEC-007 / SEC-013）

匿名访问 `GET /api/v1/assets/file/:id` 必须同时满足：

1. 附件被某篇文档**真实引用**（通过解析 Markdown 中实际的图片/链接节点建立
   `document_assets` 关联）；
2. 该文档 `visibility='public'`；
3. 该文档 `status='published'`。

引用识别基于 Markdown **Token 树**（`marked.lexer`），只从 `image` / `link` 节点的
目标地址中提取附件 ID，支持三种正式写法：

| 写法 | 示例 |
| --- | --- |
| 编辑器标准 URL | `![图](/api/v1/assets/file/ast_xxx)` |
| 旧版内联附件 | `![图](attachment:ast_xxx)` |
| 显式附件协议 | `![图](asset:ast_xxx)` |

以下情况**不会**建立关联，也不会获得匿名访问权限：

- fenced code block / 行内代码中的 ID；
- 普通正文文本中出现的 ID；
- 原始 HTML `<img src="...">`；
- 文件名或相似字符串（如 `secret-plans.png`、`ast_xxx_extra`）；
- 外部域名或其他协议（`https://…`、`//…`、`javascript:`、`data:`）。

`document_assets` 关联表在每次保存文档、以及服务启动时从 Markdown 重新同步，
取消发布或删除引用后匿名访问立即失效。

## 🗄️ 数据目录与 Git（SEC-008）

运行时数据**不进 Git**：

```
storage/
├── .gitkeep
├── documents/   # Markdown SSOT（.gitkeep 占位）
├── database/    # SQLite + WAL/SHM
├── assets/      # 附件
├── revisions/   # 历史快照
└── backups/
```

`.gitignore` 已覆盖 `storage/**`、`release/`、`*.sqlite*`、`*.db`、`.env*`（保留 `.env.example`）、
`*.pem`、`*.key` 等。空目录骨架通过 `.gitkeep` 保留。

> ⚠️ 如果历史上曾提交过数据库或用户数据，请先备份再评估是否需要
> `git filter-repo` 清理历史（本仓库不会自动重写历史）。

## 📦 生产发布包（SEC-009 / SEC-012）

```bash
npm run release
```

- `release/` 只包含允许公开的程序文件（`dist/`、`server/{db,routes,services}`、入口文件）。
- **绝不复制**运行时 `storage/`；`release/storage/*` 只有空目录骨架。
- 构建结束后自动扫描，发现 SQLite/WAL/SHM、用户文档、附件、修订、`.env`、密钥、日志
  则**构建失败**并列出违规路径。
- 生产数据库在首次启动时自动创建，并在主理人完成初始化后写入公开示例文档。

### 输出目录安全限制（SEC-012）

构建会**先删除**输出目录再重建，因此 `INKFLOW_RELEASE_OUT` 在使用前会被严格校验，
任何危险取值都会在删除**之前**直接终止构建（退出码 1，不修改任何文件）：

| 取值 | 结果 |
| --- | --- |
| 缺省 | `<项目>/release`（唯一的生产输出位置） |
| `<项目>/release` 绝对路径 | 允许 |
| 临时目录下 `inkflow_release_*` / `inkflow-release-*` 直接子目录 | 允许（仅测试构建） |
| 项目根目录、其父目录、文件系统根、用户主目录、临时目录本身 | 拒绝 `FORBIDDEN_TARGET` |
| `storage/`（运行时数据）及其内部任意路径 | 拒绝 `DATA_DIR_CONFLICT` |
| `.git/`、`src/`、`server/`、`scripts/`、`dist/`、`docs/`、`node_modules/` | 拒绝 `PROTECTED_PATH` |
| 相对路径、含控制字符/首尾空白的路径 | 拒绝 `RELATIVE_PATH` / `INVALID_PATH` |
| 指向上述位置的符号链接、悬空链接、非目录路径 | 拒绝 `SYMLINK_TARGET` / `NOT_A_DIRECTORY` |
| 其他任意位置 | 拒绝 `OUTSIDE_ALLOWED_BASE` |

校验使用 `realpath` 与路径包含关系，并在真正删除前**再次校验**，防止校验与删除之间
目录被替换为符号链接。

构建脚本内的**唯一**递归删除就是上面这条经过校验的 `RELEASE_DIR`；不存在其他
staging / 临时目录清理逻辑（SEC-014）。

部署：

```bash
cd release
npm install
INKFLOW_INIT_KEY="$(openssl rand -hex 32)" npm start
```

## 🛡️ 其他加固说明

- 附件路径经 `resolveWithinStorage()` 校验，拒绝目录穿越；文档/版本 ID 必须是安全路径段。
- 登录/初始化/重置接口按 IP 限流（滑动窗口，默认 15 分钟 5 次失败）。
  多进程部署时每个进程独立计数；如需跨进程共享，请在生产环境启用反向代理层限流。
  只有在设置 `INKFLOW_TRUST_PROXY` 后才会信任 `X-Forwarded-For`。
- Markdown 渲染：`srcset` 一律移除；`data:` 图片仅允许经过魔数校验的 PNG/JPEG/WebP/GIF；
  `javascript:`/`vbscript:`/`file:`/`data:` 与协议相对链接均被剥离。
- 匿名 API 响应不返回 `file_path`、`owner_id`、`content_hash` 等内部字段。
