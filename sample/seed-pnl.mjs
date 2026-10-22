import {savePnlImport} from '../pnl-database.mjs';
import crypto from 'node:crypto';
if(process.env.PORTFOLIO_SAMPLE!=='1'||!process.env.BYOU_PNL_DATABASE_URL?.includes('127.0.0.1:16531'))throw Error('Local sample database required.');
const names=['Lumen Grove','Tidewell','Fieldnote'];
for(const kind of ['forecast','payments','actuals']){
 const rows=names.flatMap((name,i)=>{const common={pid:'DEMO00'+(i+1),cid:'C'+(i+1)};
  if(kind==='forecast')return [{...common,channel:'Inline',productName:name,campaignName:name+' autumn launch',forecastRevenue:240000+i*20000,forecastCogs:84000+i*8000,forecastOtherExpenses:18000,plannedMarketing:12000,forecastUnits:10000,coverageThrough:'2026-11-19'}];
  if(kind==='payments')return [{...common,paymentId:'sample-payment-'+i,allocationPct:100,grossFee:1500+i*500,paid:i<2,paidDate:i<2?'2026-10-15':'',committedDate:'2026-10-01',expectedReimbursement:750,reimbursementReceived:0,reimbursementDate:''}];
  return ['confirmed_revenue','cogs','other_campaign_expense'].map((lineType,j)=>({...common,externalId:'sample-actual-'+i+'-'+j,transactionDate:'2026-10-20',coverageThrough:'2026-10-20',channel:'Inline',lineType,amount:[120000+i*12000,42000+i*4000,9000][j],units:j?0:5000,sourceReference:'Fictional local sample'}));
 });
 const envelope={schema:'byou-pnl-import-v1',kind,sourceSha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),sourceAsOf:'2026-10-20',rows};
 await savePnlImport(envelope,'alex.rivera@example.invalid');
}
console.log('Intel P&L: original import validation and database saved fictional forecasts, payments and actuals.');
process.exit(0);

