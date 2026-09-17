"""llm-wiki Python 后端包（Spec 038）。

模块划分（随 P1-P4 逐步落地）：
- routers/  FastAPI 路由，只能经 rag 门面调用内核
- rag/      RAG 内核：rewrite / retrieve / generate
- kb/       知识库统计与文档列表
- indexing/ 索引构建 CLI（与运行时同语言、同分词器、同 embedding）
"""

__version__ = "0.1.0"
