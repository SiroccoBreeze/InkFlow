# Astro / InkFlow Knowledge Hub — 架构设计与技术方案规范文档

> **版本**：v1.0.0  
> **作者**：InkFlow & Knowledge Hub 架构团队  
> **更新时间**：2026-11-02  
> **状态**：已批准执行 (Approved for Implementation)

---

## 1. 项目定位与核心设计哲学

InkFlow Knowledge Hub 是一个集**个人知识管理、深度 Markdown 纯净写作、双向拓扑图谱、带权限受控分享与全文搜索**于一体的本地优先（Local-First）独立知识平台。

### 1.1 核心设计准则

1. **Local-First & Markdown-First（内容真源）**：
   - 硬盘上的标准 Markdown 纯文本文件（附带规范 YAML Frontmatter）是系统内容的**唯一事实来源（Single Source of Truth, SSOT）**。
   - 数据库（SQLite）仅作为元数据索引、关系映射与快速搜索的**派生索引层（Derived Index）**。
   - 即使数据库文件意外损坏或删除，只需运行 `rebuild-index` 扫描磁盘文件，即可毫秒级无损重建全部数据与拓扑。
2. **Security-First（服务端强制鉴权）**：
   - 权限校验严格在服务端执行（Public / Private / Unlisted），未授权访客在 API 层直接被阻断，不可通过客户端伪造获取任何私密正文或搜索摘要。
3. **API-First & Modular Monolith（模块化全栈单体）**：
   - 采用前后端清晰分层：`API Router -> Service -> Repository / FileStorage`。
   - 统一 API 响应格式：成功 `{ data, meta }`，错误 `{ error: { code, message, details } }`。
4. **Future-Ready（多租户预留与零债务）**：
   - 从第一天起，数据库所有资源均具备 `owner_id` 字段，杜绝业务代码硬编码 ID，为未来扩展多用户协作奠定坚实基础。

---

## 2. 系统技术架构栈

根据项目实际运行环境及高效交付原则，采用**TypeScript 全栈工业级架构**：

| 层级 | 选用技术 / 工具 | 选型理由 |
| :--- | :--- | :--- |
| **前端交互层** | React 19 + TypeScript + Tailwind CSS | 高性能现代交互，支持分屏实时预览、WikiLinks 双向图谱、标签检索模态弹窗与沉浸写作 |
| **构建与开发服务** | Vite 8 + Express Full-Stack Middleware | 单端口（Port 3000）统一托管，开发环境通过 Vite 中间件无缝反代，免除跨域 Cookie 难题 |
| **业务服务端** | Node.js 22 LTS + Express + TypeScript (`tsx`) | 原生支持 ES Modules 与现代异步语法，统一全栈类型定义 |
| **核心数据库** | Node.js 22 原生 `node:sqlite` (SQLite 3.45+) | 原生内置，零外部 C++ 二进制依赖，支持事务（Transactions）、WAL 模式与高速检索 |
| **文件物理存储** | 宿主机本地文件系统 (`storage/`) | 按文档 ID 隔离存储，文件命名安全化，原子化写入，彻底解决浏览器清缓存数据丢失痛点 |
| **全文检索** | SQLite FTS5 (Full-Text Search) 虚拟表 | 结合标题权重与正文分词，支持中英文检索与权限前置过滤 |

---

## 3. 存储结构与文件布局规范

