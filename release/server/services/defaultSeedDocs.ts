export interface SeedDoc {
  id: string;
  title: string;
  slug: string;
  rawMarkdown: string;
  category: string;
  tags: string[];
  visibility: 'public' | 'private' | 'unlisted';
  pinned?: boolean;
  author: string;
}

export const INITIAL_SEED_DOCS: SeedDoc[] = [
  {
    id: 'doc-local-first',
    title: '本地优先（Local-First）软件架构的思考与实践',
    slug: 'local-first-architecture',
    category: '架构与系统',
    tags: ['Local-First', 'CRDT', '分布式系统', '离线优先'],
    visibility: 'public',
    pinned: true,
    author: 'Hecker',
    rawMarkdown: `---
title: "本地优先（Local-First）软件架构的思考与实践"
category: "架构与系统"
tags: ["Local-First", "CRDT", "分布式系统", "离线优先"]
visibility: "public"
author: "Hecker"
---

# 本地优先（Local-First）软件架构的思考与实践

在云端 SaaS 盛行的时代，我们把所有数据托付给了云端服务。然而，网络延迟、厂商锁定以及服务下线的风险始终存在。**本地优先（Local-First）** 提出了一种全新的软件哲学：**将数据的主权归还给用户**。

## 什么是本地优先？

根据 Ink & Switch 研究实验室的定义，本地优先软件具备以下七项核心准则：

1. **零延迟响应（No Spinners）**：所有读写操作均在本地内存与磁盘完成，界面无需等待网络往返。
2. **多设备实时协同（Multi-device）**：支持离线编辑，网络连通后通过无冲突合并算法自动同步。
3. **网络只是管道（Network is Optional）**：完全离线状态下，所有核心功能正常可用。
4. **数据归属主权（Ownership）**：数据以标准开放格式（如 Markdown）保存在用户的物理设备上。
5. **经得起时间考验（Longevity）**：即使云端中继服务器停机，本地软件与数据仍可无限期运行。
6. **安全与隐私至上（Security & Privacy）**：端到端加密，避免个人敏感数据暴露给云服务商。
7. **最终一致性（Eventual Consistency）**：基于无冲突复制数据类型（CRDT）或操作转换（OT）解决并发分歧。

## InkFlow 的实践路径

InkFlow 坚决贯彻“**Markdown 文件是唯一事实来源（Single Source of Truth）**”的设计理念：

- **正文纯净落盘**：所有文档按 \`storage/documents/{id}/index.md\` 存储在本地磁盘。
- **派生索引分离**：SQLite 仅作为高性能派生索引与 FTS5 全文搜索加速器，绝不形成独立分裂的正文副本。
- **素材物理持久**：图片与附件物理落盘在 \`storage/assets/\`，彻底杜绝数据丢失。
`,
  },
  {
    id: 'doc-second-brain',
    title: '打造个人第二大脑：卡片盒笔记法与知识图谱',
    slug: 'second-brain-zettelkasten',
    category: '认知与方法论',
    tags: ['知识管理', 'Zettelkasten', '学习方法', '第二大脑'],
    visibility: 'public',
    pinned: true,
    author: 'Hecker',
    rawMarkdown: `---
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
2. **自给自足（Self-contained）**：无论多久之后阅读，不依赖外部背景就能完全读懂该卡片。
3. **双向链接（Bi-directional Linking）**：通过引用关系构建语义网，而非依赖死板的单向分类树。
4. **结构笔记（Structure Notes / MOC）**：当某一主题积累了足够多卡片时，撰写内容地图（Maps of Content）串联主线。
`,
  },
];
