const { contextBridge, ipcRenderer } = require('electron');
const call = ch => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('app', {
  onSignedIn: cb => ipcRenderer.on('signed-in', (_e, d) => cb(d)),
  authState: call('auth-state'), authSend: call('auth-send'), authVerify: call('auth-verify'), signOut: call('sign-out'),
  account: call('account'), dgToken: call('dg-token'), coach: call('coach'), usage: call('usage'),
  profilesList: call('profiles-list'), profileSave: call('profile-save'), profileDelete: call('profile-delete'),
  dealsList: call('deals-list'), dealSave: call('deal-save'), dealDelete: call('deal-delete'), dealCalls: call('deal-calls'), dealCallAdd: call('deal-call-add'),
  fathomKeySet: call('fathom-key-set'), fathomStatus: call('fathom-status'), fathomMeetings: call('fathom-meetings'),
  transcribe: call('transcribe'), fetchSite: call('fetch-site'),
  setTop: call('set-top'), setHidden: call('set-hidden'), copy: call('copy'), open: call('open'), version: call('version')
});