```text
/
├── storage/                               # 物理持久化数据真源目录 (永不提交到 Git)
│   ├── documents/                         # Markdown 文章真源库
│   │   └── {document_id}/
│   │       └── index.md                   # 纯 Markdown 正文 + 规范 YAML Frontmatter
│   ├── revisions/                         # 历史版本快照
│   │   └── {document_id}/
│   │       └── {revision_id}.md           # 每次保存前的快照
│   ├── assets/                            # 媒体资源库 (图片、PDF、附件)
│   │   └── {asset_id}.{extension}         # 内容指纹重命名，防止路径穿越
│   ├── database/                          # SQLite 派生索引与凭据库
│   │   └── knowledge_hub.sqlite           # SQLite 数据库文件 (WAL 模式)
│   └── backups/                           # 全库完整 ZIP / JSON 备份文件
│
├── server/                                # 服务端核心源码
│   ├── db/                                # 数据库连接与 Schema 初始化
│   │   ├── schema.ts                      # 表结构定义与 DDL
│   │   └── sqlite.ts                      # 数据库连接单例与事务助手
│   ├── services/                          # 核心业务服务层
│   │   ├── documentService.ts             # 文档生命周期与双写管理
│   │   ├── fileStorageService.ts          # 物理文件原子写入与读取
│   │   ├── searchService.ts               # FTS5 全文搜索与权限过滤
│   │   ├── shareService.ts                # Token 哈希、过期与受控分享验证
│   │   ├── authService.ts                 # Owner 登录、密码哈希与 Session
│   │   └── backupService.ts               # 导入导出与索引重建
│   ├── routes/                            # RESTful API 路由 (/api/v1/*)
│   │   ├── auth.ts
│   │   ├── documents.ts
│   │   ├── categories.ts
│   │   ├── tags.ts
│   │   ├── shares.ts
│   │   ├── search.ts
│   │   └── system.ts
│   └── index.ts                           # Express 服务端入口
│
├── src/                                   # 前端用户界面
│   ├── components/                        # UI 组件
│   ├── services/                          # 前端 API 客户端与本地缓存适配层
│   └── App.tsx                            # 前端顶层应用
│
└── server.ts                              # 全栈开发与生产启动入口 (Port 3000)
```

---

## 4. Markdown 正文与 Frontmatter 规范

### 4.1 存储路径与命名
每一个文档独立拥有专属目录：`storage/documents/{document_id}/index.md`。

### 4.2 Frontmatter 规范示例
```yaml
---
id: "doc-k9z2a1"
title: "打造个人第二大脑：卡片盒笔记法与知识图谱"
slug: "second-brain-zettelkasten"
category: "认知与方法论"
tags:
  - "知识管理"
  - "Zettelkasten"
  - "学习方法"
  - "第二大脑"
visibility: "public"
status: "published"
author: "Hecker"
pinned: true
created_at: "2026-10-31T10:00:00.000Z"
updated_at: "2026-11-02T08:00:00.000Z"
content_hash: "a8f3b2c1..."
---

# 打造个人第二大脑：卡片盒笔记法与知识图谱

正文从此处开始，用户在编辑器中纯净书写，YAML 区域由系统静默自动维护。
```

---

## 5. 数据库设计 (SQLite Schema)

### 5.1 用户表 (`users`)
```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 5.2 认证会话表 (`sessions`)
```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### 5.3 文档元数据表 (`documents`)
```sql
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category_id TEXT,
  category_name TEXT NOT NULL DEFAULT '未分类',
  file_path TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public', 'private', 'unlisted')),
  status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published', 'archived')),
  content_hash TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  reading_time INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  version_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_owner_slug ON documents (owner_id, slug);
CREATE INDEX IF NOT EXISTS idx_docs_visibility ON documents (visibility);
CREATE INDEX IF NOT EXISTS idx_docs_category ON documents (category_name);
```

### 5.4 分类表 (`categories`)
```sql
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cat_owner_name ON categories (owner_id, name);
```

### 5.5 标签表 (`tags` & `document_tags`)
```sql
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_owner_name ON tags (owner_id, name);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (document_id, tag_id),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
```

### 5.6 受控分享表 (`shares`)
```sql
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  expires_at TEXT,
  max_views INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
```

### 5.7 历史版本快照表 (`document_revisions`)
```sql
CREATE TABLE IF NOT EXISTS document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
```

