# RAG 평가셋

RAG-B(소비기한) 와 RAG-A(상품명 인식) 의 전/후 정량 비교. 아래는 RAG-B, 맨 끝이 RAG-A.

---

# RAG-B 평가셋 (Step 5~6)

RAG-B(소비기한 참고값 검색) 적용 전/후를 정량 비교하기 위한 평가셋과 하네스.

## 파일

| 파일 | 내용 |
|---|---|
| `scan_items.jsonl` | `scan_logs`의 최근 `mode='receipt' AND status='success'` 30건에서 추출한 **고유 품목 109개** (`name`, `storage`, `category_name`). 정규화 후 결과 기준. |
| `ground_truth.jsonl` | 각 품목의 **정답 소비기한(일)** 초안. `conf`(high/med/low/exclude)와 `note` 포함. **사람이 반드시 검수/수정해야 함** — 현재 값은 식약처 「식품유형별 소비기한 참고값」(2023) + 가정용 통상치로 채운 초안이다. |
| `compare.py` | OLD(RAG-B 이전) vs NEW(현재) 로직을 평가셋에 돌려 MAE·중앙값 절대오차·치명 오류율을 출력. |

## 재현

```bash
# ai 컨테이너는 ./ai:/app 바인드 마운트이므로 파일 복사 불필요
docker exec -w /app smartpantry-ai python3 rag/eval/compare.py
```

`compare.py`는 `pipeline_common`에서 `_MFDS_USE_BY`, `_STORAGE_DEFAULT_DAYS`,
`calculate_use_by`를 import한다. OLD 로직(카테고리 무시 + 키워드 테이블 첫 매칭,
없으면 storage 기본값)은 `compare.py` 안에 `old_calc()`로 재현되어 있다
(git `HEAD:ai/pipeline_common.py`의 `calculate_use_by`와 동일).

## 지표 정의

- **MAE(일)**: `mean(|예측일수 - 정답일수|)`
- **UNDER100**: 정답 ≥ 100일인데 예측 ≤ 10일 (지시서 정의 — 멀쩡한 식품을 폐기하게 만드는 과소예측)
- **UNDER_R**: 예측 < 정답×0.34 이고 (정답-예측) ≥ 30 (완화된 과소예측 기준)
- **OVER_R**: 예측 > 정답×3 이고 (예측-정답) ≥ 30 (**상한 식품을 먹게 만드는 과대예측 — 안전 위험**)

## 안정화 결과 (2026-08-30, ②③④ 적용 후)

| | n | MAE(일) | 중앙값 AE | UNDER100 | UNDER_R | OVER_R |
|---|---|---|---|---|---|---|
| OLD | 105 | 56.1 | 5.0 | 7 (6.7%) | 13 (12.4%) | 1 (1.0%) |
| **NEW** | 105 | **49.5** | **4.0** | **0** | **4 (3.8%)** | 2 (1.9%) |
| OLD (conf=high) | 40 | 49.6 | 0.0 | 2 | 4 | 0 |
| **NEW (conf=high)** | 40 | **39.4** | 0.0 | **0** | **1** | **0** |

- 전체 MAE 56.1→49.5 (−12%), 고신뢰 라벨 49.6→39.4 (−20%). 치명 과소예측(UNDER100) 7→0.
- 적용한 변경:
  - **②** 가공식품도 RAG 미스 시 `_MFDS_SHELF_STABLE`(상온 가공식품 키워드만)을
    폴백으로 탄다 → 참기름·간장·케첩·참치캔·햇반 복구. (신선식품 키워드는 여전히 차단)
  - **③** 색인에서 특수영양식품(대분류 10)·특수의료용도식품(대분류 11) 제외
    (`build_index.py`, 63건). `min_score` 0.35→0.40 (`store.py`).
  - `_MFDS_USE_BY`를 `_MFDS_FRESH` + `_MFDS_SHELF_STABLE`로 분리(신선식품 경로는 동작 불변).
- **남은 오매칭 2건**:
  - `고구마빵`(빵인데 상위 단계에서 스낵·과자로 분류됨) → RAG가 "기타잼"에 0.44로 매칭 → 635일.
    0.40 임계값으로 못 막음(오감자 0.404가 같이 탈락). 스낵·과자 카테고리 MAE 악화는 전부 이 1건 때문.
  - `닭갈비` → storage_default 90일(정답 7). 데이터상 storage=실온인데 냉장 밀키트로 봐야 하는 라벨 품질 문제.

