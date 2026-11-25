// Clinch in the browser: the same UI as the desktop app, with this file standing in for the desktop bridge (preload.js + main.js).
(() => {
  window.CLINCH_WEB = true;
  const CFG = window.CLINCH_CONFIG;
  const KEY = 'clinch.session', FATHOM = 'clinch.fathom';
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  let sess = store.get(KEY);
  const setSession = d => {
    sess = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || (Date.now() / 1000 + (d.expires_in || 3600)), email: d.user?.email || sess?.email };
    store.set(KEY, sess);
  };
  const err = (m, code) => Object.assign(new Error(m), { code });

  async function authFetch(p, body) {
    const r = await fetch(CFG.supabaseUrl + '/auth/v1' + p, { method: 'POST', headers: { apikey: CFG.supabaseAnonKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.msg || d.error_description || d.message || ('Sign-in error ' + r.status));
    return d;
  }
  async function token() {
    if (!sess) throw err('Not signed in', 'auth');
    if (sess.expires_at - Date.now() / 1000 < 90) {
      try { setSession(await authFetch('/token?grant_type=refresh_token', { refresh_token: sess.refresh_token })); }
      catch (e) { sess = null; store.set(KEY, null); throw err('Please sign in again', 'auth'); }
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
  const safe = f => async (...a) => { try { return await f(...a); } catch (e) { return { error: e.message, code: e.code }; } };

  // Sign-in link: Supabase sends people back here with #access_token=...&refresh_token=...
  async function signInFromLink(text) {
    const raw = String(text || '').trim();
    const hp = new URLSearchParams(raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : '');
    if (hp.get('access_token') && hp.get('refresh_token')) { setSession(await authFetch('/token?grant_type=refresh_token', { refresh_token: hp.get('refresh_token') })); return true; }
    let u = null; try { u = new URL(raw); } catch (e) { return false; }
    const th = u.searchParams.get('token_hash') || u.searchParams.get('token');
    if (th) { setSession(await authFetch('/verify', { type: u.searchParams.get('type') === 'signup' ? 'signup' : 'magiclink', token_hash: th })); return true; }
    return false;
  }
  let signedInCb = null, pendingSignIn = null;
  if (/access_token=/.test(location.hash)) {
    const link = location.href;
    history.replaceState(null, '', location.pathname + location.search);
    pendingSignIn = signInFromLink(link).then(() => ({ email: sess?.email })).catch(e => ({ error: e.message }));
  } else if (/error_description=/.test(location.hash)) {
    const m = new URLSearchParams(location.hash.slice(1)).get('error_description');
    history.replaceState(null, '', location.pathname);
    pendingSignIn = Promise.resolve({ error: m || 'That sign-in link has expired' });
  }

  const blobToB64 = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsArrayBuffer(b); });
  const prof = p => ({ ...p, updated_at: new Date().toISOString() });

  window.app = {
    onSignedIn: cb => { signedInCb = cb; },  // the page load itself handles a returning sign-in link (see authState)
    authState: safe(async () => {
      if (pendingSignIn) { const d = await pendingSignIn; pendingSignIn = null; if (d.error) return null; }
      return sess ? { email: sess.email } : null;
    }),
    authSend: safe(async email => { await authFetch('/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { email, create_user: true }); return { ok: true }; }),
    authVerify: safe(async (email, code) => {
      if (/[:/#=]/.test(code)) { if (!(await signInFromLink(code))) throw new Error('That link did not work'); }
      else setSession(await authFetch('/verify', { type: 'email', email, token: code }));
      return { email: sess.email };
    }),
    signOut: safe(async () => { sess = null; store.set(KEY, null); return { ok: true }; }),
    account: safe(() => fn('account', null, 'GET')),
    dgToken: safe(() => fn('dg-token')),
    coach: safe(body => fn('coach', body)),
    usage: safe(minutes => fn('usage', { minutes })),
    profilesList: safe(() => rest('call_profiles?select=*&order=updated_at.desc')),
    profileSave: safe(p => rest('call_profiles', 'POST', prof(p)).then(r => r[0])),
    profileDelete: safe(id => rest('call_profiles?id=eq.' + encodeURIComponent(id), 'DELETE')),
    dealsList: safe(() => rest('deals?select=*&order=updated_at.desc')),
    dealSave: safe(d => rest('deals', 'POST', prof(d)).then(r => r[0])),
    dealDelete: safe(id => rest('deals?id=eq.' + encodeURIComponent(id), 'DELETE')),
    dealCalls: safe(id => rest('deal_calls?select=*&order=called_at.desc&deal_id=eq.' + encodeURIComponent(id))),
    dealCallAdd: safe(c => rest('deal_calls', 'POST', c).then(r => r[0])),
    // The Fathom key stays in this browser and is only passed through our server to Fathom.
    fathomKeySet: safe(async k => { k = String(k || '').trim(); store.set(FATHOM, k || null); return { ok: true, connected: !!k }; }),
    fathomStatus: safe(async () => ({ connected: !!store.get(FATHOM) })),
    fathomMeetings: safe(async cursor => {
      const r = await fn('tools', { kind: 'fathom', key: store.get(FATHOM) || '', cursor });
      if (r.error) throw new Error(r.error);
      return r;
    }),
    fetchSite: safe(async url => { const r = await fn('tools', { kind: 'site', url }); if (r.error) throw new Error(r.error); return r; }),
    transcribe: safe(async ({ data, mime, lang }) => {
      const t = await fn('dg-token');
      if (t.error) throw new Error(t.error);
      const q = new URLSearchParams({ model: 'nova-3', smart_format: 'true', diarize: 'true', paragraphs: 'true', language: lang || 'en' });
      const body = data instanceof Blob ? await blobToB64(data) : data;
      const r = await fetch('https://api.deepgram.com/v1/listen?' + q, { method: 'POST', headers: { Authorization: 'Bearer ' + t.token, 'Content-Type': mime || 'audio/webm' }, body });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.err_msg || ('Transcription failed ' + r.status));
      const alt = d.results?.channels?.[0]?.alternatives?.[0] || {};
      return { text: alt.paragraphs?.transcript || alt.transcript || '' };
    }),
    setTop: async () => ({ ok: true }),
    setHidden: async () => ({ ok: true }),
    copy: async t => { try { await navigator.clipboard.writeText(t); } catch (e) {} return { ok: true }; },
    open: async url => { if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener'); return { ok: true }; },
    version: async () => 'web'
  };
})();
