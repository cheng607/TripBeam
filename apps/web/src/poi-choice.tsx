import { useState } from 'react';
import type { Poi } from '@tripbeam/contracts';

const VISIBLE_OPTIONS = 6;

export function filterPoiChoices(pois: Poi[], search: string): Poi[] {
  const keyword = search.trim().toLocaleLowerCase();
  return pois.filter((poi) => !keyword || [poi.name, poi.category, poi.place.address].some((value) => value.toLocaleLowerCase().includes(keyword)));
}

export function PoiChoice({ pois, selectedId, onSelect, loading = false, error = false }: { pois: Poi[]; selectedId: string; onSelect: (id: string) => void; loading?: boolean; error?: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = pois.find((poi) => poi.id === selectedId);
  const matches = filterPoiChoices(pois, search);
  const visible = matches.slice(0, VISIBLE_OPTIONS);
  const choose = (id: string) => { onSelect(id); setOpen(false); setSearch(''); };

  return <div className="poi-choice">
    <button type="button" className="poi-choice-trigger" aria-label={selected ? `选择附近候选地点，当前为${selected.name}` : '选择附近候选地点'} aria-expanded={open} aria-controls="poi-choice-list" onClick={() => setOpen((value) => !value)}>
      <span className={selected ? '' : 'poi-choice-placeholder'}>{selected?.name ?? '搜索并选择地点'}</span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
    </button>
    {open && <div className="poi-choice-panel">
      <input aria-label="搜索附近候选地点" autoFocus value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
        if (event.key === 'Enter' && visible[0]) { event.preventDefault(); choose(visible[0].id); }
      }} placeholder="搜索名称、类别或地址" />
      {loading ? <p className="poi-choice-hint">正在加载附近地点…</p> : error ? <p className="poi-choice-hint">候选地点加载失败，请稍后重试。</p> :
        <div id="poi-choice-list" className="poi-choice-list" role="listbox" aria-label="附近候选地点">
          {visible.map((poi) => <button type="button" role="option" aria-selected={poi.id === selectedId} key={poi.id} onClick={() => choose(poi.id)}>
            <strong>{poi.name}</strong><small>{poi.category} · {poi.place.address || '地址待确认'}</small>
          </button>)}
          {matches.length === 0 && <p className="poi-choice-hint">没有匹配的地点，换个关键词试试。</p>}
        </div>}
      {!loading && !error && matches.length > VISIBLE_OPTIONS && <p className="poi-choice-hint">显示前 {VISIBLE_OPTIONS} 个，共 {matches.length} 个；输入关键词查找更多。</p>}
    </div>}
  </div>;
}
