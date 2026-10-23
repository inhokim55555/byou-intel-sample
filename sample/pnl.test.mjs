import test from 'node:test';
import assert from 'node:assert/strict';
import {samplePnl,sampleAsOf} from './pnl-fixtures.mjs';
import {buildPnlView,validatePnlImportEnvelope} from '../src/lib/pnl.js';
const normalized={};
for(const [kind,key] of [['forecast','forecasts'],['payments','payments'],['actuals','actuals']]){
 const result=validatePnlImportEnvelope({schema:'byou-pnl-import-v1',kind,sourceAsOf:sampleAsOf,sourceSha256:'a'.repeat(64),rows:samplePnl[key]});
 test(`${kind} fixtures pass import validation`,()=>assert.deepEqual(result.errors,[]));
 normalized[key]=result.normalized.rows;
}
test('complete P&Ls balance and show three distinct statuses',()=>{
 const v=buildPnlView({...normalized,asOf:sampleAsOf});
 assert.deepEqual(v.portfolio.statusCounts,{profitable:1,on_track:1,forecast_loss:1,unknown:0});
 assert.equal(v.portfolio.actualContribution,56750);
 assert.equal(v.portfolio.forecastContribution,181250);
 for(const c of v.campaigns){
  assert.ok(c.productName && c.campaignName);
  assert.equal(c.actualComplete,true);
  assert.equal(c.actual.contribution,c.actual.revenue+c.actual.reimbursement-c.actual.expenses-c.actual.paidMarketing);
  assert.equal(c.lineItems.forecast.filter(x=>!['forecast_revenue','forecast_cogs'].includes(x.lineType)).reduce((n,x)=>n+x.amount,0),c.forecast.otherExpenses);
  assert.equal(c.forecast.marketing,Math.max(c.reconciliation.committedMarketing,c.reconciliation.plannedMarketing));
 }
});
test('future dates retain the incomplete-data safeguard',()=>{
 assert.equal(buildPnlView({...normalized,asOf:'2026-10-21'}).portfolio.actualCampaignCount,0);
});
