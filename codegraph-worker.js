// Persistent tree-sitter PARSE worker. All WASM parsing — full repo builds and
// single-file re-parses — runs here, OFF the Electron main process (parsing is
// pure CPU and stuttered the UI even with yielding). The runtime + grammars
// load once (lazily, inside codegraph-parse) and stay resident.
//
// Jobs are serialized: one Parser instance is reused across files and is not
// safe to run re-entrantly.
//
// Protocol (mirrors vectors-worker): main posts { id, job, ... }; we reply
// { id, type:'progress', done, total } zero or more times, then exactly one
// { id, type:'done', ok, ... }. A tree-sitter init failure surfaces as
// ok:false + error; main mirrors it into tsBroken/tsInitError and a manual
// rebuild respawns this worker to retry init.

const { parentPort } = require('worker_threads');
const P = require('./codegraph-parse');

let chain = Promise.resolve();   // serial job queue

function handle(msg) {
  const { id, job } = msg;
  return (async () => {
    try {
      if (job === 'build') {
        const res = await P.parseRepo(msg.root, {
          countFirst: !!msg.countFirst,
          // counting is readdir-only but can still take seconds on a big repo —
          // report it so the UI never sits silent before parsing starts
          onCount: (done) =>
            parentPort.postMessage({ id, type: 'progress', done, total: 0, phase: 'count' }),
          onProgress: (done, total) =>
            parentPort.postMessage({ id, type: 'progress', done, total, phase: 'parse' }),
        });
        parentPort.postMessage({
          id, type: 'done', ok: true, raws: res.raws, truncated: res.truncated,
        });
      } else if (job === 'parse') {
        const raw = await P.parseFile(msg.abs, msg.rel);
        parentPort.postMessage({ id, type: 'done', ok: true, raw });
      } else {
        parentPort.postMessage({ id, type: 'done', ok: false, error: 'unknown job: ' + job });
      }
    } catch (e) {
      parentPort.postMessage({
        id, type: 'done', ok: false,
        error: String(e && e.message ? e.message : e),
      });
    }
  })();
}

parentPort.on('message', (msg) => { chain = chain.then(() => handle(msg)); });
