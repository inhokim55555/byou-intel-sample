import React, { useEffect, useState } from 'react';
import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

const price = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(value);
const time = value => value ? new Intl.DateTimeFormat('en-US', { timeZone:'America/Los_Angeles', dateStyle:'medium', timeStyle:'short' }).format(new Date(value)) + ' PT' : '—';
function exportRows(filename, rows) {
  const fields = ['itemId','warehouseNo','title','price','status','sourceDate','observedAt','releaseId','evidenceHash'];
  const cell = value => '"' + String(value ?? '').replace(/^([\s]*[=+@-])/, "'$1").replace(/"/g, '""') + '"';
  const blob = new Blob(['\uFEFF' + [fields.join(','), ...rows.map(r => fields.map(f => cell(r[f])).join(','))].join('\r\n')], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

export default function WarehouseCompetitors({ warehouseNo, productKey = '', copy }) {
  const [state, setState] = useState({ key:'', status:'loading', data:null });
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState('');
  const [days, setDays] = useState('90');
  const [detail, setDetail] = useState({ key:'', status:'loading', data:null });
  const params = new URLSearchParams({ warehouseNo:warehouseNo || '', pids:productKey });
  const url = `/api/competitors?${params}`;
  const detailUrl = `${url}&itemId=${encodeURIComponent(selected)}&days=${days}`;
  useEffect(() => {
    if (!warehouseNo) return;
    const controller = new AbortController();
    setState(s => s.key === url && s.status === 'ready' ? s : { key:url, status:'loading', data:null });
    fetch(url, { signal:controller.signal, credentials:'same-origin', cache:'no-store' }).then(async r => {
      const data = await r.json();
      if (!r.ok || data.schema !== 'byou-warehouse-competitors-v1' || data.warehouseNo !== warehouseNo) throw new Error('Invalid response');
      if (!controller.signal.aborted) setState({ key:url, status:'ready', data });
    }).catch(e => { if (e.name !== 'AbortError' && !controller.signal.aborted) setState({ key:url, status:'error', data:null }); });
    return () => controller.abort();
  }, [url, warehouseNo, revision]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) setRevision(v => v + 1); };
    const timer = setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setDetail(s => s.key === detailUrl && s.status === 'ready' ? s : { key:detailUrl, status:'loading', data:null });
    fetch(detailUrl, { signal:controller.signal, credentials:'same-origin', cache:'no-store' }).then(async r => {
      const data = await r.json();
      if (!r.ok || data.schema !== 'byou-warehouse-competitors-v1' || data.warehouseNo !== warehouseNo) throw new Error('Invalid response');
      if (!controller.signal.aborted) setDetail({ key:detailUrl, status:'ready', data:data.rows[0] || null });
    }).catch(e => { if (e.name !== 'AbortError' && !controller.signal.aborted) setDetail({ key:detailUrl, status:'error', data:null }); });
    return () => controller.abort();
  }, [detailUrl, selected, revision, warehouseNo]);
  const data = state.key === url ? state.data : null;
  const ready = state.key === url && state.status === 'ready';
  const item = detail.key === detailUrl && detail.status === 'ready' ? detail.data : null;
  const history = item?.history || [];
  const stockLabel = value => ({ in_stock:copy('In Stock','재고 있음'), low_stock:copy('Low Stock','재고 부족'), out_of_stock:copy('Out of Stock','품절'), unknown:copy('Unknown','미확인') })[value] || value;
  return <section className="bi-warehouse-profile-section">
    <h3>{copy('Competitors','경쟁 제품')}</h3>
    {!warehouseNo ? <p>{copy('An exact warehouse number is required.','정확한 웨어하우스 번호가 필요합니다.')}</p> : state.key === url && state.status === 'error' ? <div role="alert"><p>{copy('Competitor information could not be loaded.','경쟁 제품 정보를 불러올 수 없습니다.')}</p><button className="bi-warehouse-action" onClick={() => setRevision(v => v + 1)}>{copy('Retry','다시 시도')}</button></div> : !ready ? <p role="status">{copy('Loading competitor observations…','경쟁 제품 관측 정보를 불러오는 중…')}</p> : <>
      {!data.releaseId ? <p>{copy('No competitor research has been synced yet.','아직 동기화된 경쟁 제품 조사가 없습니다.')}</p> : !data.rows.length ? <p>{copy('No tracked competitors currently meet the In Stock display criteria. This does not establish an absence of competition.','현재 재고 있음 표시 조건을 충족하는 추적 경쟁 제품이 없습니다. 경쟁이 없다는 의미는 아닙니다.')}</p> : <div className="bi-warehouse-profile-table-wrap"><table className="bi-warehouse-profile-table">
        <thead><tr><th>{copy('Product / item','제품 / 품목')}</th><th>{copy('Local price','현지 가격')}</th><th>{copy('Change','변동')}</th><th>{copy('Availability','재고 상태')}</th><th>{copy('Source date','원본 날짜')}</th></tr></thead>
        <tbody>{data.rows.map(row => <tr key={row.itemId}><td><button className="bi-warehouse-action" aria-expanded={selected === row.itemId} onClick={() => setSelected(selected === row.itemId ? '' : row.itemId)}>{row.title}</button><div>#{row.itemId}</div></td><td>{price(row.price)}</td><td>{row.priceChange === null ? '—' : <>{price(row.priceChange)}<div>{row.previousDate}</div></>}</td><td>{stockLabel(row.status)}</td><td>{row.sourceDate}</td></tr>)}</tbody>
      </table></div>}
    </>}
    {ready && selected && data.rows.some(r => r.itemId === selected) && <div>
      <h4>{copy('Observed price and availability history','관측된 가격 및 재고 이력')}</h4>
      <label>{copy('History window','이력 기간')} <select value={days} onChange={e => setDays(e.target.value)}><option value="30">{copy('30 days','30일')}</option><option value="90">{copy('90 days','90일')}</option><option value="0">{copy('All observed history','전체 관측 이력')}</option></select></label>
      {detail.status === 'error' ? <div role="alert"><p>{copy('History could not be loaded.','이력을 불러올 수 없습니다.')}</p><button className="bi-warehouse-action" onClick={() => setRevision(v => v + 1)}>{copy('Retry','다시 시도')}</button></div> : !item ? <p role="status">{copy('Loading history or checking eligibility…','이력 및 표시 자격 확인 중…')}</p> : <>
        <p>{item.title} · <a href={item.url} target="_blank" rel="noreferrer">Warehouse Runner</a></p>
        <p>{copy('Related BYOU products (provisional):','관련 BYOU 제품 (잠정):')} {item.productIds.join(', ')}</p>
        {item.warnings?.includes('headline_table_stock_conflict') && <p>{copy('The source headline and warehouse table disagree on stock totals. This profile uses the exact warehouse row.','원본 요약과 웨어하우스 표의 재고 합계가 다릅니다. 이 프로필은 해당 웨어하우스 행을 사용합니다.')}</p>}
        <p>{copy('Dots are reported prices, not continuous daily availability. Earlier Low Stock and Out of Stock observations remain in history.','점은 보고된 가격이며 매일 연속된 재고를 의미하지 않습니다. 이전 재고 부족 및 품절 관측은 이력에 보존됩니다.')}</p>
        {history.some(r => r.price !== null && r.sourceDate) && <div style={{ width:'100%', height:180 }} role="img" aria-label={copy('Observed warehouse prices; exact values are in the table below.','관측 웨어하우스 가격. 정확한 값은 아래 표에 있습니다.')}><ResponsiveContainer><ScatterChart margin={{ top:10, right:15, bottom:10, left:5 }}><CartesianGrid strokeDasharray="3 3"/><XAxis type="number" dataKey="date" domain={['dataMin','dataMax']} tickFormatter={v => new Date(v).toISOString().slice(5,10)}/><YAxis type="number" dataKey="price" tickFormatter={v => `$${v}`}/><Tooltip labelFormatter={v => String(v)} formatter={(v,n) => n === 'date' ? [new Date(v).toISOString().slice(0,10), copy('Source date','원본 날짜')] : [price(v), copy('Price','가격')]}/><Scatter fill="#718cff" data={history.filter(r => r.price !== null && r.sourceDate).map(r => ({ date:Date.parse(r.sourceDate), price:r.price }))}/></ScatterChart></ResponsiveContainer></div>}
        <button className="bi-warehouse-action" onClick={() => exportRows(`warehouse-${warehouseNo}-item-${selected}-history.csv`, history.map(r => ({ ...r, title:item.title })))}>{copy('Export history','이력 내보내기')}</button>
        <div className="bi-warehouse-profile-table-wrap"><table className="bi-warehouse-profile-table"><thead><tr><th>{copy('Source date','원본 날짜')}</th><th>{copy('Price','가격')}</th><th>{copy('Status','상태')}</th><th>{copy('Checked (Pacific)','확인 시간 (태평양)')}</th><th>{copy('Evidence','근거')}</th></tr></thead><tbody>{history.map((r,i) => <tr key={`${r.releaseId}-${i}`}><td>{r.sourceDate || '—'}</td><td>{price(r.price)}</td><td>{stockLabel(r.status)}</td><td>{time(r.observedAt)}</td><td><details><summary>{copy('Source record','원본 기록')}</summary><div>{r.address}, {r.city}, {r.state} {r.zip}</div><div>{r.statusRaw}</div><div>{r.releaseId}</div><code style={{ overflowWrap:'anywhere' }}>{r.evidenceHash}</code></details></td></tr>)}</tbody></table></div>
        {history.length === 1 && <p>{copy('One observation so far. Price changes will appear after comparable later checks.','현재 관측은 1회입니다. 비교 가능한 후속 확인 후 가격 변동이 표시됩니다.')}</p>}
      </>}
    </div>}
  </section>;
}
