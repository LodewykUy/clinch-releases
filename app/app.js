const $ = id => document.getElementById(id);
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const A = window.app;

// ---------- local preferences ----------
const PREF_DEFAULTS = { name: '', lang: 'en', includeMic: true, hidden: true, onTop: true, activeProfile: '', activeDeal: '', soundChecked: false };
let P;
try { P = { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem('ccPrefs') || '{}') }; } catch (e) { P = { ...PREF_DEFAULTS }; }
const savePrefs = () => { try { localStorage.setItem('ccPrefs', JSON.stringify(P)); } catch (e) {} };

let acct = null;        // server account state
let profiles = [];      // synced call profiles
let deals = [];         // follow-up memory, newest first
const profile = () => profiles.find(p => p.id === P.activeProfile) || profiles[0];

// ---------- views ----------
const VIEWS = ['vLogin', 'vOnboard', 'vCall', 'vSettings'];
function show(v) { VIEWS.forEach(x => { $(x).hidden = x !== v; }); }
function obStep(n) {
  $('obCancel').hidden = !(n === 1 && builderReturn === 'settings');
  [1, 2, 3].forEach(i => { $('ob' + i).hidden = i !== n; $('st' + i).className = i <= n ? 'on' : ''; });
  show('vOnboard');
}
function msg(el, level, text) { $(el).className = 'msg ' + (level || ''); $(el).textContent = text || ''; }
function applyWindow() { A.setHidden(P.hidden); A.setTop(P.onTop); }

// ---------- boot ----------
async function boot() {
  applyWindow();
  $('ver').textContent = 'Version ' + (await A.version());
  const st = await A.authState();
  if (!st || st.error) return showLogin();
  await afterSignIn();
}
async function afterSignIn() {
  const a = await A.account();
  if (a.error) { if (a.code === 'auth') return showLogin(); msg('loginMsg', 'error', a.error); return showLogin(); }
  acct = a;
  const list = await A.profilesList();
  profiles = Array.isArray(list) ? list : [];
  const dl = await A.dealsList();
  deals = Array.isArray(dl) ? dl : [];
  renderProfileSelect(); renderDealSelect(); renderPlan();
  if (!profiles.length) { $('bName').value = P.name; return obStep(1); }
  if (!P.soundChecked) return obStep(2);
  show('vCall');
}

// ---------- sign in ----------
function showLogin() { $('loginEmail').hidden = false; $('loginCode').hidden = true; show('vLogin'); }
$('sendCode').onclick = async () => {
  const email = $('email').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return msg('loginMsg', 'error', 'Enter a valid email.');
  $('sendCode').disabled = true; msg('loginMsg', '', 'Sending…');
  const r = await A.authSend(email);
  $('sendCode').disabled = false;
  if (r.error) return msg('loginMsg', 'error', r.error);
  $('sentTo').textContent = email; $('loginEmail').hidden = true; $('loginCode').hidden = false;
  msg('loginMsg', '', 'Check your inbox (and spam). The code expires in an hour.'); $('code').focus();
};
$('email').onkeydown = e => { if (e.key === 'Enter') $('sendCode').click(); };
$('code').onkeydown = e => { if (e.key === 'Enter') $('verify').click(); };
$('back').onclick = showLogin;
$('verify').onclick = async () => {
  const code = $('code').value.replace(/\D/g, '');
  if (code.length < 6) return msg('loginMsg', 'error', 'Enter the code from the email.');
  $('verify').disabled = true; msg('loginMsg', '', 'Signing in…');
  const r = await A.authVerify($('sentTo').textContent, code);
  $('verify').disabled = false;
  if (r.error) return msg('loginMsg', 'error', 'That code did not work. Check it, or request a new one.');
  msg('loginMsg', '', ''); await afterSignIn();
};

