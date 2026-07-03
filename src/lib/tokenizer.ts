// ============================================================
// 统一分词模块
// 基于 @node-rs/jieba（结巴分词 Rust 实现）
// 合并默认词典 + 业务自定义词典
// ============================================================

import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict';

// 业务自定义词典（词语 + 词频权重）
const CUSTOM_WORDS = [
  // 技术概念
  '微服务 100', '架构设计 100', '数字孪生 100', '云原生 100',
  '负载均衡 100', '消息队列 100', '注册中心 100', '配置中心 100',
  '分布式 100', '容器 100', '网关 100', '中台 100',
  // 技术组件
  'Docker 100', 'Kubernetes 100', 'Redis 100', 'MySQL 100',
  'Kafka 100', 'Nginx 100', 'Elasticsearch 100', 'Spring 100',
  'Vue 100', 'React 100', 'RabbitMQ 100', 'RocketMQ 100',
  'Jenkins 100', 'GitLab 100', 'MinIO 100', 'MongoDB 100',
  'PostgreSQL 100',
  // 客户企业
  '国家电网 100', '中国移动 100', '中国联通 100', '中国石油 100',
  '中国建筑 100', '中国航天 100', '中国航发 100', '中国船舶 100',
  '中国电科 100', '中国中铁 100', '中国银行 100', '中信证券 100',
  '万科集团 100', '碧桂园 100', '龙湖集团 100', '华润置地 100',
  '华能集团 100', '融创中国 100', '招商银行 100', '国泰君安 100',
  '浦发银行 100', '太平洋保险 100', '宝武钢铁 100', '中钢集团 100',
  '中粮集团 100', '中化集团 100', '南方电网 100',
  // 业务系统
  'ERP 100', 'CRM 100', 'OA 100', 'AI质检 100', '电子签章 100',
  '统一身份认证 100', '风控系统 100', '智能客服 100',
  '数据中台 100', '物联网管理平台 100', '供应链管理平台 100',
  '项目管理系统 100', '人力资源系统 100', '财务共享中心 100',
  '智慧园区平台 100', '移动办公APP 100',
  // 云平台
  '阿里云 100', '腾讯云 100', '华为云 100',
  // 文档类型
  '技术架构设计 100', '技术方案 100', '需求规格说明书 100',
  '项目管理计划 100', '项目进度汇报 100', '项目人员清单 100',
  '项目费用结算 100', '系统测试报告 100', '客户项目验收 100',
  '来往账目 100',
  // 业务术语
  '星辰数智 100', '等保2.0 100', '微服务架构改造 100',
  // 部门
  '技术研发部 100', '产品设计部 100', '项目管理部 100',
  '质量保障部 100', '财务管理部 100', '人力资源部 100',
  '商务拓展部 100',
];

let jiebaInstance: Jieba | null = null;

/**
 * 获取 jieba 分词实例（懒加载 + 单例）
 * 合并默认词典 + 业务自定义词典
 */
export function getJieba(): Jieba {
  if (jiebaInstance) return jiebaInstance;

  const defaultDictStr = Buffer.from(dict).toString('utf-8');
  const customStr = CUSTOM_WORDS.join('\n');
  const mergedDict = Buffer.from(defaultDictStr + '\n' + customStr, 'utf-8');

  jiebaInstance = Jieba.withDict(mergedDict);
  return jiebaInstance;
}

/**
 * 中文分词（去重，供查询侧使用）
 * @param text 待分词文本
 * @returns 分词结果（去重、过滤空串）
 */
export function tokenize(text: string): string[] {
  const jieba = getJieba();
  const result = jieba.cut(text, false);

  // 去重 + 过滤单字和空白
  const tokens = new Set<string>();
  for (const token of result) {
    const trimmed = token.trim();
    if (trimmed.length >= 1) {
      tokens.add(trimmed);
    }
  }

  return [...tokens];
}

/**
 * 中文分词（不去重，保留词频信息，供索引构建侧使用）
 * 用于统计准确的 TF（词频）和文档词数
 * @param text 待分词文本
 * @returns 分词结果（保留顺序、不去重、过滤空串）
 */
export function tokenizeAll(text: string): string[] {
  const jieba = getJieba();
  const result = jieba.cut(text, false);
  const tokens: string[] = [];
  for (const token of result) {
    const trimmed = token.trim();
    if (trimmed.length >= 1) {
      tokens.push(trimmed);
    }
  }
  return tokens;
}

/**
 * 用于重建索引时的批量分词（避免每次调用重建实例）
 */
export function createTokenizer(): (text: string) => string[] {
  const jieba = getJieba();
  return (text: string) => {
    const result = jieba.cut(text, false);
    const tokens = new Set<string>();
    for (const token of result) {
      const trimmed = token.trim();
      if (trimmed.length >= 1) {
        tokens.add(trimmed);
      }
    }
    return [...tokens];
  };
}
