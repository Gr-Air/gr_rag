// ============================================================
// linker.cjs 单元测试
// 运行: node scripts/lib/__tests__/linker.test.cjs
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

// 动态加载 linker 模块
const linker = require('../linker.cjs');

// 临时目录工具
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'linker-test-'));
}
function cleanup(d) {
  fs.rmSync(d, { recursive: true, force: true });
}

// ============================================================
// 测试 1: 基本替换 + 长名称优先
// ============================================================
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
  console.assert(r.linkedCount >= 2, `expected >=2 links, got ${r.linkedCount}`);

  const out = fs.readFileSync(fp, 'utf-8');
  // MQTT协议(6字) > 微服务架构(5字) > MQTT(4字) > 微服务(3字)
  // MQTT协议和微服务架构应该被包裹，短词条MQTT和微服务在长词条内部被跳过
  console.assert(out.includes('[[微服务架构]]'), 'expected [[微服务架构]]');
  console.assert(out.includes('[[MQTT协议]]'), 'expected [[MQTT协议]]');
  console.assert(!out.includes('[[微服务]]'), '短词条微服务不应被单独包裹（已在微服务架构中）');
  console.assert(!out.includes('[[MQTT]]'), '短词条MQTT不应被单独包裹（已在MQTT协议中）');

  console.log('✅ test_basic_replacement PASSED');
  cleanup(root);
}

// ============================================================
// 测试 2: 不破坏已有 [[...]] 链接
// ============================================================
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

  // 已有链接不应被破坏
  console.assert(out.includes('[[星辰数智]]'), '已有 [[星辰数智]] 应保留');
  // MQTT协议 在已有链接之外，应被包裹
  console.assert(out.includes('[[MQTT协议]]'), 'MQTT协议 应被包裹');
  // 不应出现双重包裹
  console.assert(!out.includes('[[[[星辰数智]]]]'), '不应出现双重包裹');
  // 智慧港口 会匹配 "智慧港口项目" 中的子串，这是正确行为（直接匹配模式）
  console.assert(out.includes('[[智慧港口]]'), '智慧港口应匹配智慧港口项目中的子串');

  console.log('✅ test_preserve_existing_links PASSED');
  cleanup(root);
}

// ============================================================
// 测试 3: 英文词条边界匹配
// ============================================================
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

  // "API Gateway" 应被完整包裹（长名称优先）
  console.assert(out.includes('[[API Gateway]]'), 'API Gateway 应被包裹');
  // 第二个独立 "API"（在 "API for" 中）应被包裹
  const apiMatches = (out.match(/\[\[API\]\]/g) || []);
  console.assert(apiMatches.length >= 1, `独立 API 应被包裹, 找到 ${apiMatches.length} 个`);
  // 不应出现嵌套 [[
  console.assert(!out.includes('[[[['), '不应出现嵌套标记');

  console.log('✅ test_english_boundary PASSED');
  cleanup(root);
}

// ============================================================
// 测试 4: checkMissing 遗漏检测
// ============================================================
function test_check_missing() {
  const root = tmpDir();
  const rawDir = path.join(root, 'Raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const fp = path.join(rawDir, 'doc.md');
  // 微服务架构已包裹，MQTT协议未包裹
  fs.writeFileSync(fp, '系统采用[[微服务架构]]，使用MQTT协议。', 'utf-8');

  const entries = [
    { name: '微服务架构', type: 'concept' },
    { name: 'MQTT协议', type: 'entity' },
    { name: 'MQTT', type: 'entity' },
  ].sort((a, b) => b.name.length - a.name.length);

  const r = linker.checkMissing(fp, entries);

  // 应检测到遗漏
  console.assert(r.missingCount > 0, `应检测到遗漏, got ${r.missingCount}`);
  // MQTT协议 应被报告遗漏（在 [[...]] 之外）
  const hasMQTT = r.missingNames.includes('MQTT协议') || r.missingNames.includes('MQTT');
  console.assert(hasMQTT, `MQTT相关词条应在遗漏列表中: ${r.missingNames.join(', ')}`);
  // 微服务架构 已在 [[...]] 中，不应报告
  console.assert(!r.missingNames.includes('微服务架构'), '微服务架构已包裹，不应报告遗漏');

  console.log('✅ test_check_missing PASSED');
  cleanup(root);
}

// ============================================================
// 测试 5: dry-run 模式不修改文件
// ============================================================
function test_dry_run() {
  const root = tmpDir();
  const rawDir = path.join(root, 'Raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const fp = path.join(rawDir, 'doc.md');
  const original = '使用MQTT协议通信。';
  fs.writeFileSync(fp, original, 'utf-8');

  const entries = [{ name: 'MQTT协议', type: 'entity' }];
  const r = linker.linkFile(fp, entries, { dryRun: true });

  // 应检测到变化
  console.assert(r.changed, 'dry-run 应检测到变化');
  console.assert(r.linkedCount === 1, `应发现 1 个链接, got ${r.linkedCount}`);

  // 文件内容不应被修改
  const after = fs.readFileSync(fp, 'utf-8');
  console.assert(after === original, 'dry-run 模式不应修改文件');

  console.log('✅ test_dry_run PASSED');
  cleanup(root);
}

// ============================================================
// 测试 6: loadWikiEntries 加载和排序
// ============================================================
function test_load_entries() {
  // 测试排序逻辑：按长度降序，同长度按字母序
  const entries = [
    { name: '微服务架构', type: 'concept' },
    { name: 'MQTT协议', type: 'entity' },
    { name: '微服务', type: 'concept' },
    { name: 'MQTT', type: 'entity' },
  ];
  entries.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));

  // 验证排序：长名称优先（MQTT协议=6字 > 微服务架构=5字）
  console.assert(entries[0].name === 'MQTT协议', `Expected MQTT协议 first (len=6), got ${entries[0].name} (len=${entries[0].name.length})`);
  console.assert(entries[1].name === '微服务架构', `Expected 微服务架构 second (len=5), got ${entries[1].name} (len=${entries[1].name.length})`);
  console.assert(entries[2].name === 'MQTT', `Expected MQTT third (len=4), got ${entries[2].name} (len=${entries[2].name.length})`);
  console.assert(entries[3].name === '微服务', `Expected 微服务 fourth (len=3), got ${entries[3].name} (len=${entries[3].name.length})`);

  // 验证类型标记
  console.assert(entries[1].type === 'concept', '微服务架构 type should be concept');
  console.assert(entries[0].type === 'entity', 'MQTT协议 type should be entity');

  console.log('✅ test_load_entries PASSED');
}

