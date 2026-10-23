import {savePnlImport} from '../pnl-database.mjs';
import crypto from 'node:crypto';
import {samplePnl,sampleAsOf} from './pnl-fixtures.mjs';
if(process.env.PORTFOLIO_SAMPLE!=='1'||!process.env.BYOU_PNL_DATABASE_URL?.includes('127.0.0.1:16531'))throw Error('Local sample database required.');
for(const [kind,key] of [['forecast','forecasts'],['payments','payments'],['actuals','actuals']]){
 const rows=samplePnl[key];
 const envelope={schema:'byou-pnl-import-v1',kind,sourceSha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),sourceAsOf:'2026-10-23',rows};
 await savePnlImport(envelope,'alex.rivera@example.invalid');
}
console.log('Seeded fictional campaign P&L.');
process.exit(0);
