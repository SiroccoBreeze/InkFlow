# InkFlow Knowledge Hub · 生产独立部署包

本文件夹（`release/`）包含了在服务器、VPS 或本地生产环境独立运行所需的全部资源：

```
release/
├── dist/             # 已打包编译的前端静态文件 (React + Tailwind)
├── server/           # 全栈后端服务与 SQLite WAL 数据库驱动
├── server.ts         # 生产入口服务
├── storage/          # 物理数据持久化目录 (Markdown SSOT, SQLite, Assets)
│   ├── documents/    # Markdown 物理真源文件 (按 docId 独立存储)
│   ├── database/     # SQLite WAL 数据库文件
│   ├── assets/       # 上传与粘贴的图片媒体
│   └── revisions/    # 文档版本快照
├── package.json      # 精简的生产依赖声明
├── tsconfig.json     # TypeScript 运行配置
└── README.md
```

## 🚀 生产部署运行步骤（仅需 2 步）

在 `release/` 目录下打开终端（PowerShell 或 Bash）：

### 步骤 1：安装依赖
```bash
npm install
```

### 步骤 2：启动生产全栈服务
```bash
npm start
```

服务启动后，终端将输出：
```
🚀 InkFlow Knowledge Hub running on http://0.0.0.0:3000
📁 Physical Markdown SSOT: storage/documents/
🗄️ Native SQLite WAL Database: storage/database/knowledge_hub.sqlite
```

在浏览器访问 **http://localhost:3000** 即可。

### 🔑 首次启动与管理员安全初始化
InkFlow 遵循安全默认原则（Secure by Default），**不存在任何预设的弱密码或固定应急恢复码**。

1. 服务首次启动后，在浏览器中打开 **http://localhost:3000** 将自动进入【主理人初始化向导】。
2. 设置您的专属主理人密码（支持 Argon2id/scrypt 加盐哈希保护）。
3. 系统将为您生成专属的**一次性应急恢复密钥**（例如 `INK-XXXX-XXXX-XXXX-XXXX`）。
4. 请妥善抄录或备份此密钥，当遗忘密码时可用于重置主理人权限。

