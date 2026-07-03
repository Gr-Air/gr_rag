# Wiki 反向链接标注流水线

> **For agentic workers:** 使用 subagent-driven-development 或 executing-plans 按任务执行。`- [ ]` checkbox 追踪进度。

**Goal:** 将根目录 Python 脚本（`process_entities_v2.py`、`process_concepts_v2.py` 及 `check_*.py`）合并为 Node.js 流水线阶段 `link-entities.cjs`，实现"读取 Wiki 词条 → 反向标注 Raw 文档 `[[wikiLinks]]` → 质量检查报告"。

**Architecture:** 新增 `scripts/lib/linker.cjs` 核心库（占位符法替换 + 遗漏检查），新增 `scripts/pipeline/link-entities.cjs` 流水线脚本。纯 Node.js，零外部依赖。

**Tech Stack:** Node.js CommonJS, fs/path, 无 npm 依赖

---

## 文件结构

```
scripts/
├── lib/
│   ├── linker.cjs              ← NEW: 核心库
│   └── __tests__/
│       └── linker.test.cjs     ← NEW: 单元测试
└── pipeline/
    └── link-entities.cjs       ← NEW: 流水线脚本
```

## 设计决策

### 核心算法：占位符法（来自 `process_entities_v2.py`）

1. 将已有 `[[...]]` 替换为唯一占位符
2. 在剩余纯文本中按词条名匹配并包裹 `[[词条]]`
3. 恢复占位符

避免三个问题：子串破坏已有链接、重复包裹、短词条优先匹配（通过长度降序解决）。

### Entity + Concept 合并

Python 分两个脚本，Node.js 合并为统一流程，一次性加载 `Wiki/entity` + `Wiki/concept` 所有词条。

### 质量检查内置化

`check_*` 脚本逻辑内置为 `checkMissing()` 函数，输出 JSON 报告。

### 命令行参数

- `--dry-run`：预览不修改文件
- `--check-only`：仅质量检查
- `--verbose`：详细输出

---

## Task 1: `scripts/lib/linker.cjs` 核心库

**Files:** Create `scripts/lib/linker.cjs`

### 1.1 模块骨架 + `loadWikiEntries()`

```javascript
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const WIKI_DIR = path.join(ROOT, 'Wiki');
const RAW_DIR = path.join(ROOT, 'Raw');

/**
 * 加载所有 Wiki 词条，按长度降序（长名称优先匹配）
 * @returns {Array<{name: string, type: 'entity'|'concept'}>}
 */
function loadWikiEntries() {
  const entries = [];
  for (const sub of ['entity', 'concept']) {
    const dir = path.join(WIKI_DIR, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const name = f.replace(/\.md$/, '');
      if (name) entries.push({ name, type: sub });
    }
  }
  entries.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
  return entries;
}
```

### 1.2 `linkFile(filePath, entries, opts)` — 占位符法替换

```javascript
/**
 * 占位符法反向标注。opts.dryRun=true 时不写文件。
 * @returns {{ changed: boolean, linkedCount: number, linkedNames: string[], newContent?: string }}
 */
function linkFile(filePath, entries, opts = {}) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const original = content;
  let linkedCount = 0;
  const linkedNames = [];

  // Step 1: [[...]] → 占位符
  const phMap = new Map();
  let counter = 0;
  let text = content.replace(/\[\[[^\]]+\]\]/g, (match) => {
    const ph = `__WLPH_${counter}__`;
    phMap.set(ph, match);
    counter++;
    return ph;
  });

  // Step 2: 匹配词条并包裹 [[name]]
  for (const { name } of entries) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = /^[a-zA-Z0-9]/.test(name)
      ? new RegExp('\\b' + escaped + '\\b', 'g')
      : new RegExp(escaped, 'g');

    let replaced = false;
    text = text.replace(pattern, () => { replaced = true; return `[[${name}]]`; });
    if (replaced) { linkedCount++; linkedNames.push(name); }
  }

  // Step 3: 恢复占位符
  for (const [ph, orig] of phMap) text = text.replace(ph, orig);

  const changed = text !== original;
  if (changed && !opts.dryRun) {
    fs.writeFileSync(filePath, text, 'utf-8');
  }

  return { changed, linkedCount, linkedNames, newContent: changed ? text : undefined };
}
```

### 1.3 `checkMissing(filePath, entries)` — 遗漏检查

