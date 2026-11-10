#!/usr/bin/env node
/**
 * InkFlow Release Builder
 *
 * Produces a self-contained production bundle inside release/.
 *
 * SEC-009 guarantees:
 *  - The runtime storage/ directory is NEVER copied wholesale.
 *  - Only an explicit allow-list of program files is copied.
 *  - A hard post-build scan fails the build if any sensitive runtime data
 *    (SQLite/WAL/SHM, user documents, revisions, assets, .env, keys, logs)
 *    made it into the package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertSafeReleasePath, scanRelease } from './lib/releaseGuard.js';
import {
  ReleaseTargetError,
  resolveReleaseTarget,
  removeReleaseDirSafely,
} from './lib/releaseTarget.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SKIP_BUILD = process.env.INKFLOW_RELEASE_SKIP_BUILD === '1';
const STAGING_DIR = path.join(ROOT_DIR, '.release-staging');

console.log('🚀 [InkFlow Release Builder] Starting production release bundling...');

// ---------------------------------------------------------------------------
// 0a. Validate the output directory BEFORE doing anything destructive.
//     INKFLOW_RELEASE_OUT is user-controlled; a bad value must never lead to
//     the project root or user data being deleted (SEC-012).
// ---------------------------------------------------------------------------
const targetOptions = {
  rootDir: ROOT_DIR,
  dataDir: process.env.INKFLOW_DATA_DIR
    ? path.resolve(process.env.INKFLOW_DATA_DIR)
    : path.join(ROOT_DIR, 'storage'),
};

let RELEASE_DIR;
try {
  ({ releaseDir: RELEASE_DIR } = resolveReleaseTarget(process.env.INKFLOW_RELEASE_OUT, targetOptions));
} catch (err) {
  if (err instanceof ReleaseTargetError) {
    console.error(`\n❌ [InkFlow Release Builder] BUILD ABORTED — unsafe output directory [${err.code}]`);
    console.error(`   ${err.message}`);
    console.error('   未删除或修改任何文件。');
    process.exit(1);
  }
  throw err;
}

console.log(`📁 Output directory (validated): ${RELEASE_DIR}`);

// ---------------------------------------------------------------------------
// 0. Allow-list of files that may be shipped
// ---------------------------------------------------------------------------
const ALLOWED_ROOT_FILES = ['server.ts', 'tsconfig.json', '.env.example'];
const ALLOWED_SERVER_DIRS = ['db', 'routes', 'services'];

function copyFileSafe(src, destDir) {
  const relative = path.relative(RELEASE_DIR, path.join(destDir, path.basename(src)));
  assertSafeReleasePath(relative);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
}

function copyDirSafe(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    assertSafeReleasePath(path.relative(RELEASE_DIR, destPath));

    if (entry.isDirectory()) {
      // Skip tests and any nested runtime data folders
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      copyDirSafe(srcPath, destPath);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Build frontend bundle
// ---------------------------------------------------------------------------
console.log('📦 Step 1: Building optimized frontend into dist/ ...');
if (SKIP_BUILD) {
  console.log('   ↳ INKFLOW_RELEASE_SKIP_BUILD=1 — reusing existing dist/');
} else {
  execSync('npm run build', { cwd: ROOT_DIR, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// 2. Recreate a clean release directory
//    The target is re-validated immediately before deletion so a symlink swap
//    between step 0a and here cannot redirect the recursive delete.
// ---------------------------------------------------------------------------
console.log('📁 Step 2: Preparing a clean release/ directory...');
try {
  removeReleaseDirSafely(RELEASE_DIR, targetOptions);
} catch (err) {
  if (err instanceof ReleaseTargetError) {
    console.error(`\n❌ [InkFlow Release Builder] BUILD ABORTED — output directory changed [${err.code}]`);
    console.error(`   ${err.message}`);
    console.error('   未删除或修改任何文件。');
    process.exit(1);
  }
  throw err;
}
fs.mkdirSync(RELEASE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 3. Copy the program files (explicit allow-list)
// ---------------------------------------------------------------------------
console.log('🚚 Step 3: Copying dist/ frontend assets...');
copyDirSafe(path.join(ROOT_DIR, 'dist'), path.join(RELEASE_DIR, 'dist'));

console.log('🚚 Step 4: Copying allow-listed backend modules...');
for (const dir of ALLOWED_SERVER_DIRS) {
  const src = path.join(ROOT_DIR, 'server', dir);
  if (fs.existsSync(src)) {
    copyDirSafe(src, path.join(RELEASE_DIR, 'server', dir));
  }
}

console.log('🚚 Step 5: Copying root entry files...');
for (const file of ALLOWED_ROOT_FILES) {
  const src = path.join(ROOT_DIR, file);
  if (fs.existsSync(src)) {
    copyFileSafe(src, RELEASE_DIR);
  }
}

// ---------------------------------------------------------------------------
// 4. Create an EMPTY runtime storage skeleton (no user data)
// ---------------------------------------------------------------------------
console.log('🗄️ Step 6: Creating empty runtime storage skeleton (no user data)...');
const releaseStorage = path.join(RELEASE_DIR, 'storage');
['documents', 'assets', 'database', 'revisions', 'backups'].forEach(dir => {
  const target = path.join(releaseStorage, dir);
  fs.mkdirSync(target, { recursive: true });
  // .gitkeep keeps the empty structure versionable / visible
  fs.writeFileSync(path.join(target, '.gitkeep'), '', 'utf-8');
});

// Never ship the developer's live runtime storage, even if an allow-listed folder
// accidentally contains data. The source tree storage/ is intentionally untouched.

// ---------------------------------------------------------------------------
// 5. Generate standalone production package.json
// ---------------------------------------------------------------------------
console.log('📝 Step 7: Generating release/package.json...');
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
    tsx: rootPkg.devDependencies?.tsx || '^4.21.0',
  },
};

fs.writeFileSync(
  path.join(RELEASE_DIR, 'package.json'),
  JSON.stringify(releasePkg, null, 2),
  'utf-8'
);

// ---------------------------------------------------------------------------
// 6. Write deployment README
// ---------------------------------------------------------------------------
console.log('📄 Step 8: Generating release/README.md guide...');
const readmeContent = `# InkFlow Knowledge Hub · 生产独立部署包

本文件夹（\`release/\`）包含了在服务器、VPS 或本地生产环境独立运行所需的全部资源。

**发布包中不含任何运行时数据**：没有数据库、没有用户文档、没有附件、没有历史快照。

\`\`\`
release/
├── dist/             # 已打包编译的前端静态文件 (React + Tailwind)
├── server/           # 全栈后端服务（仅 db/ routes/ services/）
├── server.ts         # 生产入口服务
├── storage/          # 空的数据目录骨架（首次启动时自动创建真实数据）
│   ├── documents/    # Markdown 物理真源文件 (运行时生成)
│   ├── database/     # SQLite WAL 数据库 (首次启动时创建)
│   ├── assets/       # 上传的附件 (运行时生成)
│   ├── revisions/    # 文档版本快照 (运行时生成)
│   └── backups/      # 备份目录 (运行时生成)
├── .env.example      # 环境变量模板
├── package.json      # 精简的生产依赖声明
├── tsconfig.json     # TypeScript 运行配置
└── README.md
\`\`\`

## 🚀 生产部署步骤

### 步骤 1：安装依赖
\`\`\`bash
npm install
\`\`\`

### 步骤 2：配置环境变量
复制 \`.env.example\` 为 \`.env\`（或直接使用系统环境变量），并至少配置：

\`\`\`bash
# 一次性初始化密钥：仅用于创建第一位主理人账号
# 要求：至少 24 个字符，随机生成，切勿提交到 Git
# 生成方法：openssl rand -hex 32
INKFLOW_INIT_KEY="<your-random-64-char-hex-key>"

# 可选：监听端口
PORT=3000

# 可选：数据目录（默认 ./storage）
# INKFLOW_DATA_DIR=/var/lib/inkflow

# 可选：反向代理层数（仅当部署在 Nginx/CDN 之后时设置）
# INKFLOW_TRUST_PROXY=1
\`\`\`

### 步骤 3：启动生产全栈服务
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

### 🔑 首次启动与管理员安全初始化（SEC-006）

InkFlow 遵循安全默认原则（Secure by Default），**不存在任何预设的弱密码或固定应急恢复码**。

1. 首次启动前，必须在服务端配置 \`INKFLOW_INIT_KEY\`（本发布包不包含任何密钥）。
   未配置时初始化接口返回 403，初始化入口完全关闭。
2. 打开 **http://localhost:3000**，在【主理人初始化向导】中填入该初始化密钥。
3. 设置主理人密码，系统将生成一次性的**应急恢复密钥**（\`INK-XXXX-XXXX-XXXX-XXXX\`），请离线保存。
4. 初始化成功后，初始化入口**永久关闭**；重复请求返回 403。
5. 初始化完成后建议从服务器环境中**删除 \`INKFLOW_INIT_KEY\`** 并重启服务。

### 🗂️ 数据与备份

- 运行时数据全部位于 \`storage/\`，请定期备份该目录（数据库 + documents + revisions + assets）。
- 生产数据库在首次启动时自动创建，**发布包内不包含任何数据库文件**。
- 若需迁移，停止服务后整体复制 \`storage/\` 即可。
`;

fs.writeFileSync(path.join(RELEASE_DIR, 'README.md'), readmeContent, 'utf-8');

// ---------------------------------------------------------------------------
// 7. Post-build security scan (fails the build)
// ---------------------------------------------------------------------------
console.log('🔍 Step 9: Scanning release package for sensitive data ...');

const violations = scanRelease(RELEASE_DIR);

if (violations.length > 0) {
  console.error('\n❌ [InkFlow Release Builder] BUILD FAILED — sensitive data detected in release/:');
  for (const v of violations) console.error(`   • ${v}`);
  console.error('\nThe release directory was left in place for inspection. Do NOT deploy it.');
  process.exit(1);
}

console.log('✅ Security scan passed: no database, user documents, assets, revisions, .env or logs.');

console.log('\n============================================================');
console.log('✅ [InkFlow Release Builder] Release folder successfully created at:');
console.log(`📁 ${RELEASE_DIR}`);
console.log('You can now copy the entire "release" directory to any server!');
console.log('============================================================\n');

// Cleanup staging dir if it was ever created
if (fs.existsSync(STAGING_DIR)) {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
}