// ---------- plan / billing ----------
function daysLeft(iso) { return Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 864e5)); }
function renderPlan() {
  if (!acct) return;
  const b = $('planBanner');
  const capHrs = Math.round(acct.minutes_cap / 60);
  if (!acct.active) {
    b.innerHTML = `<div class="banner err"><span>${acct.status === 'trial' ? 'Your free trial has ended.' : 'Your subscription is not active.'}</span><button class="primary" data-billing>Subscribe</button></div>`;
  } else if (acct.status === 'trial') {
    const d = daysLeft(acct.trial_ends_at);
    b.innerHTML = `<div class="banner"><span>Free trial: ${d} day${d === 1 ? '' : 's'} left</span><button data-billing>Subscribe</button></div>`;
  } else if (acct.minutes_cap > 0 && acct.minutes_used >= acct.minutes_cap * 0.9) {
    b.innerHTML = `<div class="banner"><span>${acct.minutes_used} of ${capHrs * 60} call minutes used this month.</span></div>`;
  } else b.innerHTML = '';
  $('start').disabled = !acct.active;
  $('obBanner').innerHTML = acct.active ? '' : b.innerHTML;
  $('aEmail').textContent = acct.email || '';
  $('aPlan').textContent = acct.status === 'trial' ? `Free trial (${daysLeft(acct.trial_ends_at)} days left)`
    : acct.active ? (acct.status === 'cancelled' ? 'Cancelled, active until ' + new Date(acct.ends_at).toLocaleDateString() : 'Active') : 'Not active';
  $('aMins').textContent = acct.minutes_cap > 0 ? `${acct.minutes_used} / ${acct.minutes_cap} min` : `${acct.minutes_used} min · unlimited`;
  $('aBilling').textContent = acct.portal_url ? 'Manage billing' : 'Subscribe';
}
function openBilling() {
  const url = acct?.portal_url || acct?.checkout_url;
  if (url) A.open(url); else msg('status', 'warn', 'Billing is not set up yet.');
}
document.addEventListener('click', e => { if (e.target.closest('[data-billing]')) openBilling(); });
$('aBilling').onclick = openBilling;
$('aSignOut').onclick = async () => { await A.signOut(); acct = null; profiles = []; showLogin(); };
// Refresh plan when the window regains focus (e.g. after paying in the browser).
window.addEventListener('focus', async () => {
  if (!acct) return;
  const a = await A.account(); if (!a.error) { acct = a; renderPlan(); }
});

// ---------- profile builder (onboarding step 1) ----------
let voiceNote = null, recState = null, builderReturn = null;
$('bRec').onclick = async () => {
  if (recState) { recState.rec.stop(); return; }
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [], rec = new MediaRecorder(st, { mimeType: 'audio/webm;codecs=opus' }), t0 = Date.now();
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      st.getTracks().forEach(t => t.stop()); clearInterval(recState.tick); recState = null;
      voiceNote = new Blob(chunks, { type: 'audio/webm' });
      $('bRec').textContent = '● Re-record'; $('bRecMsg').textContent = `Voice note ready (${Math.round((Date.now() - t0) / 1000)}s)`;
    };
    rec.start(500);
    recState = { rec, tick: setInterval(() => { $('bRecMsg').textContent = `Recording… ${Math.round((Date.now() - t0) / 1000)}s`; }, 500) };
    $('bRec').textContent = '■ Stop';
  } catch (e) { $('bRecMsg').textContent = 'Mic blocked: ' + e.message; }
};
async function transcribeBlob(blob, mime) {
  const r = await A.transcribe({ data: await blob.arrayBuffer(), mime: mime || blob.type || 'audio/webm', lang: P.lang });
  if (r.error) throw new Error(r.error);
  return r.text;
}
$('bBuild').onclick = async () => {
  const say = (t, l) => msg('bMsg', l, t);
  P.name = $('bName').value.trim() || P.name; savePrefs();
  const btn = $('bBuild'); btn.disabled = true;
  try {
    if (!acct?.active) throw new Error('Your trial or subscription has ended. Subscribe in Settings.');
    const parts = [];
    const industry = $('bIndustry').value.trim(), site = $('bSite').value.trim(), offer = $('bOffer').value.trim();
    if (industry) parts.push('INDUSTRY: ' + industry);
    if (offer) parts.push('OFFER (in their words): ' + offer);
    if (site) {
      say('Reading your website…');
      const r = await A.fetchSite(site);
      parts.push(r.error ? `WEBSITE ${site}: could not be read` : `WEBSITE ${site}:\n${r.text}`);
    }
    if (voiceNote) { say('Transcribing your voice note…'); parts.push('VOICE NOTE FROM THE SELLER:\n' + await transcribeBlob(voiceNote)); }
    const files = [...$('bFiles').files];
    for (const [i, f] of files.entries()) {
      say(`Reading call ${i + 1} of ${files.length}…`);
      const text = /\.(txt|vtt|srt|md)$/i.test(f.name) ? await f.text() : await transcribeBlob(f, f.type);
      parts.push(`PREVIOUS CALL (${f.name}):\n` + text.slice(0, 20000));
    }
    if (!parts.length) throw new Error('Give it at least one thing: industry, website, offer, voice note or a call.');
    say('Building your call sequence and objection answers… (about 30–60 seconds)');
    const r = await A.coach({ kind: 'build', material: parts.join('\n\n'), name: P.name });
    if (r.error) throw new Error(r.error);
    const j = r.result || {};
    const saved = await A.profileSave({ name: j.name || industry || 'My offer', goal: j.goal || '', offer: j.offer || '', proof: j.proof || '', rules: j.rules || '', playbook: j.playbook || '' });
    if (!saved || saved.error) throw new Error(saved?.error || 'Could not save the profile');
    profiles.unshift(saved); P.activeProfile = saved.id; savePrefs(); renderProfileSelect();
    say('✓ Profile built: ' + saved.name, 'ok');
    voiceNote = null; $('bRecMsg').textContent = ''; $('bFiles').value = '';
    if (builderReturn === 'settings') { builderReturn = null; openSettings(); }
    else setTimeout(() => obStep(P.soundChecked ? 3 : 2), 700);
  } catch (e) { say('Could not build: ' + (e.message || e), 'error'); }
  finally { btn.disabled = false; }
};

