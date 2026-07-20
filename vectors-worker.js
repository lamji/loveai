// Persistent embedding worker. Runs ALL vector work — build, incremental sync,
// and query — OFF the Electron main process so neither building NOR querying ever
// freezes the UI. The model loads once (lazily) and stays resident here.
//
// Jobs are serialized (one at a time): an ONNX session isn't safe to run
// re-entrantly, and the index cache must stay coherent across build/sync/query.
//
// Protocol: main posts { id, job, dir, ... }; we reply { id, type:'progress',... }
// zero or more times, then exactly one { id, type:'done', ok, ... }.

const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const V = require('./vectors');

let chain = Promise.resolve();   // serial job queue

function handle(msg) {
  const { id, job, dir } = msg;
  return (async () => {
    try {
      if (job === 'query') {
        const hits = await V.queryVectors(dir, msg.query, msg.k || 20);
        // hits === null means "no index built" — keep it null so main can tell
        // that apart from "index exists but no matches".
        parentPort.postMessage({ id, type: 'done', ok: true, hits });
        return;
      }
      const graph = JSON.parse(fs.readFileSync(path.join(dir, 'codegraph.json'), 'utf8'));
      let r;
      if (job === 'sync') {
        r = await V.syncFilesVectors(dir, graph, msg.rels || []);
      } else {
        r = await V.buildVectorIndex(dir, graph,
          (done, total) => parentPort.postMessage({ id, type: 'progress', done, total }));
      }
      parentPort.postMessage({ id, type: 'done', ok: !!(r && r.ok), count: (r && r.count) || 0 });
    } catch (e) {
      parentPort.postMessage({ id, type: 'done', ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
}

parentPort.on('message', (msg) => { chain = chain.then(() => handle(msg)); });
