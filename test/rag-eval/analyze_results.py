import json

with open('results/report_20260702_154702.json') as f:
    data = json.load(f)

samples = data['detailed_results']

low_precision = sorted(samples, key=lambda x: x.get('context_precision', 1))[:5]
low_recall = sorted(samples, key=lambda x: x.get('context_recall', 1))[:5]

print('=== Context Precision 最低的 5 条 ===')
for i, s in enumerate(low_precision, 1):
    print(f'\n[{i}] 查询: {s["query"]}')
    print(f'  Precision: {s.get("context_precision")}')
    print(f'  Recall: {s.get("context_recall")}')
    print(f'  上下文数: {len(s.get("contexts", []))}')

print('\n=== Context Recall 最低的 5 条 ===')
for i, s in enumerate(low_recall, 1):
    print(f'\n[{i}] 查询: {s["query"]}')
    print(f'  Recall: {s.get("context_recall")}')
    print(f'  Precision: {s.get("context_precision")}')
    print(f'  上下文数: {len(s.get("contexts", []))}')

print('\n=== 路由命中率统计 ===')
struct_hits = 0
rrf_hits = 0
for s in samples:
    contexts = s.get('contexts', [])
    has_struct = any('struct' in c.lower() or 'entity' in c.lower() or 'wiki_' in c for c in contexts)
    if has_struct:
        struct_hits += 1
    else:
        rrf_hits += 1

print(f'总样本数: {len(samples)}')
print(f'结构化查询命中: {struct_hits} ({struct_hits/len(samples)*100:.1f}%)')
print(f'RRF 语义检索: {rrf_hits} ({rrf_hits/len(samples)*100:.1f}%)')