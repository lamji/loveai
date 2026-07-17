// ===== SaaS auth (Supabase + Google OAuth via system browser + deep link) =====
// The supabase client lives in the MAIN process so the PKCE code verifier and
// the session survive between "open browser" and the loveai:// callback, and so
// tokens can be stored encrypted with safeStorage instead of renderer storage.
const { app, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
// Electron 33 ships Node 20, which has no native WebSocket — supabase-js's
// realtime client refuses to start without one, so hand it the ws package.
const WebSocketImpl = require('ws');
const config = require('./config');

let client = null;
let sendToRenderer = () => {};

function configured() {
  return config.SUPABASE_URL && !config.SUPABASE_URL.includes('YOUR-PROJECT-REF');
}

// ---- encrypted single-file storage adapter (userData/session.bin) ----
// supabase-js persists the session AND the PKCE verifier through this adapter.
function storeFile() { return path.join(app.getPath('userData'), 'session.bin'); }

function loadStore() {
  try {
    const raw = fs.readFileSync(storeFile());
    const txt = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    return JSON.parse(txt);
  } catch { return {}; }
}

function saveStore(obj) {
  try {
    const txt = JSON.stringify(obj);
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(txt)
      : Buffer.from(txt, 'utf8');
    fs.writeFileSync(storeFile(), data);
  } catch (e) { console.error('saas: session store write failed:', e.message); }
}

const storageAdapter = {
  getItem: (key) => loadStore()[key] ?? null,
  setItem: (key, value) => { const s = loadStore(); s[key] = value; saveStore(s); },
  removeItem: (key) => { const s = loadStore(); delete s[key]; saveStore(s); }
};

function sb() {
  if (!client) {
    client = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: storageAdapter
      },
      realtime: { transport: WebSocketImpl }
    });
  }
  return client;
}

// ---- public API ----
function init(sendFn) { sendToRenderer = sendFn; }

async function getSession() {
  if (!configured()) return { configured: false, user: null };
  try {
    const { data, error } = await sb().auth.getSession();
    if (error || !data.session) return { configured: true, user: null };
    return { configured: true, user: sessionUser(data.session) };
  } catch (e) { return { configured: true, user: null, error: String(e.message || e) }; }
}

function sessionUser(session) {
  const u = session.user || {};
  const m = u.user_metadata || {};
  return {
    id: u.id,
    email: u.email,
    name: m.full_name || m.name || u.email,
    avatar: m.avatar_url || m.picture || null
  };
}

async function startLogin() {
  if (!configured()) return { ok: false, error: 'Supabase not configured — edit config.js' };
  try {
    const { data, error } = await sb().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: config.REDIRECT_URL, skipBrowserRedirect: true }
    });
    if (error) return { ok: false, error: error.message };
    shell.openExternal(data.url);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// loveai://auth-callback?code=... — arrives via second-instance argv (or cold
// start argv) on Windows. Exchange the PKCE code for a session and notify UI.
async function handleDeepLink(url) {
  try {
    const u = new URL(url);
    const code = u.searchParams.get('code');
    const errDesc = u.searchParams.get('error_description');
    if (errDesc) { sendToRenderer('auth-changed', { user: null, error: errDesc }); return; }
    if (!code) return;
    const { data, error } = await sb().auth.exchangeCodeForSession(code);
    if (error) { sendToRenderer('auth-changed', { user: null, error: error.message }); return; }
    sendToRenderer('auth-changed', { user: sessionUser(data.session) });
  } catch (e) {
    sendToRenderer('auth-changed', { user: null, error: String(e.message || e) });
  }
}

async function logout() {
  try { await sb().auth.signOut(); } catch {}
  try { fs.rmSync(storeFile(), { force: true }); } catch {}
  client = null;
  return { ok: true };
}

// ---- per-user data (RLS-scoped tables) ----
async function userId() {
  const { data } = await sb().auth.getSession();
  return data.session ? data.session.user.id : null;
}

async function fetchProfile() {
  const uid = await userId();
  if (!uid) return { ok: false, error: 'not logged in' };
  const { data, error } = await sb().from('profiles').select('*').eq('id', uid).maybeSingle();
  return error ? { ok: false, error: error.message } : { ok: true, profile: data };
}

async function fetchSettings() {
  const uid = await userId();
  if (!uid) return { ok: false, error: 'not logged in' };
  const { data, error } = await sb().from('user_settings')
    .select('settings').eq('user_id', uid).maybeSingle();
  return error ? { ok: false, error: error.message } : { ok: true, settings: data && data.settings };
}

async function saveSettings(settings) {
  const uid = await userId();
  if (!uid) return { ok: false, error: 'not logged in' };
  const { error } = await sb().from('user_settings')
    .upsert({ user_id: uid, settings, updated_at: new Date().toISOString() });
  return error ? { ok: false, error: error.message } : { ok: true };
}

async function fetchRoster() {
  const uid = await userId();
  if (!uid) return { ok: false, error: 'not logged in' };
  const { data, error } = await sb().from('user_roster')
    .select('agents').eq('user_id', uid).maybeSingle();
  return error ? { ok: false, error: error.message } : { ok: true, agents: data && data.agents };
}

async function saveRoster(agents) {
  const uid = await userId();
  if (!uid) return { ok: false, error: 'not logged in' };
  const { error } = await sb().from('user_roster')
    .upsert({ user_id: uid, agents, updated_at: new Date().toISOString() });
  return error ? { ok: false, error: error.message } : { ok: true };
}

async function fetchSkills() {
  const uid = await userId();
  if (!uid) return { ok: false, error: 'not logged in' };
  const { data, error } = await sb().from('user_skills')
    .select('skills').eq('user_id', uid).maybeSingle();
  return error ? { ok: false, error: error.message } : { ok: true, skills: data && data.skills };
}

async function saveSkills(skills) {
  const uid = await userId();
  if (!uid) return { ok: false, error: 'not logged in' };
  const { error } = await sb().from('user_skills')
    .upsert({ user_id: uid, skills, updated_at: new Date().toISOString() });
  return error ? { ok: false, error: error.message } : { ok: true };
}

module.exports = {
  init, getSession, startLogin, handleDeepLink, logout,
  fetchProfile, fetchSettings, saveSettings, fetchRoster, saveRoster,
  fetchSkills, saveSkills
};
