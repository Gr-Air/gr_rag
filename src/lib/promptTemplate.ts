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
  structSummary?: string;
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

    // 构建上下文（包含实体文档和结构化摘要）
    let context = options.context;

    if (options.entityDocsContent) {
      context = `## 实体关联文档全文\n\n${options.entityDocsContent}\n\n---\n\n${
        options.structSummary
          ? `## 结构化关联查询结果\n\n${options.structSummary}\n\n---\n\n`
          : ''
      }${context ? `## 语义检索文档内容\n\n${context}` : ''}`;
    } else if (options.structSummary) {
      context = `## 结构化关联查询结果\n\n${options.structSummary}\n\n---\n\n${context ? `## 语义检索文档内容\n\n${context}` : ''}`;
    }

    // 验证必填变量（在构建上下文之后，因为 entityDocsContent/structSummary 可以替代空的 context）
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
      structSummary: options.structSummary || '',
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
}
