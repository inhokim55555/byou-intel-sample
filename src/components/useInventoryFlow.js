import { useEffect, useMemo, useState } from "react";

export default function useInventoryFlow(jobs, dateRange) {
  const request = useMemo(() => ({jobs,dateRange:{start:dateRange.start,end:dateRange.end}}),[jobs,dateRange.start,dateRange.end]);
  const [result,setResult] = useState({request:null,status:"loading",chartData:[]});
  const [attempt,setAttempt] = useState(0);
  useEffect(() => {
    if (!jobs.length) {setResult({request,status:"ready",chartData:[],processingMs:0}); return;}
    let active = true;
    let worker;
    let timer;
    let transferMs = 0;
    const fail = (reason = "") => {
      clearTimeout(timer);
      const error = typeof reason === "string" ? reason : String(reason?.message || "");
      if (active) setResult({request,status:"error",chartData:[],error});
      worker?.terminate();
    };
    setResult({request,status:"loading",chartData:[]});
    timer = setTimeout(() => fail("Inventory flow chart timed out after 45 seconds."),45000);
    try {
      worker = new Worker(new URL("../workers/inventoryFlow.worker.js",import.meta.url),{type:"module"});
      worker.onmessage = ({data}) => {
        if (!active) return;
        clearTimeout(timer);
        if (data.ok) setResult({...data,request,status:"ready",transferMs}); else fail(data.error || "");
        worker.terminate();
      };
      worker.onerror = fail;
      const started = performance.now();
      worker.postMessage(request);
      transferMs = performance.now() - started;
    } catch {fail();}
    return () => {active=false;clearTimeout(timer);worker?.terminate();};
  },[request,attempt]);
  return {...(result.request === request ? result : {status:"loading",chartData:[]}),retry:() => setAttempt(n=>n+1)};
}
