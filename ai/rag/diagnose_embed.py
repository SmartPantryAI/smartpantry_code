"""
nomic-embed-text가 한국어를 실제로 구분하는지 진단.
서버에서 실행: docker exec smartpantry-ai python3 rag/diagnose_embed.py
"""
import requests

OLLAMA_URL = "https://ollama.aikopo.net"
MODEL = "nomic-embed-text"

texts = [
    "오감자",
    "새우깡",
    "감자",
    "우유",
    "banana",
    "shrimp chips",
    "hello world",
]

vecs = {}
for t in texts:
    r = requests.post(f"{OLLAMA_URL}/api/embeddings",
                      json={"model": MODEL, "prompt": t}, timeout=30)
    v = r.json()["embedding"]
    vecs[t] = v
    print(f"{t:20s} 앞 5개 값: {[round(x,4) for x in v[:5]]}")

print()
print("=== 한국어 단어끼리 완전 동일한지 확인 ===")
print("오감자 == 새우깡 ?", vecs["오감자"] == vecs["새우깡"])
print("오감자 == 감자   ?", vecs["오감자"] == vecs["감자"])
print("오감자 == 우유   ?", vecs["오감자"] == vecs["우유"])
print()
print("=== 영어 단어끼리는 다른지 확인 (대조군) ===")
print("banana == hello world ?", vecs["banana"] == vecs["hello world"])
