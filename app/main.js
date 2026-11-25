const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SESSION_FILE = () => path.join(app.getPath('userData'), 'session.bin');
let sess = null;  // { access_token, refresh_token, expires_at, email }

// ---------- session storage (encrypted with the OS keychain) ----------
function loadSession() {
  try {
    const buf = fs.readFileSync(SESSION_FILE());
    sess = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString());
  } catch (e) { sess = null; }
}
function saveSession() {
  try {
    if (!sess) { fs.rmSync(SESSION_FILE(), { force: true }); return; }
    const s = JSON.stringify(sess);
    fs.writeFileSync(SESSION_FILE(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s) : s);
  } catch (e) {}
}
function setSession(d) {
  sess = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || (Date.now() / 1000 + (d.expires_in || 3600)), email: d.user?.email || sess?.email };
  saveSession();
}

// ---------- Supabase calls ----------
async function authFetch(p, body) {
  const r = await fetch(CFG.supabaseUrl + '/auth/v1' + p, {
    method: 'POST', headers: { apikey: CFG.supabaseAnonKey, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.msg || d.error_description || d.message || ('Sign-in error ' + r.status));
  return d;
}
async function token() {
  if (!sess) throw Object.assign(new Error('Not signed in'), { code: 'auth' });
  if (sess.expires_at - Date.now() / 1000 < 90) {
    try { setSession(await authFetch('/token?grant_type=refresh_token', { refresh_token: sess.refresh_token })); }
    catch (e) { sess = null; saveSession(); throw Object.assign(new Error('Please sign in again'), { code: 'auth' }); }
  }
  return sess.access_token;
}
async function fn(name, body, method = 'POST') {
  const r = await fetch(`${CFG.supabaseUrl}/functions/v1/${name}`, {
    method, headers: { Authorization: 'Bearer ' + await token(), apikey: CFG.supabaseAnonKey, 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error || ('Server error ' + r.status), code: d.code || (r.status === 401 ? 'auth' : undefined) };
  return d;
}
async function rest(p, method = 'GET', body) {
  const r = await fetch(`${CFG.supabaseUrl}/rest/v1/${p}`, {
    method, headers: { Authorization: 'Bearer ' + await token(), apikey: CFG.supabaseAnonKey, 'content-type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error((d && d.message) || ('Save failed ' + r.status));
  return d;
}
const safe = f => async (_e, ...a) => { try { return await f(...a); } catch (e) { return { error: e.message, code: e.code }; } };

ipcMain.handle('auth-state', safe(async () => (sess ? { email: sess.email } : null)));
ipcMain.handle('auth-send', safe(async email => { await authFetch('/otp', { email, create_user: true }); return { ok: true }; }));
ipcMain.handle('auth-verify', safe(async (email, code) => { setSession(await authFetch('/verify', { type: 'email', email, token: code })); return { email: sess.email }; }));
ipcMain.handle('sign-out', safe(async () => { sess = null; saveSession(); return { ok: true }; }));
ipcMain.handle('account', safe(() => fn('account', null, 'GET')));
ipcMain.handle('dg-token', safe(() => fn('dg-token')));
ipcMain.handle('coach', safe(body => fn('coach', body)));
ipcMain.handle('usage', safe(minutes => fn('usage', { minutes })));
ipcMain.handle('profiles-list', safe(() => rest('call_profiles?select=*&order=updated_at.desc')));
ipcMain.handle('profile-save', safe(p => rest('call_profiles', 'POST', { ...p, updated_at: new Date().toISOString() }).then(r => r[0])));
ipcMain.handle('deals-list', safe(() => rest('deals?select=*&order=updated_at.desc')));
ipcMain.handle('deal-save', safe(d => rest('deals', 'POST', { ...d, updated_at: new Date().toISOString() }).then(r => r[0])));
ipcMain.handle('deal-delete', safe(id => rest('deals?id=eq.' + encodeURIComponent(id), 'DELETE')));
ipcMain.handle('deal-calls', safe(id => rest('deal_calls?select=*&order=called_at.desc&deal_id=eq.' + encodeURIComponent(id))));
ipcMain.handle('deal-call-add', safe(c => rest('deal_calls', 'POST', c).then(r => r[0])));

// ---------- Fathom (the user's own key, stored encrypted on this computer) ----------
const FATHOM_FILE = () => path.join(app.getPath('userData'), 'fathom.bin');
function fathomKey() {
  try { const b = fs.readFileSync(FATHOM_FILE()); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString(); }
  catch (e) { return ''; }
}
ipcMain.handle('fathom-key-set', safe(async k => {
  k = String(k || '').trim();
  if (!k) { fs.rmSync(FATHOM_FILE(), { force: true }); return { ok: true, connected: false }; }
  fs.writeFileSync(FATHOM_FILE(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(k) : k);
  return { ok: true, connected: true };
}));
ipcMain.handle('fathom-status', safe(async () => ({ connected: !!fathomKey() })));
ipcMain.handle('fathom-meetings', safe(async cursor => {
  const key = fathomKey();
  if (!key) throw new Error('Connect Fathom first');
  const q = new URLSearchParams({ include_transcript: 'true' });
  if (cursor) q.set('cursor', cursor);
  const r = await fetch('https://api.fathom.ai/external/v1/meetings?' + q, { headers: { 'X-Api-Key': key } });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('Fathom key not accepted. Generate a new one in Fathom → Settings → API Access.');
  if (!r.ok) throw new Error('Fathom error ' + r.status);
  const items = (d.items || d.meetings || d.data || []).map(m => ({
    id: String(m.recording_id ?? m.id ?? ''),
    title: m.title || m.meeting_title || 'Untitled meeting',
    date: m.created_at || m.recording_start_time || m.scheduled_start_time || '',
    who: (m.calendar_invitees || []).map(i => i.name || i.email).filter(Boolean).slice(0, 4).join(', '),
    transcript: (m.transcript || []).map(t => `${t.speaker?.display_name || 'Speaker'}: ${t.text || ''}`).join('\n')
  }));
  return { items, next: d.next_cursor || null };
}));
ipcMain.handle('profile-delete', safe(id => rest('call_profiles?id=eq.' + encodeURIComponent(id), 'DELETE')));

// Recorded voice note / old call audio -> text, via a short-lived Deepgram token.
ipcMain.handle('transcribe', safe(async ({ data, mime, lang }) => {
  const t = await fn('dg-token');
  if (t.error) throw new Error(t.error);
  const q = new URLSearchParams({ model: 'nova-3', smart_format: 'true', diarize: 'true', paragraphs: 'true', language: lang || 'en' });
  const r = await fetch('https://api.deepgram.com/v1/listen?' + q, {
    method: 'POST', headers: { Authorization: 'Bearer ' + t.token, 'Content-Type': mime || 'audio/webm' }, body: Buffer.from(data)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.err_msg || ('Transcription failed ' + r.status));
  const alt = d.results?.channels?.[0]?.alternatives?.[0] || {};
  return { text: alt.paragraphs?.transcript || alt.transcript || '' };
}));

ipcMain.handle('fetch-site', safe(async url => {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 Clinch' }, redirect: 'follow' });
  const html = await r.text();
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { text: text.slice(0, 15000) };
}));

ipcMain.handle('set-top', (e, v) => BrowserWindow.fromWebContents(e.sender).setAlwaysOnTop(!!v));
ipcMain.handle('set-hidden', (e, v) => BrowserWindow.fromWebContents(e.sender).setContentProtection(!!v));
ipcMain.handle('copy', (_e, t) => clipboard.writeText(String(t)));
ipcMain.handle('open', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('version', () => app.getVersion());

// ---------- window ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 440, height: 800, minWidth: 360, minHeight: 480, alwaysOnTop: true, title: 'Clinch',
    backgroundColor: '#0f1115', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.setContentProtection(true);
  win.loadFile('index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  loadSession();
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(s => cb({ video: s[0], audio: 'loopback' })).catch(() => cb({}));
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'display-capture'].includes(perm)));
  createWindow();
  // Auto-update from GitHub Releases (installed builds only).
  if (app.isPackaged) {
    try { require('electron-updater').autoUpdater.checkForUpdatesAndNotify(); } catch (e) {}
  }
});
app.on('window-all-closed', () => app.quit());