// ---------- sound check (onboarding step 2) ----------
const passed = { spk: false, mic: false };
function setTest(id, ok, text) {
  $(id).className = 'test ' + (ok === true ? 'pass' : ok === false ? 'fail' : '');
  $(id).querySelector('.ic').textContent = ok === true ? '✓' : ok === false ? '!' : $(id).querySelector('.ic').textContent;
  $(id + 'Msg').textContent = text;
  $('obDone').disabled = !(passed.spk && passed.mic);
}
async function peakLevel(stream, ms, onLevel, during) {
  const ctx = new AudioContext(), an = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize); let peak = 0;
  const stopExtra = during ? during(ctx) : null;
  const t0 = performance.now();
  await new Promise(res => {
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let rms = 0; for (const v of buf) rms += v * v; rms = Math.sqrt(rms / buf.length);
      peak = Math.max(peak, rms); onLevel && onLevel(rms);
      performance.now() - t0 < ms ? requestAnimationFrame(tick) : res();
    };
    tick();
  });
  stopExtra && stopExtra(); await ctx.close();
  return peak;
}
$('runSpk').onclick = async () => {
  setTest('tSpk', null, 'Listening… you should hear a beep.');
  try {
    const disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    disp.getVideoTracks().forEach(t => t.stop());
    const stream = new MediaStream(disp.getAudioTracks());
    const beep = ctx => {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      g.gain.value = 0.12; osc.frequency.value = 660; osc.connect(g).connect(ctx.destination); osc.start();
      setTimeout(() => { try { osc.stop(); } catch (e) {} }, 1200);
      return () => { try { osc.stop(); } catch (e) {} };
    };
    const peak = await peakLevel(stream, 4000, null, beep);
    stream.getTracks().forEach(t => t.stop());
    passed.spk = peak > 0.01;
    setTest('tSpk', passed.spk, passed.spk ? 'It can hear your computer sound.'
      : "Didn't hear anything. Make your headphones the Windows default speaker, or play a YouTube video and press Test again.");
  } catch (e) { passed.spk = false; setTest('tSpk', false, 'Could not capture computer sound: ' + e.message); }
};
$('runMic').onclick = async () => {
  setTest('tMic', null, 'Say "testing, one two three"…');
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const peak = await peakLevel(st, 4000, rms => { $('micBar').style.width = Math.min(100, rms * 600) + '%'; });
    st.getTracks().forEach(t => t.stop()); $('micBar').style.width = '0';
    passed.mic = peak > 0.03;
    setTest('tMic', passed.mic, passed.mic ? 'It can hear you.' : "Too quiet. Check your headset mic is the Windows default input, then try again.");
  } catch (e) { passed.mic = false; setTest('tMic', false, 'Microphone blocked: ' + e.message); }
};
$('obDone').onclick = () => { P.soundChecked = true; savePrefs(); obStep(3); };
$('obSkip').onclick = () => { obStep(3); };
$('toCall').onclick = () => show('vCall');

