"""chat 领域：query 改写 + RAG 生成（Spec 038 P3）。

子模块：
- types：会话/消息/事件 dataclass
- llm_client：OpenAI 兼容 Chat API（complete + stream），Noop 降级
- prompt_template：system/user 模板 + rewrite 模板
- sessions：进程内会话 Map、追问检测、对话压缩
- query_rewriter：LLM 改写 + 实体提取 + 路由决策，字典匹配 fallback
- entity_docs：实体关联 Raw 文档加载（短文档全文/长文档片段）
- rag_engine：检索→rerank→prompt→流式回答
- chat_service：会话→改写→缓存→实体/语义检索→RAG 全链路编排
"""
