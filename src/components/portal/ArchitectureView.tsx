import React from 'react';
import { Database, FileText, Share2, Shield, Users, Layers, Zap, HardDrive, Lock } from 'lucide-react';

export const ArchitectureView: React.FC = () => {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-12">
      
      {/* Title */}
      <div className="space-y-3 pb-6 border-b border-neutral-200 dark:border-neutral-800">
        <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
          InkFlow 本地优先系统架构设计
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed max-w-2xl">
          坚持“Markdown 文本即唯一事实来源”，打造兼具数据自主权与优雅阅读体验的个人知识发布体系。
        </p>
      </div>

      {/* 3 Core Tenets */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="p-6 rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xs space-y-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center">
            <HardDrive className="w-5 h-5" />
          </div>
          <h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100">
            01. 本地优先 (Local-First)
          </h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
            数据在浏览器本地离线优先运行，读写响应时间在毫秒以内。无需受制于远程服务器网络状态，支持一键无损打包导出。
          </p>
        </div>

        <div className="p-6 rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xs space-y-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
            <FileText className="w-5 h-5" />
          </div>
          <h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100">
            02. Markdown 唯一事实来源
          </h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
            正文完全遵守 CommonMark / GFM 规范，搭配标准的 YAML Frontmatter 存储分类、标签与可见性。随时可导入 Obsidian、VitePress 或 Astro。
          </p>
        </div>

        <div className="p-6 rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-xs space-y-3">
          <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-950/50 text-purple-600 dark:text-purple-400 flex items-center justify-center">
            <Shield className="w-5 h-5" />
          </div>
          <h3 className="text-base font-bold text-neutral-900 dark:text-neutral-100">
            03. 三级可见性模型
          </h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
            支持 Public（公开索引）、Unlisted（凭专属 Token 不公开分享）与 Private（仅 Owner 可见）三种灵活发布等级。
          </p>
        </div>
      </div>

      {/* Visibility Spectrum */}
      <section className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl p-6 sm:p-8 shadow-xs space-y-6">
        <div>
          <h2 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">
            三级可见性 (Visibility Hierarchy) 路由设计
          </h2>
          <p className="text-xs text-neutral-500 mt-1">
            严密的权限隔离保障个人思考的私密性与精准分享
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/40 dark:bg-emerald-950/20 space-y-2">
            <div className="font-semibold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              公开文档 (Public)
            </div>
            <p className="text-neutral-600 dark:text-neutral-400 leading-relaxed">
              出现在公开知识门户首页、全站搜索建议、分类列表与标签网中，对所有访客公开。
            </p>
          </div>

          <div className="p-4 rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50/40 dark:bg-amber-950/20 space-y-2">
            <div className="font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              不公开链接 (Unlisted)
            </div>
            <p className="text-neutral-600 dark:text-neutral-400 leading-relaxed">
              不出现在公开门户首页和搜索索引中。仅持有专属长随机 Key（如 <code>?share=alpha-share-8f92b7c4</code>）的用户方可打开阅读。
            </p>
          </div>

          <div className="p-4 rounded-xl border border-rose-200 dark:border-rose-800/60 bg-rose-50/40 dark:bg-rose-950/20 space-y-2">
            <div className="font-semibold text-rose-800 dark:text-rose-300 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-rose-500" />
              私密文档 (Private)
            </div>
            <p className="text-neutral-600 dark:text-neutral-400 leading-relaxed">
              严格受限状态，仅在 Owner 主理人认证成功后才在管理后台或专属阅读器中可查看。
            </p>
          </div>
        </div>
      </section>

      {/* Multi-user Architecture Readiness */}
      <section className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl p-6 sm:p-8 shadow-xs space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 flex items-center justify-center">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">
              V1 单 Owner 到未来多用户扩展路径
            </h2>
            <p className="text-xs text-neutral-500">
              架构契约预留：数据层已解耦所有者与协作者上下文
            </p>
          </div>
        </div>

        <div className="space-y-3 text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed pt-2">
          <p>
            当前 V1 系统面向<strong>单主理人个人知识库</strong>，无繁琐的公开注册流程，保障轻快体验；同时底层类型与数据实体均已包含多用户协同的演进接口：
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <strong>用户角色模型 (RBAC)</strong>：已在 <code>UserSession</code> 中定义 <code>owner</code>、<code>collaborator</code> 与 <code>viewer</code> 角色接口。
            </li>
            <li>
              <strong>多作者归属</strong>：每篇笔记拥有独立的 <code>author</code> 标识与 <code>versionHistory</code> 快照签名，为后续协同编辑版本回溯提供依据。
            </li>
            <li>
              <strong>CRDT 与分布式中继</strong>：通过将本地快照接入 Yjs / Automerge 或 WebRTC 数据通道，可平滑升级至多端实时协同知识网络。
            </li>
          </ul>
        </div>
      </section>

    </div>
  );
};
