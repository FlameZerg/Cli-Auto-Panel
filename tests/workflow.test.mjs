import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// 配置回归与真实压缩检查不启动应用，也不冒充已运行 GitHub Actions。
const workflow = readFileSync(new URL('../.github/workflows/build-windows.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const steps = workflow.split(/^ {6}- /m).slice(1);

test('构建成功后打包并校验 ZIP，直接上传单个文件且不自动发布', () => {
  assert.match(workflow, /^on:\n {2}push:/m);
  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  assert.match(workflow, /^ {6}BUILD_ARTIFACT_NAME: Cli-Auto-Panel\.zip$/m);
  const testIndex = steps.findIndex(step => step.includes('run: node --test tests/workflow.test.mjs'));
  const buildIndex = steps.findIndex(step => step.includes('run: npm run build -- --no-bundle'));
  const packageIndex = steps.findIndex(step => step.includes('name: 打包并校验交付 ZIP'));
  const cleanupIndex = steps.findIndex(step => step.includes('name: 清理本工作流的同名旧产物'));
  const uploadIndex = steps.findIndex(step => step.includes('name: 上传交付 ZIP'));
  assert.ok(testIndex >= 0 && buildIndex > testIndex && packageIndex > buildIndex);
  assert.ok(cleanupIndex > packageIndex && uploadIndex > cleanupIndex);
  // 外层包名与包内程序名分别约束，防止一起替换空格。
  assert.match(steps[packageIndex], /Get-Item -LiteralPath 'src-tauri\/target\/release\/Cli Auto Panel\.exe'/);
  const upload = steps[uploadIndex];
  const paths = [...upload.matchAll(/^\s+path: ([^\n]+)$/gm)].map(match => match[1]);
  assert.deepEqual(paths, ['artifacts/${{ env.BUILD_ARTIFACT_NAME }}']);
  assert.match(upload, /^\s+archive: false$/m);
  assert.match(upload, /if-no-files-found: error/);
  assert.doesNotMatch(steps[packageIndex] + upload, /\bif:|\bcontinue-on-error:/);
  assert.doesNotMatch(workflow, /gh release|action-gh-release|contents: write/);
});

test('真实 ZIP 打包保留根目录原名与二进制内容，缺失或空输入立即失败', {
  skip: process.platform !== 'win32' && '实际打包检查需要 Windows PowerShell',
}, () => {
  const step = steps.find(step => step.includes('name: 打包并校验交付 ZIP'));
  const script = step?.match(/run: \|\n([\s\S]*)/)?.[1].replace(/^ {10}/gm, '');
  assert.ok(script, '必须存在可独立执行的打包脚本');
  const root = mkdtempSync(join(tmpdir(), 'cli-auto-panel-delivery-'));
  const executable = join(root, 'src-tauri', 'target', 'release', 'Cli Auto Panel.exe');
  const archiveName = 'Cli-Auto-Panel.zip';
  const options = {
    cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, BUILD_ARTIFACT_NAME: archiveName },
  };
  const run = command => {
    // 固定管道编码，确保中文错误在不同 Windows 控制台代码页下仍可定位。
    const utf8Command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${command}`;
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', utf8Command], options);
    assert.ifError(result.error);
    return result;
  };
  try {
    mkdirSync(join(root, 'src-tauri', 'target', 'release'), { recursive: true });
    const missing = run(script);
    assert.notEqual(missing.status, 0, '缺失主程序必须阻止交付');
    assert.equal(existsSync(join(root, 'artifacts', archiveName)), false);
    writeFileSync(executable, Buffer.alloc(0));
    const empty = run(script);
    assert.notEqual(empty.status, 0, '空主程序必须阻止交付');
    assert.match(empty.stderr, /主程序不是有效的非空文件/);
    // 这是压缩流程的二进制夹具，不是可运行 EXE，也不替代原生应用验收。
    writeFileSync(executable, Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256)));
    const packaged = run(`${script}
      $sourceHash = (Get-FileHash -LiteralPath $executable.FullName -Algorithm SHA256).Hash
      $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $archivePath).Path)
      try {
        $stream = $zip.Entries[0].Open()
        try {
          if ((Get-FileHash -InputStream $stream -Algorithm SHA256).Hash -cne $sourceHash) {
            throw 'ZIP 内容哈希与源文件不一致'
          }
        } finally { $stream.Dispose() }
      } finally { $zip.Dispose() }
    `);
    assert.equal(packaged.status, 0, packaged.stderr);
    assert.ok(existsSync(join(root, 'artifacts', archiveName)));
  } finally {
    // 只移除本次 mkdtemp 创建的独立测试目录，不触碰仓库或真实应用文件。
    assert.equal(root.startsWith(join(tmpdir(), 'cli-auto-panel-delivery-')), true);
    rmSync(root, { recursive: true, force: true });
  }
});
