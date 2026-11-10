import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');

console.log('🚀 [InkFlow Release Builder] Starting production release bundling...');

// 1. Build frontend bundle if needed
console.log('📦 Step 1: Building optimized frontend into dist/ ...');
execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' });

// 2. Prepare release directory
console.log('📁 Step 2: Preparing release/ directory...');
if (fs.existsSync(RELEASE_DIR)) {
  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(RELEASE_DIR, { recursive: true });

// Helper to copy recursively
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 3. Copy dist/
console.log('🚚 Step 3: Copying dist/ frontend assets...');
copyDirSync(path.join(ROOT_DIR, 'dist'), path.join(RELEASE_DIR, 'dist'));

// 4. Copy server/
console.log('🚚 Step 4: Copying server/ backend modules...');
copyDirSync(path.join(ROOT_DIR, 'server'), path.join(RELEASE_DIR, 'server'));

// 5. Copy server.ts
console.log('🚚 Step 5: Copying server.ts entry point...');
fs.copyFileSync(path.join(ROOT_DIR, 'server.ts'), path.join(RELEASE_DIR, 'server.ts'));

// 6. Copy tsconfig.json
console.log('🚚 Step 6: Copying tsconfig.json...');
fs.copyFileSync(path.join(ROOT_DIR, 'tsconfig.json'), path.join(RELEASE_DIR, 'tsconfig.json'));

// 7. Copy .env.example
if (fs.existsSync(path.join(ROOT_DIR, '.env.example'))) {
  fs.copyFileSync(path.join(ROOT_DIR, '.env.example'), path.join(RELEASE_DIR, '.env.example'));
}

// 8. Prepare default storage folders in release/
console.log('🗄️ Step 7: Initializing storage/ structure...');
const releaseStorage = path.join(RELEASE_DIR, 'storage');
['documents', 'assets', 'database', 'revisions', 'backups'].forEach(dir => {
  fs.mkdirSync(path.join(releaseStorage, dir), { recursive: true });
});

// If local storage has documents or seed data, copy them over for instant out-of-the-box readiness
const localStorageDir = path.join(ROOT_DIR, 'storage');
if (fs.existsSync(localStorageDir)) {
  try {
    copyDirSync(localStorageDir, releaseStorage);
    console.log('   ↳ Synced current storage assets and markdown into release/storage/');
  } catch (err) {
    console.warn('   ↳ Failed copying existing storage, created blank structure instead.');
  }
}

// 9. Generate standalone production package.json
console.log('📝 Step 8: Generating release/package.json...');
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));

const releasePkg = {
  name: 'inkflow-knowledge-hub-release',
  version: rootPkg.version || '1.0.0',
  description: 'InkFlow Knowledge Hub - Local-First Production Bundle',
  type: 'module',
  scripts: {
    start: 'tsx server.ts --prod',
    serve: 'tsx server.ts --prod',
  },
  dependencies: {
    express: rootPkg.dependencies.express || '^4.21.2',
    dotenv: rootPkg.dependencies.dotenv || '^17.2.3',
    jszip: rootPkg.dependencies.jszip || '^3.10.2',
    marked: rootPkg.dependencies.marked || '^18.1.2',
    tsx: rootPkg.devDependencies.tsx || '^4.21.0',
  },
};

fs.writeFileSync(
  path.join(RELEASE_DIR, 'package.json'),
  JSON.stringify(releasePkg, null, 2),
  'utf-8'
);

// 10. Write standalone deployment README in release/
console.log('📄 Step 9: Generating release/README.md guide...');
const readmeContent = `# InkFlow Knowledge Hub · 生产独立部署包

本文件夹（\`release/\`）包含了在服务器、VPS 或本地生产环境独立运行所需的全部资源：

\`\`\`
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
\`\`\`

## 🚀 生产部署运行步骤（仅需 2 步）

在 \`release/\` 目录下打开终端（PowerShell 或 Bash）：

### 步骤 1：安装依赖
\`\`\`bash
npm install
\`\`\`

### 步骤 2：启动生产全栈服务
\`\`\`bash
npm start
\`\`\`

服务启动后，终端将输出：
\`\`\`
🚀 InkFlow Knowledge Hub running on http://0.0.0.0:3000
📁 Physical Markdown SSOT: storage/documents/
🗄️ Native SQLite WAL Database: storage/database/knowledge_hub.sqlite
\`\`\`

在浏览器访问 **http://localhost:3000** 即可。

### 🔑 首次启动与管理员安全初始化
InkFlow 遵循安全默认原则（Secure by Default），不存在任何预设的弱密码或固定应急恢复码。
首次启动后在浏览器打开 http://localhost:3000 将自动进入初始化向导，由您设置专属主理人密码并获取一次性应急安全恢复密钥。

`;

fs.writeFileSync(path.join(RELEASE_DIR, 'README.md'), readmeContent, 'utf-8');

console.log('\n============================================================');
console.log('✅ [InkFlow Release Builder] Release folder successfully created at:');
console.log(`📁 ${RELEASE_DIR}`);
console.log('You can now copy the entire "release" directory to any server!');
console.log('============================================================\n');
