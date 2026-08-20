import React, { useState, useEffect, useRef } from 'react';
import { PlusCircle, Loader2, RefreshCw, RotateCcw, Pencil, X, Check } from 'lucide-react';
import FoodIcon from '../components/FoodIcon';
import { formatPantryQuantity } from '../utils/quantityFormat';

const STORAGE_STYLE = {
  냉장: "bg-blue-100 text-blue-700",
  냉동: "bg-indigo-100 text-indigo-700",
  실온: "bg-amber-100 text-amber-700",
};

const EMOJI_LIST = [
  '🥕','🧅','🧄','🥔','🍠','🥬','🥦','🌽','🍆','🫑',
  '🌶️','🍅','🥒','🍄','🌿','🫘','🌱','🥗','🪴',
  '🍎','🍐','🍌','🍓','🍇','🍉','🍊','🍋','🥭','🥝',
  '🍑','🍒','🍍','🫐','🍈','🥑','🥥',
  '🥩','🍗','🥓','🍖','🦐','🐟','🦑','🦀','🐚','🍢',
  '🥛','🥚','🧀','🧈',
  '🍜','🍝','🥟','🍚','🍡','🥫','🫙','🌾',
  '🍺','🍶','🍷','🥤','🧃','💧','☕','🍵',
  '🍪','🍫','🍬','🍦','🥜','🍿','🛒',
];

const FOOD_CATEGORIES = [
  '채소류', '과일류', '육류', '수산물',
  '유제품·계란', '두부·콩류', '가공·즉석식품',
  '음료·주류', '양념·소스', '곡류·면류', '스낵·과자',
];