```javascript
/**
 * 检查文件中的遗漏词条。排除已在 [[...]] 内部的匹配。
 * @returns {{ missingCount: number, missingNames: string[] }}
 */
function checkMissing(filePath, entries) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // 收集所有 [[...]] 区间
  const wikiSpans = [];
  for (const m of content.matchAll(/\[\[[^\]]+\]\]/g)) {
    wikiSpans.push({ start: m.index, end: m.index + m[0].length });
  }

  function isInside(pos) {
    return wikiSpans.some(s => s.start <= pos && pos < s.end);
  }

  const missingNames = [];
  for (const { name } of entries) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = /^[a-zA-Z0-9]/.test(name)
      ? new RegExp('\\b' + escaped + '\\b', 'g')
      : new RegExp(escaped, 'g');

    for (const m of content.matchAll(pattern)) {
      if (isInside(m.index) && isInside(m.index + m[0].length - 1)) continue;
      missingNames.push(name);
      break; // 每个词条只报一次
    }
  }

  return { missingCount: missingNames.length, missingNames };
}

module.exports = { ROOT, WIKI_DIR, RAW_DIR, loadWikiEntries, linkFile, checkMissing };
```

- [ ] **1.1** 写入上述完整代码到 `scripts/lib/linker.cjs`
- [ ] **1.2** Commit: `feat: add linker.cjs core library`

---

## Task 2: `scripts/lib/__tests__/linker.test.cjs` 单元测试

**Files:** Create `scripts/lib/__tests__/linker.test.cjs`

### 2.1 测试文件骨架

```javascript
const fs = require('fs');
const path = require('path');
const os = require('os');
const linker = require('../linker.cjs');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'linker-test-')); }
function cleanup(d) { fs.rmSync(d, { recursive: true, force: true }); }
```

### 2.2 测试 1: `linkFile` 基本替换 + 长名称优先

```javascript
function test_basic_replacement() {
  const root = tmpDir();
  const rawDir = path.join(root, 'Raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const fp = path.join(rawDir, 'doc.md');
  fs.writeFileSync(fp, '系统采用微服务架构设计，支持MQTT协议。', 'utf-8');

  const entries = [
    { name: '微服务架构', type: 'concept' },
    { name: 'MQTT协议', type: 'entity' },
    { name: '微服务', type: 'concept' },
    { name: 'MQTT', type: 'entity' },
  ].sort((a, b) => b.name.length - a.name.length);

  const r = linker.linkFile(fp, entries);
  console.assert(r.changed, 'should be changed');
  console.assert(r.linkedCount >= 2, `expected >=2, got ${r.linkedCount}`);

  const out = fs.readFileSync(fp, 'utf-8');
  console.assert(out.includes('[[微服务架构]]'), 'missing [[微服务架构]]');
  console.assert(out.includes('[[MQTT协议]]'), 'missing [[MQTT协议]]');
  console.assert(!out.includes('[[微服务]]'), 'short name should not be wrapped separately');
  console.log('✅ test_basic_replacement PASSED');
  cleanup(root);
}
```

### 2.3 测试 2: 不破坏已有 `[[...]]`

```javascript
function test_preserve_existing_links() {
  const root = tmpDir();
  const rawDir = path.join(root, 'Raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const fp = path.join(rawDir, 'doc.md');
  fs.writeFileSync(fp, '[[星辰数智]]负责智慧港口项目，使用MQTT协议。', 'utf-8');

  const entries = [
    { name: 'MQTT协议', type: 'entity' },
    { name: '智慧港口', type: 'entity' },
  ].sort((a, b) => b.name.length - a.name.length);

  linker.linkFile(fp, entries);
  const out = fs.readFileSync(fp, 'utf-8');
  console.assert(out.includes('[[星辰数智]]'), 'existing [[星辰数智]] preserved');
  console.assert(out.includes('[[MQTT协议]]'), 'MQTT协议 wrapped');
  console.assert(!out.includes('[[[[星辰数智]]]]'), 'no double wrapping');
  console.log('✅ test_preserve_existing_links PASSED');
  cleanup(root);
}
```

### 2.4 测试 3: 英文词条边界匹配