// ---------- call ----------
let sessions = [], lines = [], interim = { them: '', you: '' }, lastSuggestedAt = 0;
let busy = false, pending = false, live = false, startedAt = 0, usageTimer = null;

function renderProfileSelect() {
  $('profile').innerHTML = profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (profile()) $('profile').value = profile().id;
}
$('profile').onchange = () => { P.activeProfile = $('profile').value; savePrefs(); };

function setStatus(level, text) {
  msg('status', level, text);
  if (level === 'live') { $('pill').className = 'pill live'; $('pill').textContent = 'Live'; }
  else if (level === 'error') { $('pill').className = 'pill error'; $('pill').textContent = 'Problem'; }
  else if (!live) { $('pill').className = 'pill'; $('pill').textContent = 'Idle'; }
}

$('start').onclick = async () => {
  if (!acct?.active) return setStatus('error', 'Your trial or subscription has ended. Press Subscribe.');
  if (!profile()) return setStatus('error', 'Build a profile first (Settings).');
  try {
    const tok = await A.dgToken();
    if (tok.error) throw new Error(tok.error);
    const disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    disp.getVideoTracks().forEach(t => t.stop());
    if (!disp.getAudioTracks().length) throw new Error('No computer sound available');
    lines = []; interim = { them: '', you: '' }; lastSuggestedAt = 0;
    $('history').innerHTML = ''; $('stage').innerHTML = ''; renderTx();
    openStream(new MediaStream(disp.getAudioTracks()), 'them', tok.token);
    if (P.includeMic) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        const tok2 = await A.dgToken();
        if (tok2.error) throw new Error(tok2.error);
        openStream(mic, 'you', tok2.token);
      } catch (e) { setStatus('warn', 'Mic not available – transcribing the prospect only.'); }
    }
    live = true; startedAt = Date.now();
    $('start').hidden = true; $('stop').hidden = false;
    setStatus('live', 'Connecting…');
    usageTimer = setInterval(async () => {
      const u = await A.usage(1);
      if (u && !u.error) { acct.minutes_used = u.minutes_used; if (u.over) { stopCall(); setStatus('error', "You've reached this month's call time."); } }
    }, 60000);
  } catch (e) { setStatus('error', 'Could not start: ' + (e.message || e)); }
};
function stopCall() {
  clearInterval(usageTimer); usageTimer = null;
  while (sessions.length) {
    const s = sessions.pop(); clearInterval(s.ka);
    try { if (s.rec.state !== 'inactive') s.rec.stop(); } catch (e) {}
    try { if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: 'CloseStream' })); s.ws.close(1000); } catch (e) {}
    s.stream.getTracks().forEach(t => t.stop());
  }
  live = false; $('start').hidden = false; $('stop').hidden = true;
}
$('stop').onclick = () => { stopCall(); setStatus('', `Stopped. ${Math.max(1, Math.round((Date.now() - startedAt) / 60000))} min call.`); renderPlan(); if (lines.length >= 4) showSaveCall(); };

function openStream(stream, who, token) {
  const q = new URLSearchParams({ model: 'nova-3', language: P.lang || 'en', smart_format: 'true', punctuate: 'true',
    interim_results: 'true', endpointing: '400', utterance_end_ms: '1200', vad_events: 'true' });
  const ws = new WebSocket('wss://api.deepgram.com/v1/listen?' + q, ['bearer', token]);
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const s = { who, ws, rec, stream, ka: null };
  sessions.push(s);
  rec.ondataavailable = e => { if (e.data.size && ws.readyState === 1) ws.send(e.data); };
  ws.onopen = () => {
    rec.start(250);
    s.ka = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'KeepAlive' })); }, 8000);
    if (who === 'them') setStatus('live', 'Listening');
  };
  ws.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.type === 'Results') {
      const text = d.channel?.alternatives?.[0]?.transcript || '';
      if (text) onTranscript({ who, text, isFinal: !!d.is_final, speechFinal: !!d.speech_final });
    } else if (d.type === 'UtteranceEnd' && who === 'them') maybeSuggest();
  };
  ws.onerror = () => setStatus('error', 'Transcription connection problem. Press Stop, then Start again.');
  ws.onclose = ev => { clearInterval(s.ka); if (live && ev.code !== 1000 && ev.code !== 1005) setStatus('error', 'Transcription disconnected. Press Stop, then Start again.'); };
}

