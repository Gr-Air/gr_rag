// ============================================================
// 提示词模板类
// 将提示词从业务逻辑中抽离，支持场景化模板切换
// ============================================================

interface TemplateConfig {
  systemPrompt: string;
  userPrompt: string;
}

interface BuildOptions {
  context: string;
  query: string;
  conversationContext?: string;
  isFollowUp?: boolean;
  intent?: string;
  entityDocsContent?: string;
}

const REQUIRED_VARS: (keyof BuildOptions)[] = ['context', 'query'];

/**
 * 变量替换：将 ${var} 替换为实际值
 * 使用函数避免用户内容中的 $ 被误解释
 */
function replaceVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

/**
 * 基础系统提示词
 */
const BASE_SYSTEM_PROMPT = `你是一个企业内部项目文档知识库的智能助手，名为"星辰Wiki助手"。
你的知识来源于企业项目文档库，包括技术方案、架构设计、需求文档、测试报告、项目进度等。

回答规则：
1. 基于提供的文档上下文回答问题，不要编造信息
2. 如果文档上下文中没有相关信息，诚实告知用户"当前知识库中暂无相关信息"
3. 回答要简洁、专业，适合企业内部使用
4. 引用文档时，注明文档标题和来源
5. 如果涉及多个文档的信息，综合归纳后给出答案
6. 对于技术问题，给出具体的技术细节
7. 对于项目进度/人员相关问题，基于文档中的具体数据回答
8. 使用中文回答
9. 如果上下文中有"实体关联文档全文"，这些是与问题实体直接相关的完整文档，优先基于这些文档回答
10. 如果上下文中有"结构化关联查询结果"，优先用它来回答文档列表/关联类问题
11. 如果上下文中包含对话历史，请结合历史理解用户的追问意图，但不要重复引用历史的完整内容`;

/**
 * 基础用户提示词
 */
const BASE_USER_PROMPT = `请基于以下文档内容回答用户的问题。

## 参考文档

${'${context}'}

## 用户问题

${'${query}'}

请基于上述文档内容，给出准确、专业的回答：`;

/**
 * 追问用户提示词
 */
const FOLLOWUP_USER_PROMPT = `⚠️ 用户正在追问，请结合对话历史理解上下文，继续补充回答，不要重复之前已经回答过的内容。

## 对话历史

${'${conversationContext}'}

---

## 参考文档

${'${context}'}

## 用户问题

${'${query}'}

请基于上述文档内容和对话历史，给出准确、专业的补充回答：`;

/**
 * 对比用户提示词
 */
const COMPARE_USER_PROMPT = `用户希望对比多个方案/内容，请从不同维度进行结构化对比分析。

## 参考文档

${'${context}'}

## 用户问题

${'${query}'}

请基于上述文档内容，从关键维度进行对比分析，使用表格或分点形式呈现：`;

/**
 * 提示词模板类
 */
export class PromptTemplate {
  private templates: Map<string, TemplateConfig> = new Map();

  constructor() {
    this.registerDefaults();
  }

  /**
   * 注册默认模板
   */
  private registerDefaults(): void {
    this.templates.set('base', {
      systemPrompt: BASE_SYSTEM_PROMPT,
      userPrompt: BASE_USER_PROMPT,
    });

    this.templates.set('followup', {
      systemPrompt: BASE_SYSTEM_PROMPT,
      userPrompt: FOLLOWUP_USER_PROMPT,
    });

    this.templates.set('compare', {
      systemPrompt: BASE_SYSTEM_PROMPT,
      userPrompt: COMPARE_USER_PROMPT,
    });
  }

  /**
   * 注册自定义模板
   */
  register(name: string, config: TemplateConfig): void {
    this.templates.set(name, config);
  }

  /**
   * 选择模板
   */
  private selectTemplate(options: BuildOptions): string {
    if (options.isFollowUp) return 'followup';
    if (options.intent === 'compare') return 'compare';
    return 'base';
  }

  /**
   * 构建提示词
   */
  build(options: BuildOptions): { systemPrompt: string; userPrompt: string } {
    const templateName = this.selectTemplate(options);
    const template = this.templates.get(templateName)!;

    // 构建上下文（包含实体文档）
    let context = options.context;

    if (options.entityDocsContent) {
      context = `## 实体关联文档全文\n\n${options.entityDocsContent}\n\n---\n\n${context ? `## 语义检索文档内容\n\n${context}` : ''}`;
    }

    // 验证必填变量（在构建上下文之后，因为 entityDocsContent 可以替代空的 context）
    if (!context) {
      throw new Error(`必填变量缺失: context（无检索结果且无实体文档数据）`);
    }
    if (!options.query) {
      throw new Error(`必填变量缺失: query`);
    }

    // 变量替换
    const vars: Record<string, string> = {
      context,
      query: options.query,
      conversationContext: options.conversationContext || '',
      entityDocs: options.entityDocsContent || '',
    };

    let userPrompt = replaceVars(template.userPrompt, vars);

    // 基础模板和对比模板：如果有对话历史，前置注入
    if (options.conversationContext && !options.isFollowUp) {
      userPrompt = `${userPrompt}\n\n---\n\n## 对话历史\n\n${options.conversationContext}`;
    }

    return {
      systemPrompt: replaceVars(template.systemPrompt, vars),
      userPrompt,
    };
  }

