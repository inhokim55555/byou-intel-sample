import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSalesAffinityModel } from '../src/lib/salesAffinity.js';
import { createMarketDirectoryIndex, matchWarehouseDirectoryStore } from '../src/lib/marketDirectoryIndex.js';
import { asianDatasetMatchesCityReference, asianDatasetMatchesMarketDirectory, rankedAsianGroupRows } from '../src/lib/demographicDisplay.js';
import { samplePnl } from './pnl-fixtures.mjs';
const read = async path => JSON.parse(await readFile(new URL('../'+path,import.meta.url),'utf8'));
const data = await read('sample/seed/latest-dataset.json');
const market = await read('public/data/costco-market-demographics.json');
const city = await read('public/data/costco-city-demographics-2024-acs5.json');
const localGroups = await read('public/data/costco-five-mile-asian-demographics-2024-acs5.json');
const cityGroups = await read('public/data/costco-city-asian-demographics-2024-acs5.json');
const index = createMarketDirectoryIndex(market.stores);
test('daily media data covers every product and reconciles to P&L promotions',()=>{
  for(const pid of Object.keys(data.productMeta)){
    const rows=data.ppcRows.filter(r=>r.pid===pid);
    assert.equal(rows.length,81);
    assert.equal(new Set(rows.map(r=>r.date)).size,81);
    assert.ok(rows.every(r=>r.clicks<=r.impressions && r.attributedUnits<=r.clicks && r.spend>0));
    assert.equal(Math.round(rows.reduce((s,r)=>s+r.spend,0)*100),samplePnl.actuals.find(r=>r.pid===pid&&r.lineType==='promotion').amount*100);
  }
});
test('all sample locations have matching, internally consistent profiles and group drilldowns',()=>{
  assert.ok(asianDatasetMatchesMarketDirectory(localGroups,market));
  assert.ok(asianDatasetMatchesCityReference(cityGroups,city));
  for(const w of data.whs){
    const store=matchWarehouseDirectoryStore(w,index);
    assert.ok(store?.synthetic);
    const d=store.demographics;
    assert.ok(Math.abs(d.asianPct+d.whitePct+d.blackPct+d.hispanicPct-100)<0.001);
    assert.equal(d.malePct+d.femalePct,100);
    const profile=city.placesByGeoid[city.warehouseMappings[w.warehouseNo].geoid];
    assert.ok(profile.metrics.population.estimate>0);
    for(const [p,defs] of [[localGroups.storesByWarehouseNo[w.warehouseNo],localGroups.groupDefinitions],[cityGroups.placesByGeoid[profile.geoid],cityGroups.groupDefinitions]]){
      const rows=rankedAsianGroupRows(p,defs);
      assert.equal(rows.length,8);
      assert.ok(rows.every(r=>r.count.estimate>0 && r.shareOfTotalPopulation.estimate>0));
    }
  }
});
test('Sales Affinity qualifies all 12 locations for every sample product',()=>{
  const demographicsByWarehouseId=Object.fromEntries(data.whs.map(w=>[w.id,matchWarehouseDirectoryStore(w,index).demographics]));
  for(const pid of ['',...Object.keys(data.productMeta)]){
    const model=buildSalesAffinityModel({scopeRows:pid?data.prodSales.filter(r=>r.pid===pid):data.sales,baselineRows:data.prodSales,warehouses:data.whs,demographicsByWarehouseId,selectedProductKey:pid});
    assert.equal(model.status,'ready',pid);
    assert.equal(model.rows.length,12);
    assert.ok(model.rows.every(r=>Number.isFinite(r.affinityIndex)&&r.velocity>0));
  }
});
