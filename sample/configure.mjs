// Refuse ambient configuration files; samples never read production credentials.
import {existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';
for(const f of ['.env','.env.local','.env.production','.env.production.local','.env.development','.env.development.local'])if(existsSync(fileURLToPath(new URL('../'+f,import.meta.url))))throw Error('Remove '+f+' from this sample folder. No credentials are needed.');

// Fixed local sample configuration also applies to direct server invocation.
for(const key of Object.keys(process.env))if(/^(BYOU_|SUPABASE_|VITE_|DATABASE_URL$|POSTGRES_URL$|RAILWAY_)/.test(key))delete process.env[key];
Object.assign(process.env,{PORTFOLIO_SAMPLE:'1',BYOU_ALLOW_AUTH_DISABLED:'true',NODE_ENV:'development',BYOU_SESSION_SECRET:'public-fictional-local-sample',BYOU_ADMIN_TOKEN:'sample-only',BYOU_PNL_DATABASE_URL:'postgresql://postgres:postgres@127.0.0.1:16531/postgres'});
