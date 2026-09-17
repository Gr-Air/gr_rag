# Spec 002: 提示词模板类

> 创建日期：2026-07-06
> 状态：planned | in-progress | **implemented** | archived
> 关联 Issue：`[DESIGN] 抽取提示词模板类，提高可维护性`
> 关联分支：refactor/prompt-template

---

## 1. 动机

当前提示词硬编码在 `buildRAGPrompt` 函数中，存在以下问题：

1. **可维护性差**：提示词与业务逻辑耦合，修改提示词需要阅读大量代码
2. **可扩展性差**：无法根据不同场景（追问、对比、总结等）灵活调整提示词
3. **复用性差**：相同的提示词逻辑无法在多个模块间复用
4. **缺乏管理**：提示词版本、变更历史难以追踪

本变更将提示词抽取为独立的模板类，实现：
- 提示词与业务逻辑解耦
- 支持场景化提示词切换
- 支持变量替换
- 提高代码可测试性

---

## 2. 行为契约

### 2.1 核心功能

| 功能 | 说明 |
|------|------|
| 提示词模板管理 | 支持系统提示词、用户提示词的模板定义 |
| 变量替换 | 支持 `${variable}` 格式的变量替换 |
| 场景化切换 | 根据查询类型（追问、对比、总结等）加载不同提示词 |
| 模板继承 | 基础模板可被场景模板继承和覆盖 |

### 2.2 使用示例

```typescript
const promptTemplate = new PromptTemplate('rag');

// 基础查询
const { systemPrompt, userPrompt } = promptTemplate.build({
  context: '文档内容...',
  query: '项目经理是谁',
});

// 追问场景
const { systemPrompt, userPrompt } = promptTemplate.build({
  context: '文档内容...',
  query: '还有呢',
  isFollowUp: true,
});

// 对比场景
const { systemPrompt, userPrompt } = promptTemplate.build({
  context: '文档内容...',
  query: '对比两个方案',
  intent: 'compare',
});
```

### 2.3 边界条件

| 场景 | 预期行为 |
|------|---------|
| 模板不存在 | 使用默认模板 |
| 变量缺失 | 使用空字符串替代 |
| 未知场景 | 使用基础模板 |

---

## 3. 验收标准

- [ ] 提示词模板类能正确生成基础查询的系统提示词和用户提示词
- [ ] 追问场景能添加追问专属提示词
- [ ] 变量替换功能正常工作
- [ ] 模板类可独立测试（不依赖其他模块）
- [ ] 原有 `buildRAGPrompt` 功能不变

---

## 4. 实现锚点

| 文件 | 函数/区域 | 变更类型 |
|------|----------|---------|
| `src/lib/promptTemplate.ts` | 新增模块 | 新增 |
| `src/lib/ragEngine.ts` | `buildRAGPrompt` 函数 | 修改（调用模板类） |

---

## 5. 设计方案

### 5.1 类结构

```typescript
class PromptTemplate {
  private templates: Map<string, TemplateConfig>;
  private currentTemplate: string;
  
  constructor(templateName: string = 'rag');
  
  build(options: BuildOptions): { systemPrompt: string; userPrompt: string };
  
  register(name: string, config: TemplateConfig): void;
  
  use(name: string): void;
}

interface TemplateConfig {
  systemPrompt: string;
  userPrompt: string;
  extends?: string;
}

interface BuildOptions {
  context: string;
  query: string;
  conversationContext?: string;
  isFollowUp?: boolean;
  intent?: string;
  [key: string]: any;
}
```

### 5.2 提示词模板定义

```typescript
// 基础模板
{
  systemPrompt: `你是一个企业内部项目文档知识库的智能助手...`,
  userPrompt: `请基于以下文档内容回答用户的问题。\n\n${context}\n\n## 用户问题\n\n${query}`
}

// 追问模板（继承基础模板）
{
  extends: 'base',
  userPrompt: `⚠️ 用户正在追问，请结合对话历史理解上下文，继续补充回答，不要重复之前的内容。\n\n${conversationContext}\n\n---\n\n${context}\n\n## 用户问题\n\n${query}`
}
```

### 5.3 变量列表

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `${context}` | 检索到的文档上下文 | "文档1内容...\n文档2内容..." |
| `${query}` | 用户问题 | "项目经理是谁" |
| `${conversationContext}` | 对话历史 | "用户: 之前的问题...\n助手: 之前的回答..." |
| `${entityDocs}` | 实体关联文档全文 | "实体关联文档内容..." |
| `${structSummary}` | 结构化查询结果 | "查询到3条相关文档..." |

---

## 6. 兼容影响

### 6.1 公开 API 变更

无破坏性变更，`buildRAGPrompt` 的函数签名不变。

### 6.2 下游调用方

| 调用方 | 影响 |
|--------|------|
| `ragEngine.ts` | 修改内部实现，调用模板类 |

---

## 7. 测试覆盖

| 测试文件 | 用例数 | 覆盖场景 |
|---------|--------|---------|
| `test/promptTemplate.test.ts` | 6 | 基础模板加载、变量替换、追问模板、模板继承、未知模板、变量缺失 |

---

## 8. 优缺点分析

### 优点

| 优点 | 说明 |
|------|------|
| **可维护性** | 提示词集中管理，修改方便 |
| **可扩展性** | 新增场景只需添加新模板 |
| **可测试性** | 模板类可独立单元测试 |
| **灵活性** | 支持模板继承和覆盖 |

### 缺点

| 缺点 | 应对策略 |
|------|---------|
| **增加复杂度** | 保持类设计简洁，避免过度抽象 |
| **模板膨胀** | 定期清理不常用模板 |

---

## 9. 实施步骤

```
Step 1: 创建 promptTemplate.ts
        - 实现 PromptTemplate 类
        - 定义基础模板和追问模板

Step 2: 修改 ragEngine.ts
        - 将 buildRAGPrompt 改为调用模板类
        - 恢复 isFollowUp 参数

Step 3: 添加测试
        - 创建 promptTemplate.test.ts

Step 4: 更新 spec 状态为 implemented
```

---

## 10. 讨论结论

1. **模板存储方式**：代码中硬编码
2. **模板命名规范**：按意图翻译（如 `followup`、`compare`、`summary`）
3. **变量验证**：需要验证必填变量
4. **模板热更新**：不需要（硬编码方案）