function onTranscript({ who, text, isFinal, speechFinal }) {
  if (!isFinal) { interim[who] = text; renderTx(); return; }
  interim[who] = '';
  const last = lines[lines.length - 1];
  if (last && last.who === who) last.text += ' ' + text; else lines.push({ who, text });
  renderTx();
  if (who === 'them' && speechFinal) maybeSuggest();
}
function renderTx() {
  const el = $('tx'), stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  const row = (who, text, cls = '') => `<p class="${who} ${cls}"><b>${who === 'them' ? 'Prospect' : 'You'}</b> ${esc(text)}</p>`;
  el.innerHTML = lines.slice(-80).map(l => row(l.who, l.text)).join('') + ['them', 'you'].filter(w => interim[w]).map(w => row(w, interim[w], 'interim')).join('');
  if (stick) el.scrollTop = el.scrollHeight;
}

function maybeSuggest() {
  const fresh = lines.slice(lastSuggestedAt).filter(l => l.who === 'them').map(l => l.text).join(' ');
  if (fresh.split(/\s+/).filter(Boolean).length < 4) return;
  suggest(false);
}
async function suggest(force) {
  if (busy) { pending = true; return; }
  if (!acct?.active) return setStatus('error', 'Your trial or subscription has ended.');
  const p = profile(); if (!p) return setStatus('error', 'Build a profile first (Settings).');
  busy = true; pending = false;
  const mark = lines.length, t0 = performance.now(), cur = $('current');
  cur.querySelector('.say')?.classList.add('thinking');
  if (force && !cur.querySelector('.say')) cur.innerHTML = '<div class="empty">Thinking…</div>';
  try {
    const r = await A.coach({ kind: 'suggest', profile: { goal: p.goal, offer: p.offer, proof: p.proof, rules: p.rules, playbook: p.playbook }, lines: lines.slice(-40), name: P.name, force, deal: dealCtx() });
    if (r.error) throw new Error(r.error);
    const j = r.result || {};
    lastSuggestedAt = mark;
    if (j.stage) $('stage').innerHTML = 'Stage: <b>' + esc(j.stage) + '</b>';
    if (j.moment === 'none' && !force) cur.querySelector('.say')?.classList.remove('thinking');
    else showCard(j, Math.round(performance.now() - t0));
  } catch (e) {
    setStatus('error', e.message || String(e));
    cur.querySelector('.say')?.classList.remove('thinking');
  } finally { busy = false; if (pending) maybeSuggest(); }
}
function showCard(j, ms) {
  const cur = $('current'), old = cur.querySelector('.say');
  if (old) { old.classList.remove('thinking'); $('history').prepend(old); }
  const moment = /objection|question|buying_signal|stall|guide/.test(j.moment) ? j.moment : 'question';
  cur.innerHTML = `<div class="say ${moment}"><div class="tag">${moment === 'guide' ? 'Next: ' : ''}${esc(j.label || moment.replace('_', ' '))}</div>
    ${j.tone ? `<div class="tone">🎙 ${esc(j.tone)}</div>` : ''}<div class="line">${esc(j.say)}</div>${j.next ? `<div class="next">Then ask: ${esc(j.next)}</div>` : ''}
    <div class="meta">${(ms / 1000).toFixed(1)}s</div></div>`;
  while ($('history').children.length > 15) $('history').lastChild.remove();
}
$('help').onclick = () => suggest(true);
document.addEventListener('keydown', e => { if (e.ctrlKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); suggest(true); } });
$('copy').onclick = () => {
  A.copy(lines.map(l => (l.who === 'them' ? 'Prospect: ' : 'Me: ') + l.text).join('\n'));
  $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy'; }, 1200);
};