```javascript
function test_english_boundary() {
  const root = tmpDir();
  const rawDir = path.join(root, 'Raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const fp = path.join(rawDir, 'doc.md');
  fs.writeFileSync(fp, 'Use API Gateway and API for management.', 'utf-8');

  const entries = [
    { name: 'API Gateway', type: 'concept' },
    { name: 'API', type: 'concept' },
  ].sort((a, b) => b.name.length - a.name.length);

  linker.linkFile(fp, entries);
  const out = fs.readFileSync(fp, 'utf-8');
  console.assert(out.includes('[[API Gateway]]'), 'API Gateway wrapped');
  // 第二个 API（在 "API for" 中）应被包裹
  console.assert((out.match(/\[\[API\]\]/g) || []).length >= 1, 'independent API wrapped');
  console.assert(!out.includes('[[[[API'), 'no nested wrapping');
  console.log('✅ test_english_boundary PASSED');
  cleanup(root);
}
```

### 2.5 测试 4: `checkMissing` 遗漏检测

```javascript
function test_check_missing() {
  const root = tmpDir();
  const rawDir = path.join(root, 'Raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const fp = path.join(rawDir, 'doc.md');
  fs.writeFileSync(fp, '系统采用[[微服务架构]]，使用MQTT协议。', 'utf-8');

  const entries = [
    { name: '微服务架构', type: 'concept' },
    { name: 'MQTT协议', type: 'entity' },
  ].sort((a, b) => b.name.length - a.name.length);

  const r = linker.checkMissing(fp, entries);
  console.assert(r.missingCount > 0, 'should detect missing');
  console.assert(r.missingNames.includes('MQTT协议'), 'MQTT协议 should be missing');
  console.assert(!r.missingNames.includes('微服务架构'), '微服务架构 already wrapped');
  console.log('✅ test_check_missing PASSED');
  cleanup(root);
}
```

### 2.6 测试 5: dry-run 不修改文件

```javascript
function test_dry_run() {
  const root = tmpDir();
  const rawDir = path.join(root, 'Raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const fp = path.join(rawDir, 'doc.md');
  const original = '使用MQTT协议通信。';
  fs.writeFileSync(fp, original, 'utf-8');

  const entries = [{ name: 'MQTT协议', type: 'entity' }];
  const r = linker.linkFile(fp, entries, { dryRun: true });
  console.assert(r.changed, 'should detect change');
  console.assert(r.linkedCount === 1, 'should find 1 link');

  const after = fs.readFileSync(fp, 'utf-8');
  console.assert(after === original, 'file should NOT be modified in dry-run');
  console.log('✅ test_dry_run PASSED');
  cleanup(root);
}
```

### 2.7 测试运行入口

```javascript
function runAll() {
  console.log('\n========== linker.cjs 单元测试 ==========\n');
  const tests = [
    test_basic_replacement, test_preserve_existing_links,
    test_english_boundary, test_check_missing, test_dry_run,
  ];
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { t(); pass++; } catch (e) { fail++; console.error(`❌ ${t.name}:`, e.message); }
  }
  console.log(`\n========== ${pass} 通过, ${fail} 失败 ==========\n`);
  process.exit(fail > 0 ? 1 : 0);
}
if (require.main === module) runAll();
```

- [ ] **2.1** 写入上述测试代码
- [ ] **2.2** 运行 `node scripts/lib/__tests__/linker.test.cjs` 验证全部通过
- [ ] **2.3** Commit: `test: add linker.cjs unit tests`

---

## Task 3: `scripts/pipeline/link-entities.cjs` 流水线脚本

**Files:** Create `scripts/pipeline/link-entities.cjs`

三步编排：
1. **[1/3]** `loadWikiEntries()` 加载词条
2. **[2/3]** 遍历 `Raw/*.md`，调用 `linkFile()`（支持 `--dry-run`）
3. **[3/3]** 遍历 `Raw/*.md`，调用 `checkMissing()`，输出 `link_report.json`

