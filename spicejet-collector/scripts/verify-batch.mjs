import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyRun } from '../src/verify.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory=path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-batch.mjs WEB_RUN_DIRECTORY');
const job=JSON.parse(await fs.readFile(path.join(directory,'job.json')));
const hash=crypto.createHash('sha256');
for(const name of ['collect.mjs','parse.mjs','diagnostics.mjs','verify.mjs','browser-path.mjs','form.mjs','background-display.mjs']) hash.update(await fs.readFile(path.join(root,'src',name)));
const currentSourceFingerprint=hash.digest('hex');
const checks=[];
for(const task of job.tasks){
  const errors=[];
  if(!task.runId || !/^[\w-]+$/.test(task.runId)){checks.push({query:task.query,ok:false,errors:['No valid saved search run']});continue;}
  try{
    const dir=path.join(root,'runs',task.runId);
    const result=JSON.parse(await fs.readFile(path.join(dir,'result.json')));
    const verified=await verifyRun(dir,task.query); errors.push(...verified.errors);
    if(task.status!==result.status)errors.push('Batch/search status mismatch');
    if(!['ok','empty'].includes(task.status))errors.push('Task has no verified outcome');
    if(JSON.stringify(task.fares)!==JSON.stringify(result.fares))errors.push('Batch/search fares disagree');
    if(result.sourceFingerprint!==currentSourceFingerprint)errors.push('Saved search was collected with a different source version');
    if(job.mode==='background' && (result.browserMode!=='background' || result.browserDisplay!=='virtual'))errors.push('Background display metadata missing');
    const screenshot=await fs.readFile(path.join(dir,'results.png'));
    if(screenshot.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||screenshot.length<1000)errors.push('Invalid screenshot file');
    checks.push({query:task.query,runId:task.runId,status:task.status,ok:verified.ok && !errors.length,fareCount:verified.fareCount||0,attempts:task.attempts?.length||1,browserMode:result.browserMode,browserDisplay:result.browserDisplay,startedAt:result.startedAt,finishedAt:result.finishedAt,errors});
  }catch(error){checks.push({query:task.query,ok:false,errors:[error.message]});}
}
const unique=new Set(job.tasks.map(t=>JSON.stringify(t.query)));
const report={id:job.id,status:job.status,mode:job.mode,ok:job.status==='complete'&&job.tasks.length>0&&unique.size===job.tasks.length&&checks.every(c=>c.ok),sourceFingerprint:currentSourceFingerprint,searches:checks.length,fares:checks.reduce((n,c)=>n+c.fareCount,0),fareSearches:checks.filter(c=>c.status==='ok').length,noFlightSearches:checks.filter(c=>c.status==='empty').length,retriedSearches:checks.filter(c=>c.attempts>1).length,checks};
await fs.writeFile(path.join(directory,'independent-verification.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({...report,checks:checks.filter(c=>!c.ok)},null,2));
if(!report.ok)process.exitCode=1;