// ---------- settings ----------
const PREF_TEXT = ['name', 'lang'], PREF_CHECK = ['includeMic', 'hidden', 'onTop'];
function openSettings() {
  PREF_TEXT.forEach(k => { $(k).value = P[k]; });
  PREF_CHECK.forEach(k => { $(k).checked = !!P[k]; });
  renderProfiles(); renderPlan(); msg('profMsg', '', ''); renderDealsList(); refreshFathom();
  show('vSettings');
}
$('openSettings').onclick = openSettings;
$('closeSettings').onclick = async () => {
  PREF_TEXT.forEach(k => { P[k] = $(k).value.trim(); });
  PREF_CHECK.forEach(k => { P[k] = $(k).checked; });
  savePrefs(); applyWindow();
  if (dirty) await saveAllProfiles();
  renderProfileSelect(); show('vCall');
};
let dirty = false;
function renderProfiles() {
  $('profiles').innerHTML = profiles.map((p, i) => `
    <div class="prof" data-i="${i}">
      <label>Profile name</label><input data-k="name" value="${esc(p.name)}">
      <label>Goal of the call</label><textarea data-k="goal" rows="2">${esc(p.goal)}</textarea>
      <label>What you sell</label><textarea data-k="offer" rows="2">${esc(p.offer)}</textarea>
      <label>Proof you may use (real results only)</label><textarea data-k="proof" rows="3">${esc(p.proof)}</textarea>
      <label>Rules (never say / compliance)</label><textarea data-k="rules" rows="3">${esc(p.rules)}</textarea>
      <label>Call sequence & objection answers</label><textarea data-k="playbook" rows="10">${esc(p.playbook)}</textarea>
      <div class="btns"><button data-del="${i}">Delete profile</button></div>
    </div>`).join('') || '<p class="foot">No profiles yet.</p>';
}
$('profiles').addEventListener('input', () => { dirty = true; });
function readProfiles() {
  document.querySelectorAll('.prof').forEach(el => {
    const p = profiles[+el.dataset.i];
    if (p) el.querySelectorAll('[data-k]').forEach(f => { p[f.dataset.k] = f.value.trim(); });
  });
}
async function saveAllProfiles() {
  readProfiles(); msg('profMsg', '', 'Saving…');
  for (const [i, p] of profiles.entries()) {
    const r = await A.profileSave({ id: p.id, name: p.name, goal: p.goal, offer: p.offer, proof: p.proof, rules: p.rules, playbook: p.playbook });
    if (r && !r.error) profiles[i] = r; else return msg('profMsg', 'error', 'Save failed: ' + (r?.error || ''));
  }
  dirty = false; msg('profMsg', 'ok', 'Saved ✓'); renderProfileSelect();
}
$('saveProfiles').onclick = saveAllProfiles;
$('profiles').onclick = async e => {
  const d = e.target.dataset.del; if (d === undefined) return;
  const p = profiles[+d];
  if (!confirmDelete(e.target)) return;
  readProfiles();
  if (p.id) { const r = await A.profileDelete(p.id); if (r && r.error) return msg('profMsg', 'error', r.error); }
  profiles.splice(+d, 1); renderProfiles(); renderProfileSelect();
};
function confirmDelete(btn) {   // two-click confirm, no blocking dialogs
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1'; btn.textContent = 'Click again to delete';
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete profile'; }, 3000);
  return false;
}
$('addBlank').onclick = async () => {
  readProfiles();
  const r = await A.profileSave({ name: 'New profile' });
  if (r && !r.error) { profiles.unshift(r); renderProfiles(); renderProfileSelect(); }
};
$('newProfile').onclick = () => { builderReturn = 'settings'; $('bName').value = P.name; obStep(1); };
$('obCancel').onclick = () => { builderReturn = null; openSettings(); };
$('redoSound').onclick = () => obStep(2);


// ---------- follow-up calls (deals) ----------
const deal = () => deals.find(d => d.id === P.activeDeal);
const dealCtx = () => { const d = deal(); return d ? { name: d.name, stage: d.stage, summary: d.summary, next_plan: d.next_plan, calls: d.calls } : undefined; };
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

function renderDealSelect() {
  if (P.activeDeal && !deal()) P.activeDeal = '';
  $('deal').innerHTML = `<option value="">New prospect (first call)</option>` +
    deals.map(d => `<option value="${esc(d.id)}">Follow-up: ${esc(d.name)} · call ${d.calls + 1}</option>`).join('');
  $('deal').value = P.activeDeal || '';
  renderDealBox();
}
$('deal').onchange = () => { P.activeDeal = $('deal').value; savePrefs(); renderDealBox(); };
function renderDealBox() {
  const d = deal();
  if (!d || !(d.summary || d.next_plan)) { $('dealBox').innerHTML = ''; return; }
  $('dealBox').innerHTML = `<div class="deal"><b>Last time with ${esc(d.name)} · ${esc(d.stage || '')}</b>
    <pre>${esc(d.next_plan || '')}</pre>
    <button class="linkbtn" id="dealMore" style="margin-top:6px">Show everything we know</button>
    <pre id="dealAll" hidden>${esc(d.summary || '')}</pre></div>`;
  $('dealMore').onclick = () => { const h = $('dealAll').hidden; $('dealAll').hidden = !h; $('dealMore').textContent = h ? 'Hide' : 'Show everything we know'; };
}