```javascript
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const linker = require('../lib/linker.cjs');

function parseArgs() {
  const a = process.argv.slice(2);
  return { dryRun: a.includes('--dry-run'), checkOnly: a.includes('--check-only'), verbose: a.includes('--verbose') };
}

function main() {
  const opts = parseArgs();
  console.log('========================================');
  console.log('  星辰Wiki 反向链接标注' + (opts.dryRun ? ' [预览]' : '') + (opts.checkOnly ? ' [仅检查]' : ''));
  console.log('========================================\n');

  // [1/3] 加载
  console.log('[1/3] 加载 Wiki 词条...');
  const entries = linker.loadWikiEntries();
  console.log(`  ✅ 实体: ${entries.filter(e=>e.type==='entity').length} | 概念: ${entries.filter(e=>e.type==='concept').length} | 总计: ${entries.length}\n`);
  if (entries.length === 0) { console.log('❌ 无词条'); process.exit(1); }

  // [2/3] 标注
  let linkStats = { changed: 0, unchanged: 0, errors: 0, totalLinks: 0 };
  if (!opts.checkOnly) {
    console.log('[2/3] 反向标注 Raw 文档...');
    const rawDir = linker.RAW_DIR;
    if (!fs.existsSync(rawDir)) { console.log('  ⚠️  Raw/ 不存在\n'); }
    else {
      const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.md'));
      for (const f of files) {
        try {
          const r = linker.linkFile(path.join(rawDir, f), entries, { dryRun: opts.dryRun });
          if (r.changed) {
            linkStats.changed++;
            linkStats.totalLinks += r.linkedCount;
            const preview = opts.verbose ? ` (${r.linkedNames.slice(0,5).join(', ')}${r.linkedCount>5?'...':''})` : '';
            console.log(`  ${opts.dryRun?'📝 [预览]':'✏️ '} ${f}: +${r.linkedCount}${preview}`);
          } else { linkStats.unchanged++; }
        } catch (e) { console.error(`  ❌ ${f}: ${e.message}`); linkStats.errors++; }
      }
      console.log(`\n  📊 修改:${linkStats.changed} 无变化:${linkStats.unchanged} 错误:${linkStats.errors} 总链接:${linkStats.totalLinks}\n`);
    }
  }

  // [3/3] 质量检查
  console.log('[3/3] 质量检查...');
  const rawDir = linker.RAW_DIR;
  const details = [];
  let missingFiles = 0, totalMissing = 0;
  if (fs.existsSync(rawDir)) {
    for (const f of fs.readdirSync(rawDir).filter(f => f.endsWith('.md'))) {
      const r = linker.checkMissing(path.join(rawDir, f), entries);
      if (r.missingCount > 0) {
        missingFiles++; totalMissing += r.missingCount;
        details.push({ file: f, missingCount: r.missingCount, missingNames: r.missingNames.slice(0, 20) });
        if (opts.verbose) {
          console.log(`  ⚠️  ${f}: ${r.missingCount} 遗漏`);
          r.missingNames.slice(0, 10).forEach(n => console.log(`      - ${n}`));
        }
      }
    }
  }
  const report = { timestamp: new Date().toISOString(), mode: opts.dryRun?'dry-run':opts.checkOnly?'check-only':'full', summary: { totalFiles: fs.existsSync(rawDir)?fs.readdirSync(rawDir).filter(f=>f.endsWith('.md')).length:0, filesWithMissing: missingFiles, totalMissing }, details: details.slice(0, 50) };
  const reportPath = path.join(linker.ROOT, 'link_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n  📊 遗漏文件:${missingFiles} 遗漏词条:${totalMissing} 报告:${reportPath}\n`);

  console.log('========================================');
  console.log('  ✅ 完成!');
  console.log(`  📝 标注: ${linkStats.changed} 文件 / ${linkStats.totalLinks} 链接`);
  console.log(`  🔍 遗漏: ${missingFiles} 文件 / ${totalMissing} 词条`);
  console.log('========================================');
}

if (require.main === module) { try { main(); } catch(e) { console.error('❌', e); process.exit(1); } }
module.exports = { main };
```

- [ ] **3.1** 写入上述代码
- [ ] **3.2** Commit: `feat: add link-entities.cjs pipeline script`

---

## 验证清单

- [ ] `node scripts/lib/__tests__/linker.test.cjs` — 5/5 通过
- [ ] `node scripts/pipeline/link-entities.cjs --dry-run` — 预览模式正常
- [ ] `node scripts/pipeline/link-entities.cjs --check-only` — 仅检查模式正常
- [ ] `node scripts/pipeline/link-entities.cjs --verbose` — 详细模式正常
- [ ] 完整运行后 `link_report.json` 生成正确
- [ ] 确认 Python 脚本可以删除（`process_entities.py`, `process_entities_v2.py`, `process_concepts.py`, `process_concepts_v2.py`, `check_*.py`, `debug_missing.py`）