### 5.8 全文检索虚拟表 (`documents_fts`)
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  document_id UNINDEXED,
  title,
  body,
  category,
  tags,
  tokenize = 'porter unicode61'
);
```

---

## 6. API 契约设计规范

统一前缀：`/api/v1`

### 6.1 标准响应格式
```json
// 成功响应 (HTTP 200/201)
{
  "data": { ... },
  "meta": {
    "timestamp": "2026-11-02T10:00:00.000Z",
    "total": 42,
    "page": 1,
    "pageSize": 20
  }
}

// 错误响应 (HTTP 400/401/403/404/409/500)
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "文档不存在或已被移除",
    "details": null
  }
}
```

### 6.2 核心端点清单

| 方法 | 路径 | 权限要求 | 描述 |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/login` | 公开 | 用户密码登录（带验证码校验） |
| `GET` | `/api/v1/auth/me` | 当前会话 | 获取当前已认证的主理人信息 |
| `POST` | `/api/v1/auth/logout` | 已登录 | 注销登录并废除当前 Session Token |
| `GET` | `/api/v1/documents` | 公开/Owner | 分页获取文档列表（自动做权限过滤） |
| `GET` | `/api/v1/documents/:id` | 权限判定 | 获取单篇文档（公开、Owner 或通过分享 Key 校验） |
| `POST` | `/api/v1/documents` | Owner | 创建新文档（物理写入 `storage/` 并更新索引） |
| `PUT` | `/api/v1/documents/:id` | Owner | 更新文档（带版本快照与乐观锁校验） |
| `DELETE` | `/api/v1/documents/:id` | Owner | 删除文档（软删除/物理移除并清理 FTS 索引） |
| `POST` | `/api/v1/shares` | Owner | 为未公开文档创建带密码/有效期的受控分享链接 |
| `GET` | `/api/v1/shares/:token` | 公开受控 | 验证并访问分享文档（校验次数/过期/密码） |
| `DELETE` | `/api/v1/shares/:id` | Owner | 一键废除/撤销已生成的分享链接 |
| `GET` | `/api/v1/search` | 公开/Owner | 全文搜索接口（自动根据身份过滤不可见文档） |
| `POST` | `/api/v1/system/rebuild-index` | Owner | 从磁盘 `.md` 目录全量重建数据库与 FTS 索引 |
| `GET` | `/api/v1/system/export-zip` | Owner | 一键将磁盘所有文档与分类打包下载为 ZIP |
| `POST` | `/api/v1/system/import-files` | Owner | 批量导入 Markdown 并防范 Zip Slip 攻击 |

---

## 7. 实施计划 (Implementation Roadmap)

1. **里程碑 1 (Phase 1) - 物理存储与 SQLite 索引基础**：
   - 建立 `storage/` 完整物理目录架构；
   - 编写 `server/db/schema.ts` 与 `server/db/sqlite.ts`，初始化 SQLite 表结构与 FTS5；
   - 编写 `server/services/fileStorageService.ts`，实现原子化 Markdown 文件的创建、读取与版本快照写入。
2. **里程碑 2 (Phase 2) - 后端业务 API 与全栈中间件贯通**：
   - 构建 `server/services/documentService.ts` 与 `server/services/authService.ts`；
   - 挂载 Express 服务端路由至 `server/routes/*`；
   - 在 `server.ts` 中整合 Vite 中间件（在端口 3000 上同时提供 API 和前端页面）。
3. **里程碑 3 (Phase 3) - 离线优先 Dual-Sync 适配**：
   - 前端 `src/services/api.ts` 与现存 `src/services/storage.ts` 双向同步：
   - 优先通过 API 实时读写宿主机物理硬盘上的真实 `.md` 文件与 SQLite 索引；
   - 当离线或在纯静态环境时无缝 fallback 到本地持久化，兼备极速响应与永久防丢。
4. **里程碑 4 (Phase 4) - 受控分享与防 Zip-Slip 导入导出验证**：
   - 实现 Token 密码保护与过期核验；
   - 完备的测试与构建验证（`compile_applet` / `lint_applet`）。