function transcriptText(ls) { return ls.map(l => (l.who === 'them' ? 'PROSPECT: ' : (P.name || 'ME').toUpperCase() + ': ') + l.text).join('\n'); }

// Run the recap and store it on a deal (creating the deal if needed).
async function recapIntoDeal({ dealId, newName, transcript, source, title, when }) {
  let d = deals.find(x => x.id === dealId);
  if (!d) {
    const name = (newName || '').trim();
    if (!name) throw new Error('Give the prospect or company a name.');
    d = await A.dealSave({ name, profile_id: profile()?.id || null });
    if (!d || d.error) throw new Error(d?.error || 'Could not create the deal');
    deals.unshift(d);
  }
  const r = await A.coach({ kind: 'recap', profile: profile() || {}, deal: { name: d.name, summary: d.summary, calls: d.calls }, transcript, name: P.name });
  if (r.error) throw new Error(r.error);
  const j = r.result || {};
  const upd = await A.dealSave({ id: d.id, name: d.name, summary: j.summary || d.summary, stage: j.stage || d.stage, next_plan: j.next_plan || d.next_plan, calls: (d.calls || 0) + 1 });
  if (!upd || upd.error) throw new Error(upd?.error || 'Could not save the deal');
  await A.dealCallAdd({ deal_id: d.id, source, title: title || '', recap: j.call_recap || '', called_at: when || new Date().toISOString() });
  deals = [upd, ...deals.filter(x => x.id !== upd.id)];
  return { deal: upd, recap: j.call_recap || '' };
}

function showSaveCall() {
  const d = deal();
  $('current').innerHTML = `<div class="saveCall">
    <b>Save this call for the follow-up?</b>
    <p class="foot" style="margin:4px 0 8px">Clinch writes the notes and plans the next call. Only the summary is kept, not the transcript.</p>
    <input id="scName" placeholder="Prospect or company name" value="${esc(d ? d.name : '')}" ${d ? 'disabled' : ''}>
    <div class="btns"><button id="scSave" class="primary">Save and plan the next call</button><button id="scSkip">Don't save</button></div>
    <p id="scMsg" class="msg"></p></div>`;
  $('scSkip').onclick = () => { $('current').innerHTML = '<div class="empty">Call not saved.</div>'; };
  $('scSave').onclick = async () => {
    $('scSave').disabled = true; msg('scMsg', '', 'Writing the recap… (about 20 seconds)');
    try {
      const r = await recapIntoDeal({ dealId: d?.id, newName: $('scName').value, transcript: transcriptText(lines), source: 'clinch', title: 'Call on ' + fmtDate(new Date().toISOString()) });
      P.activeDeal = r.deal.id; savePrefs(); renderDealSelect();
      $('current').innerHTML = `<div class="deal"><b>Saved · ${esc(r.deal.name)} · ${esc(r.deal.stage)}</b><pre>${esc(r.recap)}</pre></div>`;
    } catch (e) { $('scSave').disabled = false; msg('scMsg', 'error', e.message || String(e)); }
  };
}