const EditModal = ({ item, onClose, onSave }) => {
  const [name,         setName]         = useState(item.name);
  const [useBy,        setUseBy]        = useState(item.use_by);
  const [storage,      setStorage]      = useState(item.storage);
  const [qty,          setQty]          = useState(item.qty);
  const [unit,         setUnit]         = useState(item.unit || null);
  const [emoji,        setEmoji]        = useState(item.emoji);
  const [categoryName, setCategoryName] = useState(item.category_name || null);
  const [showEmoji,    setShowEmoji]    = useState(false);

  const handleSave = () => {
    if (!name.trim()) { alert('식재료 이름을 입력해주세요.'); return; }
    if (!useBy)       { alert('소비기한을 입력해주세요.'); return; }
    if (!unit)        { alert('단위를 선택해주세요.'); return; }
    onSave(item.id, { name: name.trim(), use_by: useBy, storage, qty, unit, emoji, category_name: categoryName });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[430px] bg-white rounded-t-[32px] p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">

        <div className="flex items-center justify-between">
          <h3 className="text-lg font-black text-gray-950">식재료 수정</h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 transition-colors">
            <X size={20} className="text-gray-400" />
          </button>
        </div>

        {/* 이모지 */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-gray-500">이모지</label>
          <button
            onClick={() => setShowEmoji(v => !v)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl border border-gray-200 hover:border-gray-400 transition-colors"
          >
            <span className="text-2xl">{emoji}</span>
            <span className="text-sm font-bold text-gray-500">이모지 변경하기</span>
          </button>
          {showEmoji && (
            <div className="grid grid-cols-10 gap-1 p-3 bg-gray-50 rounded-2xl border border-gray-100 max-h-40 overflow-y-auto">
              {EMOJI_LIST.map(e => (
                <button
                  key={e}
                  onClick={() => { setEmoji(e); setShowEmoji(false); }}
                  className={`text-xl p-1 rounded-lg hover:bg-gray-200 transition-colors ${emoji === e ? 'bg-gray-200 ring-2 ring-gray-400' : ''}`}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 이름 */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-gray-500">식재료 이름</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full px-4 py-3 rounded-2xl border border-gray-200 text-sm font-bold text-gray-900 focus:outline-none focus:border-gray-400"
            placeholder="식재료 이름"
          />
        </div>

        {/* 카테고리 */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-gray-500">식품 카테고리</label>
          <div className="flex flex-wrap gap-2">
            {FOOD_CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setCategoryName(categoryName === cat ? null : cat)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all
                  ${categoryName === cat ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* 소비기한 */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-gray-500">소비기한</label>
          <input
            type="date"
            value={useBy}
            onChange={e => setUseBy(e.target.value)}
            className="w-full px-4 py-3 rounded-2xl border border-gray-200 text-sm font-bold text-gray-900 focus:outline-none focus:border-gray-400"
          />
          <div className="flex gap-2 pt-0.5">
            {[['+ 1주', 0, 7, 0], ['+ 1달', 1, 0, 0], ['+ 1년', 0, 0, 1]].map(([label, m, d, y]) => (
              <button
                key={label} type="button"
                onClick={() => {
                  const dt = useBy ? new Date(useBy + 'T00:00:00') : new Date();
                  dt.setDate(dt.getDate() + d);
                  dt.setMonth(dt.getMonth() + m);
                  dt.setFullYear(dt.getFullYear() + y);
                  setUseBy(dt.toISOString().split('T')[0]);
                }}
                className="flex-1 py-2 bg-gray-100 text-gray-500 rounded-xl text-xs font-bold active:scale-95 transition-all"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 수량 / 무게 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold text-gray-500">수량 / 무게</label>
            <div className="flex gap-1 bg-gray-100 rounded-xl p-0.5">
              {['개', 'g', 'ml'].map(u => (
                <button
                  key={u}
                  onClick={() => setUnit(u)}
                  className={`px-3 py-1 rounded-lg text-xs font-black transition-all ${unit === u ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400'}`}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
          {!unit ? (
            <p className="text-xs font-bold text-amber-600 bg-amber-50 rounded-2xl px-4 py-3">
              ⚠️ 위에서 단위(개/g/ml)를 먼저 선택해주세요
            </p>
          ) : unit === '개' ? (
            <div className="flex items-center gap-3">
              <button onClick={() => setQty(q => Math.max(1, q - 1))} className="w-12 h-12 rounded-2xl border border-gray-200 text-xl font-bold text-gray-600 hover:bg-gray-100 active:scale-95 transition-all">−</button>
              <span className="flex-1 text-center text-lg font-black text-gray-900">{qty}개</span>
              <button onClick={() => setQty(q => q + 1)} className="w-12 h-12 rounded-2xl border border-gray-200 text-xl font-bold text-gray-600 hover:bg-gray-100 active:scale-95 transition-all">+</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                value={qty}
                onChange={e => setQty(Math.max(1, Number(e.target.value) || 1))}
                className="flex-1 px-4 py-3 rounded-2xl border border-gray-200 text-sm font-bold text-gray-900 focus:outline-none focus:border-gray-400 text-center"
              />
              <span className="text-sm font-black text-gray-500 w-8">{unit}</span>
            </div>
          )}
        </div>

        {/* 보관방법 */}
        <div className="space-y-1.5">
          <label className="text-xs font-bold text-gray-500">보관방법</label>
          <div className="flex gap-2">
            {['냉장', '냉동', '실온'].map(s => (
              <button
                key={s}
                onClick={() => setStorage(s)}
                className={`flex-1 py-3 rounded-2xl text-sm font-bold transition-all
                  ${storage === s ? 'bg-gray-950 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={handleSave}
          className="w-full flex items-center justify-center gap-2 py-4 bg-gray-950 text-white rounded-[20px] font-bold text-sm active:scale-95 transition-all"
        >
          <Check size={16} /> 수정 완료
        </button>
      </div>
    </div>
  );
};


const ScanResultPage = ({ capturedImg, onBack, onNavigate, scanMode = 'food' }) => {
  const [status,   setStatus]   = useState('scanning');
  const [items,    setItems]    = useState([]);
  const [source,   setSource]   = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [editItem, setEditItem] = useState(null);
  const isRunning = useRef(false);
  const resultsRef = useRef(null);

  useEffect(() => {
    if (!capturedImg) return;
    runScan();
  }, [capturedImg]);

  useEffect(() => {
    if (status === 'done') {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [status]);

  const runScan = async () => {
    if (isRunning.current) return;
    isRunning.current = true;
    setStatus('scanning'); setItems([]); setErrorMsg('');

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ image: capturedImg, mode: scanMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || '인식 실패');

      setItems(data.items.map((it, idx) => ({
        id:            idx,
        name:          it.name,
        category_name: it.category_name || null,
        emoji:         it.emoji   || '🛒',
        storage:       it.storage || '냉장',
        use_by:        it.use_by,
        qty:           it.qty     || 1,
        unit:          it.unit    || null,
        failed:        false,
      })));
      setSource(data.source);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err.message || '서버 오류');
      setStatus('error');
    } finally {
      isRunning.current = false;
    }
  };

  const handleEditSave = (id, changes) => {
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...changes } : it));
  };

  const markFailed = (id) => setItems(prev => prev.map(it => it.id === id ? { ...it, failed: true  } : it));
  const markOk     = (id) => setItems(prev => prev.map(it => it.id === id ? { ...it, failed: false } : it));

  const handleSave = async () => {
    const ok = items.filter(it => !it.failed);
    if (!ok.length) { alert('저장할 항목이 없습니다.'); return; }
    setStatus('saving');

    try {
      const res = await fetch('/api/add-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(ok.map(it => ({
          item_name:     it.name,
          item_emoji:    it.emoji,
          expiry_date:   it.use_by,
          category:      it.storage,
          category_name: it.category_name || null,
          quantity:      it.qty || 1,
          unit:          it.unit || '개',
        }))),
      });
      const result = await res.json();
      if (result.success) {
        alert(`✅ ${result.count}개 식재료가 저장고에 추가됐어요!`);
        onNavigate ? onNavigate('pantry') : (window.location.href = '/');
      } else throw new Error('저장 실패');
    } catch {
      alert('저장 중 오류가 발생했습니다.');
      setStatus('done');
    }
  };

  const okItems     = items.filter(it => !it.failed);
  const failedItems = items.filter(it =>  it.failed);
  const sourceLabel = source === 'yolo'     ? '📷 식재료 직접 인식'
                    : source === 'food_llm' ? '🤖 AI 식재료 인식'
                    : '🧾 영수증 OCR 인식';
  const modeLabel   = scanMode === 'receipt' ? '🧾 영수증 OCR 인식 중...' : '🥦 식재료 AI 인식 중...';

  return (
    <>
      {editItem && (
        <EditModal
          item={editItem}
          onClose={() => setEditItem(null)}
          onSave={handleEditSave}
        />
      )}

      <div className="p-5 space-y-5 animate-in fade-in duration-500 pb-32">

        <div className="w-full rounded-[36px] overflow-hidden bg-gray-100 border border-gray-200 shadow-inner">
          {capturedImg
            ? <img src={capturedImg} alt="촬영 이미지" className="w-full h-auto object-contain" />
            : <span className="text-gray-400 text-sm font-bold">이미지 없음</span>
          }
        </div>

        {status === 'scanning' && (
          <div className="bg-white rounded-[28px] border border-gray-100 p-8 shadow-sm flex flex-col items-center gap-4">
            <Loader2 size={36} className="text-gray-400 animate-spin" />
            <p className="text-gray-600 font-bold text-sm text-center">
              {modeLabel}<br />
              <span className="text-gray-400 font-normal">최대 1~2분 소요될 수 있어요</span>
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="bg-white rounded-[28px] border border-red-100 p-8 shadow-sm flex flex-col items-center gap-4">
            <p className="text-red-500 font-bold text-sm text-center">{errorMsg}</p>
            <button onClick={runScan} className="flex items-center gap-2 px-6 py-3 bg-gray-950 text-white rounded-2xl font-bold text-sm">
              <RefreshCw size={16} /> 다시 시도
            </button>
            <button onClick={onBack} className="text-gray-400 text-sm font-bold">다시 촬영하기</button>
          </div>
        )}

        {(status === 'done' || status === 'saving') && (
          <div ref={resultsRef} className="bg-white rounded-[28px] border border-gray-100 p-6 shadow-sm space-y-5">
            <div>
              <h2 className="text-xl font-black text-gray-950">
                {items.length > 0 ? `${items.length}개 식재료 인식됨 🎉` : '인식된 식재료가 없어요'}
              </h2>
              <p className="text-xs text-gray-400 mt-1">{sourceLabel}</p>
            </div>

            {okItems.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-black text-gray-400">
                  인식 성공 <span className="text-gray-900">{okItems.length}</span>
                  <span className="text-gray-400 font-normal ml-1">· 탭하면 수정 가능</span>
                </p>
                <ul className="space-y-2">
                  {okItems.map(it => (
                    <li key={it.id} className="flex items-center gap-3 p-4 rounded-2xl border border-gray-100 bg-gray-50">
                      <FoodIcon name={it.name} emoji={it.emoji} size={28} className="text-2xl shrink-0" />
                      <div
                        className="flex-1 min-w-0 cursor-pointer active:opacity-70 transition-opacity"
                        onClick={() => setEditItem(it)}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-bold text-sm text-gray-900 truncate">{it.name}</p>
                          {it.category_name && (
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold border bg-green-50 text-green-600 border-green-200 shrink-0">
                              {it.category_name}
                            </span>
                          )}
                          <Pencil size={11} className="text-gray-300 shrink-0" />
                        </div>
                        {/* 단위 없으면 '개'로 기본값 처리 */}
                        <div className="flex flex-col gap-0.5 mt-0.5">
                          <p className="text-xs text-gray-400 whitespace-nowrap">
                            소비기한 {it.use_by}
                          </p>
                          <p className="text-xs text-gray-500 font-medium">
                            수량 {formatPantryQuantity(it.qty, it.unit || '개')}
                          </p>
                        </div>
                      </div>
                      <span
                        onClick={() => setEditItem(it)}
                        className={`text-xs font-bold px-2 py-1 rounded-lg shrink-0 cursor-pointer ${STORAGE_STYLE[it.storage] || 'bg-gray-100 text-gray-600'}`}
                      >
                        {it.storage}
                      </span>
                      <button
                        onClick={() => markFailed(it.id)}
                        className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-white border border-gray-200 text-xs font-bold text-gray-400 hover:border-red-200 hover:text-red-400 active:scale-95 transition-all"
                      >
                        <X size={11} /> 제외
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {failedItems.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-black text-red-400">제외됨 <span>{failedItems.length}</span></p>
                <ul className="space-y-2">
                  {failedItems.map(it => (
                    <li key={it.id} className="flex items-center gap-3 p-4 rounded-2xl border border-red-100 bg-red-50 opacity-60">
                      <FoodIcon name={it.name} emoji={it.emoji} size={28} className="text-2xl shrink-0 grayscale" />
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm text-gray-400 truncate line-through">{it.name}</p>
                        <p className="text-xs text-gray-300">저장에서 제외됩니다</p>
                      </div>
                      <button onClick={() => markOk(it.id)} className="shrink-0 p-1.5 rounded-xl bg-white border border-gray-200 text-gray-300 hover:text-gray-500 active:scale-95 transition-all">
                        <RotateCcw size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="pt-2 space-y-3">
              {okItems.length > 0 && (
                <button
                  onClick={handleSave}
                  disabled={status === 'saving'}
                  className="w-full flex items-center justify-center gap-2 py-5 bg-gray-950 text-white rounded-[20px] font-bold text-base shadow-lg active:scale-95 transition-all disabled:opacity-60"
                >
                  {status === 'saving'
                    ? <><Loader2 size={18} className="animate-spin" /> 저장 중...</>
                    : <><PlusCircle size={18} /> {okItems.length}개 저장고에 추가</>
                  }
                </button>
              )}
              <button onClick={onBack} className="w-full py-4 text-center text-gray-400 font-bold text-sm hover:text-gray-600 transition-colors">
                다시 촬영하기
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default ScanResultPage;