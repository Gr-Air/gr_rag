from __future__ import annotations

import json
import os
import time
import argparse
from pathlib import Path
from typing import Any
from datetime import datetime

import asyncio
import requests
from datasets import Dataset
from dotenv import load_dotenv
from ragas import evaluate
from ragas.metrics import Faithfulness, AnswerRelevancy, ContextPrecision, ContextRecall, AnswerCorrectness, AspectCritic
from dashscope import TextEmbedding
from ragas.embeddings.base import BaseRagasEmbeddings
from ragas.run_config import RunConfig

# 加载项目根目录的 .env 文件（本脚本在 test/rag-eval/ 下，向上两级到项目根目录）
ENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)
    print(f"已加载 .env: {ENV_PATH}")
else:
    print(f"警告: .env 文件不存在 ({ENV_PATH})，将仅使用命令行参数")


RAG_API_URL = "http://localhost:3000/api/eval"
TEST_SET_PATH = os.path.join(os.path.dirname(__file__), "test_set.json")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "results")

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "qwen-plus"
DEFAULT_EMBEDDING_MODEL = "text-embedding-v4"

# 设置默认环境变量供 langchain-openai 使用
# 这些值会在 main() 中被实际的 API key 覆盖
os.environ.setdefault("OPENAI_API_KEY", "placeholder")
os.environ.setdefault("OPENAI_BASE_URL", DEFAULT_BASE_URL)


def is_table_line(line: str) -> bool:
    trimmed = line.strip()
    return trimmed.startswith('|') and trimmed.endswith('|')


def is_table_block(text: str) -> bool:
    lines = [l for l in text.split('\n') if l.strip()]
    if len(lines) < 2:
        return False
    return all(is_table_line(l) for l in lines)


def has_incomplete_table(chunk_text: str) -> bool:
    lines = [l for l in chunk_text.split('\n') if l.strip()]
    if len(lines) == 0:
        return False
    
    table_blocks = []
    in_table = False
    block_start = 0
    
    for i, line in enumerate(lines):
        is_tbl = is_table_line(line)
        if is_tbl and not in_table:
            in_table = True
            block_start = i
        elif not is_tbl and in_table:
            in_table = False
            table_blocks.append((block_start, i - 1))
    
    if in_table:
        table_blocks.append((block_start, len(lines) - 1))
    
    if not table_blocks:
        return False
    
    for start, end in table_blocks:
        block_lines = lines[start:end + 1]
        if len(block_lines) < 2:
            return True
        has_header_separator = any('---' in l for l in block_lines)
        if not has_header_separator:
            return True
    
    return False


def analyze_table_truncation(test_results: list) -> dict:
    total_chunks = 0
    chunks_with_incomplete_table = 0
    samples_with_truncation = 0
    truncation_samples = []
    
    for result in test_results:
        if result.get("error"):
            continue
        
        contexts = result.get("contexts", [])
        sample_has_truncation = False
        truncated_contexts = []
        
        for ctx in contexts:
            total_chunks += 1
            if has_incomplete_table(ctx):
                chunks_with_incomplete_table += 1
                sample_has_truncation = True
                truncated_contexts.append(ctx[:500] + '...' if len(ctx) > 500 else ctx)
        
        if sample_has_truncation:
            samples_with_truncation += 1
            result["has_truncated_table"] = True
            if len(truncation_samples) < 3:
                truncation_samples.append({
                    "query": result["query"],
                    "contexts": truncated_contexts[:2],
                })
        else:
            result["has_truncated_table"] = False
    
    if truncation_samples:
        print("\n=== 表格截断样本诊断 ===")
        for i, sample in enumerate(truncation_samples, 1):
            print(f"\n[{i}] 查询: {sample['query']}")
            for j, ctx in enumerate(sample["contexts"], 1):
                print(f"  上下文 {j} (前500字符):")
                lines = ctx.split('\n')
                for k, line in enumerate(lines[:10], 1):
                    print(f"    [{k}] {line[:80]}")
    
    return {
        "total_chunks": total_chunks,
        "chunks_with_incomplete_table": chunks_with_incomplete_table,
        "samples_with_truncation": samples_with_truncation,
        "total_samples": len([r for r in test_results if not r.get("error")]),
        "truncation_rate_chunks": chunks_with_incomplete_table / max(total_chunks, 1),
        "truncation_rate_samples": samples_with_truncation / max(len([r for r in test_results if not r.get("error")]), 1),
    }