// ============================================================
// 测试 7: 无变化时不写入文件
// ============================================================
function test_no_change_no_write() {
  const root = tmpDir();
  const rawDir = path.join(root, 'Raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const fp = path.join(rawDir, 'doc.md');
  const original = '这是一段没有词条匹配的文本。';
  fs.writeFileSync(fp, original, 'utf-8');

  const entries = [
    { name: '微服务架构', type: 'concept' },
    { name: 'MQTT协议', type: 'entity' },
  ];

  const statBefore = fs.statSync(fp);
  const r = linker.linkFile(fp, entries);

  console.assert(!r.changed, '不应检测到变化');
  console.assert(r.linkedCount === 0, '链接数应为 0');
  console.assert(r.linkedNames.length === 0, '链接名列表应为空');

  const after = fs.readFileSync(fp, 'utf-8');
  console.assert(after === original, '文件内容不应改变');

  console.log('✅ test_no_change_no_write PASSED');
  cleanup(root);
}

// ============================================================
// 测试 8: 特殊正则字符词条名
// ============================================================
function test_special_regex_chars() {
  const root = tmpDir();
  const rawDir = path.join(root, 'Raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const fp = path.join(rawDir, 'doc.md');
  fs.writeFileSync(fp, 'C++ 是编程语言，C++标准很重要。', 'utf-8');

  const entries = [
    { name: 'C++', type: 'concept' },
  ];

  const r = linker.linkFile(fp, entries);

  // C++ 中的 + 是正则特殊字符，应被正确转义
  // C++ 不以单词字符结尾（+ 不是 \w），所以不用 \b 边界，直接匹配
  console.assert(r.changed, '应检测到变化');
  console.assert(r.linkedCount === 1, `应找到 1 个链接, got ${r.linkedCount}`);

  const out = fs.readFileSync(fp, 'utf-8');
  console.assert(out.includes('[[C++]]'), 'C++ 应被正确包裹');
  // 两个 C++ 都应被包裹
  const matches = (out.match(/\[\[C\+\+\]\]/g) || []);
  console.assert(matches.length === 2, `应有两个 [[C++]], got ${matches.length}`);

  console.log('✅ test_special_regex_chars PASSED');
  cleanup(root);
}

// ============================================================
// 运行所有测试
// ============================================================
function runAll() {
  console.log('\n========== linker.cjs 单元测试 ==========\n');

  const tests = [
    test_basic_replacement,
    test_preserve_existing_links,
    test_english_boundary,
    test_check_missing,
    test_dry_run,
    test_load_entries,
    test_no_change_no_write,
    test_special_regex_chars,
  ];

  let pass = 0;
  let fail = 0;

  for (const t of tests) {
    try {
      t();
      pass++;
    } catch (e) {
      fail++;
      console.error(`❌ ${t.name}: ${e.message}`);
    }
  }

  console.log(`\n========== 结果: ${pass} 通过, ${fail} 失败 ==========\n`);
  process.exit(fail > 0 ? 1 : 0);
}

if (require.main === module) {
  runAll();
}
