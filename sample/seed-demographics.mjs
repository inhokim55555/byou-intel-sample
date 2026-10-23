// Synthetic aggregate profiles only. No Census records or customer data.
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const read = async p => JSON.parse(await readFile(new URL(p, root), 'utf8'));
const write = (p, value) => writeFile(new URL(p, root), JSON.stringify(value) + '\n');
const dataset = await read('sample/seed/latest-dataset.json');
const startup = await read('sample/seed/latest-startup.json');
const generatedAt = '2026-10-23T12:00:00.000Z';
const common = { datasetVersion:'synthetic-markets-v1', generatedAt, synthetic:true, source:{name:'Fictional demonstration data'} };
const vintage = {year:2026, dataset:'Synthetic sample', period:'2026', boundaryDate:'Not applicable'};
const market = {...common, schema:'byou-costco-market-demographics-v1', stores:[]};
const city = {...common, schema:'byou-costco-city-demographics-v1', vintage, warehouseMappings:{}, placesByGeoid:{}};
const groupDefinitions = ['Chinese','Indian','Filipino','Vietnamese','Korean','Japanese','Pakistani','Other Asian'].map(label => ({id:label.toLowerCase().replaceAll(' ','_'),label}));
const detailed = (population, asianPct, index) => {
  const weights = [26,23,18,11,9,6,4,3].map((v,j) => v + ((index+j)%3-1));
  const total = weights.reduce((a,b)=>a+b,0);
  return Object.fromEntries(groupDefinitions.map((g,j)=>{
    const count = Math.round(population*asianPct/100*weights[j]/total);
    return [g.id,{count:{estimate:count},shareOfTotalPopulation:{estimate:100*count/population}}];
  }));
};
const localGroups = {...common, schema:'byou-costco-five-mile-asian-demographics-v1', groupDefinitions, storesByWarehouseNo:{}};
const cityGroups = {...common, schema:'byou-costco-city-asian-demographics-v1', groupDefinitions, placesByGeoid:{}};
for (const [i,w] of dataset.whs.entries()) {
  const warehouseNo = String(9001+i), geoid = `sample-city-${i+1}`;
  w.warehouseNo = warehouseNo;
  const population = 48000 + ((i*7)%12)*9300;
  const asianPct = 5 + ((i*7)%12)*2.4, blackPct = 6+(i*3)%17, hispanicPct = 12+(i*5)%22;
  const demographics = {population, householdIncome:62000+((i*5)%12)*6500, averageAge:30+(i*7)%16,
    asianPct,blackPct,hispanicPct,whitePct:100-asianPct-blackPct-hispanicPct,
    malePct:48+(i%5)*0.6,femalePct:52-(i%5)*0.6,radiusMiles:5,tractCount:12+i,scope:'Synthetic local area'};
  market.stores.push({warehouseNo,name:w.name,city:w.city,state:w.st,country:'US',region:w.region,lat:w.lat,lng:w.lng,demographics,synthetic:true});
  const cityPopulation = population*3;
  const metrics = Object.fromEntries(Object.entries({population:cityPopulation,households:Math.round(cityPopulation/2.7),medianHouseholdIncome:demographics.householdIncome-12000,meanHouseholdIncome:demographics.householdIncome,medianAge:demographics.averageAge+1,
    asianNonHispanicPct:asianPct,whiteNonHispanicPct:demographics.whitePct,blackNonHispanicPct:blackPct,hispanicPct,malePct:demographics.malePct,femalePct:demographics.femalePct}).map(([k,v])=>[k,{estimate:v}]));
  city.warehouseMappings[warehouseNo]={status:'resolved',geoid};
  city.placesByGeoid[geoid]={geoid,name:w.city,state:w.st,vintage,synthetic:true,metrics};
  localGroups.storesByWarehouseNo[warehouseNo]={status:'complete',tractCount:12+i,population,groups:detailed(population,asianPct,i)};
  cityGroups.placesByGeoid[geoid]={status:'complete',population:cityPopulation,groups:detailed(cityPopulation,asianPct,i)};
}
market.counts={totalWarehouses:market.stores.length,usWarehouses:market.stores.length};
localGroups.baseMarketDirectory={schema:market.schema,generatedAt,totalWarehouses:market.stores.length,usWarehouses:market.stores.length};
cityGroups.baseCityReference={schema:city.schema,datasetVersion:city.datasetVersion,generatedAt,vintageYear:vintage.year,uniqueCityProfiles:dataset.whs.length};
startup.whs=dataset.whs;
// Daily media spend reconciles to the promotion expense in the sample P&L.
dataset.ppcRows=[];
const dates=[...new Set(dataset.onlineSales.map(r=>r.date))].sort();
Object.values(dataset.productMeta).forEach((p,i)=>{
  const totalCents=[150000,120000,250000][i];
  dates.forEach((date,j)=>{
    const spend=(Math.floor(totalCents/dates.length)+(j<totalCents%dates.length?1:0))/100;
    const clicks=40+(j*7+i*13)%65, impressions=clicks*65;
    const units=3+(j+i)%8, sales=units*[28,24,22][i];
    dataset.ppcRows.push({id:`sample-meta-${p.id}-${date}`,partner:'Meta',source:'Synthetic sample',level:'campaign',date,snapshotStart:date,snapshotEnd:date,reportingPeriod:'daily',periodStart:date,
      pid:p.id,cid:`C${i+1}`,product:p.short,campaign:`${p.short} autumn launch`,externalCampaignId:`sample-meta-${i+1}`,objective:'Sales',resultType:'Purchases',results:units,
      spend,attributedSales:sales,attributedUnits:units,clicks,impressions,reach:Math.round(impressions/1.3),frequency:1.3,ctr:100*clicks/impressions,avgCpc:spend/clicks,cpm:1000*spend/impressions,roas:sales/spend,costPerResult:spend/units});
  });
});
startup.ppcRows=dataset.ppcRows;
for(const [file,value] of Object.entries({'costco-market-demographics.json':market,'costco-city-demographics-2024-acs5.json':city,'costco-city-asian-demographics-2024-acs5.json':cityGroups,'costco-five-mile-asian-demographics-2024-acs5.json':localGroups})) await write(`public/data/${file}`,value);
await write('sample/seed/latest-dataset.json',dataset);
await write('sample/seed/latest-startup.json',startup);
console.log(`Seeded ${market.stores.length} fictional market profiles and both detailed group views.`);