def load_test_set(path: str) -> list[dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def call_rag_api(query: str, api_key: str | None = None, base_url: str | None = None, model: str | None = None, max_retries: int = 3) -> dict[str, Any]:
    payload = {
        "query": query,
        "topK": 5,
    }
    if api_key:
        payload["apiKey"] = api_key
    if base_url:
        payload["baseURL"] = base_url
    if model:
        payload["model"] = model

    for attempt in range(max_retries):
        try:
            t0 = time.time()
            response = requests.post(RAG_API_URL, json=payload, timeout=300)
            latency_ms = (time.time() - t0) * 1000
            response.raise_for_status()
            result = response.json()
            result["latency_ms"] = latency_ms
            return result
        except requests.exceptions.RequestException as e:
            print(f"API 请求失败 (尝试 {attempt+1}/{max_retries}): {e}")
            if attempt < max_retries - 1:
                time.sleep(2)

    return {
        "query": query,
        "answer": "",
        "contexts": [],
        "sources": [],
        "searchMethod": "error",
        "numResults": 0,
        "matchedEntities": [],
        "error": f"API 请求失败，已重试 {max_retries} 次",
        "latency_ms": 0,
    }


def compute_latency_stats(latencies: list[float]) -> dict[str, float]:
    """计算延迟统计：P50 / P95 / P99 / Max / Avg"""
    if not latencies:
        return {}
    sorted_lat = sorted(latencies)
    n = len(sorted_lat)
    return {
        "avg_ms": sum(sorted_lat) / n,
        "p50_ms": sorted_lat[int(n * 0.5)],
        "p95_ms": sorted_lat[min(int(n * 0.95), n - 1)],
        "p99_ms": sorted_lat[min(int(n * 0.99), n - 1)],
        "max_ms": sorted_lat[-1],
        "min_ms": sorted_lat[0],
    }


def build_ragas_dataset(test_results: list[dict[str, Any]]) -> Dataset:
    questions = []
    answers = []
    contexts = []
    ground_truths = []

    for result in test_results:
        if result.get("error") or not result.get("answer"):
            continue
        questions.append(result["query"])
        answers.append(result["answer"])
        contexts.append(result["contexts"])
        ground_truths.append(result["ground_truth"])

    return Dataset.from_dict({
        "question": questions,
        "answer": answers,
        "contexts": contexts,
        "ground_truth": ground_truths,
    })


class DashScopeEmbeddings(BaseRagasEmbeddings):
    def __init__(self, api_key: str, model: str = DEFAULT_EMBEDDING_MODEL):
        self.api_key = api_key
        self.model = model
        self.dimensions = 1024
        self.run_config = RunConfig()

    def set_run_config(self, run_config: RunConfig):
        self.run_config = run_config

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        embeddings = []
        for text in texts:
            response = TextEmbedding.call(
                model=self.model,
                input=text,
                api_key=self.api_key,
                text_type="document",
            )
            embeddings.append(response.output['embeddings'][0]['embedding'])
        return embeddings

    def embed_query(self, text: str) -> list[float]:
        response = TextEmbedding.call(
            model=self.model,
            input=text,
            api_key=self.api_key,
            text_type="query",
        )
        return response.output['embeddings'][0]['embedding']

    async def embed_text(self, text: str, is_async: bool = True) -> list[float]:
        """RAGAS 使用的 embed_text 方法"""
        return self.embed_query(text)

    async def embed_texts(self, texts: list[str], is_async: bool = True) -> list[list[float]]:
        """RAGAS 使用的 embed_texts 方法"""
        return self.embed_documents(texts)

    async def aembed_documents(self, texts: list[str]) -> list[list[float]]:
        return self.embed_documents(texts)

    async def aembed_query(self, text: str) -> list[float]:
        return self.embed_query(text)


def evaluate_with_ragas(dataset: Dataset, openai_api_key: str, openai_base_url: str | None = None, model_name: str | None = None, dashscope_api_key: str | None = None):
    if len(dataset) == 0:
        print("警告: 没有有效数据进行评估")
        return {}, {}

    # 设置环境变量供 langchain-openai 使用
    os.environ["OPENAI_API_KEY"] = openai_api_key
    os.environ["OPENAI_API_BASE"] = openai_base_url or DEFAULT_BASE_URL

    # ragas 0.2.8 的 llm_factory 不传 openai_api_key，需要手动创建 ChatOpenAI
    from langchain_openai import ChatOpenAI
    from ragas.llms.base import LangchainLLMWrapper

    openai_model = ChatOpenAI(
        model=model_name or DEFAULT_MODEL,
        base_url=openai_base_url or DEFAULT_BASE_URL,
        timeout=60,
    )
    eval_llm = LangchainLLMWrapper(openai_model)
    embeddings = DashScopeEmbeddings(dashscope_api_key or openai_api_key, DEFAULT_EMBEDDING_MODEL)

    # ---- 预检：测试 LLM 连接 ----
    print("\n预检 LLM 连接...")
    try:
        test_response = openai_model.invoke("Hello, respond with just 'OK'.")
        print(f"  LLM 连接正常: {test_response.content[:100]}")
    except Exception as e:
        print(f"  ❌ LLM 连接失败: {e}")
        print("  请检查 API Key 和 Base URL 是否正确")
        print(f"  当前 Base URL: {openai_base_url or DEFAULT_BASE_URL}")
        print(f"  当前 Model: {model_name or DEFAULT_MODEL}")
        print("  跳过 RAGAS 评估，LLM 不可用")
        return {}, {}
    # ---- 预检结束 ----

    results = {}
    detailed_results = {}

    try:
        print("\n[1/4] 评估 Faithfulness...")
        fa = Faithfulness(llm=eval_llm)
        fa_result = evaluate(dataset, metrics=[fa])
        fa_df = fa_result.to_pandas()
        results["faithfulness"] = float(fa_df["faithfulness"].mean())
        detailed_results["faithfulness"] = fa_df["faithfulness"].tolist()
        print(f"  Faithfulness: {results['faithfulness']:.4f}")
    except Exception as e:
        print(f"  Faithfulness 评估失败: {e}")
        results["faithfulness"] = float('nan')

    try:
        print("\n[2/4] 评估 Context Recall...")
        cr = ContextRecall(llm=eval_llm)
        cr_result = evaluate(dataset, metrics=[cr])
        cr_df = cr_result.to_pandas()
        results["context_recall"] = float(cr_df["context_recall"].mean())
        detailed_results["context_recall"] = cr_df["context_recall"].tolist()
        print(f"  Context Recall: {results['context_recall']:.4f}")
    except Exception as e:
        print(f"  Context Recall 评估失败: {e}")
        results["context_recall"] = float('nan')

    try:
        print("\n[3/4] 评估 Context Precision...")
        cp = ContextPrecision(llm=eval_llm)
        cp_result = evaluate(dataset, metrics=[cp])
        cp_df = cp_result.to_pandas()
        results["context_precision"] = float(cp_df["context_precision"].mean())
        detailed_results["context_precision"] = cp_df["context_precision"].tolist()
        print(f"  Context Precision: {results['context_precision']:.4f}")
    except Exception as e:
        print(f"  Context Precision 评估失败: {e}")
        results["context_precision"] = float('nan')

    try:
        print("\n[4/4] 评估 Answer Relevancy...")
        ar = AnswerRelevancy(llm=eval_llm, embeddings=embeddings)
        ar_result = evaluate(dataset, metrics=[ar])
        ar_df = ar_result.to_pandas()
        results["answer_relevancy"] = float(ar_df["answer_relevancy"].mean())
        detailed_results["answer_relevancy"] = ar_df["answer_relevancy"].tolist()
        print(f"  Answer Relevancy: {results['answer_relevancy']:.4f}")
    except Exception as e:
        print(f"  Answer Relevancy 评估失败: {e}")
        results["answer_relevancy"] = float('nan')

    try:
        print("\n[5/6] 评估 Answer Correctness...")
        ac = AnswerCorrectness(llm=eval_llm, embeddings=embeddings)
        ac_result = evaluate(dataset, metrics=[ac])
        ac_df = ac_result.to_pandas()
        results["answer_correctness"] = float(ac_df["answer_correctness"].mean())
        detailed_results["answer_correctness"] = ac_df["answer_correctness"].tolist()
        print(f"  Answer Correctness: {results['answer_correctness']:.4f}")
    except Exception as e:
        print(f"  Answer Correctness 评估失败: {e}")
        results["answer_correctness"] = float('nan')

    try:
        print("\n[6/6] 评估 AspectCritic（简洁性 + 引用来源）...")
        conciseness = AspectCritic(
            name="conciseness",
            definition="answer is concise and to the point, without unnecessary verbosity or repetition",
            llm=eval_llm,
        )
        citation = AspectCritic(
            name="source_citation",
            definition="answer provides specific source references (document titles, project names) when making claims",
            llm=eval_llm,
        )
        conc_result = evaluate(dataset, metrics=[conciseness])
        conc_df = conc_result.to_pandas()
        results["conciseness"] = float(conc_df["conciseness"].mean())
        detailed_results["conciseness"] = conc_df["conciseness"].tolist()

        cit_result = evaluate(dataset, metrics=[citation])
        cit_df = cit_result.to_pandas()
        results["source_citation"] = float(cit_df["source_citation"].mean())
        detailed_results["source_citation"] = cit_df["source_citation"].tolist()
        print(f"  Conciseness: {results['conciseness']:.4f}")
        print(f"  Source Citation: {results['source_citation']:.4f}")
    except Exception as e:
        print(f"  AspectCritic 评估失败: {e}")
        results["conciseness"] = float('nan')
        results["source_citation"] = float('nan')

    return results, detailed_results


def generate_report(results: dict[str, float], detailed_results: dict[str, list], test_results: list[dict[str, Any]], duration: float, table_truncation: dict | None = None, latency_stats: dict | None = None):
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_path = os.path.join(OUTPUT_DIR, f"report_{timestamp}.json")
    summary_path = os.path.join(OUTPUT_DIR, f"summary_{timestamp}.md")

    valid_results = [r for r in test_results if not r.get("error") and r.get("answer")]
    invalid_results = [r for r in test_results if r.get("error") or not r.get("answer")]

    for i, r in enumerate(valid_results):
        for metric, values in detailed_results.items():
            if i < len(values):
                r[metric] = values[i]

    report = {
        "timestamp": datetime.now().isoformat(),
        "duration_seconds": duration,
        "total_samples": len(test_results),
        "valid_samples": len(valid_results),
        "invalid_samples": len(invalid_results),
        "metrics": results,
        "latency_stats": latency_stats,
        "table_truncation": table_truncation,
        "detailed_results": test_results,
    }

    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(f"# RAG 评估报告\n\n")
        f.write(f"**生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"**总样本数**: {len(test_results)}\n")
        f.write(f"**有效样本数**: {len(valid_results)}\n")
        f.write(f"**失败样本数**: {len(invalid_results)}\n")
        f.write(f"**耗时**: {duration:.2f} 秒\n\n")

        f.write("## 评估指标\n\n")
        f.write("| 指标 | 分数 | 说明 |\n")
        f.write("|------|------|------|\n")
        
        metrics_desc = {
            "faithfulness": "回答忠实于上下文的程度",
            "context_recall": "上下文包含真实答案的程度",
            "context_precision": "上下文的精确性",
            "answer_relevancy": "回答与问题的相关性",
            "answer_correctness": "回答的事实正确性（结合忠实度与语义相似度）",
            "conciseness": "回答是否简洁精炼，无冗余重复",
            "source_citation": "回答是否提供具体的文档来源引用",
        }
        
        for metric, desc in metrics_desc.items():
            score = results.get(metric, float('nan'))
            if score != score:
                f.write(f"| {metric} | nan | {desc} |\n")
            else:
                f.write(f"| {metric} | {score:.4f} | {desc} |\n")
        f.write("\n")

        f.write("## 延迟统计\n\n")
        if latency_stats:
            f.write("| 指标 | 值 (ms) |\n")
            f.write("|------|--------|\n")
            f.write(f"| Avg | {latency_stats['avg_ms']:.0f} |\n")
            f.write(f"| P50 | {latency_stats['p50_ms']:.0f} |\n")
            f.write(f"| P95 | {latency_stats['p95_ms']:.0f} |\n")
            f.write(f"| P99 | {latency_stats['p99_ms']:.0f} |\n")
            f.write(f"| Max | {latency_stats['max_ms']:.0f} |\n")
            f.write(f"| Min | {latency_stats['min_ms']:.0f} |\n")
        else:
            f.write("无延迟数据\n")
        f.write("\n")

        f.write("## 表格截断分析\n\n")
        if table_truncation:
            f.write(f"- **总 Chunk 数**: {table_truncation['total_chunks']}\n")
            f.write(f"- **包含不完整表格的 Chunk 数**: {table_truncation['chunks_with_incomplete_table']}\n")
            f.write(f"- **Chunk 级表格截断率**: {table_truncation['truncation_rate_chunks']:.2%}\n")
            f.write(f"- **样本级表格截断率**: {table_truncation['truncation_rate_samples']:.2%}\n")
            
            if table_truncation["truncation_rate_chunks"] > 0:
                f.write("\n**建议**: 表格截断率较高，建议检查 chunker 配置（如 MAX_CHUNK_SIZE）或优化表格切分逻辑。\n")
            else:
                f.write("\n**状态**: ✅ 未发现表格被切断的情况\n")
        else:
            f.write("未执行表格截断分析\n")
        f.write("\n")

        f.write("## 详细结果\n\n")
        for i, result in enumerate(test_results, 1):
            f.write(f"### {i}. {result['query']}\n\n")
            f.write(f"- **标准答案**: {result['ground_truth']}\n")
            f.write(f"- **RAG回答**: {result.get('answer', '')}\n")
            f.write(f"- **检索方法**: {result.get('searchMethod', 'unknown')}\n")
            f.write(f"- **检索结果数**: {result.get('numResults', 0)}\n")
            f.write(f"- **命中实体**: {', '.join(result.get('matchedEntities', [])) or '无'}\n")
            f.write(f"- **来源**: {', '.join(result.get('sources', []))}\n")
            if result.get("has_truncated_table"):
                f.write(f"- **⚠️ 表格截断**: 检索到的上下文中包含被切断的表格\n")
            
            if result.get("error"):
                f.write(f"- **错误**: {result['error']}\n")
            else:
                for metric in ["faithfulness", "context_recall", "context_precision", "answer_relevancy", "answer_correctness", "conciseness", "source_citation"]:
                    if metric in result:
                        val = result[metric]
                        if val == val:
                            f.write(f"- **{metric}**: {val:.4f}\n")
            f.write("\n")

    print(f"\n报告已保存到: {report_path}")
    print(f"摘要已保存到: {summary_path}")


def main():
    parser = argparse.ArgumentParser(description="RAG 离线批量评估脚本")
    parser.add_argument("--api-key", default=os.getenv("OPENAI_API_KEY"), help="LLM API Key (默认从 .env 的 OPENAI_API_KEY 读取)")
    parser.add_argument("--base-url", default=os.getenv("OPENAI_BASE_URL", DEFAULT_BASE_URL), help=f"LLM Base URL (默认: {os.getenv('OPENAI_BASE_URL', DEFAULT_BASE_URL)})")
    parser.add_argument("--model", default=os.getenv("LLM_MODEL", DEFAULT_MODEL), help=f"LLM 模型名称 (默认: {os.getenv('LLM_MODEL', DEFAULT_MODEL)})")
    parser.add_argument("--test-set", default=TEST_SET_PATH, help="测试集路径")
    parser.add_argument("--dashscope-api-key", default=os.getenv("DASHSCOPE_API_KEY"), help="DashScope API Key (默认从 .env 的 DASHSCOPE_API_KEY 读取)")
    args = parser.parse_args()

    if not args.api_key:
        parser.error("--api-key 未提供且 .env 中未设置 OPENAI_API_KEY")

    print("=" * 60)
    print("RAG 离线批量评估")
    print("=" * 60)
    print(f"模型: {args.model}")
    print(f"Base URL: {args.base_url}")

    print(f"\n加载测试集: {args.test_set}")
    test_set = load_test_set(args.test_set)
    print(f"测试样本数: {len(test_set)}")

    print(f"\n开始调用 RAG API...")
    test_results = []
    start_time = time.time()

    for i, sample in enumerate(test_set, 1):
        print(f"\r[{i}/{len(test_set)}] 处理: {sample['query'][:30]}...", end="", flush=True)

        api_result = call_rag_api(
            sample["query"],
            api_key=args.api_key,
            base_url=args.base_url,
            model=args.model,
        )

        test_results.append({
            "id": sample["id"],
            "query": sample["query"],
            "ground_truth": sample["ground_truth"],
            "expected_docs": sample["expected_docs"],
            **api_result,
        })

        if i <= 5:
            print(f"\n  检索方法: {api_result.get('searchMethod', 'unknown')}")
            print(f"  命中实体: {api_result.get('matchedEntities', [])}")
            print(f"  延迟: {api_result.get('latency_ms', 0):.0f}ms")

        time.sleep(1)

    duration = time.time() - start_time
    print(f"\n\nRAG API 调用完成，耗时: {duration:.2f} 秒")

    valid_count = sum(1 for r in test_results if not r.get("error") and r.get("answer"))
    print(f"有效样本数: {valid_count}/{len(test_results)}")

    # 延迟统计
    latencies = [r.get("latency_ms", 0) for r in test_results if not r.get("error") and r.get("latency_ms", 0) > 0]
    latency_stats = compute_latency_stats(latencies) if latencies else {}
    if latency_stats:
        print(f"\n延迟统计 (ms):")
        print(f"  Avg: {latency_stats['avg_ms']:.0f}")
        print(f"  P50: {latency_stats['p50_ms']:.0f}")
        print(f"  P95: {latency_stats['p95_ms']:.0f}")
        print(f"  P99: {latency_stats['p99_ms']:.0f}")
        print(f"  Max: {latency_stats['max_ms']:.0f}")

    print("\n构建 RAGAS 数据集...")
    dataset = build_ragas_dataset(test_results)
    print(f"数据集大小: {len(dataset)}")

    ragas_results = {}
    detailed_results = {}
    
    if len(dataset) > 0:
        print("\n运行 RAGAS 评估...")
        ragas_results, detailed_results = evaluate_with_ragas(
            dataset, 
            args.api_key, 
            openai_base_url=args.base_url,
            model_name=args.model,
            dashscope_api_key=args.dashscope_api_key,
        )
    else:
        print("没有有效数据，跳过 RAGAS 评估")

    print("\n" + "=" * 60)
    print("评估结果汇总")
    print("=" * 60)
    for metric, score in ragas_results.items():
        if score != score:
            print(f"{metric}: nan")
        else:
            print(f"{metric}: {score:.4f}")

    print("\n分析表格截断情况...")
    table_truncation = analyze_table_truncation(test_results)
    print(f"  总 Chunk 数: {table_truncation['total_chunks']}")
    print(f"  包含不完整表格的 Chunk 数: {table_truncation['chunks_with_incomplete_table']}")
    print(f"  Chunk 级表格截断率: {table_truncation['truncation_rate_chunks']:.2%}")
    print(f"  样本级表格截断率: {table_truncation['truncation_rate_samples']:.2%}")

    print("\n生成评估报告...")
    generate_report(ragas_results, detailed_results, test_results, duration, table_truncation, latency_stats)


if __name__ == "__main__":
    main()