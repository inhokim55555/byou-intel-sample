import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
const [kind, folder, rawPort] = process.argv.slice(2);
if (!['trackify','intel'].includes(kind) || !folder || !/^\d+$/.test(rawPort||'')) throw Error('Expected database kind, data folder, and port.');
await mkdir(folder,{recursive:true});
const db = await PGlite.create(path.resolve(folder));
if(kind==='trackify') {
  const exists=await db.query(`SELECT to_regclass('public."Organisation"') AS name`);
  if(!exists.rows[0].name) await db.exec(await readFile(new URL('./trackify-schema.sql',import.meta.url),'utf8'));
}
const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:Number(rawPort),maxConnections:40});
await server.start();
console.log(JSON.stringify({ready:true,kind,port:Number(rawPort)}));
process.send?.({ready:true,kind});
let closing=false;
async function close(){if(closing)return;closing=true;await server.stop();await db.close();process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);process.on('message',message=>{if(message==='stop')void close();});
