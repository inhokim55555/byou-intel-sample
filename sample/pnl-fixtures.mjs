// Entirely fictional fixed-date scenarios for the public demo.
export const sampleAsOf = '2026-10-20';
const types = ['confirmed_revenue','cogs','import_cost','costco_allowance','promotion','markdown','endcap','packaging','returns','other_campaign_expense'];
const scenarios = [
  {name:'Lumen Grove', actual:[120000,42000,3000,2400,1500,600,500,400,300,300], forecast:[240000,84000,6000,4800,3000,1200,1000,800,600,600], paid:6000, committed:9000, received:500},
  {name:'Tidewell', actual:[18000,14000,1800,900,1200,500,700,300,300,300], forecast:[160000,64000,3600,3200,4800,1500,1400,1000,1200,1300], paid:2000, committed:7000, received:0},
  {name:'Fieldnote', actual:[48000,32000,3000,2400,2500,1600,1000,800,2400,800], forecast:[95000,65000,6000,4800,5000,3200,2000,1600,4800,1600], paid:4500, committed:14000, received:250},
];
export const samplePnl = {forecasts:[],payments:[],actuals:[]};
scenarios.forEach((s,i)=>{
 const common={pid:`DEMO00${i+1}`,cid:`C${i+1}`};
 samplePnl.forecasts.push({...common,channel:'Inline',productName:s.name,campaignName:'Autumn launch',forecastRevenue:s.forecast[0],forecastCogs:s.forecast[1],forecastOtherExpenses:s.forecast.slice(2).reduce((a,b)=>a+b,0),plannedMarketing:12000,forecastUnits:10000,coverageThrough:'2026-11-19',forecastLines:types.map((type,j)=>({lineType:j===0?'forecast_revenue':j===1?'forecast_cogs':type,amount:s.forecast[j]}))});
 for(const [j,fee] of [s.paid,s.committed-s.paid].entries()) samplePnl.payments.push({...common,paymentId:`sample-payment-${i}${j?'-unpaid':''}`,allocationPct:100,grossFee:fee,paid:j===0,paidDate:j===0?'2026-10-15':'',committedDate:'2026-10-01',expectedReimbursement:j===0?750:0,reimbursementReceived:j===0?s.received:0,reimbursementDate:j===0&&s.received?'2026-10-18':''});
 types.forEach((lineType,j)=>samplePnl.actuals.push({...common,externalId:`sample-actual-${i}-${j}`,transactionDate:sampleAsOf,coverageThrough:sampleAsOf,channel:'Inline',lineType,amount:s.actual[j],units:j?0:5000,sourceReference:'Fictional sample'}));
});
