import { Category, DocVersion, KnowledgeDoc } from '../types';
import { calculateReadingStats } from './markdown';

export const DEFAULT_CATEGORIES: Category[] = [
  {
    id: 'cat-arch',
    name: '架构与系统',
    slug: 'architecture',
    description: '分布式架构、本地优先设计、高可用系统与底层协议',
    color: '#0284c7',
    order: 1,
  },
  {
    id: 'cat-eng',
    name: '前端与工程',
    slug: 'engineering',
    description: '现代 Web 工程化、TypeScript、状态编排与渲染性能优化',
    color: '#16a34a',
    order: 2,
  },
  {
    id: 'cat-method',
    name: '认知与方法论',
    slug: 'methodology',
    description: '第二大脑搭建、卡片盒笔记、系统思考与深度学习路径',
    color: '#d97706',
    order: 3,
  },
  {
    id: 'cat-biz',
    name: '商业与战略',
    slug: 'business',
    description: '商业模式画布、独立开发盈利模式、产品定位与战略思考',
    color: '#7c3aed',
    order: 4,
  },
  {
    id: 'cat-review',
    name: '个人复盘',
    slug: 'review',
    description: '年度思考、生活日志、决策复盘与长期愿景规划',
    color: '#e11d48',
    order: 5,
  },
];

const RAW_DOC_1 = `---
title: "本地优先（Local-First）软件架构的思考与实践"
category: "架构与系统"
tags: ["Local-First", "CRDT", "分布式系统", "离线优先"]
visibility: "public"
author: "Hecker"
---

# 本地优先（Local-First）软件架构的思考与实践

在传统的云端优先（Cloud-First）架构中，服务器是数据的唯一主权者。用户在客户端所进行的操作，本质上是对远端数据库的一次次 RPC 代理调用。一旦网络抖动或服务停机，应用立即陷入不可用状态。

**本地优先（Local-First）** 颠覆了这一范式：它将**本地设备**作为数据的第一事实来源（Single Source of Truth），把网络从强依赖退化为增量同步管道。

## 1. 为什么我们需要本地优先？

本地优先架构赋予用户七项核心理想权利：

1. **零延迟响应**：读写均直接作用于本地内存或 IndexedDB/SQLite，达到极致的微秒级吞吐。
2. **多设备协作**：基于冲突自由复制数据类型（CRDTs）实现对等合并。
3. **彻底离线工作**：无论在飞行途中还是地库隧道，体验与联网完全一致。
4. **用户数据主权**：数据存储在用户可控的文件系统或本地数据库，避免“云厂商倒闭即失联”。
5. **长寿命数据**：文件以纯文本 Markdown、JSON 或 SQLite 格式留存，数十年后依然可用。
6. **隐私与加密**：在离线状态或端到端加密通道中传输，最小化服务端数据暴露面。
7. **最终一致性**：在恢复联网后通过逻辑时钟与状态向量进行自愈对齐。

## 2. 核心技术栈选型对比

下表总结了目前主流的本地优先同步方案及其特性：

| 技术方案 | 数据模型 | 冲突解决策略 | 典型应用场景 |
| :--- | :--- | :--- | :--- |
| **Yjs / Automerge** | CRDT (树/文本) | 操作序列编排 + RGA | 富文本实时协同、白板 |
| **ElectricSQL / PowerSync** | SQLite 关系型 | 基于行级版本向量 | 事务型企业应用、看板 |
| **Markdown + Git / VFS** | 纯文本目录树 | 3-Way Merge / 时间戳 | 个人知识库、代码工作流 |
| **RxDB / WatermelonDB** | NoSQL 客户端库 | 自定义 Last-Write-Wins | 移动轻量应用、离线表单 |

## 3. 本知识库系统的本地优先实现

本系统（InkFlow）秉承**“Markdown 文本即唯一事实”**的准则：

- **正文纯净性**：不使用私有二进制黑盒存储，正文与 YAML Frontmatter 完全对齐标准 CommonMark 规范。
- **本地存储引擎**：基于浏览器 IndexedDB 与 LocalStorage 实现毫秒级热缓存。
- **全量无损导出**：支持一键将整个知识库导出为标准目录结构的 Markdown 压缩包。
- **版本快照**：每次重要更新自动记录差异（Diff）并支持无损回溯。

\`\`\`typescript
// 伪代码：本地状态保存与无损归档
async function persistDocument(doc: KnowledgeDoc): Promise<void> {
  // 1. 本地快速持久化
  await localDB.put('docs', doc);
  
  // 2. 生成版本快照
  await versionManager.createSnapshot({
    docId: doc.id,
    content: doc.rawMarkdown,
    timestamp: new Date().toISOString()
  });
  
  // 3. 发布渠道按 Visibility 过滤广播
  if (doc.visibility === 'public') {
    broadcastChannel.postMessage({ type: 'DOC_UPDATED', id: doc.id });
  }
}
\`\`\`

## 4. 总结与未来演进

本地优先不是倒退回单机软件，而是站在分布式系统肩膀上的“去中心化升华”。未来我们将进一步探索 WebRTC P2P 节点直连同步，让知识在设备间像水流一样自由穿梭。
`;

