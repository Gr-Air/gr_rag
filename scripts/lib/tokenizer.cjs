// ============================================================
// jieba 分词工具（CommonJS）
// 统一自定义词典，供 buildIndex / buildIncremental 共用
// ============================================================

const { Jieba } = require('@node-rs/jieba');
const { dict } = require('@node-rs/jieba/dict');

const CUSTOM_WORDS = [
  '微服务 100', '架构设计 100', '数字孪生 100', '云原生 100',
  '负载均衡 100', '消息队列 100', '注册中心 100', '配置中心 100',
  '分布式 100', '容器 100', '网关 100', '中台 100',
  'Docker 100', 'Kubernetes 100', 'Redis 100', 'MySQL 100',
  'Kafka 100', 'Nginx 100', 'Elasticsearch 100', 'Spring 100',
  'Vue 100', 'React 100', 'RabbitMQ 100', 'RocketMQ 100',
  'Jenkins 100', 'GitLab 100', 'MinIO 100', 'MongoDB 100',
  'PostgreSQL 100',
  '国家电网 100', '中国移动 100', '中国联通 100', '中国石油 100',
  '中国建筑 100', '中国航天 100', '中国航发 100', '中国船舶 100',
  '中国电科 100', '中国中铁 100', '中国银行 100', '中信证券 100',
  '万科集团 100', '碧桂园 100', '龙湖集团 100', '华润置地 100',
  '华能集团 100', '融创中国 100', '招商银行 100', '国泰君安 100',
  '浦发银行 100', '太平洋保险 100', '宝武钢铁 100', '中钢集团 100',
  '中粮集团 100', '中化集团 100', '南方电网 100',
  'ERP 100', 'CRM 100', 'OA 100', 'AI质检 100', '电子签章 100',
  '统一身份认证 100', '风控系统 100', '智能客服 100',
  '数据中台 100', '物联网管理平台 100', '供应链管理平台 100',
  '项目管理系统 100', '人力资源系统 100', '财务共享中心 100',
  '智慧园区平台 100', '移动办公APP 100',
  '阿里云 100', '腾讯云 100', '华为云 100',
  '技术架构设计 100', '技术方案 100', '需求规格说明书 100',
  '项目管理计划 100', '项目进度汇报 100', '项目人员清单 100',
  '项目费用结算 100', '系统测试报告 100', '客户项目验收 100',
  '来往账目 100',
  '星辰数智 100', '等保2.0 100', '微服务架构改造 100',
  '技术研发部 100', '产品设计部 100', '项目管理部 100',
  '质量保障部 100', '财务管理部 100', '人力资源部 100',
  '商务拓展部 100',
];

// 单例
let jiebaInstance = null;

/**
 * 获取 jieba 分词器实例（懒加载单例）
 * @returns {Jieba}
 */
function getJieba() {
  if (jiebaInstance) return jiebaInstance;

  const defaultDictStr = dict.toString('utf-8');
  const customStr = CUSTOM_WORDS.join('\n');
  const mergedDict = Buffer.from(defaultDictStr + '\n' + customStr, 'utf-8');
  jiebaInstance = Jieba.withDict(mergedDict);
  return jiebaInstance;
}

/**
 * 对文本进行 jieba 分词（去重，供查询侧使用）
 * @param {string} text
 * @returns {string[]} 去重后的词条列表
 */
function tokenize(text) {
  const jieba = getJieba();
  const result = jieba.cut(text, false);
  const tokens = new Set();
  for (const token of result) {
    const trimmed = token.trim();
    if (trimmed.length >= 1) tokens.add(trimmed);
  }
  return [...tokens];
}

/**
 * 对文本进行 jieba 分词（不去重，保留词频信息，供索引构建侧使用）
 * 用于统计准确的 TF（词频）和文档词数
 * @param {string} text
 * @returns {string[]} 保留顺序的分词结果列表（不去重）
 */
function tokenizeAll(text) {
  const jieba = getJieba();
  const result = jieba.cut(text, false);
  const tokens = [];
  for (const token of result) {
    const trimmed = token.trim();
    if (trimmed.length >= 1) tokens.push(trimmed);
  }
  return tokens;
}

module.exports = {
  tokenize,
  tokenizeAll,
  getJieba,
  CUSTOM_WORDS,
};