## 한계

- 정답 라벨 1차 검수 완료(두유·비엔나·즉석국 소비기한 상향 등). `conf=high`(40건) 지표를 따로 낸다.
- `scan_logs`에 저장되는 건 정규화 **후** 품목명이라, OCR 원문("오감자"가 "감자"로
  뭉개지기 전) 은 이 평가셋으로 재현할 수 없다 — 그 문제는 RAG-A 평가셋에서 다룬다.
- 109건 중 표본이 1~3건뿐인 카테고리(수산물 1, 곡류·면류 2, 두부·콩류 3)의
  카테고리별 수치는 참고만.

---

# RAG-A 평가셋 (상품명 인식 → 카테고리 안전망)

## 파일
| 파일 | 내용 |
|---|---|
| `receipt_items_all.json` | scan_logs 106개 영수증에서 추출한 고유 (name, category, storage) 449건 |
| `product_eval.jsonl` | 위에 `gold_category` + `conf`(high/med/assumed/garbage) + `rag_should_fire` 라벨 (초안, 사람 검수 필요) |
| `product_compare.py` | baseline(현재 저장 카테고리) vs RAG-A 보정 비교. 임계값 스윕 + 좁은 안전망 규칙 |

## 재현
```bash
python3 ai/rag/build_product_index.py          # 큐레이션 마스터로 역색인 빌드
python3 ai/rag/eval/product_compare.py
```

## 1차 측정 결과 (범용 override — 폐기)
- baseline 카테고리 정확도 = **95.5%** (pass-2 LLM이 이미 잘함)
- 최종 이름에 `lookup_product`를 걸어 카테고리를 덮어쓰는 방식은 **모든 임계값에서 정확도 하락**
  (t=0.80: 0.953→0.929, FIXED 2 / BROKEN 11). 유통바코드 35k의 카테고리가 파이프라인
  관례와 안 맞고(라면→곡류·면류, 버터→스낵 등), n-gram 오매칭도 발생.
- → **범용 카테고리 override 폐기.**

## 채택: 좁은 안전망 규칙
`pass2_normalize`에서 아래 3조건을 모두 만족할 때만 카테고리를 마스터 값으로 교체:
1. 저장 카테고리가 **신선**(채소류/과일류/육류/수산물/유제품·계란/두부·콩류)
2. 손 큐레이션 마스터에 **score ≥ 0.80** 정확 매칭
3. 매칭된 마스터 카테고리가 **가공**(가공·즉석식품/음료·주류/양념·소스/곡류·면류/스낵·과자)

+ 생재료 가드(`is_raw_ingredient`): "감자", "브로콜리 1" 등은 조회 자체를 스킵.

**결과: ACC 0.953 → 0.968 (+0.015), FIXED 5, BROKEN 0, FALSE_FIRE 0.** (라벨 검수 반영)
고친 것: 참치캔·참치캔 135g·참치캔(중)·참치캔 100g·김치 500g (수산물/채소류 → 가공·즉석식품).

## 마스터 데이터
- `ai/rag/data/product_master_curated.jsonl` — 손 큐레이션 506건(5개 가공 카테고리). 사람이 계속 보강.
- `ai/rag/data/barcode_products.jsonl` — 식품안전나라 I2570 유통바코드 35,683건.
  **현재 색인에 미포함**(카테고리 노이즈). `build_product_index.py --with-barcode`로 넣을 수 있으나
  넣기 전 `product_compare.py`로 BROKEN 증가 여부 확인할 것. 2015년 갱신 정지된 DB라 커버리지도 제한적.

## 한계
- "오감자→감자" 붕괴 자체가 현재 데이터에선 관측 안 됨(pass-2 LLM이 이름·카테고리를 대체로 보존).
  RAG-A는 그 붕괴가 재발할 때의 방어 + 가공식품 오분류 소수 케이스 보정용.
- gold 라벨은 1차 검수 완료(OCR 훼손 39건 제외, 순두부찌개·참치1kg 등 수정). 추가 검수 여지는 있음.
- raw pass-1 이름은 저장 안 됨 → LLM 이전 단계 붕괴는 이 평가셋으로 측정 불가.