const RAW_DOC_2 = `---
title: "打造个人第二大脑：卡片盒笔记法与知识图谱"
category: "认知与方法论"
tags: ["知识管理", "Zettelkasten", "学习方法", "第二大脑"]
visibility: "public"
author: "Hecker"
---

# 打造个人第二大脑：卡片盒笔记法与知识图谱

我们生活在信息过载的时代，收藏夹早已成了信息的墓地。“知道在哪里能搜到”并不等于“真正掌握并能运用”。

德国社会学家尼克拉斯·卢曼（Niklas Luhmann）凭借其著名的 **卡片盒笔记法（Zettelkasten）**，一生完成了 70 多部专著与近 400 篇高水平论文。他的秘密并不在于超常的记忆力，而在于他将卡片盒作为思考的“外置协处理器”。

## 核心法则：从收集到链接

> “卡片盒不是仓库，而是一台对话机器。每一张新卡片都在与旧卡片交谈。”

1. **原子化（Atomicity）**：每张卡片只记录一个完整、独立的观点或论点，便于在不同语境下组合。
2. **自给自足（Self-contained）**：无论多久之后重新阅读，不依赖外部背景就能完全读懂该卡片。
3. **双向链接（Bi-directional Linking）**：通过引用关系构建语义网，而非依赖死板的单向分类树。
4. **结构笔记（Structure Notes / MOC）**：当某一主题积累了足够多卡片时，撰写内容地图（Maps of Content）串联主线。

## 知识流转生命周期

\`\`\`
[原始输入: 书籍/播客/论文]
         │
         ▼
[闪念笔记 (Fleeting Notes)]  ──> 24小时内处理
         │
         ▼
[文献笔记 (Literature Notes)] ──> 用自己的语言转述
         │
         ▼
[永久笔记 (Permanent Notes)] ──> 汇入知识库并建立链接
         │
         ▼
[公开输出 (Articles/Products)] ──> 形成可检索的知识资产
\`\`\`

坚持使用 Markdown 进行长期沉淀，是抵抗格式腐烂与平台锁定的唯一解药。
`;

const RAW_DOC_3 = `---
title: "现代 TypeScript 类型体操与工程化避坑手册"
category: "前端与工程"
tags: ["TypeScript", "架构设计", "代码质量"]
visibility: "public"
author: "Hecker"
---

# 现代 TypeScript 类型体操与工程化避坑手册

在大型前端与全栈项目中，良好的类型系统不仅是自文档化的契约，更是重构时抵御回归缺陷的护城河。

## 1. 模式匹配与分布式条件类型

当条件类型作用于裸类型参数时，若传入联合类型，条件类型会自动分发（Distributive Conditional Types）：

\`\`\`typescript
// 提取 Promise 或直接类型的展开值
type Awaited<T> = T extends Promise<infer U> ? Awaited<U> : T;

// 深度只读模式
type DeepReadonly<T> = T extends Function | boolean | number | string
  ? T
  : { readonly [P in keyof T]: DeepReadonly<T[P]> };
\`\`\`

## 2. 避免 \`any\` 传染：善用 \`unknown\` 与类型守卫

\`\`\`typescript
function isDocPayload(data: unknown): data is { title: string; markdown: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'title' in data &&
    typeof (data as any).title === 'string' &&
    'markdown' in data &&
    typeof (data as any).markdown === 'string'
  );
}
\`\`\`

类型约束应当在系统的输入边界（I/O、网络请求、本地序列化）完成守卫收敛，在系统内部享受零运行时开销的绝对确定性。
`;

const RAW_DOC_4 = `---
title: "2026 个人年度复盘与长期规划（私密草稿）"
category: "个人复盘"
tags: ["年度规划", "OKR", "思考"]
visibility: "private"
author: "Hecker"
---

# 2026 个人年度复盘与长期规划（私密草稿）

> ⚠️ 该文档为私密文档（Visibility: Private），仅 Owner 登录后可见，不会在公开知识门户展示。

## 1. 核心战略定力

- **知识生产**：建立每周深度写作习惯，输出 2 篇有体系的本地优先与系统设计沉淀。
- **产品孵化**：完善独立作品集，探索可持续的微型 SaaS 商业化闭环。
- **身心精力管理**：保持每周 4 次有氧训练，严控无效社交与信息碎片化干扰。

## 2. 待启动项目清单

- [ ] InkFlow 跨设备 WebRTC 局域网同步协议设计
- [ ] 个人开源图书：《现代前端的工程化第一性原理》
- [ ] 基于 WebAssembly 的本地全文字符向量检索引擎
`;

