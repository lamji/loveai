#!/usr/bin/env node
// ============================================================
// browserctl — CLI for the LoveAi in-app browser bridge.
// Drives the app's OWN sandbox browser tabs (snapshot / click / fill / eval /
// console / network / screenshot) over the localhost bridge — the in-app
// Playwright. Near-instant: no browser spawn, no CDP handshake.
//
// Connection: LOVEAI_BRIDGE_PORT + LOVEAI_BRIDGE_TOKEN (auto-set in every
// in-app terminal) or ~/.loveai/browser-bridge.json (written on app start).
//
//   node browserctl.js health
//   node browserctl.js tabs
//   node browserctl.js open http://localhost:5173
//   node browserctl.js snapshot [--full] [--max 30000] [--tab <id>]
//   node browserctl.js click e12            (ref from snapshot)
//   node browserctl.js click "Sign in"      (visible text)
//   node browserctl.js click css=#submit    (CSS selector)
//   node browserctl.js fill css=#email me@x.com [--submit]
//   node browserctl.js press Enter | press Control+a
//   node browserctl.js eval "document.title"
//   node browserctl.js console [--limit 100] [--clear]
//   node browserctl.js network [--filter api] [--limit 40]
//   node browserctl.js screenshot [C:\abs\path.png]
//   node browserctl.js wait --text "Welcome" [--timeout 15000]
//   node browserctl.js nav back|forward|reload|<url>
//   node browserctl.js activate <tabId> / close-tab <tabId>
// ============================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

function connection() {
  let port = process.env.LOVEAI_BRIDGE_PORT;
  let token = process.env.LOVEAI_BRIDGE_TOKEN;
  if (!port || !token) {
    const fp = path.join(os.homedir(), '.loveai', 'browser-bridge.json');
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      port = j.port;
      token = j.token;
    } catch {
      fail('bridge not found — is the LoveAi app running? (no env vars and no ' + fp + ')');
    }
  }
  return { port, token };
}

function fail(msg) {
  console.error('browserctl: ' + msg);
  process.exit(1);
}

async function send(cmd) {
  const { port, token } = connection();
  let res;
  try {
    res = await fetch('http://127.0.0.1:' + port + '/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-token': token },
      body: JSON.stringify(cmd),
    });
  } catch (e) {
    fail('cannot reach the app on port ' + port + ' — restart LoveAi (' + e.message + ')');
  }
  return res.json();
}

// --flag value / --flag parsing; bare args in order
function parseArgs(argv) {
  const flags = {};
  const bare = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i++; }
      else flags[name] = true;
    } else bare.push(a);
  }
  return { flags, bare };
}

// click/fill targets: "e12" → ref, "css=..." → selector, anything else → text
function target(s) {
  if (!s) return {};
  if (/^e\d+$/.test(s)) return { ref: s };
  if (s.startsWith('css=')) return { selector: s.slice(4) };
  return { text: s };
}

function print(r, rawField) {
  if (r && r.ok && rawField && typeof r[rawField] === 'string') {
    const { [rawField]: raw, ...rest } = r;
    console.log(JSON.stringify(rest));
    console.log(raw);
  } else {
    console.log(JSON.stringify(r, null, 2));
  }
  if (!r || !r.ok) process.exit(2);
}

async function main() {
  const [cmdName, ...rest] = process.argv.slice(2);
  const { flags, bare } = parseArgs(rest);
  const tabId = flags.tab;

  switch (cmdName) {
    case 'health': {
      const { port, token } = connection();
      try {
        const res = await fetch(
          'http://127.0.0.1:' + port + '/health?token=' + token);
        return print(await res.json());
      } catch (e) { fail('app not reachable on port ' + port + ': ' + e.message); }
      break;
    }
    case 'tabs': return print(await send({ op: 'tabs' }));
    case 'open':
      if (!bare[0]) fail('usage: open <url>');
      return print(await send({ op: 'open', url: bare[0], reuse: !flags.new }));
    case 'nav': {
      const dest = bare[0];
      if (!dest) fail('usage: nav back|forward|reload|<url>');
      const cmd = ['back', 'forward', 'reload'].includes(dest)
        ? { op: 'navigate', action: dest, tabId }
        : { op: 'navigate', url: dest, tabId };
      return print(await send(cmd));
    }
    case 'snapshot':
      return print(await send({
        op: 'snapshot', tabId,
        mode: flags.full ? 'full' : 'interactive',
        maxChars: flags.max ? Number(flags.max) : undefined,
      }), 'snapshot');
    case 'click':
      if (!bare[0]) fail('usage: click <ref|text|css=selector>');
      return print(await send({ op: 'click', tabId, ...target(bare[0]) }));
    case 'fill':
      if (bare.length < 2) fail('usage: fill <ref|text|css=selector> <value> [--submit]');
      return print(await send({
        op: 'fill', tabId, ...target(bare[0]),
        value: bare.slice(1).join(' '), submit: !!flags.submit,
      }));
    case 'press':
      return print(await send({
        op: 'press', tabId, key: bare[0] || 'Enter',
        ...(flags.at ? target(flags.at) : {}),
      }));
    case 'eval':
      if (!bare.length) fail('usage: eval "<js code>"');
      return print(await send({ op: 'eval', tabId, code: bare.join(' ') }));
    case 'console':
      return print(await send({
        op: 'console', tabId,
        limit: flags.limit ? Number(flags.limit) : undefined,
        clear: !!flags.clear,
      }));
    case 'network':
      return print(await send({
        op: 'network',
        filter: flags.filter,
        limit: flags.limit ? Number(flags.limit) : undefined,
        since: flags.since ? Number(flags.since) : undefined,
      }));
    case 'screenshot':
      return print(await send({
        op: 'screenshot', tabId,
        path: bare[0] ? path.resolve(bare[0]) : undefined,
      }));
    case 'wait':
      return print(await send({
        op: 'waitFor', tabId,
        selector: flags.selector, text: flags.text,
        urlContains: flags.url, gone: flags.gone,
        load: !!flags.load,
        timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
      }));
    case 'activate':
      return print(await send({ op: 'activate', tabId: bare[0] || tabId }));
    case 'close-tab':
      if (!bare[0]) fail('usage: close-tab <tabId>');
      return print(await send({ op: 'closeTab', tabId: bare[0] }));
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('const fs =')[0]
        .replace(/^\/\/ ?=*\n?/gm, '').replace(/^\/\/ ?/gm, ''));
      process.exit(cmdName ? 1 : 0);
  }
}

main().catch(e => fail(String((e && e.message) || e)));