  /**
   * 构建 Query 改写 system prompt（Spec 035-B3：从 queryRewriter 迁入）
   * 动态注入已知实体列表作为参考 + 路由决策指令
   */
  buildRewritePrompt(entitiesWithMeta: Array<{ name: string; type: 'concept' | 'entity'; category: string }>): string {
    const personEntities = entitiesWithMeta.filter(e => e.category === '人员').map(e => e.name);
    const clientEntities = entitiesWithMeta.filter(e => e.category === '客户企业').map(e => e.name);
    const techEntities = entitiesWithMeta.filter(e => e.category === '技术组件').map(e => e.name);
    const deptEntities = entitiesWithMeta.filter(e => e.category === '部门').map(e => e.name);
    const conceptEntities = entitiesWithMeta.filter(e => e.type === 'concept').map(e => e.name);
    const projectEntities = entitiesWithMeta.filter(e => e.category === '项目系统').map(e => e.name);

    const sample = (arr: string[], max: number) => arr.slice(0, max).join('、');

    return `你是一个知识库查询改写与实体提取助手。你的任务是：
1. 改写用户的自然语言查询，使其更精准、更适合检索
2. 从查询中提取结构化的实体关键词

## 知识库包含的实体类型

已知的部分实体（供参考，用户可能使用同义词或简称）：
- 客户企业：${sample(clientEntities, 15)}
- 技术组件：${sample(techEntities, 15)}
- 项目系统：${sample(projectEntities, 10)}
- 人员：${sample(personEntities, 8)}
- 部门：${sample(deptEntities, 8)}
- 概念：${sample(conceptEntities, 10)}

知识库的 index.md 包含以下章节可查询元信息：
客户列表、文档类型、项目类型、概念索引、实体索引、客户企业、技术组件、项目系统、人员、部门、全部原始文档、知识库概览

## 知识库文档类型

知识库中的文档按以下类型分类（文件名中的 docType 字段）：
客户项目验收、技术方案、技术架构设计、来往账目、系统测试报告、需求规格说明书、项目人员清单、项目管理计划、项目费用结算、项目进度汇报、大型台账

## 改写规则

1. **补全隐含实体**：如果用户说"上次那个项目"，结合上下文补全为具体项目名
2. **术语标准化**：将口语化表达转为标准术语（如"钱收回来没"→"回款金额"）
3. **同义词展开**：将简称/别名展开为知识库中的标准名称
4. **多实体拆分**：明确区分多个独立实体
5. **保持简洁**：不要添加原始 query 中没有的信息，不要编造

## 路由决策规则

### isFollowUp（追问检测）
判断当前 query 是否依赖上一轮对话才能理解。以下情况应为 true：
- 包含指代词："那个"、"这个"、"它"、"他"、"她"、"这些"
- 省略追问："那进度呢"、"那人呢"、"那成本呢"
- 纠错/否定："不对，我说的是..."、"不是这个意思"、"重新查一下"
- 确认反问："就这些？"、"没了吗？"
- 展开/继续："详细说说"、"然后呢"、"还有呢"、"继续说"
- 序号追问："第二个呢"、"第三个怎么样"
- 比较追问："它和XX比呢"

## 输出格式

严格输出一个 JSON 对象，不要有任何其他内容：

{
  "rewritten": "改写后的查询语句",
  "entities": ["实体1", "实体2"],
  "intent": "fact|list|compare|summary|analysis|other",
  "relevantDocTypes": ["文档类型1", "文档类型2"],
  "isFollowUp": true或false,
  "reason": "改写理由（中文，不超过20字）"
}

### intent 说明
- fact: 查询具体事实/数值（如"徐峰负责什么"、"项目有多少人"）
- list: 列举/统计（如"有哪些项目"、"多少家公司"）
- compare: 对比分析（如"对比两个方案"）
- summary: 总结概括（如"总结项目进展"）
- analysis: 分析评估（如"为什么选择这个架构"）
- other: 其他

### relevantDocTypes 说明
根据查询语义，判断哪些文档类型最可能包含答案，从上述文档类型列表中选择1-3个。
如果查询与具体文档类型无关（如纯概念查询），输出空数组 []。
例如：
- "项目验收进度" → ["客户项目验收", "项目进度汇报"]
- "Redis怎么配置" → ["技术方案", "技术架构设计"]
- "上月付款了多少" → ["来往账目", "项目费用结算"]
- "CRM是什么" → []（概念查询，不限定文档类型）`;
  }
}