const RAW_DOC_5 = `---
title: "InkFlow 商业化蓝图与早期合作伙伴备忘录"
category: "商业与战略"
tags: ["商业模式", "Roadmap", "合作方案"]
visibility: "unlisted"
unlistedKey: "alpha-share-8f92b7c4"
author: "Hecker"
---

# InkFlow 商业化蓝图与早期合作伙伴备忘录

> 🔗 该文档为**不公开链接（Unlisted）**文档。它不在公开知识库的目录与搜索结果中展示，只有持有专有分享凭证或链接的受邀伙伴方可浏览。

## 1. 目标客户画像

面向注重数据自主权的技术极客、研究员、作家与独立开发者，解决市面上闭源笔记平台“绑架数据”、“随时可能变更隐私条款”与“离线卡顿”的终极痛点。

## 2. 合作模式与阶段里程碑

- **Stage 1 (当前)**：单 Owner 永久开源单机版，以卓越的本地优先交互和精致排版确立口碑。
- **Stage 2**：推出端到端加密的企业/团队私有协作中继节点（Self-hosted Relay）。
- **Stage 3**：增值插件生态与托管备份服务，提供一键多端自动同步。

如果你收到此文档链接，欢迎在邮件中回复你的独到反馈！
`;

function buildDoc(
  id: string,
  slug: string,
  rawMarkdown: string,
  category: string,
  tags: string[],
  visibility: 'public' | 'private' | 'unlisted',
  unlistedKey?: string,
  pinned?: boolean
): KnowledgeDoc {
  const lines = rawMarkdown.split('\n');
  const h1Line = lines.find(l => l.startsWith('# '));
  const title = h1Line ? h1Line.replace(/^#\s+/, '').trim() : '无标题笔记';
  const { wordCount, readingTimeMinutes } = calculateReadingStats(rawMarkdown);

  const createdAt = '2026-10-15T10:00:00.000Z';
  const updatedAt = '2026-11-01T08:00:00.000Z';

  return {
    id,
    slug,
    title,
    rawMarkdown,
    category,
    tags,
    visibility,
    unlistedKey,
    author: 'Hecker',
    createdAt,
    updatedAt,
    versionCount: 2,
    wordCount,
    readingTimeMinutes,
    pinned,
    attachments: [],
  };
}

export const INITIAL_DOCS: KnowledgeDoc[] = [
  buildDoc(
    'doc-local-first',
    'local-first-architecture-thinking',
    RAW_DOC_1,
    '架构与系统',
    ['Local-First', 'CRDT', '分布式系统', '离线优先'],
    'public',
    undefined,
    true
  ),
  buildDoc(
    'doc-second-brain',
    'second-brain-zettelkasten-guide',
    RAW_DOC_2,
    '认知与方法论',
    ['知识管理', 'Zettelkasten', '学习方法', '第二大脑'],
    'public',
    undefined,
    true
  ),
  buildDoc(
    'doc-ts-gymnastics',
    'modern-typescript-patterns-guide',
    RAW_DOC_3,
    '前端与工程',
    ['TypeScript', '架构设计', '代码质量'],
    'public',
    undefined,
    false
  ),
  buildDoc(
    'doc-private-review-2026',
    'personal-review-plan-2026',
    RAW_DOC_4,
    '个人复盘',
    ['年度规划', 'OKR', '思考'],
    'private',
    undefined,
    false
  ),
  buildDoc(
    'doc-unlisted-business-alpha',
    'inkflow-business-blueprint-memo',
    RAW_DOC_5,
    '商业与战略',
    ['商业模式', 'Roadmap', '合作方案'],
    'unlisted',
    'alpha-share-8f92b7c4',
    false
  ),
];

export const INITIAL_VERSIONS: DocVersion[] = [
  {
    id: 'ver-1-doc-1',
    docId: 'doc-local-first',
    versionNumber: 1,
    title: '本地优先（Local-First）软件架构的初探',
    rawMarkdown: RAW_DOC_1.replace('## 4. 总结与未来演进', '## 4. 初步草稿小结'),
    timestamp: '2026-10-15T10:00:00.000Z',
    note: '初始化草稿',
    charCount: 1450,
  },
  {
    id: 'ver-2-doc-1',
    docId: 'doc-local-first',
    versionNumber: 2,
    title: '本地优先（Local-First）软件架构的思考与实践',
    rawMarkdown: RAW_DOC_1,
    timestamp: '2026-11-01T08:00:00.000Z',
    note: '补充 CRDT 与技术选型对比表',
    charCount: 1820,
  },
];
