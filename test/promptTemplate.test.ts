import { describe, it, expect, beforeEach } from 'vitest';
import { PromptTemplate } from '@/lib/promptTemplate.js';

describe('PromptTemplate', () => {
  let template: PromptTemplate;

  beforeEach(() => {
    template = new PromptTemplate();
  });

  describe('基础模板', () => {
    it('应该正确生成基础查询的提示词', () => {
      const result = template.build({
        context: '这是文档上下文',
        query: '项目经理是谁',
      });

      expect(result.systemPrompt).toContain('星辰Wiki助手');
      expect(result.systemPrompt).toContain('企业内部项目文档知识库');
      expect(result.userPrompt).toContain('这是文档上下文');
      expect(result.userPrompt).toContain('项目经理是谁');
    });

    it('缺少必填变量时应该抛出错误', () => {
      expect(() =>
        template.build({
          context: '',
          query: '项目经理是谁',
        })
      ).toThrow('context');

      expect(() =>
        template.build({
          context: '文档内容',
          query: '',
        })
      ).toThrow('query');
    });
  });

  describe('追问模板', () => {
    it('追问场景应该包含追问提示', () => {
      const result = template.build({
        context: '文档内容',
        query: '还有呢',
        isFollowUp: true,
        conversationContext: '用户: 之前的问题\n助手: 之前的回答',
      });

      expect(result.userPrompt).toContain('追问');
      expect(result.userPrompt).toContain('对话历史');
      expect(result.userPrompt).toContain('之前的问题');
      expect(result.userPrompt).toContain('之前的回答');
    });

    it('追问场景但缺少对话历史时应该正常降级', () => {
      const result = template.build({
        context: '文档内容',
        query: '还有呢',
        isFollowUp: true,
      });

      expect(result.userPrompt).toContain('追问');
      // 没有对话历史时不应该崩溃
      expect(result.userPrompt).toContain('文档内容');
    });
  });

  describe('对比模板', () => {
    it('对比场景应该包含对比提示', () => {
      const result = template.build({
        context: '方案A内容\n方案B内容',
        query: '对比两个方案',
        intent: 'compare',
      });

      expect(result.userPrompt).toContain('对比');
      expect(result.userPrompt).toContain('方案A内容');
      expect(result.userPrompt).toContain('方案B内容');
    });
  });

  describe('变量替换', () => {
    it('应该正确替换所有变量', () => {
      const result = template.build({
        context: '文档上下文',
        query: '用户问题',
        structSummary: '结构化摘要',
      });

      expect(result.userPrompt).toContain('文档上下文');
      expect(result.userPrompt).toContain('用户问题');
      // structSummary 应该出现在上下文中
      expect(
        result.systemPrompt.includes('结构化关联查询结果') ||
        result.userPrompt.includes('结构化摘要')
      ).toBe(true);
    });

    it('基础模板应该注入对话历史', () => {
      const result = template.build({
        context: '文档上下文',
        query: '用户问题',
        conversationContext: '对话历史内容',
      });

      expect(result.userPrompt).toContain('对话历史内容');
    });

    it('应该处理特殊字符', () => {
      const result = template.build({
        context: '文档包含 $符号 和 {大括号}',
        query: '查询$test{变量}',
      });

      // 不应该将用户内容中的 $ 或 {} 解释为变量
      expect(result.userPrompt).toContain('文档包含');
      expect(result.userPrompt).toContain('查询');
    });
  });

  describe('实体文档', () => {
    it('包含实体文档时应该正确注入', () => {
      const result = template.build({
        context: '语义检索文档',
        query: '项目经理是谁',
        entityDocsContent: '实体关联文档全文',
      });

      expect(result.userPrompt).toContain('实体关联文档全文');
      expect(result.userPrompt).toContain('语义检索文档');
      // 实体文档应该在语义检索文档之前
      const entityIdx = result.userPrompt.indexOf('实体关联文档全文');
      const semanticIdx = result.userPrompt.indexOf('语义检索文档');
      expect(entityIdx).toBeLessThan(semanticIdx);
    });
  });

  describe('系统提示词', () => {
    it('系统提示词应该包含所有规则', () => {
      const result = template.build({
        context: '文档',
        query: '问题',
      });

      expect(result.systemPrompt).toContain('基于提供的文档上下文回答');
      expect(result.systemPrompt).toContain('不要编造信息');
      expect(result.systemPrompt).toContain('使用中文回答');
      expect(result.systemPrompt).toContain('对话历史');
    });
  });
});
