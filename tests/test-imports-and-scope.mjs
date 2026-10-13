import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function getFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results = results.concat(getFiles(full));
    } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
      results.push(full);
    }
  }
  return results;
}

const jsFiles = getFiles(path.join(rootDir, 'js'));

console.log(`=== 1. 静的インポート整合性テスト (全 ${jsFiles.length} ファイル) ===`);

let errorCount = 0;

for (const file of jsFiles) {
  const code = fs.readFileSync(file, 'utf8');
  const relFile = path.relative(rootDir, file).replace(/\\/g, '/');

  // 1. 各 import 文のシンボルがエクスポート元に実在するかチェック
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(code)) !== null) {
    const symbols = match[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    const fromPath = match[2];
    if (fromPath.startsWith('.')) {
      const targetPath = path.resolve(path.dirname(file), fromPath);
      let targetCode = '';
      try {
        targetCode = fs.readFileSync(targetPath, 'utf8');
      } catch (err) {
        console.error(`[FAIL] ファイル不在: ${fromPath} in ${relFile}`);
        errorCount++;
        continue;
      }

      for (const sym of symbols) {
        const hasExport =
          new RegExp(`export\\s+(async\\s+)?(function\\*?|const|let|var|class)\\s+${sym}\\b`).test(targetCode) ||
          new RegExp(`export\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}`).test(targetCode);
        if (!hasExport) {
          console.error(`[FAIL] 未エクスポートのシンボル: '${sym}' (import元: ${relFile}, 参照先: ${fromPath})`);
          errorCount++;
        }
      }
    }
  }
}

// 2. youtube-modal.js で使用されている主要関数の宣言・スコープチェック
console.log('=== 2. youtube-modal.js スコープ整合性テスト ===');
const ytModalCode = fs.readFileSync(path.join(rootDir, 'js/ui/youtube-modal.js'), 'utf8');

// 必須のインポートシンボル
const requiredModalSymbols = ['fetchVideoInfo', 'downloadAudioStream', 'extractYouTubeVideoId'];
for (const sym of requiredModalSymbols) {
  const isImported = new RegExp(`import\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*from`).test(ytModalCode);
  if (!isImported) {
    console.error(`[FAIL] youtube-modal.js に '${sym}' がインポートされていません`);
    errorCount++;
  } else {
    console.log(`  ✓ '${sym}' は正常にインポートされています`);
  }
}

assert.strictEqual(errorCount, 0, `インポート・スコープ整合性テストで ${errorCount} 件のエラーが見つかりました`);
console.log('インポート・スコープ整合性テスト PASS ✓');