// Settings: Fathom + imports + deal list
async function refreshFathom() {
  const st = await A.fathomStatus();
  msg('fathomMsg', st.connected ? 'ok' : '', st.connected ? 'Fathom connected ✓' : 'Not connected');
  $('fathomKey').value = '';
}
$('fathomSave').onclick = async () => {
  const r = await A.fathomKeySet($('fathomKey').value);
  if (r.error) return msg('fathomMsg', 'error', r.error);
  const t = r.connected ? await A.fathomMeetings() : null;
  if (t && t.error) { msg('fathomMsg', 'error', t.error); return; }
  refreshFathom();
};
let impSource = null, impPicked = null, impCursor = null;
function openImport(source) {
  impSource = source; impPicked = null;
  $('impDeal').innerHTML = `<option value="">New deal…</option>` + deals.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  $('impDealName').hidden = false;
  $('impPanel').hidden = false; msg('impMsg', '', '');
}
$('impDeal').onchange = () => { $('impDealName').hidden = !!$('impDeal').value; };
$('impCancel').onclick = () => { $('impPanel').hidden = true; msg('impMsg', '', ''); };
async function loadMeetings(more) {
  msg('impMsg', '', 'Loading your Fathom calls…');
  const r = await A.fathomMeetings(more ? impCursor : undefined);
  if (r.error) { msg('impMsg', 'error', r.error); return; }
  impCursor = r.next; $('moreWrap').hidden = !r.next;
  const html = r.items.map((m, i) => `<div data-m="${i}"><b>${esc(m.title)}</b><small>${fmtDate(m.date)}${m.who ? ' · ' + esc(m.who) : ''}${m.transcript ? '' : ' · no transcript yet'}</small></div>`).join('');
  if (!more) { $('mlist').innerHTML = ''; window.__meetings = []; }
  window.__meetings = (window.__meetings || []).concat(r.items);
  $('mlist').insertAdjacentHTML('beforeend', html.replace(/data-m="(\d+)"/g, (_, i) => `data-m="${+i + window.__meetings.length - r.items.length}"`));
  msg('impMsg', '', r.items.length ? 'Pick the call to import.' : 'No calls found in Fathom.');
}
$('impFathom').onclick = async () => {
  const st = await A.fathomStatus();
  if (!st.connected) return msg('fathomMsg', 'error', 'Paste your Fathom API key and press Connect first.');
  openImport('fathom'); $('mlist').hidden = false; loadMeetings(false);
};
$('moreMeetings').onclick = () => loadMeetings(true);
$('mlist').onclick = e => {
  const el = e.target.closest('[data-m]'); if (!el) return;
  document.querySelectorAll('#mlist [data-m]').forEach(x => x.classList.remove('sel')); el.classList.add('sel');
  impPicked = window.__meetings[+el.dataset.m];
  if (!$('impDeal').value && !$('impDealName').value) $('impDealName').value = (impPicked.who || impPicked.title || '').split(',')[0];
};
$('impFileBtn').onclick = () => $('impFile').click();
$('impFile').onchange = async () => {
  const f = $('impFile').files[0]; if (!f) return;
  openImport('upload'); $('mlist').hidden = true; $('moreWrap').hidden = true;
  impPicked = { title: f.name, date: new Date().toISOString(), transcript: (await f.text()).slice(0, 60000) };
  msg('impMsg', '', `Loaded ${f.name}. Choose the deal, then import.`); $('impFile').value = '';
};
$('impGo').onclick = async () => {
  if (!impPicked) return msg('impMsg', 'error', 'Pick a call first.');
  if (!impPicked.transcript) return msg('impMsg', 'error', 'That call has no transcript yet. Try again once Fathom has processed it.');
  $('impGo').disabled = true; msg('impMsg', '', 'Writing the recap… (about 20 seconds)');
  try {
    const r = await recapIntoDeal({ dealId: $('impDeal').value, newName: $('impDealName').value, transcript: impPicked.transcript, source: impSource, title: impPicked.title, when: impPicked.date || undefined });
    msg('impMsg', 'ok', `✓ Imported into ${r.deal.name}. Pick it under "Follow-up" on the call screen.`);
    $('impPanel').hidden = true; renderDealsList(); renderDealSelect();
  } catch (e) { msg('impMsg', 'error', e.message || String(e)); }
  finally { $('impGo').disabled = false; }
};
function renderDealsList() {
  $('dealsList').innerHTML = deals.map((d, i) => `<div class="dealrow"><div><b>${esc(d.name)}</b><br><small>${esc(d.stage || 'No calls yet')} · ${d.calls} call${d.calls === 1 ? '' : 's'} · ${fmtDate(d.updated_at)}</small></div><button data-deldeal="${i}">Delete</button></div>`).join('') || '<p class="foot">No deals yet. Save a call or import one.</p>';
}
$('dealsList').onclick = async e => {
  const i = e.target.dataset.deldeal; if (i === undefined) return;
  const btn = e.target;
  if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Click again'; setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete'; }, 3000); return; }
  const d = deals[+i]; const r = await A.dealDelete(d.id);
  if (r && r.error) return;
  deals.splice(+i, 1); if (P.activeDeal === d.id) { P.activeDeal = ''; savePrefs(); }
  renderDealsList(); renderDealSelect();
};

boot();
