"""组装根（移植自 src/composition/container.ts，Spec 038）。

唯一实例化具体引擎/适配器的位置：
引擎 → Retriever/Fusion → hybridSearch → entitySearch / smartRewriter / ragChat / chatService。
懒加载单例，首次请求时组装，避免模块导入副作用。
"""

from __future__ import annotations

from ..config import get_settings
from ..indexing.manifest import check_stores_ready, read_manifest
from .chat.chat_service import ChatService, create_chat_service
from .chat.document_store import FsDocumentFileStore
from .chat.llm_client import LlmClientConfig, create_llm_client
from .chat.query_rewriter import create_smart_rewriter
from .chat.rag_engine import create_rag_chat_stream
from .eval.eval_service import EvalService, create_eval_service
from .retrieve import cache as cache_mod
from .retrieve.engines import embedding as embedding_mod
from .retrieve.engines.bm25_tantivy import get_tantivy_bm25_engine
from .retrieve.engines.chunk_store import get_chunk_store
from .retrieve.engines.struct_engine import get_struct_engine
from .retrieve.engines.vector_engine import VectorEngine
from .retrieve.entity_search import EntitySearch, EntitySearchDeps, create_entity_search
from .retrieve.fusion import RRFFusion
from .retrieve.hybrid_search import HybridSearchDeps, create_hybrid_search
from .retrieve.rerankers import get_reranker
from .retrieve.retrievers import BM25Retriever, StructRetriever, VectorRetriever

_container: dict | None = None


def _build() -> dict:
    settings = get_settings()

    # ---- Infrastructure ----
    chunk_store = get_chunk_store()
    vector_engine = VectorEngine()
    bm25_engine = get_tantivy_bm25_engine()
    struct_engine = get_struct_engine()

    retrievers = [VectorRetriever(vector_engine), BM25Retriever(bm25_engine)]
    struct_retriever = StructRetriever(struct_engine)
    fusion = RRFFusion(chunk_store)

    default_llm = create_llm_client(
        LlmClientConfig(
            api_key=settings.effective_api_key,
            base_url=settings.effective_base_url or None,
            model=settings.llm_model,
            supports_temperature=settings.llm_supports_temperature,
        )
    )
    file_store = FsDocumentFileStore()

    # ---- Use cases ----
    hybrid_search = create_hybrid_search(
        HybridSearchDeps(
            chunk_store=chunk_store,
            retrievers=retrievers,
            fusion=fusion,
            struct_retriever=struct_retriever,
        )
    )

    entity_search = create_entity_search(
        EntitySearchDeps(
            chunk_store=chunk_store,
            struct_query=struct_engine,
            entity_repo=struct_engine,
            hybrid_search=hybrid_search,
        )
    )

    smart_rewriter = create_smart_rewriter(
        {"llm": default_llm, "entity_repo": struct_engine}
    )

    rag_chat_stream = create_rag_chat_stream(
        {
            "llm": default_llm,
            "reranker_factory": get_reranker,
            "hybrid_search": hybrid_search,
        }
    )

    chat_service = create_chat_service(
        {
            "llm": default_llm,
            "embed_query": embedding_mod.get_query_embedding,
            "prewarm_query": embedding_mod.prewarm_query_embedding,
            "cache_lookup": cache_mod.lookup,
            "cache_save": cache_mod.save,
            "chunk_store": chunk_store,
            "entity_search": entity_search,
            "hybrid_search": hybrid_search,
            "smart_rewriter": smart_rewriter,
            "rag_chat_stream": rag_chat_stream,
        }
    )

    eval_service = create_eval_service(
        {
            "llm": default_llm,
            "chunk_store": chunk_store,
            "struct_query": struct_engine,
            "entity_repo": struct_engine,
            "file_store": file_store,
            "hybrid_search": hybrid_search,
            "smart_rewriter": smart_rewriter,
            "rag_chat_stream": rag_chat_stream,
        }
    )

    return {
        "entity_search": entity_search,
        "chat_service": chat_service,
        "eval_service": eval_service,
    }


def _get_container() -> dict:
    global _container
    if _container is None:
        _container = _build()
    return _container


def get_entity_search() -> EntitySearch:
    return _get_container()["entity_search"]


def get_chat_service() -> ChatService:
    return _get_container()["chat_service"]


def get_eval_service() -> EvalService:
    return _get_container()["eval_service"]


def create_request_llm(
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
):
    """Presentation 层按请求配置创建 LlmClient（无 key → NoopLlmClient）。"""
    settings = get_settings()
    return create_llm_client(
        LlmClientConfig(
            api_key=api_key or settings.effective_api_key,
            base_url=base_url or settings.effective_base_url or None,
            model=model or settings.llm_model,
            supports_temperature=settings.llm_supports_temperature,
        )
    )


def _reset_for_test() -> None:
    """测试用：重置组装单例。"""
    global _container
    _container = None


# ============================================================
# 索引就绪判定（移植自 indexManager.ts）
# ============================================================


def is_index_ready() -> bool:
    data_dir = get_settings().data_dir
    manifest = read_manifest(data_dir)
    if manifest is None:
        # 降级：旧版文件存在性检查（兼容尚未重新构建索引的本地环境）
        return (data_dir / "lancedb").exists() and (data_dir / "tantivy_bm25").exists()
    return check_stores_ready(data_dir)


def is_struct_db_ready() -> bool:
    return (get_settings().data_dir / "struct_kb.db").exists()
