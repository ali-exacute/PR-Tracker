const KEY = 'pr-tracker-v1';

/* Cloud session object must exist before any save() call during boot */
const cloudSession = {
  unlocked: false,
  token: '',
  passphrase: '',
  key: null,
  saltB64: '',
  lastPush: null,
  lastPull: null,
  lastPushMs: 0,
  lastLocalEditMs: 0,
  lastCloudAt: '',
  pushTimer: null,
  pollTimer: null,
  gistFileSha: null,
  suppressPush: false,
  pushing: false,
  pulling: false
};
const CLOUD_CREDS_KEY = 'pr-tracker-cloud-creds-v1';


const SETTINGS_KEY = 'pr-tracker-settings-v1';
let settings = Object.assign({
  autoBackup: false, backupMinutes: 60, darkMode: false,
  jiraBaseUrl: '',
  azureRepoUrl: '',
  azureMasterPath: 'masters/{branch}',
  azureTempPath: 'master_dev/Temp/v{ver}/{branch}',
  azureSimpleBranches: 'developer',
  savedViews: [],
  cloudGistId: '',
  cloudAutoSync: true,
  cloudRemember: true,
  cloudLiveSync: false
}, readStoredJSON(SETTINGS_KEY, {}));
if (!Array.isArray(settings.savedViews)) settings.savedViews = [];
let backupTimer = null;



const PRIORITIES = ['Critical', 'High', 'Normal', 'Low'];
const DEFAULT_VERSIONS = ['V11+', 'V12+', 'V14+', 'V15+'];
const DEFAULT_TAGS = ['Important', 'Backend', 'Testing'];
const DEFAULT_STATUSES = ['TODO', 'PR Only', "PR'd", 'Rejected', 'Not Required'];
const BACKUP_FILENAME = 'pr-tracker-data.json';

function readStoredJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (e) {
    console.warn(`Could not read ${key} from storage`, e);
    return fallback;
  }
}

function uniqSorted(arr) {
  return [...new Set((arr || []).map(s => String(s || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
function itemName(x) { return x == null ? '' : (typeof x === 'string' ? x : String(x.name || '')); }
function itemColor(x) { return (x && typeof x === 'object' && x.color) ? x.color : ''; }
function toNamedItems(arr) {
  return (arr || []).map(x => {
    if (x && typeof x === 'object' && x.name != null) return { name: String(x.name).trim(), color: x.color || '', active: x.active };
    const n = String(x || '').trim();
    return n ? { name: n, color: '' } : null;
  }).filter(Boolean);
}
function versionNames() { return (data.versions || []).map(itemName); }
function statusNames() { return (data.statuses && data.statuses.length ? data.statuses : DEFAULT_STATUSES.map(s => ({ name: s }))).map(itemName); }
function tagNames() { return (data.tagsCatalog || []).map(itemName); }
function companyNames(activeOnly) {
  return (data.companies || []).filter(c => !activeOnly || c.active !== false).map(c => c.name);
}
function companyObj(name) { return (data.companies || []).find(c => c.name === name); }
function versionObj(name) { return (data.versions || []).find(v => itemName(v) === name); }
function statusObj(name) { return (data.statuses || []).find(s => itemName(s) === name); }
function tagObj(name) { return (data.tagsCatalog || []).find(t => itemName(t) === name); }

function contrastText(hex) {
  if (!hex || hex[0] !== '#' || (hex.length !== 7 && hex.length !== 4)) return '#20242b';
  let h = hex.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? '#20242b' : '#ffffff';
}
function chipStyle(color) {
  if (!color) return '';
  return `background:${color};color:${contrastText(color)}`;
}
function coloredChip(label, color, extraClass = '') {
  const st = chipStyle(color);
  return `<span class="chip ${st ? 'has-color' : ''} ${extraClass}" ${st ? `style="${st}"` : ''}>${esc(label)}</span>`;
}
function coloredTag(label, color) {
  const st = chipStyle(color);
  return `<span class="tag ${st ? 'has-color' : ''}" ${st ? `style="${st}"` : ''}>#${esc(label)}</span>`;
}
function coloredStatus(label) {
  const c = itemColor(statusObj(label));
  const st = chipStyle(c);
  if (st) return `<span class="status has-color" style="${st}">${esc(label)}</span>`;
  return `<span class="status ${statusClass(label)}">${esc(label)}</span>`;
}

function ensureCompany(name, active = true) {
  const n = String(name || '').trim(); if (!n) return;
  if (!data.companies) data.companies = [];
  const existing = data.companies.find(c => c.name === n);
  if (existing) return existing;
  data.companies.push({ name: n, active: !!active, color: '' });
  data.companies.sort((a, b) => a.name.localeCompare(b.name));
  return data.companies.find(c => c.name === n);
}
function suggestTempNames(parent, company) {
  const m = String((parent && (parent.branch || parent.name)) || '').match(/(\d+)/);
  const num = m ? m[1] : 'x';
  const companySlug = String(company || '').replace(/\s+/g, '_');
  const branch = `Temp_${num}_${companySlug}`;
  return { branch, name: branch };
}

/** Rename helpers — update all references */
function renameVersion(oldName, newName) {
  newName = newName.trim();
  if (!newName || newName === oldName) return false;
  if (versionNames().includes(newName)) { alert('Version already exists.'); return false; }
  const obj = versionObj(oldName); if (obj) obj.name = newName;
  data.issues.forEach(i => { if (i.version === oldName) i.version = newName; if (i.reportedVersion === oldName) i.reportedVersion = newName; });
  data.destinations.forEach(d => { if (d.fromVersion === oldName) d.fromVersion = newName; });
  return true;
}
function renameStatus(oldName, newName) {
  newName = newName.trim();
  if (!newName || newName === oldName) return false;
  if (statusNames().includes(newName)) { alert('Status already exists.'); return false; }
  const obj = statusObj(oldName); if (obj) obj.name = newName;
  data.prs.forEach(p => { if (p.status === oldName) p.status = newName; });
  return true;
}
function renameTag(oldName, newName) {
  newName = newName.trim();
  if (!newName || newName === oldName) return false;
  if (tagNames().includes(newName)) { alert('Tag already exists.'); return false; }
  const obj = tagObj(oldName); if (obj) obj.name = newName;
  const swap = arr => { if (!arr) return; for (let i = 0; i < arr.length; i++) if (arr[i] === oldName) arr[i] = newName; };
  data.issues.forEach(i => swap(i.tags));
  data.prs.forEach(p => swap(p.tags));
  return true;
}
function renameCompany(oldName, newName) {
  newName = newName.trim();
  if (!newName || newName === oldName) return false;
  if (companyNames(false).includes(newName)) { alert('Company already exists.'); return false; }
  const obj = companyObj(oldName); if (obj) obj.name = newName;
  data.destinations.forEach(d => { if (d.company === oldName) d.company = newName; });
  data.issues.forEach(i => { if (i.reportedBy === oldName) i.reportedBy = newName; });
  return true;
}

/**
 * Destination model (v4):
 *   kind: 'master' | 'temp'
 *   parentId: null for master; master id for temp
 *   company: null for master; company name for temp
 *   branch: branch name (v14_master, Temp_14_Saman, …)
 *   fromVersion: set on master only; temps inherit from parent
 *   name: display name
 *   active: bool
 */
function migrateData(raw) {
  if (!Array.isArray(raw.versions) || !raw.versions.length) {
    raw.versions = DEFAULT_VERSIONS.map(n => ({ name: n, color: '' }));
  } else {
    raw.versions = toNamedItems(raw.versions);
  }

  // Old destinations.versions[] → fromVersion
  const verNames = (raw.versions || []).map(v => (v && v.name != null) ? v.name : String(v || ''));
  (raw.destinations || []).forEach(d => {
    if (!d.fromVersion && Array.isArray(d.versions) && d.versions.length) {
      let earliest = d.versions[0], earliestIdx = verNames.indexOf(earliest);
      d.versions.forEach(v => {
        const idx = verNames.indexOf(v);
        if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) { earliest = v; earliestIdx = idx }
      });
      d.fromVersion = earliestIdx !== -1 ? earliest : d.versions[0];
    }
    delete d.versions;
  });

  // Promote flat destinations to master/temp if missing kind
  (raw.destinations || []).forEach(d => {
    if (d.kind === 'master' || d.kind === 'temp') return;
    // Heuristic: no company or company was (Shared) → master; else temp without parent
    const company = d.company && d.company !== '(Shared)' ? d.company : null;
    if (!company) {
      d.kind = 'master';
      d.company = null;
      d.parentId = null;
      if (!d.fromVersion) d.fromVersion = (raw.versions[0] && (raw.versions[0].name || raw.versions[0])) || 'V14+';
    } else {
      d.kind = 'temp';
      d.company = company;
      d.parentId = d.parentId || null; // may be null until user links
      // keep fromVersion as fallback if no parent yet
    }
    if (!d.branch) d.branch = d.name || '';
  });

  // Catalogs
  const cos = (raw.destinations || []).map(d => d.company).filter(Boolean);
  const tagsI = (raw.issues || []).flatMap(i => i.tags || []);
  const tagsP = (raw.prs || []).flatMap(p => p.tags || []);

  // companies: migrate string[] → {name, active}[]
  const oldCos = raw.companies || [];
  const asObjects = oldCos.map(c => {
    if (c && typeof c === 'object' && c.name) return { name: String(c.name).trim(), active: c.active !== false, color: c.color || '' };
    return { name: String(c || '').trim(), active: true, color: '' };
  }).filter(c => c.name);
  const known = new Set(asObjects.map(c => c.name));
  cos.forEach(name => {
    if (name && !known.has(name)) { asObjects.push({ name, active: true }); known.add(name); }
  });
  asObjects.sort((a, b) => a.name.localeCompare(b.name));
  raw.companies = asObjects;

  const existingTags = toNamedItems(raw.tagsCatalog || []);
  const tagMap = new Map(existingTags.map(t => [t.name, t]));
  [...DEFAULT_TAGS, ...tagsI, ...tagsP].forEach(n => {
    n = String(n || '').trim();
    if (n && !tagMap.has(n)) tagMap.set(n, { name: n, color: '' });
  });
  raw.tagsCatalog = [...tagMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  const statusFromPrs = (raw.prs || []).map(p => p.status).filter(Boolean);
  let statuses = toNamedItems(raw.statuses || []);
  if (!statuses.length) {
    const names = [...DEFAULT_STATUSES];
    statusFromPrs.forEach(s => { if (!names.includes(s)) names.push(s); });
    statuses = names.map(n => ({ name: n, color: '' }));
  } else {
    statusFromPrs.forEach(s => {
      if (!statuses.some(x => x.name === s)) statuses.push({ name: s, color: '' });
    });
  }
  raw.statuses = statuses;

  // companies already objects; ensure color field
  raw.companies = (raw.companies || []).map(c => {
    if (c && typeof c === 'object') return { name: String(c.name || '').trim(), active: c.active !== false, color: c.color || '' };
    return { name: String(c || '').trim(), active: true, color: '' };
  }).filter(c => c.name);

  // Timestamps on issues, PRs, destinations
  const stamp = new Date().toISOString();
  (raw.issues || []).forEach(i => { if (!i.createdAt) i.createdAt = stamp; if (!i.updatedAt) i.updatedAt = i.createdAt; });
  (raw.prs || []).forEach(p => { if (!p.createdAt) p.createdAt = stamp; if (!p.updatedAt) p.updatedAt = p.createdAt; });
  (raw.destinations || []).forEach(d => { if (!d.createdAt) d.createdAt = stamp; if (!d.updatedAt) d.updatedAt = d.createdAt; });

  return raw;
}

let data = readStoredJSON(KEY, null);
if (!data) {
  data = {
    versions: DEFAULT_VERSIONS.map(n => ({ name: n, color: '' })),
    companies: [{ name: 'Saman', active: true, color: '' }, { name: 'Mellat', active: true, color: '' }, { name: 'Razi', active: true, color: '' }, { name: 'Parsian', active: true, color: '' }, { name: 'Asia', active: true, color: '' }],
    tagsCatalog: DEFAULT_TAGS.map(n => ({ name: n, color: '' })),
    statuses: DEFAULT_STATUSES.map(n => ({ name: n, color: '' })),
    issues: [
      { id: 'i1', jira: 'ABC-123', link: '', description: 'Fix calculation issue', version: 'V14+', priority: 'High', tags: ['Important'], notes: 'Example issue.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'i2', jira: 'ABC-456', link: '', description: 'Update policy validation', version: 'V15+', priority: 'Normal', tags: [], notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    ],
    destinations: [
      { id: 'm14', name: 'v14_master', kind: 'master', company: null, branch: 'v14_master', fromVersion: 'V14+', parentId: null, active: true },
      { id: 'm15', name: 'v15_master', kind: 'master', company: null, branch: 'v15_master', fromVersion: 'V15+', parentId: null, active: true },
      { id: 'mdev', name: 'developer', kind: 'master', company: null, branch: 'developer', fromVersion: 'V11+', parentId: null, active: true },
      { id: 't1', name: 'Temp_14_Saman', kind: 'temp', company: 'Saman', branch: 'Temp_14_Saman', fromVersion: null, parentId: 'm14', active: true },
      { id: 't2', name: 'Temp_14_Parsian', kind: 'temp', company: 'Parsian', branch: 'Temp_14_Parsian', fromVersion: null, parentId: 'm14', active: true },
      { id: 't3', name: 'Temp_15_Asia', kind: 'temp', company: 'Asia', branch: 'Temp_15_Asia', fromVersion: null, parentId: 'm15', active: true },
      { id: 't4', name: 'Temp_15_Razi', kind: 'temp', company: 'Razi', branch: 'Temp_15_Razi', fromVersion: null, parentId: 'm15', active: true }
    ],
    prs: [
      { id: 'p1', issueId: 'i1', destinationId: 'm14', status: "PR'd", tags: ['Important'], notes: 'On master' },
      { id: 'p2', issueId: 'i1', destinationId: 't1', status: 'TODO', tags: ['Backend'], notes: 'Saman temp' },
      { id: 'p3', issueId: 'i2', destinationId: 'm15', status: 'PR Only', tags: ['Testing'], notes: '' }
    ]
  };
} else {
  try {
    data = migrateData(data);
  } catch (e) {
    console.error('Migration failed', e);
    alert('Data migration had a problem. Some fields may need a refresh. Error: ' + (e.message || e));
    if (!Array.isArray(data.versions)) data.versions = DEFAULT_VERSIONS.map(n => ({ name: n, color: '' }));
    if (!Array.isArray(data.companies)) data.companies = [];
    if (!Array.isArray(data.statuses)) data.statuses = DEFAULT_STATUSES.map(n => ({ name: n, color: '' }));
    if (!Array.isArray(data.tagsCatalog)) data.tagsCatalog = DEFAULT_TAGS.map(n => ({ name: n, color: '' }));
    if (!Array.isArray(data.issues)) data.issues = [];
    if (!Array.isArray(data.destinations)) data.destinations = [];
    if (!Array.isArray(data.prs)) data.prs = [];
  }
}
try { data = migrateData(data); } catch (e) { console.error(e); }
save();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { console.error('localStorage save failed', e); }
  try {
    if (!cloudSession || cloudSession.suppressPush) return;
    cloudSession.lastLocalEditMs = Date.now();
    if (!cloudSession.unlocked || !cloudSession.key) return;
    if (typeof settings === 'undefined' || settings.cloudAutoSync === false) return;
    if (typeof scheduleCloudPush === 'function') scheduleCloudPush();
  } catch (e) { /* settings/cloud not ready yet during boot */ }
}


function saveSettings() {
  const en = document.getElementById('autoBackupEnabled'), bi = document.getElementById('backupInterval');
  if (en) settings.autoBackup = !!en.checked;
  if (bi) settings.backupMinutes = Number(bi.value) || 60;
  const val = id => { const el = document.getElementById(id); return el ? (el.value || '').trim() : undefined; };
  const j = val('jiraBaseUrl'); if (j !== undefined) settings.jiraBaseUrl = j;
  const a = val('azureRepoUrl'); if (a !== undefined) settings.azureRepoUrl = a;
  const mp = val('azureMasterPath'); if (mp !== undefined) settings.azureMasterPath = mp || 'masters/{branch}';
  const tp = val('azureTempPath'); if (tp !== undefined) settings.azureTempPath = tp || 'master_dev/Temp/v{ver}/{branch}';
  const sb = val('azureSimpleBranches'); if (sb !== undefined) settings.azureSimpleBranches = sb;
  const gid = val('cloudGistId'); if (gid !== undefined) settings.cloudGistId = gid;
  const cas = document.getElementById('cloudAutoSync'); if (cas) settings.cloudAutoSync = !!cas.checked;
  const clr = document.getElementById('cloudRemember'); if (clr) settings.cloudRemember = !!clr.checked;
  settings.cloudLiveSync = false;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  if (settings.cloudRemember === false) clearSavedCloudCreds();
  stopCloudLiveSync();
  scheduleAutoBackup(); updateBackupInfo(); updateCloudSyncUI();
}
function toggleDarkMode(on) { settings.darkMode = !!on; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); applyTheme(); }
function applyTheme() { document.body.classList.toggle('dark', !!settings.darkMode); const x = document.getElementById('darkMode'); if (x) x.checked = !!settings.darkMode; }
let backupDirHandle = null;
let backupFileHandle = null;
let backupToastTimer = null;

function showBackupToast(message) {
  const toast = document.getElementById('backupToast');
  if (!toast) return;
  toast.textContent = message;
  toast.setAttribute('aria-hidden', 'false');
  toast.classList.add('show');
  clearTimeout(backupToastTimer);
  backupToastTimer = setTimeout(() => {
    toast.classList.remove('show');
    toast.setAttribute('aria-hidden', 'true');
  }, 4500);
}

function recordBackup(auto, message = 'Backup saved successfully.') {
  localStorage.setItem('pr-tracker-last-backup', String(Date.now()));
  updateBackupInfo();
  if (!auto) showBackupToast(message);
}

function canUseFileSystemAccess() {
  return !!(window.isSecureContext && (window.showDirectoryPicker || window.showSaveFilePicker));
}
function isFileProtocol() {
  try { return typeof location !== 'undefined' && location.protocol === 'file:'; } catch (e) { return false; }
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pr-tracker-fs', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function backupPayload() {
  return { version: 6, section: 'all', exportedAt: new Date().toISOString(), data, settings: exportableSettings() };
}

async function ensureHandlePermission(handle) {
  if (!handle) return false;
  try {
    let perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return true;
    perm = await handle.requestPermission({ mode: 'readwrite' });
    return perm === 'granted';
  } catch (e) { return false; }
}

async function restoreBackupDirHandle() {
  backupDirHandle = null;
  backupFileHandle = null;
  if (!canUseFileSystemAccess()) { updateBackupFolderLabel(); return; }
  try {
    backupDirHandle = await idbGet('backupDir');
    if (backupDirHandle && !(await ensureHandlePermission(backupDirHandle))) backupDirHandle = null;
    backupFileHandle = await idbGet('backupFile');
    if (backupFileHandle && !(await ensureHandlePermission(backupFileHandle))) backupFileHandle = null;
  } catch (e) {
    backupDirHandle = null;
    backupFileHandle = null;
  }
  updateBackupFolderLabel();
}

function updateBackupFolderLabel() {
  const el = document.getElementById('backupFolderLabel');
  const note = document.getElementById('backupModeNote');
  const row = document.getElementById('backupFolderRow');

  if (note) {
    if (isFileProtocol() || !canUseFileSystemAccess()) {
      note.innerHTML = `<b>Opened as a local file (<code>file://</code>)</b> — the browser blocks writing into folders from this context.<br><br>
        <b>What still works:</b> “Backup now” saves <code>${BACKUP_FILENAME}</code> via the browser save/download dialog (same filename every time; choose the HTML folder and overwrite when asked).<br><br>
        <b>Silent overwrite next to the HTML</b> needs a secure context. Easiest offline option if Python exists on the PC:<br>
        <code style="display:block;margin-top:6px;padding:8px;background:#fff;border-radius:6px">cd folder-with-html<br>python -m http.server 8765</code>
        Then open <code>http://localhost:8765/pr-tracker.html</code> and use “Choose backup folder…”.`;
    } else {
      note.innerHTML = `Secure context detected. Link a folder once; backups will silently overwrite <code>${BACKUP_FILENAME}</code> there.`;
    }
  }

  if (row) {
    row.style.display = canUseFileSystemAccess() && !isFileProtocol() ? '' : 'none';
  }

  if (!el) return;
  if (backupDirHandle) {
    el.textContent = 'Folder linked — backups overwrite ' + BACKUP_FILENAME + ' in that folder.';
  } else if (backupFileHandle) {
    el.textContent = 'File linked — backups overwrite the chosen ' + BACKUP_FILENAME + '.';
  } else if (canUseFileSystemAccess() && !isFileProtocol()) {
    el.textContent = 'No folder linked yet. Choose the folder that contains this HTML file.';
  } else {
    el.textContent = '';
  }
}

async function linkBackupFolder() {
  if (!canUseFileSystemAccess()) {
    alert('Folder access is not available in this browser/context. Use “Backup now” (save dialog), or open the app via localhost (see note above).');
    return;
  }
  if (isFileProtocol()) {
    alert('Browsers block folder access on file:// pages.\n\nOpen this app via http://localhost (see Settings note), or use Backup now which opens a save dialog for ' + BACKUP_FILENAME + '.');
    return;
  }
  try {
    if (window.showDirectoryPicker) {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      backupDirHandle = handle;
      await idbSet('backupDir', handle);
      updateBackupFolderLabel();
      await backupNow(false);
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    console.warn('Directory picker failed, trying file picker', e);
  }
  // Fallback: pick/create the json file itself
  try {
    if (window.showSaveFilePicker) {
      const fh = await window.showSaveFilePicker({
        suggestedName: BACKUP_FILENAME,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
      });
      backupFileHandle = fh;
      await idbSet('backupFile', fh);
      updateBackupFolderLabel();
      await backupNow(false);
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    alert('Could not link backup location: ' + (e.message || e));
  }
}

function scheduleAutoBackup() {
  if (backupTimer) clearInterval(backupTimer);
  if (settings.autoBackup) {
    backupTimer = setInterval(() => backupNow(true), Math.max(1, settings.backupMinutes) * 60000);
  }
}

async function writeViaHandle(handle, jsonText) {
  const writable = await handle.createWritable();
  await writable.write(jsonText);
  await writable.close();
}

function writeViaDownload(jsonText) {
  // Fixed filename, no timestamp — user can save into the HTML folder and overwrite.
  const blob = new Blob([jsonText], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = BACKUP_FILENAME;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

async function backupNow(auto) {
  const jsonText = JSON.stringify(backupPayload(), null, 2);

  // Restore handles if needed
  if (!backupDirHandle && !backupFileHandle && canUseFileSystemAccess()) {
    try {
      backupDirHandle = await idbGet('backupDir');
      backupFileHandle = await idbGet('backupFile');
    } catch (e) { }
  }

  // 1) Directory handle
  if (backupDirHandle && await ensureHandlePermission(backupDirHandle)) {
    try {
      const fileHandle = await backupDirHandle.getFileHandle(BACKUP_FILENAME, { create: true });
      await writeViaHandle(fileHandle, jsonText);
      recordBackup(auto);
      return;
    } catch (e) { console.warn(e); }
  }

  // 2) File handle
  if (backupFileHandle && await ensureHandlePermission(backupFileHandle)) {
    try {
      await writeViaHandle(backupFileHandle, jsonText);
      recordBackup(auto);
      return;
    } catch (e) { console.warn(e); }
  }

  // 3) Try save-file picker (interactive, not for auto)
  if (!auto && canUseFileSystemAccess() && window.showSaveFilePicker && !isFileProtocol()) {
    try {
      const fh = await window.showSaveFilePicker({
        suggestedName: BACKUP_FILENAME,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
      });
      backupFileHandle = fh;
      await idbSet('backupFile', fh);
      await writeViaHandle(fh, jsonText);
      updateBackupFolderLabel();
      recordBackup(auto);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.warn(e);
    }
  }

  // 4) Download fallback — same fixed name every time
  if (auto && (isFileProtocol() || !canUseFileSystemAccess())) {
    // Auto + file:// : downloads may be blocked; skip silently after first note
    updateBackupInfo();
    return;
  }
  writeViaDownload(jsonText);
  recordBackup(auto, 'Backup download started. Check your browser downloads.');
  if (!auto && (isFileProtocol() || !canUseFileSystemAccess())) {
    // one-line hint; full explanation is in Settings
  }
}

function updateBackupInfo() {
  const el = document.getElementById('backupInfo'); if (!el) return;
  const last = Number(localStorage.getItem('pr-tracker-last-backup') || 0);
  const when = last ? `Last backup: ${new Date(last).toLocaleString()}` : 'No backup written yet.';
  const interval = settings.backupMinutes < 60 ? settings.backupMinutes + ' minutes' : settings.backupMinutes === 60 ? '1 hour' : settings.backupMinutes === 1440 ? '1 day' : (settings.backupMinutes / 60) + ' hours';
  const mode = (backupDirHandle || backupFileHandle) ? 'silent file overwrite' : (isFileProtocol() ? 'save/download dialog' : 'save dialog or folder link');
  el.textContent = (settings.autoBackup ? `Automatic backup on · every ${interval} · ` : 'Automatic backup off · ') + when + ' · mode: ' + mode;
}

function renderSettings() {
  const en = document.getElementById('autoBackupEnabled'), bi = document.getElementById('backupInterval');
  if (en) en.checked = !!settings.autoBackup;
  if (bi) bi.value = String(settings.backupMinutes);
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('jiraBaseUrl', settings.jiraBaseUrl);
  set('azureRepoUrl', settings.azureRepoUrl);
  set('azureMasterPath', settings.azureMasterPath || 'masters/{branch}');
  set('azureTempPath', settings.azureTempPath || 'master_dev/Temp/v{ver}/{branch}');
  set('azureSimpleBranches', settings.azureSimpleBranches || 'developer');
  set('cloudGistId', settings.cloudGistId || '');
  const cas = document.getElementById('cloudAutoSync'); if (cas) cas.checked = settings.cloudAutoSync !== false;
  const clr = document.getElementById('cloudRemember'); if (clr) clr.checked = settings.cloudRemember !== false;
  fillCloudCredFieldsFromStorage();
  applyTheme(); updateBackupInfo(); updateBackupFolderLabel(); updateCloudSyncUI();
}

function esc(s = '') { return String(s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;', '`': '&#96;' }[c])) }
/* Safe handlers — never embed user/id strings inside JS quotes */
function onOpenPr(el) { openPrModal(el.dataset.pr || null, el.dataset.issue || undefined); }
function onOpenIssue(el) { event.stopPropagation(); openIssueModal(el.dataset.id); }
function onToggleIssue(el) { toggleIssue(el.dataset.id); }
function onDeleteIssue(el) { deleteIssue(el.dataset.id); }
function onDeletePr(el) { deletePr(el.dataset.id); }
function onOpenMaster(el) { openMasterModal(el.dataset.id); }
function onDeleteMaster(el) { deleteMaster(el.dataset.id); }
function onToggleMaster(el) { toggleMaster(el.dataset.id); }
function onBulkTemps(el) { bulkCreateTemps(el.dataset.id); }
function onOpenTemp(el) { openTempModal(el.dataset.master || null, el.dataset.temp || undefined); }
function onDeleteTemp(el) { deleteTemp(el.dataset.id); }
function onPickDest(el) { pickDestSS(el.dataset.id); }

function cmpStr(a, b) { return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true }); }

function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }
function nowIso() { return new Date().toISOString(); }
function formatTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  } catch (e) { return '—'; }
}
function ensureTimestamps(obj) {
  if (!obj) return obj;
  if (!obj.createdAt) obj.createdAt = nowIso();
  if (!obj.updatedAt) obj.updatedAt = obj.createdAt;
  return obj;
}
function jiraHtml(i) {
  const id = i.jira || 'No Jira ID';
  const link = resolveJiraLink(i);
  if (link) {
    return `<a class="jira-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Open in Jira">${esc(id)}</a>`;
  }
  return `<span class="jira">${esc(id)}</span>`;
}
function jiraBase() {
  return String(settings.jiraBaseUrl || '').trim().replace(/\/+$/, '');
}
function extractJiraKey(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  // /browse/KEY-123 or path end, or bare KEY-123
  let m = s.match(/browse\/([A-Za-z][A-Za-z0-9_]+-\d+)/i);
  if (m) return m[1].toUpperCase();
  m = s.match(/\b([A-Za-z][A-Za-z0-9_]+-\d+)\b/);
  if (m) return m[1].toUpperCase();
  return '';
}
function resolveJiraLink(i) {
  const link = (i.link || '').trim();
  if (link) return link;
  const key = (i.jira || '').trim();
  const base = jiraBase();
  if (key && base) return base + '/' + key;
  return '';
}
function onJiraIdInput(el) {
  const key = (el.value || '').trim();
  const linkEl = document.querySelector('#modal input[name=link]');
  if (!linkEl) return;
  const base = jiraBase();
  if (!base) return;
  // Only auto-fill link if empty or previously auto-generated from base
  const cur = (linkEl.value || '').trim();
  const looksAuto = !cur || cur.startsWith(base + '/') || cur.startsWith(base + '?');
  if (key && looksAuto) {
    linkEl.value = base + '/' + key;
  }
}
function onJiraLinkInput(el) {
  const url = (el.value || '').trim();
  const idEl = document.querySelector('#modal input[name=jira]');
  if (!idEl) return;
  const key = extractJiraKey(url);
  if (key && !(idEl.value || '').trim()) {
    idEl.value = key;
  } else if (key && extractJiraKey(idEl.value) !== key) {
    // if id empty-ish or different key from URL, prefer URL key
    if (!(idEl.value || '').trim()) idEl.value = key;
  }
}

function extractVerNum(text) {
  const m = String(text || '').match(/(\d+)/);
  return m ? m[1] : '';
}
function simpleBranchSet() {
  return new Set(String(settings.azureSimpleBranches || '').split(/[,;]+/).map(s => s.trim()).filter(Boolean));
}
function applyPathTemplate(tpl, vars) {
  let out = String(tpl || '');
  Object.keys(vars).forEach(k => {
    out = out.split('{' + k + '}').join(vars[k] != null ? String(vars[k]) : '');
  });
  return out.replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
}
function azureBranchPath(d) {
  if (!d) return '';
  if (d.azurePath) return String(d.azurePath).replace(/^\/|\/$/g, '');
  const branch = d.branch || d.name || '';
  const simple = simpleBranchSet();
  if (simple.has(branch) || simple.has(d.name)) return branch;
  const ver = extractVerNum(branch) || extractVerNum(effectiveFromVersion(d)) || extractVerNum(d.fromVersion) || '';
  const vars = { branch, name: d.name || branch, company: d.company || '', ver };
  if (d.kind === 'temp') {
    return applyPathTemplate(settings.azureTempPath || 'master_dev/Temp/v{ver}/{branch}', vars);
  }
  return applyPathTemplate(settings.azureMasterPath || 'masters/{branch}', vars);
}
function azureBranchUrl(d) {
  const repo = String(settings.azureRepoUrl || '').trim().replace(/\/+$/, '');
  if (!repo || !d) return '';
  const path = azureBranchPath(d);
  if (!path) return '';
  // Azure uses version=GB + path with / encoded as %2F
  const encoded = encodeURIComponent(path); // turns / into %2F
  const sep = repo.includes('?') ? '&' : '?';
  return repo + sep + 'version=GB' + encoded;
}
function prUrlHtml(p) {
  const u = (p && p.prUrl || '').trim();
  if (!u) return '';
  return `<a class="jira-link" href="${esc(u)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Open submitted PR">Open PR</a>`;
}
function branchLinkHtml(d, label) {
  const url = azureBranchUrl(d);
  const text = label != null ? label : (d.branch || d.name || '');
  if (url) {
    return `<a class="jira-link" dir="auto" href="${esc(url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="Open branch in Azure/TFS">${esc(text)}</a>`;
  }
  return `<span dir="auto">${esc(text)}</span>`;
}

function issue(id) { return data.issues.find(x => x.id === id) }
function dest(id) { return data.destinations.find(x => x.id === id) }
function statusClass(s) { return 's-' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '') }
function tagHtml(tags = []) { return (tags || []).map(t => coloredTag(t, itemColor(tagObj(t)))).join('') }

function masters() { return data.destinations.filter(d => d.kind === 'master'); }
function tempsOf(masterId) { return data.destinations.filter(d => d.kind === 'temp' && d.parentId === masterId); }
function effectiveFromVersion(d) {
  if (!d) return null;
  if (d.kind === 'master') return d.fromVersion;
  const parent = dest(d.parentId);
  return parent ? parent.fromVersion : d.fromVersion;
}
function versionIndex(v) { return versionNames().indexOf(v); }
function compatible(issueObj, d) {
  if (!d || !d.active) return false;
  if (d.kind === 'temp') {
    const parent = dest(d.parentId);
    if (parent && !parent.active) return false;
  }
  const fv = effectiveFromVersion(d);
  const iIdx = versionIndex(issueObj.version);
  const dIdx = versionIndex(fv);
  if (iIdx === -1 || dIdx === -1) return false;
  // Issue on V14+ only sees version lines V14+ and later (not V11/V12).
  return dIdx >= iIdx;
}
function fromVersionLabel(fv) {
  if (!fv) return '—';
  const idx = versionIndex(fv);
  if (idx === -1) return esc(fv);
  if (idx === versionNames().length - 1) return esc(fv) + ' only';
  return 'from ' + esc(fv) + ' onward';
}
function destLabel(d) {
  if (!d) return '?';
  if (d.kind === 'master') return d.name || d.branch;
  return `${d.name || d.branch} (${d.company})`;
}

function ensureInCatalog(listKey, value) {
  const v = String(value || '').trim();
  if (!v) return;
  if (!data[listKey]) data[listKey] = [];
  if (listKey === 'tagsCatalog') {
    if (!data.tagsCatalog.some(t => itemName(t) === v)) data.tagsCatalog.push({ name: v, color: '' });
    return;
  }
  if (listKey === 'statuses') {
    if (!data.statuses.some(t => itemName(t) === v)) data.statuses.push({ name: v, color: '' });
    return;
  }
  if (!data[listKey].includes(v)) { data[listKey].push(v); }
}
function ensureTagsInCatalog(tags) { (tags || []).forEach(t => ensureInCatalog('tagsCatalog', t)); }
function statuses() { return statusNames(); }

function openModal(html) {
  document.getElementById('modal').innerHTML = html;
  document.getElementById('modalOverlay').classList.add('show');
  // focus first field
  setTimeout(() => {
    const f = document.querySelector('#modal input:not([type=hidden]):not([type=color]), #modal select, #modal textarea');
    if (f) try { f.focus(); } catch (e) { }
  }, 30);
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
  document.getElementById('modal').innerHTML = '';
  document.removeEventListener('click', closeDestSSOnOutside);
}
function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}
document.addEventListener('keydown', function (e) {
  const modalOpen = document.getElementById('modalOverlay')?.classList.contains('show');
  // ESC closes modal or dest search panel
  if (e.key === 'Escape') {
    if (document.getElementById('prDestPanel')?.classList.contains('open')) {
      document.getElementById('prDestPanel').classList.remove('open');
      e.preventDefault();
      return;
    }
    if (modalOpen) { e.preventDefault(); closeModal(); return; }
  }
  // Don't trigger global shortcuts while typing or modal open
  if (modalOpen || isTypingTarget(e.target)) return;
  // / focus issue search
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const s = document.getElementById('issueSearch');
    if (s && !document.getElementById('issuesPage')?.classList.contains('hidden')) {
      e.preventDefault(); s.focus(); s.select(); return;
    }
  }
  // n = new issue on issues page
  if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (!document.getElementById('issuesPage')?.classList.contains('hidden')) {
      e.preventDefault(); openIssueModal(); return;
    }
    if (!document.getElementById('destinationsPage')?.classList.contains('hidden')) {
      e.preventDefault(); openMasterModal(); return;
    }
  }
  // 1-6 quick nav
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key >= '1' && e.key <= '6') {
    const pages = ['issues', 'prs', 'destinations', 'versions', 'lists', 'settings'];
    const idx = Number(e.key) - 1;
    if (pages[idx]) { e.preventDefault(); nav(pages[idx]); }
  }
});
function nav(page) {
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('main section').forEach(s => s.classList.add('hidden'));
  document.getElementById(page + 'Page').classList.remove('hidden');
  if (page === 'issues') renderIssues();
  if (page === 'prs') renderPRs();
  if (page === 'destinations') renderDestinations();
  if (page === 'versions') renderVersions();
  if (page === 'lists') renderLists();
  if (page === 'settings') renderSettings();
}
document.querySelectorAll('.nav button').forEach(b => b.onclick = () => nav(b.dataset.page));

function populateSelect(id, vals, allLabel) {
  const el = document.getElementById(id); if (!el) return;
  const cur = el.value;
  el.innerHTML = `<option value="">${allLabel || 'All'}</option>` + (vals || []).map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if ([...el.options].some(o => o.value === cur)) el.value = cur;
}

window._ssRegistry = window._ssRegistry || {};
function ssNormOptions(options) {
  return (options || []).map(o => {
    if (o == null) return null;
    if (typeof o === 'string') return { value: o, label: o, search: String(o).toLowerCase() };
    return {
      value: String(o.value),
      label: o.label != null ? String(o.label) : String(o.value),
      sub: o.sub || '',
      search: String(o.search || [o.label, o.value, o.sub].filter(Boolean).join(' ')).toLowerCase()
    };
  }).filter(Boolean);
}
function ssHtml(cfg) {
  const id = cfg.id;
  const opts = ssNormOptions(cfg.options);
  const emptyVal = cfg.emptyValue !== undefined ? cfg.emptyValue : '';
  const hasEmpty = cfg.emptyLabel != null;
  let display = cfg.placeholder || 'Select…';
  const value = cfg.value != null ? cfg.value : '';
  if (value !== '') {
    const hit = opts.find(o => o.value === String(value));
    display = hit ? hit.label : String(value);
  } else if (hasEmpty) {
    display = cfg.emptyLabel;
  }
  window._ssRegistry[id] = {
    options: opts, hasEmpty, emptyLabel: cfg.emptyLabel || '', emptyValue: emptyVal, onChange: cfg.onChange || null
  };
  return `<input type="hidden" name="${cfg.name || ''}" id="${id}" value="${esc(value)}">
    <div class="ss-wrap" id="${id}-wrap">
      <div class="ss-display" onclick="ssToggle('${id}')">
        <span class="ss-val" id="${id}-val">${esc(display)}</span>
        <span class="muted">▾</span>
      </div>
      <div class="ss-panel" id="${id}-panel">
        <div class="ss-search"><input dir="auto" class="field" id="${id}-search" placeholder="Search…" oninput="ssFilter('${id}')" onclick="event.stopPropagation()"></div>
        <div class="ss-list" id="${id}-list"></div>
      </div>
    </div>`;
}
function ssMountFilter(wrapId, hiddenId, options, emptyLabel, onChange) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const hidden = document.getElementById(hiddenId);
  const cur = hidden ? hidden.value : '';
  const opts = ssNormOptions(options);
  window._ssRegistry[hiddenId] = {
    options: opts, hasEmpty: true, emptyLabel: emptyLabel || 'All', emptyValue: '', onChange: onChange || null
  };
  let display = emptyLabel || 'All';
  if (cur) {
    const hit = opts.find(o => o.value === cur);
    display = hit ? hit.label : cur;
  }
  wrap.className = 'ss-wrap ss-compact';
  wrap.innerHTML = `<div class="ss-display" onclick="ssToggle('${hiddenId}')">
      <span class="ss-val" id="${hiddenId}-val">${esc(display)}</span>
      <span class="muted">▾</span>
    </div>
    <div class="ss-panel" id="${hiddenId}-panel">
      <div class="ss-search"><input dir="auto" class="field" id="${hiddenId}-search" placeholder="Search…" oninput="ssFilter('${hiddenId}')" onclick="event.stopPropagation()"></div>
      <div class="ss-list" id="${hiddenId}-list"></div>
    </div>`;
  ssRenderList(hiddenId);
}
function ssToggle(id) {
  const panel = document.getElementById(id + '-panel');
  if (!panel) return;
  const open = !panel.classList.contains('open');
  document.querySelectorAll('.ss-panel.open').forEach(p => p.classList.remove('open'));
  if (open) {
    panel.classList.add('open');
    ssRenderList(id);
    const s = document.getElementById(id + '-search');
    if (s) { s.value = ''; setTimeout(() => s.focus(), 10); }
  }
}
function ssFilter(id) { ssRenderList(id); }
function ssRenderList(id) {
  const list = document.getElementById(id + '-list');
  const reg = window._ssRegistry[id];
  if (!list || !reg) return;
  const q = (document.getElementById(id + '-search')?.value || '').toLowerCase().trim();
  const cur = document.getElementById(id)?.value ?? '';
  let opts = reg.options;
  if (q) opts = opts.filter(o => o.search.includes(q) || o.label.toLowerCase().includes(q));
  let html = '';
  // Use data-* attributes so values with quotes/apostrophes (e.g. PR'd) stay clickable
  if (reg.hasEmpty) {
    if (!q || String(reg.emptyLabel || '').toLowerCase().includes(q)) {
      html += `<div class="ss-item ${cur === reg.emptyValue ? 'active' : ''}" data-ss-id="${esc(id)}" data-ss-value="${esc(String(reg.emptyValue))}" onclick="ssPickFromEl(this)"><span class="ss-main">${esc(reg.emptyLabel || '—')}</span></div>`;
    }
  }
  if (!opts.length && !html) { list.innerHTML = '<div class="ss-empty">No matches</div>'; return; }
  html += opts.map(o => `<div class="ss-item ${o.value === cur ? 'active' : ''}" data-ss-id="${esc(id)}" data-ss-value="${esc(o.value)}" onclick="ssPickFromEl(this)"><span class="ss-main">${esc(o.label)}</span>${o.sub ? `<span class="ss-sub">${esc(o.sub)}</span>` : ''}</div>`).join('');
  list.innerHTML = html;
}
function ssPickFromEl(el) {
  ssPick(el.getAttribute('data-ss-id'), el.getAttribute('data-ss-value') ?? '');
}

function ssSetValue(id, value) {
  const el = document.getElementById(id);
  const reg = window._ssRegistry[id];
  if (el) el.value = value == null ? '' : String(value);
  let display = value == null || value === '' ? (reg && reg.hasEmpty ? reg.emptyLabel : '—') : String(value);
  if (reg && value !== '' && value != null) {
    const hit = reg.options.find(o => o.value === String(value));
    if (hit) display = hit.label;
  }
  const valEl = document.getElementById(id + '-val');
  if (valEl) valEl.textContent = display;
}
function ssPick(id, value) {
  const el = document.getElementById(id);
  const reg = window._ssRegistry[id];
  if (el) el.value = value;
  let display = value;
  if (reg) {
    if (value === reg.emptyValue || value === '') display = reg.emptyLabel || '—';
    else {
      const hit = reg.options.find(o => o.value === String(value));
      display = hit ? hit.label : String(value);
    }
  }
  const valEl = document.getElementById(id + '-val');
  if (valEl) valEl.textContent = display;
  document.getElementById(id + '-panel')?.classList.remove('open');
  if (reg && typeof reg.onChange === 'function') reg.onChange(value);
}
document.addEventListener('click', function (e) {
  if (e.target.closest && e.target.closest('.ss-wrap')) return;
  document.querySelectorAll('.ss-panel.open').forEach(p => p.classList.remove('open'));
});


function renderStats() {
  const counts = Object.fromEntries(statuses().map(s => [s, 0]));
  data.prs.forEach(p => counts[p.status] = (counts[p.status] || 0) + 1);
  document.getElementById('stats').innerHTML = `
    <div class="stat"><div class="n">${data.issues.length}</div><div class="l">Issues</div></div>
    <div class="stat"><div class="n">${counts['TODO'] || 0}</div><div class="l">TODO PRs</div></div>
    <div class="stat"><div class="n">${counts['PR Only'] || 0}</div><div class="l">PR Only</div></div>
    <div class="stat"><div class="n">${counts["PR'd"] || 0}</div><div class="l">PR'd</div></div>`;
}
function getExpanded(id) {
  const state = readStoredJSON('pr-tracker-expanded-v1', {});
  return state[id] === true;
}
function toggleIssue(id) {
  const state = readStoredJSON('pr-tracker-expanded-v1', {});
  state[id] = !getExpanded(id);
  localStorage.setItem('pr-tracker-expanded-v1', JSON.stringify(state));
  renderIssues();
}
function toggleAllIssues() {
  const state = readStoredJSON('pr-tracker-expanded-v1', {});
  const any = data.issues.some(i => getExpanded(i.id));
  data.issues.forEach(i => state[i.id] = !any);
  localStorage.setItem('pr-tracker-expanded-v1', JSON.stringify(state));
  renderIssues();
}
function updateCollapseAllButton() {
  const b = document.getElementById('collapseAllBtn'); if (!b) return;
  b.textContent = data.issues.some(i => getExpanded(i.id)) ? 'Collapse all' : 'Expand all';
}

/* Master expand state */
function getMasterExpanded(id) {
  const state = readStoredJSON('pr-tracker-master-exp-v1', {});
  return state[id] !== false;
}
function toggleMaster(id) {
  const state = readStoredJSON('pr-tracker-master-exp-v1', {});
  state[id] = !getMasterExpanded(id);
  localStorage.setItem('pr-tracker-master-exp-v1', JSON.stringify(state));
  renderDestinations();
}

/* ── Versions ── */
function renderVersions() { renderVersionList(); }
function renderVersionList() {
  const el = document.getElementById('versionList'); if (!el) return;
  if (!data.versions.length) { el.innerHTML = '<div class="empty" style="padding:20px">No versions yet.</div>'; return; }
  el.innerHTML = data.versions.map((v, idx) => {
    const name = itemName(v);
    const used = data.issues.some(i => i.version === name) || data.destinations.some(d => d.kind === 'master' && d.fromVersion === name);
    const col = itemColor(v);
    return `<div class="version-row">
      <span class="chip" style="min-width:28px;justify-content:center">${idx + 1}</span>
      <input type="color" class="color-input" title="Color (optional)" value="${col || '#e2e5e9'}" onchange="setVersionColor(${idx}, this.value)">
      <button class="btn icon" title="Clear color" onclick="setVersionColor(${idx},'')">⌀</button>
      <input dir="auto" class="name-edit field" style="flex:1;font-weight:650" value="${esc(name)}"
        data-old="${esc(name)}" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"
        onblur="commitVersionName(${idx}, this)">
      <div class="order-btns">
        <button class="btn icon" title="Move up" aria-label="Move ${esc(name)} up" ${idx === 0 ? 'disabled' : ''} onclick="moveVersion(${idx},-1)">↑</button>
        <button class="btn icon" title="Move down" aria-label="Move ${esc(name)} down" ${idx === data.versions.length - 1 ? 'disabled' : ''} onclick="moveVersion(${idx},1)">↓</button>
        <button class="btn danger icon" title="Delete ${esc(name)}" aria-label="Delete ${esc(name)}" onclick="deleteVersion(${idx})" ${used ? 'disabled style="opacity:.45"' : ''}>×</button>
      </div>
    </div>`;
  }).join('');
}
function setVersionColor(idx, color) {
  if (!data.versions[idx]) return;
  if (typeof data.versions[idx] === 'string') data.versions[idx] = { name: data.versions[idx], color: '' };
  data.versions[idx].color = color || '';
  save(); renderVersionList();
}
function commitVersionName(idx, input) {
  const oldName = input.dataset.old;
  const newName = input.value.trim();
  if (!newName) { input.value = oldName; return; }
  if (newName === oldName) return;
  if (renameVersion(oldName, newName)) { save(); renderVersionList(); }
  else { input.value = oldName; }
}
function addVersion() {
  const input = document.getElementById('newVersionName');
  const name = (input?.value || '').trim();
  if (!name) { alert('Enter a version name.'); return }
  if (versionNames().includes(name)) { alert('Already exists.'); return }
  data.versions.push({ name, color: '' }); save(); if (input) input.value = ''; renderVersionList();
}
function moveVersion(idx, dir) {
  const n = idx + dir; if (n < 0 || n >= data.versions.length) return;
  [data.versions[idx], data.versions[n]] = [data.versions[n], data.versions[idx]];
  save(); renderVersionList();
}
function deleteVersion(idx) {
  const v = itemName(data.versions[idx]);
  if (data.issues.some(i => i.version === v) || data.destinations.some(d => d.kind === 'master' && d.fromVersion === v)) {
    alert('Cannot delete: used by issues or masters.'); return;
  }
  if (!confirm('Delete "' + v + '"?')) return;
  data.versions.splice(idx, 1); save(); renderVersionList();
}

/* ── Lists ── */
function renderLists() {
  renderCompanyList();
  renderStatusList();
  renderTagList();
}
function listRowColorControls(color, onChange, onClear) {
  return `<div class="catalog-color-controls">
    <input type="color" class="color-input" title="Color (optional)" aria-label="Color (optional)" value="${color || '#e2e5e9'}" onchange="${onChange}">
    <button class="btn icon" title="Clear color" aria-label="Clear color" onclick="${onClear}">⌀</button>
  </div>`;
}
function renderStatusList() {
  const el = document.getElementById('statusList'); if (!el) return;
  if (!data.statuses) data.statuses = [];
  const list = data.statuses;
  if (!list.length) { el.innerHTML = '<div class="muted" style="padding:8px 0">Empty — add below.</div>'; return; }
  el.innerHTML = list.map((s, idx) => {
    const name = itemName(s);
    const used = data.prs.some(p => p.status === name);
    const col = itemColor(s);
    return `<div class="catalog-row catalog-row--status">
      <span class="chip" style="min-width:28px;justify-content:center">${idx + 1}</span>
      ${listRowColorControls(col, `setStatusColor(${idx}, this.value)`, `setStatusColor(${idx},'')`)}
      <input dir="auto" class="name-edit field" style="flex:1;font-weight:650" value="${esc(name)}"
        data-old="${esc(name)}" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"
        onblur="commitStatusName(${idx}, this)">
      <div class="order-btns">
        <button class="btn icon" title="Move up" aria-label="Move ${esc(name)} up" ${idx === 0 ? 'disabled' : ''} onclick="moveStatus(${idx},-1)">↑</button>
        <button class="btn icon" title="Move down" aria-label="Move ${esc(name)} down" ${idx === list.length - 1 ? 'disabled' : ''} onclick="moveStatus(${idx},1)">↓</button>
        <button class="btn danger icon" title="Remove ${esc(name)}" aria-label="Remove ${esc(name)}" ${used ? 'disabled style="opacity:.45"' : ''} onclick="removeStatus(${idx})">×</button>
      </div>
    </div>`;
  }).join('');
}
function setStatusColor(idx, color) {
  if (!data.statuses[idx]) return;
  if (typeof data.statuses[idx] === 'string') data.statuses[idx] = { name: data.statuses[idx], color: '' };
  data.statuses[idx].color = color || '';
  save(); renderStatusList();
}
function commitStatusName(idx, input) {
  const oldName = input.dataset.old, newName = input.value.trim();
  if (!newName) { input.value = oldName; return; }
  if (newName === oldName) return;
  if (renameStatus(oldName, newName)) { save(); renderStatusList(); }
  else input.value = oldName;
}
function addStatus() {
  const input = document.getElementById('newStatusName');
  const name = (input?.value || '').trim();
  if (!name) { alert('Enter a status name.'); return }
  if (!data.statuses) data.statuses = [];
  if (statusNames().includes(name)) { alert('Already exists.'); return }
  data.statuses.push({ name, color: '' }); save(); if (input) input.value = ''; renderStatusList();
}
function moveStatus(idx, dir) {
  if (!data.statuses) return;
  const n = idx + dir; if (n < 0 || n >= data.statuses.length) return;
  [data.statuses[idx], data.statuses[n]] = [data.statuses[n], data.statuses[idx]];
  save(); renderStatusList();
}
function removeStatus(idx) {
  const name = itemName(data.statuses[idx]);
  if (data.prs.some(p => p.status === name)) { alert('Status is used by PR records.'); return }
  if (!confirm('Remove status "' + name + '"?')) return;
  data.statuses.splice(idx, 1); save(); renderStatusList();
}
function renderCompanyList() {
  const el = document.getElementById('companyList'); if (!el) return;
  const list = data.companies || [];
  if (!list.length) { el.innerHTML = '<div class="muted" style="padding:8px 0">Empty — add below.</div>'; return; }
  el.innerHTML = list.map((c, idx) => {
    const used = data.destinations.some(d => d.company === c.name);
    const inactive = c.active === false;
    const col = c.color || '';
    return `<div class="catalog-row catalog-row--company" style="${inactive ? 'opacity:.55' : ''}">
      ${listRowColorControls(col, `setCompanyColor(${idx}, this.value)`, `setCompanyColor(${idx},'')`)}
      <input dir="auto" class="name-edit field" style="flex:1;font-weight:650" value="${esc(c.name)}"
        data-old="${esc(c.name)}" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"
        onblur="commitCompanyName(${idx}, this)">
      ${inactive ? '<span class="muted">(disabled)</span>' : ''}
      <div class="catalog-actions">
      <button class="btn icon" title="${inactive ? 'Enable' : 'Disable'}" onclick="toggleCompanyActive(${idx})">${inactive ? 'Enable' : 'Disable'}</button>
      <button class="btn danger icon" ${used ? 'disabled style="opacity:.45"' : ''} onclick="removeCompany(${idx})">×</button>
      </div>
    </div>`;
  }).join('');
}
function setCompanyColor(idx, color) {
  if (!data.companies[idx]) return;
  data.companies[idx].color = color || '';
  save(); renderCompanyList();
}
function commitCompanyName(idx, input) {
  const oldName = input.dataset.old, newName = input.value.trim();
  if (!newName) { input.value = oldName; return; }
  if (newName === oldName) return;
  if (renameCompany(oldName, newName)) { save(); renderCompanyList(); }
  else input.value = oldName;
}
function toggleCompanyActive(idx) {
  const c = data.companies[idx]; if (!c) return;
  c.active = c.active === false ? true : false;
  save(); renderCompanyList();
}
function removeCompany(idx) {
  const c = data.companies[idx]; if (!c) return;
  if (data.destinations.some(d => d.company === c.name)) {
    alert('Company is used by temp branches. Disable it instead, or reassign those temps.'); return;
  }
  if (!confirm('Remove company "' + c.name + '"?')) return;
  data.companies.splice(idx, 1); save(); renderCompanyList();
}
function renderTagList() {
  const el = document.getElementById('tagCatalogList'); if (!el) return;
  if (!data.tagsCatalog) data.tagsCatalog = [];
  const list = data.tagsCatalog;
  if (!list.length) { el.innerHTML = '<div class="muted" style="padding:8px 0">Empty — add below.</div>'; return; }
  el.innerHTML = list.map((t, idx) => {
    const name = itemName(t);
    const used = data.issues.some(i => (i.tags || []).includes(name)) || data.prs.some(p => (p.tags || []).includes(name));
    const col = itemColor(t);
    return `<div class="catalog-row catalog-row--tag">
      ${listRowColorControls(col, `setTagColor(${idx}, this.value)`, `setTagColor(${idx},'')`)}
      <input dir="auto" class="name-edit field" style="flex:1;font-weight:650" value="${esc(name)}"
        data-old="${esc(name)}" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"
        onblur="commitTagName(${idx}, this)">
      <div class="catalog-actions">
        <button class="btn danger icon" title="Remove ${esc(name)}" aria-label="Remove ${esc(name)}" ${used ? 'disabled style="opacity:.45"' : ''} onclick="removeTag(${idx})">×</button>
      </div>
    </div>`;
  }).join('');
}
function setTagColor(idx, color) {
  if (!data.tagsCatalog[idx]) return;
  if (typeof data.tagsCatalog[idx] === 'string') data.tagsCatalog[idx] = { name: data.tagsCatalog[idx], color: '' };
  data.tagsCatalog[idx].color = color || '';
  save(); renderTagList();
}
function commitTagName(idx, input) {
  const oldName = input.dataset.old, newName = input.value.trim();
  if (!newName) { input.value = oldName; return; }
  if (newName === oldName) return;
  if (renameTag(oldName, newName)) { save(); renderTagList(); }
  else input.value = oldName;
}
function removeTag(idx) {
  const name = itemName(data.tagsCatalog[idx]);
  const used = data.issues.some(i => (i.tags || []).includes(name)) || data.prs.some(p => (p.tags || []).includes(name));
  if (used) { alert('Tag is in use.'); return }
  if (!confirm('Remove "' + name + '"?')) return;
  data.tagsCatalog.splice(idx, 1); save(); renderTagList();
}
function addCatalogItem(listKey) {
  const inputId = listKey === 'companies' ? 'newCompanyName' : 'newTagName';
  const input = document.getElementById(inputId);
  const name = (input?.value || '').trim();
  if (!name) { alert('Enter a name.'); return }
  if (listKey === 'companies') {
    if (companyNames(false).includes(name)) { alert('Already exists.'); return }
    ensureCompany(name, true);
  } else {
    if (tagNames().includes(name)) { alert('Already exists.'); return }
    if (!data.tagsCatalog) data.tagsCatalog = [];
    data.tagsCatalog.push({ name, color: '' });
  }
  save(); if (input) input.value = ''; renderLists();
}

/* ── Tag picker ── */
function tagPickerHtml(selected = []) {
  const sel = new Set(selected || []);
  const picks = tagNames().map(t => {
    const col = itemColor(tagObj(t));
    const st = chipStyle(col);
    return `<span class="tag-pick ${sel.has(t) ? 'on' : ''}" data-tag="${esc(t)}" onclick="this.classList.toggle('on')" ${st ? `style="${st}"` : ''}>${esc(t)}</span>`;
  }).join('');
  return `<div class="tag-picks" id="tagPicker">${picks || '<span class="muted">No tags yet — add under Lists.</span>'}</div>
    <div class="actions" style="margin-top:8px">
      <input dir="auto" class="field" id="newTagInline" style="flex:1" placeholder="New tag + Enter"
        onkeydown="if(event.key==='Enter'){event.preventDefault();addInlineTag()}">
    </div>`;
}
function addInlineTag() {
  const input = document.getElementById('newTagInline');
  const name = (input?.value || '').trim(); if (!name) return;
  ensureInCatalog('tagsCatalog', name);
  const picker = document.getElementById('tagPicker');
  if (picker && ![...picker.querySelectorAll('.tag-pick')].some(el => el.dataset.tag === name)) {
    const span = document.createElement('span');
    span.className = 'tag-pick on'; span.dataset.tag = name; span.textContent = name;
    span.onclick = () => span.classList.toggle('on');
    picker.appendChild(span);
  } else if (picker) {
    [...picker.querySelectorAll('.tag-pick')].forEach(el => { if (el.dataset.tag === name) el.classList.add('on'); });
  }
  if (input) input.value = '';
}
function collectTagsFromPicker() {
  const picker = document.getElementById('tagPicker');
  if (!picker) return [];
  return [...picker.querySelectorAll('.tag-pick.on')].map(el => el.dataset.tag);
}

/* ── Issues ── */

/* ── Progress / inline edit / bulk / saved views ── */
function issuePrStats(issueId) {
  const list = data.prs.filter(p => p.issueId === issueId);
  const by = {};
  list.forEach(p => { const s = p.status || 'TODO'; by[s] = (by[s] || 0) + 1; });
  return { total: list.length, by };
}
function progressHtml(issueId) {
  const st = issuePrStats(issueId);
  if (!st.total) return '<div class="progress-bar"><span class="progress-pill">No PRs</span></div>';
  const order = statuses();
  const keys = [...order.filter(s => st.by[s]), ...Object.keys(st.by).filter(s => !order.includes(s))];
  return `<div class="progress-bar">${keys.map(s => {
    const n = st.by[s];
    const cls = /todo/i.test(s) ? 'has-todo' : (/(pr.?d|done|complete)/i.test(s) ? 'has-done' : '');
    return `<span class="progress-pill ${cls}">${esc(s)} ${n}</span>`;
  }).join('')}<span class="progress-pill">${st.total} total</span></div>`;
}
function closeInlineMenus() {
  document.querySelectorAll('.inline-menu').forEach(m => m.remove());
}
document.addEventListener('click', (e) => {
  if (e.target.closest && (e.target.closest('.inline-menu') || e.target.closest('.inline-hit'))) return;
  closeInlineMenus();
});
function openInlineMenu(el, options, current, onPick, title) {
  event && event.stopPropagation();
  closeInlineMenus();
  const menu = document.createElement('div');
  menu.className = 'inline-menu';
  const titleHtml = title ? `<div class="inline-menu-title">${esc(title)}</div>` : '';
  const items = (options || []).map(o => {
    const val = typeof o === 'string' ? o : o.value;
    const lab = typeof o === 'string' ? o : (o.label || o.value);
    return `<button type="button" class="${val === current ? 'active' : ''}" data-v="${esc(val)}">${esc(lab)}</button>`;
  }).join('') || '<div class="muted" style="padding:8px">No options</div>';
  menu.innerHTML = titleHtml + items;
  menu.querySelectorAll('button').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      onPick(btn.getAttribute('data-v'));
      closeInlineMenus();
    };
  });
  document.body.appendChild(menu);
  const r = el.getBoundingClientRect();
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 120;
  let left = r.left;
  let top = r.bottom + 6;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
  if (left < 8) left = 8;
  if (top + mh > window.innerHeight - 8 && r.top > mh + 8) {
    top = r.top - mh - 6;
  }
  if (top < 8) top = 8;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}
function inlineStatusHtml(prId, status) {
  // reuse coloredStatus look but clickable
  const inner = coloredStatus(status).replace('<span ', '<span class="inline-hit" data-pr="' + esc(prId) + '" onclick="onInlinePrStatus(this)" ');
  // coloredStatus returns full span - inject class more carefully
  return `<span class="inline-hit" data-pr="${esc(prId)}" onclick="onInlinePrStatus(this)" title="Click to change status">${coloredStatus(status)}</span>`;
}
function onInlinePrStatus(el) {
  event.stopPropagation();
  const id = el.dataset.pr || el.closest('[data-pr]')?.dataset?.pr;
  const p = data.prs.find(x => x.id === id); if (!p) return;
  const host = el.classList.contains('inline-hit') ? el : el.closest('.inline-hit') || el;
  openInlineMenu(host, statuses(), p.status, (val) => {
    p.status = val; p.updatedAt = nowIso();
    const iss = issue(p.issueId); if (iss) iss.updatedAt = nowIso();
    save(); renderIssues(); renderPRs();
  }, 'PR status');
}
function onInlineIssuePriority(el) {
  event.stopPropagation();
  const id = el.dataset.issue;
  const i = issue(id); if (!i) return;
  openInlineMenu(el, PRIORITIES, i.priority, (val) => {
    i.priority = val; i.updatedAt = nowIso(); save(); renderIssues();
  }, 'Priority');
}
function onInlineIssueVersion(el) {
  event.stopPropagation();
  const id = el.dataset.issue;
  const i = issue(id); if (!i) return;
  openInlineMenu(el, versionNames(), i.version, (val) => {
    i.version = val; i.updatedAt = nowIso(); save(); renderIssues();
  }, 'Target version');
}
function onInlineIssueCompany(el) {
  event.stopPropagation();
  const id = el.dataset.issue;
  const i = issue(id); if (!i) return;
  const opts = [{ value: '', label: '— None —' }, ...companyNames(false)];
  openInlineMenu(el, opts, i.reportedBy || '', (val) => {
    i.reportedBy = val; i.updatedAt = nowIso(); save(); renderIssues();
  }, 'Reported by company');
}
function onInlineIssueReportedVer(el) {
  event.stopPropagation();
  const id = el.dataset.issue;
  const i = issue(id); if (!i) return;
  const opts = [{ value: '', label: '— None —' }, ...versionNames()];
  openInlineMenu(el, opts, i.reportedVersion || '', (val) => {
    i.reportedVersion = val; i.updatedAt = nowIso(); save(); renderIssues();
  }, 'Reported on version');
}
function onInlineDestActive(el) {
  event.stopPropagation();
  const id = el.dataset.id;
  const d = dest(id); if (!d) return;
  openInlineMenu(el, [{ value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }], d.active !== false ? '1' : '0', (val) => {
    d.active = val === '1'; d.updatedAt = nowIso(); save(); renderDestinations();
  }, 'Destination active');
}

function openBulkAddDestModal(issueId) {
  const i = issue(issueId); if (!i) return;
  const used = new Set(data.prs.filter(p => p.issueId === issueId).map(p => p.destinationId));
  const available = data.destinations.filter(d => compatible(i, d) && !used.has(d.id));
  const groups = buildDestGroups(available);
  if (!groups.length) {
    alert('No compatible destinations left to add for this issue version.');
    return;
  }
  window._bulkAvail = available;
  window._bulkGroups = groups;
  let body = renderBulkDestList(groups, '').html;
  openModal(`<div class="modal-head"><h2>Bulk add destinations</h2><button class="kebab" onclick="closeModal()">×</button></div>
  <div class="modal-body">
    <div class="subtitle" style="margin-bottom:10px">${esc(i.jira || '')} · ${esc(i.description || '')} · ${esc(i.version || '')}</div>
    <div class="form-group"><label>Initial status</label>
      ${ssHtml({ id: 'bulkStatus', name: 'bulkStatus', options: statuses(), value: 'TODO' })}
    </div>
    <div class="form-group">
      <label>Search destinations</label>
      <input dir="auto" id="bulkDestSearch" class="field" placeholder="Search branch, company, master…" oninput="filterBulkDestList()">
    </div>
    <div class="form-group">
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button type="button" class="btn" onclick="bulkSelectAll(true)">Select all visible</button>
        <button type="button" class="btn" onclick="bulkSelectAll(false)">Select none</button>
      </div>
      <div id="bulkDestList" style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:10px">${body}</div>
      <div id="bulkDestMeta" class="small" style="margin-top:6px"></div>
    </div>
    <div class="form-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      <button type="button" class="btn success" onclick="commitBulkAddDest('${esc(issueId)}')">Add selected</button>
    </div>
  </div>`);
  ssRenderList('bulkStatus');
  filterBulkDestList();
}
function bulkRowSearchBlob(d) {
  return [destLabel(d), d.branch, d.name, d.company, d.kind, d.fromVersion].filter(Boolean).join(' ').toLowerCase();
}
function renderBulkDestList(groups, q) {
  q = (q || '').toLowerCase().trim();
  const match = d => !q || bulkRowSearchBlob(d).includes(q);
  let html = '', n = 0;
  groups.forEach(g => {
    if (g.orphan) {
      const temps = (g.temps || []).filter(match);
      if (!temps.length) return;
      html += `<div class="ss-group">Other</div>` + temps.map(t => { n++; return bulkCheckRow(t, false); }).join('');
      return;
    }
    const m = g.master;
    const temps = (g.temps || []).filter(match);
    const masterMatch = m && match(m);
    if (!masterMatch && !temps.length) return;
    html += `<div class="ss-group">${esc(m.name)}</div>`;
    if (masterMatch) {
      n++;
      html += `<label class="check bulk-row" style="display:flex;gap:8px;align-items:center;padding:4px 0;cursor:pointer">
        <input type="checkbox" class="bulk-dest" value="${esc(m.id)}" onchange="bulkToggleGroup(this,'${esc(m.id)}')">
        <span>◆ ${esc(m.name)} (master)</span>
      </label>`;
    }
    html += temps.map(t => { n++; return bulkCheckRow(t, true); }).join('');
  });
  if (!html) html = '<div class="muted" style="padding:12px;text-align:center">No destinations match.</div>';
  return { html, n };
}
function filterBulkDestList() {
  const q = document.getElementById('bulkDestSearch')?.value || '';
  const groups = window._bulkGroups || [];
  const r = renderBulkDestList(groups, q);
  const list = document.getElementById('bulkDestList');
  if (list) list.innerHTML = r.html;
  const meta = document.getElementById('bulkDestMeta');
  if (meta) meta.textContent = r.n + ' destination(s) shown';
}
function bulkCheckRow(d, indent) {
  return `<label class="check bulk-row" style="display:flex;gap:8px;align-items:center;padding:4px 0 ${indent ? '0 0 0 18px' : '0'};cursor:pointer">
    <input type="checkbox" class="bulk-dest" value="${esc(d.id)}" data-parent="${esc(d.parentId || '')}">
    <span dir="auto">${esc(destLabel(d))} <span class="muted">${d.kind === 'temp' ? ('· ' + esc(d.company || '')) : '· master'}</span></span>
  </label>`;
}
function bulkSelectAll(on) {
  document.querySelectorAll('#modal .bulk-dest').forEach(c => { c.checked = !!on; });
}
function bulkToggleGroup(masterCb, masterId) {
  const on = !!masterCb.checked;
  document.querySelectorAll('#modal .bulk-dest').forEach(c => {
    if (c.value === masterId || c.getAttribute('data-parent') === masterId) c.checked = on;
  });
}
function commitBulkAddDest(issueId) {
  const ids = [...document.querySelectorAll('#modal .bulk-dest:checked')].map(c => c.value);
  if (!ids.length) { alert('Select at least one destination.'); return; }
  const status = (document.getElementById('bulkStatus')?.value) || 'TODO';
  const ts = nowIso();
  const used = new Set(data.prs.filter(p => p.issueId === issueId).map(p => p.destinationId));
  let n = 0;
  ids.forEach(did => {
    if (used.has(did)) return;
    data.prs.push({ id: uid('p'), issueId, destinationId: did, status, prUrl: '', tags: [], notes: '', createdAt: ts, updatedAt: ts });
    used.add(did); n++;
  });
  const iss = issue(issueId); if (iss) iss.updatedAt = ts;
  save(); closeModal(); renderIssues(); renderPRs();
  if (n) alert('Added ' + n + ' PR destination(s).');
}

function getIssueFilterState() {
  return {
    search: document.getElementById('issueSearch')?.value || '',
    version: document.getElementById('issueVersion')?.value || '',
    priority: document.getElementById('issuePriority')?.value || '',
    important: document.getElementById('issueImportant')?.value || '',
    prStatus: document.getElementById('issuePrStatus')?.value || '',
    company: document.getElementById('issueCompany')?.value || '',
    reportedVer: document.getElementById('issueReportedVer')?.value || '',
    attention: document.getElementById('issueAttention')?.value === '1'
  };
}
function applyIssueFilterState(f) {
  if (!f) return;
  const setHidden = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  setHidden('issueSearch', f.search);
  setHidden('issueVersion', f.version);
  setHidden('issuePriority', f.priority);
  setHidden('issueImportant', f.important);
  setHidden('issuePrStatus', f.prStatus);
  setHidden('issueCompany', f.company);
  setHidden('issueReportedVer', f.reportedVer);
  setHidden('issueAttention', f.attention ? '1' : '');
  renderIssues();
}
function clearIssueFilters() {
  document.getElementById('issueSearch').value = '';
  ['issueVersion', 'issuePriority', 'issueImportant', 'issuePrStatus', 'issueCompany', 'issueReportedVer', 'issueAttention']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.querySelector('.filter-drawer')?.removeAttribute('open');
  renderIssues();
}
function removeIssueFilter(key) {
  const field = key === 'search' ? 'issueSearch' : ({ attention: 'issueAttention' }[key] || `issue${key[0].toUpperCase()}${key.slice(1)}`);
  const el = document.getElementById(field);
  if (el) el.value = '';
  renderIssues();
}
function toggleAttentionView() {
  const el = document.getElementById('issueAttention');
  el.value = el.value === '1' ? '' : '1';
  renderIssues();
}
function issueNeedsAttention(issueObj) {
  const issuePrs = data.prs.filter(p => p.issueId === issueObj.id);
  if (!issuePrs.length) return true;
  const terminalStatuses = new Set(["pr'd", 'rejected', 'not required']);
  const openPrs = issuePrs.filter(p => !terminalStatuses.has(String(p.status || '').toLowerCase()));
  if (!openPrs.length) return false;
  if (['critical', 'high'].includes(String(issueObj.priority || '').toLowerCase())) return true;
  const staleAfterMs = 14 * 24 * 60 * 60 * 1000;
  return openPrs.some(p => {
    const updatedAt = Date.parse(p.updatedAt || p.createdAt || '');
    return Number.isFinite(updatedAt) && Date.now() - updatedAt >= staleAfterMs;
  });
}
function renderActiveIssueFilters() {
  const row = document.getElementById('issueActiveFilters');
  if (!row) return;
  const state = getIssueFilterState();
  const entries = [
    ['search', 'Search', state.search],
    ['version', 'Version', state.version],
    ['priority', 'Priority', state.priority],
    ['important', 'Importance', state.important ? 'Important' : ''],
    ['prStatus', 'PR status', state.prStatus],
    ['company', 'Company', state.company],
    ['reportedVer', 'Reported version', state.reportedVer],
    ['attention', 'View', state.attention ? 'Needs attention' : '']
  ].filter(([, , value]) => value);
  row.innerHTML = entries.map(([key, label, value]) =>
    `<button type="button" class="filter-chip" onclick="removeIssueFilter('${key}')"><span>${esc(label)}: ${esc(value)}</span><span aria-hidden="true">×</span></button>`
  ).join('');
  row.classList.toggle('hidden', !entries.length);
  const count = document.getElementById('issueFilterCount');
  if (count) count.textContent = String(entries.filter(([key]) => key !== 'search' && key !== 'attention').length);
  const clear = document.getElementById('clearIssueFiltersBtn');
  if (clear) clear.disabled = !entries.length;
}
function renderIssueViews() {
  const row = document.getElementById('issueViewsRow');
  if (!row) return;
  const views = settings.savedViews || [];
  const cur = JSON.stringify(getIssueFilterState());
  const attentionOn = document.getElementById('issueAttention')?.value === '1';
  const attentionCount = data.issues.filter(issueNeedsAttention).length;
  row.innerHTML = `<button type="button" class="view-chip attention-view ${attentionOn ? 'on' : ''}" onclick="toggleAttentionView()" aria-pressed="${attentionOn}">Needs attention <span class="view-count">${attentionCount}</span></button>` + views.map(v => {
    const on = JSON.stringify(v.filters || {}) === cur;
    return `<span class="view-chip ${on ? 'on' : ''}" data-vid="${esc(v.id)}" onclick="applySavedView('${esc(v.id)}')">
      ${esc(v.name)}
      <span class="x" title="Delete view" onclick="event.stopPropagation();deleteSavedView('${esc(v.id)}')">×</span>
    </span>`;
  }).join('') + (views.length ? '' : '<span class="muted" style="font-size:12px">No saved views — set filters, then “Save view”.</span>');
}
function saveCurrentIssueView() {
  const name = prompt('Name for this view (filters):');
  if (!name || !name.trim()) return;
  if (!settings.savedViews) settings.savedViews = [];
  settings.savedViews.push({ id: uid('v'), name: name.trim(), filters: getIssueFilterState() });
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  renderIssueViews();
}
function applySavedView(id) {
  const v = (settings.savedViews || []).find(x => x.id === id);
  if (!v) return;
  applyIssueFilterState(v.filters || {});
}
function deleteSavedView(id) {
  if (!confirm('Delete this saved view?')) return;
  settings.savedViews = (settings.savedViews || []).filter(x => x.id !== id);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  renderIssueViews();
}


function filterIssuePrs(issueId) {
  const root = document.querySelector(`[data-issue-prs="${CSS.escape(issueId)}"]`);
  if (!root) return;
  const q = (root.querySelector('.prs-search')?.value || '').toLowerCase().trim();
  const st = (root.querySelector('.prs-status-filter')?.value || '').trim();
  const rows = [...root.querySelectorAll('.pr-row')];
  let visible = 0;
  rows.forEach(row => {
    const hay = row.getAttribute('data-search') || '';
    const rowSt = row.getAttribute('data-status') || '';
    const okQ = !q || hay.includes(q);
    const okS = !st || rowSt === st;
    const show = okQ && okS;
    row.classList.toggle('pr-hidden', !show);
    if (show) visible++;
  });
  const meta = document.getElementById('prs-meta-' + issueId);
  if (meta) {
    if (!rows.length) meta.textContent = '';
    else if (visible === rows.length) meta.textContent = rows.length + ' destination' + (rows.length === 1 ? '' : 's');
    else meta.textContent = 'Showing ' + visible + ' of ' + rows.length;
  }
  const empty = root.querySelector('.prs-filter-empty');
  if (rows.length && visible === 0) {
    if (!empty) {
      const el = document.createElement('div');
      el.className = 'prs-empty prs-filter-empty';
      el.textContent = 'No destinations match this search/filter.';
      root.querySelector('.prs-list')?.appendChild(el);
    }
  } else if (empty) {
    empty.remove();
  }
}


function sortedIssues(list) {
  const arr = [...(list || [])];
  const hasManual = arr.some(i => typeof i.sortOrder === 'number');
  if (hasManual) {
    arr.sort((a, b) => {
      const ao = typeof a.sortOrder === 'number' ? a.sortOrder : 1e15;
      const bo = typeof b.sortOrder === 'number' ? b.sortOrder : 1e15;
      if (ao !== bo) return ao - bo;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  } else {
    // Newest created first (desc). Manual drag order still wins when sortOrder is set.
    arr.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id || '').localeCompare(String(a.id || '')));
  }
  return arr;
}
function nextIssueSortOrder() {
  let max = -1;
  (data.issues || []).forEach(i => { if (typeof i.sortOrder === 'number' && i.sortOrder > max) max = i.sortOrder; });
  return max + 1;
}
let _dragIssueId = null;
function onIssueDragStart(e, id) {
  _dragIssueId = id;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', id); } catch (err) { }
  const card = e.target.closest('.issue-card');
  if (card) setTimeout(() => card.classList.add('dragging'), 0);
}
function onIssueDragEnd(e) {
  document.querySelectorAll('.issue-card.dragging,.issue-card.drag-over').forEach(el => {
    el.classList.remove('dragging'); el.classList.remove('drag-over');
  });
  _dragIssueId = null;
}
function onIssueDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const card = e.currentTarget;
  document.querySelectorAll('.issue-card.drag-over').forEach(el => { if (el !== card) el.classList.remove('drag-over'); });
  card.classList.add('drag-over');
}
function onIssueDragLeave(e) {
  if (e.currentTarget.contains(e.relatedTarget)) return;
  e.currentTarget.classList.remove('drag-over');
}
function onIssueDrop(e, targetId) {
  e.preventDefault();
  e.stopPropagation();
  let fromId = null;
  try { fromId = e.dataTransfer.getData('text/plain'); } catch (err) { }
  fromId = fromId || _dragIssueId;
  document.querySelectorAll('.issue-card.drag-over').forEach(el => el.classList.remove('drag-over'));
  if (!fromId || fromId === targetId) return;
  let order = sortedIssues(data.issues).map(i => i.id);
  const fromIdx = order.indexOf(fromId);
  if (fromIdx < 0) return;
  order.splice(fromIdx, 1);
  const newTo = order.indexOf(targetId);
  if (newTo < 0) order.push(fromId);
  else order.splice(newTo, 0, fromId);
  order.forEach((id, idx) => { const i = issue(id); if (i) i.sortOrder = idx; });
  save();
  renderIssues();
}

function renderIssues() {
  renderStats();
  ssMountFilter('issueVersionFilter', 'issueVersion', versionNames(), 'All versions', () => renderIssues());
  ssMountFilter('issuePriorityFilter', 'issuePriority', PRIORITIES, 'All priority', () => renderIssues());
  ssMountFilter('issueImportantFilter', 'issueImportant', [{ value: 'important', label: 'Important only' }], 'All importance', () => renderIssues());
  ssMountFilter('issuePrStatusFilter', 'issuePrStatus', statuses(), 'All PR status', () => renderIssues());
  ssMountFilter('issueCompanyFilter', 'issueCompany', companyNames(false), 'All companies', () => renderIssues());
  ssMountFilter('issueReportedVerFilter', 'issueReportedVer', versionNames(), 'All reported ver.', () => renderIssues());
  const q = document.getElementById('issueSearch').value.toLowerCase();
  const v = document.getElementById('issueVersion').value;
  const pv = document.getElementById('issuePriority').value;
  const ps = document.getElementById('issuePrStatus').value;
  const imp = document.getElementById('issueImportant').value;
  const co = document.getElementById('issueCompany')?.value || '';
  const rv = document.getElementById('issueReportedVer')?.value || '';
  const attention = document.getElementById('issueAttention')?.value === '1';
  const arr = data.issues.filter(i => {
    const prs = data.prs.filter(p => p.issueId === i.id);
    return (!q || [i.jira, i.description, i.notes, i.reportedBy || '', i.reportedVersion || ''].join(' ').toLowerCase().includes(q))
      && (!v || i.version === v) && (!pv || i.priority === pv)
      && (!ps || prs.some(p => p.status === ps))
      && (!imp || (i.tags || []).map(t => t.toLowerCase()).includes('important'))
      && (!co || i.reportedBy === co)
      && (!rv || i.reportedVersion === rv)
      && (!attention || issueNeedsAttention(i));
  });
  const el = document.getElementById('issueCards');
  const sorted = sortedIssues(arr);
  if (!sorted.length) {
    el.innerHTML = '<div class="empty">No issues match.</div>';
    updateCollapseAllButton(); renderIssueViews(); renderActiveIssueFilters(); return;
  }
  el.innerHTML = sorted.map(i => {
    const issuePrList = data.prs.filter(p => p.issueId === i.id);
    const prs = issuePrList.map(p => {
      const d = dest(p.destinationId); if (!d) return '';
      const searchBlob = [destLabel(d), d.branch, d.company, d.kind, p.status, (p.tags || []).join(' '), p.notes || '', p.prUrl || ''].join(' ').toLowerCase();
      return `<div class="pr-row" data-pr-id="${esc(p.id)}" data-status="${esc(p.status || '')}" data-search="${esc(searchBlob)}">
        <div class="pr-main">
          <span class="pr-dest" dir="auto">${esc(destLabel(d))}</span>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            ${inlineStatusHtml(p.id, p.status)}
            <button class="btn edit" style="padding:3px 8px;font-size:11px" data-pr="${esc(p.id)}" onclick="onOpenPr(this)">Edit</button>
          </div>
        </div>
        <div class="muted" style="font-size:11px">${d.kind === 'temp' ? esc(d.company || '') + ' · temp' : 'master'} · ${branchLinkHtml(d)}</div>
        <div class="tags">${tagHtml(p.tags)}${p.prUrl ? ` · ${prUrlHtml(p)}` : ''}</div>
        ${p.notes ? `<div dir="auto" class="notes" style="margin-top:5px">${esc(p.notes)}</div>` : ''}
        <div class="time-meta">Created ${formatTime(p.createdAt)} · Updated ${formatTime(p.updatedAt)}</div>
      </div>`;
    }).join('');
    const statusOpts = ['<option value="">All statuses</option>'].concat(statuses().map(s => `<option value="${esc(s)}">${esc(s)}</option>`)).join('');
    const expanded = getExpanded(i.id);
    return `<article class="card issue-card" data-issue-id="${esc(i.id)}"
      ondragover="onIssueDragOver(event)" ondragleave="onIssueDragLeave(event)" ondrop="onIssueDrop(event,'${esc(i.id)}')">
      <div class="card-head" style="cursor:pointer" data-id="${esc(i.id)}" onclick="onToggleIssue(this)">
        <span class="drag-handle" title="Drag to reorder" draggable="true"
          ondragstart="event.stopPropagation();onIssueDragStart(event,'${esc(i.id)}')"
          ondragend="onIssueDragEnd(event)"
          onclick="event.stopPropagation()">⠿</span>
        <div style="min-width:0">
          <div>${jiraHtml(i)}</div>
          <div dir="auto" class="card-title">${esc(i.description || 'Untitled')}</div>
          <div class="meta">
            <span class="inline-hit" data-issue="${esc(i.id)}" onclick="onInlineIssueVersion(this)" title="Click to change version">${coloredChip(i.version, itemColor(versionObj(i.version)))}</span>
            <span class="inline-hit chip priority-${(i.priority || 'normal').toLowerCase()}" data-issue="${esc(i.id)}" onclick="onInlineIssuePriority(this)" title="Click to change priority">${esc(i.priority)}</span>
          </div>
          ${progressHtml(i.id)}
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <button class="btn edit icon" data-id="${esc(i.id)}" onclick="onOpenIssue(this)">Edit</button>
          <button type="button" class="btn issue-expand" aria-expanded="${expanded}" aria-label="${expanded ? 'Collapse' : 'Expand'} ${esc(i.jira || i.description || 'issue')} details" onclick="event.stopPropagation();toggleIssue('${esc(i.id)}')"><span aria-hidden="true">${expanded ? '▾' : '▸'}</span><span>${issuePrList.length} PR${issuePrList.length === 1 ? '' : 's'}</span></button>
        </div>
      </div>
      <div class="issue-body ${expanded ? '' : 'hidden'}">
        <div class="issue-secondary-meta">
          <div class="meta">
            <span class="inline-hit" data-issue="${esc(i.id)}" onclick="onInlineIssueCompany(this)" title="Click to change company">${i.reportedBy ? coloredChip('Company · ' + i.reportedBy, (companyObj(i.reportedBy) || {}).color || '') : coloredChip('Company · —', '')}</span>
            <span class="inline-hit" data-issue="${esc(i.id)}" onclick="onInlineIssueReportedVer(this)" title="Click to change reported version">${i.reportedVersion ? coloredChip('Reported · ' + i.reportedVersion, itemColor(versionObj(i.reportedVersion))) : coloredChip('Reported · —', '')}</span>
            ${(i.tags || []).map(t => coloredChip('#' + t, itemColor(tagObj(t)))).join('')}
          </div>
          <div class="time-meta">Created ${formatTime(i.createdAt)} · Updated ${formatTime(i.updatedAt)}</div>
        </div>
        <div class="card-desc">${i.notes ? `<div dir="auto" class="notes">${esc(i.notes)}</div>` : ''}</div>
        <div class="prs" data-issue-prs="${esc(i.id)}">
          <div class="prs-head">
            <div class="prs-title">PR destinations · <span class="prs-total">${issuePrList.length}</span></div>
            ${issuePrList.length ? `<div class="prs-tools" onclick="event.stopPropagation()">
              <input dir="auto" class="field prs-search" placeholder="Search branch, company, tags…" oninput="filterIssuePrs('${esc(i.id)}')">
              <select class="field prs-status-filter" onchange="filterIssuePrs('${esc(i.id)}')">${statusOpts}</select>
            </div>`: ''}
          </div>
          <div class="prs-list" id="prs-list-${esc(i.id)}">
            ${prs || '<div class="prs-empty">No PR destinations yet.</div>'}
          </div>
          <div class="prs-visible-meta" id="prs-meta-${esc(i.id)}"></div>
          <div class="prs-foot">
            <button class="btn primary" style="flex:1" data-issue="${esc(i.id)}" onclick="onOpenPr(this)">+ Add destination</button>
            <button class="btn" style="flex:1" onclick="event.stopPropagation();openBulkAddDestModal('${esc(i.id)}')">Bulk add…</button>
          </div>
        </div>
      </div>
    </article>`;
  }).join('');
  updateCollapseAllButton();
  renderIssueViews();
  renderActiveIssueFilters();
}

function openIssueModal(id) {
  const defaultVer = versionNames().includes('V14+') ? 'V14+' : (versionNames()[0] || '');
  const i = id ? issue(id) : { jira: '', link: '', description: '', version: defaultVer, priority: 'Normal', reportedBy: '', reportedVersion: '', tags: [], notes: '' };
  openModal(`<div class="modal-head"><h2>${id ? 'Edit issue' : 'New issue'}</h2><button class="kebab" onclick="closeModal()">×</button></div>
  <form class="modal-body" onsubmit="saveIssue(event,'${id || ''}')">
    <div class="grid2">
      <div class="form-group"><label>Jira ID</label>
        <input dir="auto" class="field" name="jira" value="${esc(i.jira)}" placeholder="ABC-123"
          oninput="onJiraIdInput(this)" onblur="onJiraIdInput(this)">
        <div class="small" style="margin-top:4px">Fills the link from Settings → Jira base URL when set.</div>
      </div>
      <div class="form-group"><label>Jira link</label>
        <input dir="auto" class="field" name="link" value="${esc(i.link)}" placeholder="http://jira.../browse/ABC-123"
          oninput="onJiraLinkInput(this)" onblur="onJiraLinkInput(this)">
        <div class="small" style="margin-top:4px">Paste a full URL to auto-fill the Jira ID.</div>
      </div>
    </div>
    <div class="form-group"><label>Description</label><input dir="auto" required class="field" name="description" value="${esc(i.description)}"></div>
    <div class="grid2">
      <div class="form-group"><label>Target version</label>
        ${ssHtml({ id: 'issVersion', name: 'version', options: versionNames(), value: i.version })}
      </div>
      <div class="form-group"><label>Priority</label>
        ${ssHtml({ id: 'issPriority', name: 'priority', options: PRIORITIES, value: i.priority || 'Normal' })}
      </div>
    </div>
    <div class="grid2">
      <div class="form-group"><label>Reported by company</label>
        ${ssHtml({ id: 'issReportedBy', name: 'reportedBy', options: companyNames(false), value: i.reportedBy || '', emptyLabel: '— None —', emptyValue: '' })}
        <div class="small" style="margin-top:4px">Company that reported this issue.</div>
      </div>
      <div class="form-group"><label>Reported on version</label>
        ${ssHtml({ id: 'issReportedVer', name: 'reportedVersion', options: versionNames(), value: i.reportedVersion || '', emptyLabel: '— None —', emptyValue: '' })}
        <div class="small" style="margin-top:4px">Version where it was found / reported.</div>
      </div>
    </div>
    <div class="form-group"><label>Tags</label>${tagPickerHtml(i.tags || [])}</div>
    <div class="form-group"><label>Notes</label><textarea dir="auto" class="field" name="notes">${esc(i.notes)}</textarea></div>
    ${id ? `<div class="time-meta" style="margin-bottom:10px">Created ${formatTime(i.createdAt)} · Updated ${formatTime(i.updatedAt)}</div>` : ''}
    <div class="form-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      ${id ? `<button type="button" class="btn danger" data-id="${esc(id)}" onclick="onDeleteIssue(this)">Delete</button>` : ''}
      <button class="btn success">Save issue</button>
    </div>
  </form>`);
  ['issVersion', 'issPriority', 'issReportedBy', 'issReportedVer'].forEach(ssRenderList);
}
function saveIssue(e, id) {
  e.preventDefault();
  const f = new FormData(e.target);
  const tags = collectTagsFromPicker(); ensureTagsInCatalog(tags);
  const x = { jira: f.get('jira'), link: f.get('link'), description: f.get('description'), version: f.get('version'), priority: f.get('priority'), reportedBy: f.get('reportedBy') || '', reportedVersion: f.get('reportedVersion') || '', tags, notes: f.get('notes'), updatedAt: nowIso() };
  if (id) {
    const existing = issue(id);
    if (existing && !existing.createdAt) x.createdAt = existing.updatedAt || nowIso();
    Object.assign(existing, x);
  } else {
    data.issues.push({ id: uid('i'), createdAt: nowIso(), ...x, sortOrder: (typeof x.sortOrder === 'number' ? x.sortOrder : (data.issues.some(i => typeof i.sortOrder === 'number') ? nextIssueSortOrder() : undefined)) });
  }
  save(); closeModal(); renderIssues();
}
function deleteIssue(id) {
  if (!confirm('Delete this issue and its PR records?')) return;
  data.issues = data.issues.filter(i => i.id !== id);
  data.prs = data.prs.filter(p => p.issueId !== id);
  save(); closeModal(); renderIssues();
}

/* ── PRs ── */
function availableDestinationsForIssue(issueId, excludePrId) {
  const selectedIssue = issue(issueId);
  const used = new Set(data.prs.filter(x => x.issueId === issueId && x.id !== excludePrId).map(x => x.destinationId));
  if (!selectedIssue) return data.destinations.filter(d => d.active && !used.has(d.id));
  return data.destinations.filter(d => compatible(selectedIssue, d) && !used.has(d.id));
}
function buildDestGroups(available) {
  const groups = [];
  available.filter(d => d.kind === 'master').slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach(m => {
    const temps = available.filter(t => t.kind === 'temp' && t.parentId === m.id)
      .slice().sort((a, b) => String(a.company || '').localeCompare(String(b.company || '')) || String(a.branch || '').localeCompare(String(b.branch || '')));
    groups.push({ master: m, temps });
  });
  const orphans = available.filter(d => d.kind === 'temp' && !available.some(m => m.kind === 'master' && m.id === d.parentId));
  if (orphans.length) groups.push({ master: null, temps: orphans, orphan: true });
  return groups;
}
function destSearchBlob(d) {
  return [d.name, d.branch, d.company, d.kind, effectiveFromVersion(d)].join(' ').toLowerCase();
}

function openPrModal(prId, issueId) {
  const p = prId ? data.prs.find(x => x.id === prId) : { issueId: issueId || data.issues[0]?.id || '', destinationId: '', status: 'TODO', prUrl: '', tags: [], notes: '' };
  const available = availableDestinationsForIssue(p.issueId, prId || '');
  const selected = dest(p.destinationId);
  const display = selected ? destLabel(selected) : (available.length ? 'Select destination…' : 'No compatible destinations');

  openModal(`<div class="modal-head"><h2>${prId ? 'Edit PR' : 'Add PR destination'}</h2><button class="kebab" onclick="closeModal()">×</button></div>
  <form class="modal-body" onsubmit="savePr(event,'${prId || ''}')">
    <div class="form-group"><label>Issue</label>
      <select class="field" name="issueId" id="prIssueSelect" onchange="onPrIssueChange()">${data.issues.map(i => `<option value="${i.id}" ${i.id === p.issueId ? 'selected' : ''}>${esc(i.jira)} · ${esc(i.description)} · ${esc(i.version)}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>Destination</label>
      <input type="hidden" name="destinationId" id="prDestSelect" value="${esc(p.destinationId || '')}">
      <div class="ss-wrap" id="prDestSS">
        <div class="ss-display" id="prDestDisplay" onclick="toggleDestSS()">
          <span class="ss-val" id="prDestDisplayVal">${esc(display)}</span>
          <span class="muted">▾</span>
        </div>
        <div class="ss-panel" id="prDestPanel">
          <div class="ss-search"><input dir="auto" class="field" id="prDestSearch" placeholder="Search master, company, branch…" oninput="filterDestSS()" onclick="event.stopPropagation()"></div>
          <div class="ss-list" id="prDestList"></div>
        </div>
      </div>
      <div class="small" style="margin-top:4px">Only masters/temps on this issue’s version line or later (V14+ → V14, V15, … — not V11/V12).</div>
    </div>
    <div class="form-group"><label>Status</label>
      ${ssHtml({ id: 'prStatusSS', name: 'status', options: statuses(), value: p.status || 'TODO' })}
    </div>
    <div class="form-group"><label>Tags</label>${tagPickerHtml(p.tags || [])}</div>
    <div class="form-group"><label>Submitted PR link (optional)</label>
      <input dir="auto" class="field" name="prUrl" value="${esc(p.prUrl || '')}" placeholder="http://eit-tfs:8080/.../pullrequest/123">
      <div class="small" style="margin-top:4px">Link to the PR you opened in Azure/TFS for this destination.</div>
    </div>
    <div class="form-group"><label>Notes</label><textarea dir="auto" class="field" name="notes">${esc(p.notes || '')}</textarea></div>
    <div class="form-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      ${prId ? `<button type="button" class="btn danger" data-id="${esc(prId)}" onclick="onDeletePr(this)">Delete</button>` : ''}
      <button class="btn success">Save PR</button>
    </div>
  </form>`);
  window._prModalPrId = prId || '';
  renderDestSSList();
  ssRenderList('prStatusSS');
  document.addEventListener('click', closeDestSSOnOutside);
}
function onPrIssueChange() {
  document.getElementById('prDestSelect').value = '';
  document.getElementById('prDestDisplayVal').textContent = 'Select destination…';
  const search = document.getElementById('prDestSearch'); if (search) search.value = '';
  renderDestSSList();
}
function toggleDestSS() {
  const panel = document.getElementById('prDestPanel');
  if (!panel) return;
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) {
    const s = document.getElementById('prDestSearch');
    if (s) { s.focus(); s.select(); }
  }
}
function closeDestSSOnOutside(e) {
  const wrap = document.getElementById('prDestSS');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('prDestPanel')?.classList.remove('open');
  }
}
function filterDestSS() { renderDestSSList(); }
function renderDestSSList() {
  const list = document.getElementById('prDestList');
  if (!list) return;
  const issueId = document.getElementById('prIssueSelect')?.value;
  const q = (document.getElementById('prDestSearch')?.value || '').toLowerCase().trim();
  const selectedId = document.getElementById('prDestSelect')?.value;
  let available = availableDestinationsForIssue(issueId, window._prModalPrId || '');
  if (selectedId && !available.some(d => d.id === selectedId)) {
    const cur = dest(selectedId); if (cur) available = available.concat([cur]);
  }
  if (q) {
    const matched = available.filter(d => destSearchBlob(d).includes(q));
    const ids = new Set(matched.map(d => d.id));
    matched.forEach(d => {
      if (d.kind === 'temp' && d.parentId) ids.add(d.parentId);
    });
    available.filter(d => d.kind === 'master' && destSearchBlob(d).includes(q)).forEach(m => {
      available.filter(t => t.kind === 'temp' && t.parentId === m.id).forEach(t => ids.add(t.id));
    });
    available = available.filter(d => ids.has(d.id));
  }
  const groups = buildDestGroups(available);
  if (!groups.length) {
    list.innerHTML = '<div class="ss-empty">No matching destinations for this issue version.</div>';
    return;
  }
  list.innerHTML = groups.map(g => {
    if (g.orphan) {
      return `<div class="ss-group">Other</div>` + g.temps.map(t => ssItemHtml(t, selectedId, true)).join('');
    }
    const m = g.master;
    let html = `<div class="ss-group">${esc(m.name)} · ${esc(effectiveFromVersion(m) || '')}</div>`;
    html += ssItemHtml(m, selectedId, false);
    html += g.temps.map(t => ssItemHtml(t, selectedId, true)).join('');
    return html;
  }).join('');
}
function ssItemHtml(d, selectedId, indent) {
  const main = d.kind === 'master' ? (d.name || d.branch) : (d.branch || d.name);
  const sub = d.kind === 'master'
    ? `master · ${fromVersionLabel(d.fromVersion)}`
    : `${d.company || ''} · temp`;
  return `<div class="ss-item ${indent ? 'indent' : ''} ${d.id === selectedId ? 'active' : ''}" data-id="${d.id}" data-id="${esc(d.id)}" onclick="onPickDest(this)">
    <span class="ss-main">${esc(main)}</span>
    <span class="ss-sub">${esc(sub)}</span>
  </div>`;
}
function pickDestSS(id) {
  const d = dest(id);
  document.getElementById('prDestSelect').value = id;
  document.getElementById('prDestDisplayVal').textContent = d ? destLabel(d) : id;
  document.getElementById('prDestPanel')?.classList.remove('open');
}
function refreshPrDestinations(issueId) { onPrIssueChange(); }

function savePr(e, id) {
  e.preventDefault();
  const f = new FormData(e.target);
  const tags = collectTagsFromPicker(); ensureTagsInCatalog(tags);
  const x = { issueId: f.get('issueId'), destinationId: f.get('destinationId'), status: f.get('status'), prUrl: (f.get('prUrl') || '').trim(), tags, notes: f.get('notes'), updatedAt: nowIso() };
  if (!x.destinationId) { alert('Pick a destination.'); return; }
  if (id) {
    const existing = data.prs.find(p => p.id === id);
    if (existing && !existing.createdAt) x.createdAt = existing.updatedAt || nowIso();
    Object.assign(existing, x);
  } else {
    data.prs.push({ id: uid('p'), createdAt: nowIso(), ...x });
  }
  // touch parent issue
  const iss = issue(x.issueId);
  if (iss) { iss.updatedAt = nowIso(); if (!iss.createdAt) iss.createdAt = iss.updatedAt; }
  save(); closeModal(); renderIssues(); renderPRs();
}
function deletePr(id) {
  if (!confirm('Delete this PR record?')) return;
  data.prs = data.prs.filter(p => p.id !== id); save(); closeModal(); renderPRs(); renderIssues();
}

function renderPRs() {
  const companies = uniqSorted(data.destinations.map(d => d.company).filter(Boolean));
  ssMountFilter('prStatusFilter', 'prStatus', statuses(), 'All statuses', () => renderPRs());
  ssMountFilter('prCompanyFilter', 'prCompany', companies, 'All companies', () => renderPRs());
  ssMountFilter('prVersionFilter', 'prVersion', versionNames(), 'All versions', () => renderPRs());
  const q = document.getElementById('prSearch').value.toLowerCase();
  const s = document.getElementById('prStatus').value;
  const c = document.getElementById('prCompany').value;
  const v = document.getElementById('prVersion').value;
  const arr = data.prs.filter(p => {
    const i = issue(p.issueId), d = dest(p.destinationId); if (!i || !d) return false;
    return (!q || [i.jira, i.description, d.name, d.branch, d.company, p.prUrl || '', (p.tags || []).join(' ')].join(' ').toLowerCase().includes(q))
      && (!s || p.status === s) && (!c || d.company === c) && (!v || i.version === v);
  });
  const el = document.getElementById('prList');
  el.innerHTML = arr.length ? arr.map(p => {
    const i = issue(p.issueId), d = dest(p.destinationId);
    return `<div class="dest-row">
      <div>
        <div><b>${esc(i.jira)}</b> · ${esc(i.description)}</div>
        <div class="muted">${esc(i.version)} → <b dir="auto">${esc(destLabel(d))}</b> · ${branchLinkHtml(d)}</div>
        <div class="tags">${tagHtml(p.tags)}${p.prUrl ? ` · ${prUrlHtml(p)}` : ''}</div>
        ${p.notes ? `<div class="notes" style="margin-top:4px">${esc(p.notes)}</div>` : ''}
        <div class="time-meta">Created ${formatTime(p.createdAt)} · Updated ${formatTime(p.updatedAt)}</div>
      </div>
      <div style="display:flex;gap:7px;align-items:center">
        ${inlineStatusHtml(p.id, p.status)}
        <button class="btn" data-pr="${esc(p.id)}" onclick="onOpenPr(this)">Edit</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty">No PR records match.</div>';
}

/* ── Destinations: master + temp hierarchy ── */
function renderDestinations() {
  ssMountFilter('destCompanyFilterWrap', 'destCompanyFilter', companyNames(false), 'All companies', () => renderDestinations());
  ssMountFilter('destFromFilterWrap', 'destFromFilter', versionNames(), 'All from-versions', () => renderDestinations());
  ssMountFilter('destActiveFilterWrap', 'destActiveFilter', [{ value: '1', label: 'Active' }, { value: '0', label: 'Inactive' }], 'All', () => renderDestinations());
  const q = (document.getElementById('destSearch')?.value || '').toLowerCase();
  const cf = document.getElementById('destCompanyFilter')?.value || '';
  const ff = document.getElementById('destFromFilter')?.value || '';
  const af = document.getElementById('destActiveFilter')?.value || '';

  const matchActive = (d) => af === '' || (af === '1' ? d.active : !d.active);
  const matchQ = (d) => !q || [d.name, d.branch, d.company, d.fromVersion].join(' ').toLowerCase().includes(q);

  let masterList = masters().filter(m => {
    if (!matchActive(m) && !tempsOf(m.id).some(matchActive)) return false;
    if (ff && m.fromVersion !== ff) return false;
    // company filter: keep master if any temp matches company, or no company filter
    if (cf) {
      const temps = tempsOf(m.id).filter(t => t.company === cf && matchActive(t) && matchQ(t));
      if (!temps.length && !(matchQ(m) && !cf)) return false;
      // still show master shell if temps match
    }
    if (q) {
      const self = matchQ(m);
      const child = tempsOf(m.id).some(t => matchQ(t) && matchActive(t) && (!cf || t.company === cf));
      if (!self && !child) return false;
    }
    return true;
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  // Orphan temps (no parent)
  const orphans = data.destinations.filter(d => d.kind === 'temp' && !dest(d.parentId))
    .filter(t => matchActive(t) && matchQ(t) && (!cf || t.company === cf) && (!ff || effectiveFromVersion(t) === ff));

  const el = document.getElementById('destList');
  if (!masterList.length && !orphans.length) {
    el.innerHTML = '<div class="empty">No destinations. Add a Master (e.g. v14_master), then Temp branches under it.</div>';
    return;
  }

  let html = masterList.map(m => {
    let temps = tempsOf(m.id).filter(t => matchActive(t) && matchQ(t) && (!cf || t.company === cf));
    temps = temps.sort((a, b) => {
      const c = String(a.company || '').localeCompare(String(b.company || ''));
      return c || String(a.branch || '').localeCompare(String(b.branch || ''));
    });
    const expanded = getMasterExpanded(m.id);
    return `<div class="master-block">
      <div class="master-head" data-id="${esc(m.id)}" onclick="onToggleMaster(this)">
        <div style="min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="kind-chip kind-master">master</span>
            <b dir="auto">${esc(m.name)}</b>
            <span class="muted">${esc(m.branch)}</span>
            ${!m.active ? '<span class="chip">Inactive</span>' : ''}
          </div>
          <div class="muted" style="margin-top:4px;font-size:12px">${fromVersionLabel(m.fromVersion)} · ${branchLinkHtml(m)} · ${temps.length} temp · Updated ${formatTime(m.updatedAt)}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap" onclick="event.stopPropagation()">
          <button class="btn" title="Create missing temp branches for every active company" data-id="${esc(m.id)}" onclick="onBulkTemps(this)">Temps for all companies</button>
          <button class="btn" data-master="${esc(m.id)}" onclick="onOpenTemp(this)">+ Temp</button>
          <button class="btn" data-id="${esc(m.id)}" onclick="onOpenMaster(this)">Edit</button>
          <span class="chip" style="font-size:16px;padding:2px 8px">${expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      <div class="master-body ${expanded ? '' : 'hidden'}">
        ${temps.length ? temps.map(t => `
          <div class="temp-row">
            <div class="left">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span class="kind-chip kind-temp">temp</span>
                <b>${branchLinkHtml(t, t.branch || t.name)}</b>
                ${coloredChip(t.company, (companyObj(t.company) || {}).color || '')}
                ${!t.active ? '<span class="chip">Inactive</span>' : ''}
              </div>
              ${t.name && t.name !== t.branch ? `<div class="muted" style="font-size:12px;margin-top:2px">${esc(t.name)}</div>` : ''}
              <div class="time-meta">Updated ${formatTime(t.updatedAt)}</div>
            </div>
            <button class="btn" data-temp="${esc(t.id)}" onclick="onOpenTemp(this)">Edit</button>
          </div>
        `).join('') : '<div class="muted" style="padding:8px">No temp branches yet. Use “+ Temp”.</div>'}
      </div>
    </div>`;
  }).join('');

  if (orphans.length) {
    html += `<div class="master-block">
      <div class="master-head" style="cursor:default">
        <div><span class="kind-chip kind-temp">orphan temps</span> <b>No parent master</b>
          <div class="muted" style="margin-top:4px;font-size:12px">Link these to a master by editing them.</div>
        </div>
      </div>
      <div class="master-body">
        ${orphans.map(t => `
          <div class="temp-row">
            <div class="left">
              <b>${branchLinkHtml(t, t.branch || t.name)}</b>
              <span class="chip">${esc(t.company || '?')}</span>
            </div>
            <button class="btn" data-temp="${esc(t.id)}" onclick="onOpenTemp(this)">Edit</button>
          </div>
        `).join('')}
      </div>
    </div>`;
  }

  el.innerHTML = html;
}

function openMasterModal(id) {
  const defaultFrom = versionNames().includes('V14+') ? 'V14+' : (versionNames()[0] || '');
  const d = id ? dest(id) : { name: '', branch: '', fromVersion: defaultFrom, active: true };
  openModal(`<div class="modal-head"><h2>${id ? 'Edit master' : 'New master'}</h2><button class="kebab" onclick="closeModal()">×</button></div>
  <form class="modal-body" onsubmit="saveMaster(event,'${id || ''}')">
    <div class="form-group"><label>Display name</label>
      <input dir="auto" required class="field" name="name" value="${esc(d.name)}" placeholder="v14_master">
    </div>
    <div class="form-group"><label>Branch name</label>
      <input dir="auto" required class="field" name="branch" value="${esc(d.branch || '')}" placeholder="v14_master">
      <div class="small" style="margin-top:4px">Shared / not company-specific (v14_master, v15_master, developer, …).</div>
    </div>
    <div class="form-group"><label>Supports from version</label>
      ${ssHtml({ id: 'masterFromVer', name: 'fromVersion', options: versionNames(), value: d.fromVersion || versionNames()[0] || '' })}
      <div class="small" style="margin-top:4px">Version line of this master. A V14+ issue sees V14+ and later masters, not V11+/V12+.</div>
    </div>
    <div class="form-group"><label>Azure path override (optional)</label>
      <input dir="auto" class="field" name="azurePath" value="${esc(d.azurePath || '')}" placeholder="Leave empty to use Settings template">
      <div class="small" style="margin-top:4px">Full path after GB, e.g. <code>masters/v14_master</code> or <code>developer</code>. Preview: <span id="azurePathPreview" class="muted"></span></div>
    </div>
    <div class="form-group"><label><input type="checkbox" name="active" ${d.active !== false ? 'checked' : ''}> Active</label></div>
    <div class="form-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      ${id ? `<button type="button" class="btn danger" data-id="${esc(id)}" onclick="onDeleteMaster(this)">Delete</button>` : ''}
      <button class="btn success">Save master</button>
    </div>
  </form>`);
  ssRenderList('masterFromVer');
  updateAzurePathPreview('master');
  const ap = document.querySelector('#modal input[name=azurePath]');
  const br = document.querySelector('#modal input[name=branch]');
  if (ap) ap.addEventListener('input', () => updateAzurePathPreview('master'));
  if (br) br.addEventListener('input', () => updateAzurePathPreview('master'));
}
function updateAzurePathPreview(kind) {
  const el = document.getElementById('azurePathPreview');
  if (!el) return;
  const branch = (document.querySelector('#modal input[name=branch]')?.value || '').trim();
  const azurePath = (document.querySelector('#modal input[name=azurePath]')?.value || '').trim();
  const company = (document.getElementById('tempCompanySelect')?.value || '').trim();
  const parentId = (document.getElementById('tempParentSelect')?.value || '');
  const draft = { kind: kind === 'temp' ? 'temp' : 'master', branch, name: branch, azurePath, company, parentId };
  if (kind === 'temp' && parentId) { const p = dest(parentId); if (p) draft.fromVersion = p.fromVersion; }
  const path = azureBranchPath(draft);
  const url = azureBranchUrl(draft);
  el.textContent = url ? path + ' → openable' : (path || '(set repo URL in Settings)');
}
function saveMaster(e, id) {
  e.preventDefault();
  const f = new FormData(e.target);
  const x = {
    name: f.get('name'), branch: f.get('branch'), fromVersion: f.get('fromVersion'),
    azurePath: (f.get('azurePath') || '').trim(),
    active: f.get('active') === 'on', kind: 'master', company: null, parentId: null
  };
  x.updatedAt = nowIso();
  if (id) {
    const existing = dest(id);
    if (existing && !existing.createdAt) x.createdAt = existing.updatedAt || nowIso();
    Object.assign(existing, x);
  } else {
    data.destinations.push({ id: uid('m'), createdAt: nowIso(), ...x });
  }
  save(); closeModal(); renderDestinations();
}
function deleteMaster(id) {
  const kids = tempsOf(id);
  if (kids.length) {
    alert('This master has ' + kids.length + ' temp branch(es). Delete or reassign them first.');
    return;
  }
  if (data.prs.some(p => p.destinationId === id)) {
    alert('This master is used by PR records. Remove those PRs or mark inactive.');
    return;
  }
  if (!confirm('Delete this master?')) return;
  data.destinations = data.destinations.filter(d => d.id !== id);
  save(); closeModal(); renderDestinations();
}

function openTempModal(preselectMasterId, tempId) {
  const activeCos = companyNames(true);
  const d = tempId ? dest(tempId) : { name: '', branch: '', company: activeCos[0] || '', parentId: preselectMasterId || masters()[0]?.id || '', active: true };
  const masterOptions = masters().map(m => ({
    value: m.id,
    label: m.name,
    sub: fromVersionLabel(m.fromVersion),
    search: [m.name, m.branch, m.fromVersion].join(' ')
  }));
  let cos = activeCos.slice();
  if (d.company && !cos.includes(d.company)) cos = [d.company, ...cos];
  openModal(`<div class="modal-head"><h2>${tempId ? 'Edit temp branch' : 'New temp branch'}</h2><button class="kebab" onclick="closeModal()">×</button></div>
  <form class="modal-body" onsubmit="saveTemp(event,'${tempId || ''}')">
    <div class="form-group"><label>Parent master</label>
      ${ssHtml({ id: 'tempParentSelect', name: 'parentId', options: masterOptions, value: d.parentId || preselectMasterId || masters()[0]?.id || '' })}
    </div>
    <div class="form-group"><label>Company</label>
      ${ssHtml({ id: 'tempCompanySelect', name: 'company', options: cos, value: d.company || cos[0] || '' })}
      <div class="small" style="margin-top:4px">Only <b>active</b> companies are listed.</div>
    </div>
    <div class="form-group"><label>Branch name</label>
      <input dir="auto" required class="field" name="branch" id="tempBranchInput" value="${esc(d.branch || '')}" placeholder="Temp_14_Saman" oninput="this.dataset.userEdit='1'">
    </div>
    <div class="form-group"><label>Display name</label>
      <input dir="auto" class="field" name="name" id="tempNameInput" value="${esc(d.name || '')}" placeholder="Same as branch if empty" oninput="this.dataset.userEdit='1'">
    </div>
    <div class="form-group"><label>Azure path override (optional)</label>
      <input dir="auto" class="field" name="azurePath" value="${esc(d.azurePath || '')}" placeholder="Leave empty to use Settings template">
      <div class="small" style="margin-top:4px">Preview: <span id="azurePathPreview" class="muted"></span></div>
    </div>
    <div class="form-group"><label><input type="checkbox" name="active" ${d.active !== false ? 'checked' : ''}> Active</label></div>
    <div class="form-actions">
      <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      ${tempId ? `<button type="button" class="btn danger" data-id="${esc(tempId)}" onclick="onDeleteTemp(this)">Delete</button>` : ''}
      <button class="btn success">Save temp</button>
    </div>
  </form>`);
  ssRenderList('tempParentSelect');
  ssRenderList('tempCompanySelect');
  const regP = window._ssRegistry['tempParentSelect'];
  const regC = window._ssRegistry['tempCompanySelect'];
  if (regP) regP.onChange = () => { suggestTempBranch(true); updateAzurePathPreview('temp'); };
  if (regC) regC.onChange = () => { suggestTempBranch(true); updateAzurePathPreview('temp'); };
  document.querySelector('#modal input[name=azurePath]')?.addEventListener('input', () => updateAzurePathPreview('temp'));
  document.getElementById('tempBranchInput')?.addEventListener('input', () => updateAzurePathPreview('temp'));
  if (!tempId) suggestTempBranch(true);
  updateAzurePathPreview('temp');
}
function suggestTempBranch(force) {
  const parentId = document.getElementById('tempParentSelect')?.value;
  const company = document.getElementById('tempCompanySelect')?.value;
  const branchInput = document.getElementById('tempBranchInput');
  const nameInput = document.getElementById('tempNameInput');
  if (!branchInput || !nameInput) return;
  const parent = dest(parentId);
  if (!parent || !company) return;
  const { branch, name } = suggestTempNames(parent, company);
  const branchLocked = !force && branchInput.dataset.userEdit === '1';
  const nameLocked = !force && nameInput.dataset.userEdit === '1';
  if (!branchLocked) { branchInput.value = branch; delete branchInput.dataset.userEdit; }
  if (!nameLocked) { nameInput.value = name; delete nameInput.dataset.userEdit; }
}
function expectedTempBranch(parent, company) {
  return suggestTempNames(parent, company).branch;
}
function reevaluateTempBranchNames() {
  const status = document.getElementById('reevalStatus');
  let fixed = 0, skipped = 0, looked = 0;
  (data.destinations || []).forEach(d => {
    if (d.kind !== 'temp') return;
    looked++;
    const parent = dest(d.parentId);
    if (!parent || !d.company) { skipped++; return; }
    const expected = expectedTempBranch(parent, d.company);
    if (!expected) { skipped++; return; }
    const branchSame = (d.branch || '') === expected;
    const nameWasAuto = !d.name || d.name === d.branch || /^temp_/i.test(d.name || '');
    if (branchSame && !(nameWasAuto && d.name !== expected)) { return; }
    d.branch = expected;
    if (nameWasAuto) d.name = expected;
    d.updatedAt = nowIso();
    fixed++;
  });
  save();
  if (status) status.textContent = `Checked ${looked} temps · updated ${fixed} · skipped ${skipped}.`;
  if (typeof renderDestinations === 'function') renderDestinations();
  alert(`Temp branch names re-evaluated.\\nUpdated: ${fixed}\\nSkipped: ${skipped}`);
}

function bulkCreateTemps(masterId) {
  const master = dest(masterId);
  if (!master || master.kind !== 'master') { alert('Master not found.'); return; }
  const active = companyNames(true);
  if (!active.length) { alert('No active companies. Enable some under Lists → Companies.'); return; }
  const existing = new Set(tempsOf(masterId).map(t => t.company));
  const missing = active.filter(c => !existing.has(c));
  if (!missing.length) { alert('All active companies already have a temp under this master.'); return; }
  if (!confirm(`Create ${missing.length} temp branch(es) under "${master.name}" for:\n\n${missing.join(', ')}`)) return;
  missing.forEach(company => {
    const { branch, name } = suggestTempNames(master, company);
    const ts = nowIso();
    data.destinations.push({
      id: uid('t'), kind: 'temp', parentId: masterId, company, branch, name,
      fromVersion: null, active: true, createdAt: ts, updatedAt: ts
    });
  });
  save();
  // expand master so user sees them
  const state = JSON.parse(localStorage.getItem('pr-tracker-master-exp-v1') || '{}');
  state[masterId] = true;
  localStorage.setItem('pr-tracker-master-exp-v1', JSON.stringify(state));
  renderDestinations();
  alert(`Created ${missing.length} temp branch(es).`);
}
function saveTemp(e, id) {
  e.preventDefault();
  const f = new FormData(e.target);
  const company = f.get('company');
  const branch = f.get('branch');
  const name = f.get('name') || branch;
  const parentId = f.get('parentId');
  if (!parentId) { alert('Select a parent master.'); return; }
  if (!company) { alert('Select a company.'); return; }
  ensureCompany(company, true);
  const x = {
    kind: 'temp', parentId, company, branch, name,
    fromVersion: null, active: f.get('active') === 'on'
  };
  x.updatedAt = nowIso();
  if (id) {
    const existing = dest(id);
    if (existing && !existing.createdAt) x.createdAt = existing.updatedAt || nowIso();
    Object.assign(existing, x);
  } else {
    data.destinations.push({ id: uid('t'), createdAt: nowIso(), ...x });
  }
  save(); closeModal(); renderDestinations();
}
function deleteTemp(id) {
  if (data.prs.some(p => p.destinationId === id)) {
    alert('This temp is used by PR records. Remove those PRs or mark inactive.');
    return;
  }
  if (!confirm('Delete this temp branch?')) return;
  data.destinations = data.destinations.filter(d => d.id !== id);
  save(); closeModal(); renderDestinations();
}


/* ═══ Cloud sync: encrypted private GitHub Gist ═══ */
/* cloudSession defined at boot */


function updateCloudSyncUI() {
  const el = document.getElementById('cloudSyncStatus');
  if (!el) return;
  if (cloudSession.unlocked) {
    el.style.borderColor = '#3ca875';
    el.innerHTML = 'Unlocked · Gist: <code>' + esc(settings.cloudGistId || '(will create on push)') + '</code>'
      + (cloudSession.lastPush ? ' · last push ' + esc(cloudSession.lastPush) : '')
      + (cloudSession.lastPull ? ' · last pull ' + esc(cloudSession.lastPull) : '');
  } else {
    el.style.borderColor = '';
    el.textContent = 'Locked — enter passphrase + GitHub token, then Unlock. Data stays local until you push.';
  }
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}
async function deriveCloudKey(passphrase, saltBuf) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations: 310000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function encryptPayload(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return { v: 1, alg: 'AES-GCM-PBKDF2', iv: bufToB64(iv), data: bufToB64(cipher) };
}
async function decryptPayload(wrapper, key) {
  if (!wrapper || wrapper.v !== 1 || !wrapper.iv || !wrapper.data) throw new Error('Invalid encrypted blob');
  const iv = new Uint8Array(b64ToBuf(wrapper.iv));
  const cipher = b64ToBuf(wrapper.data);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain));
}

function cloudSetStatus(msg, isErr) {
  const el = document.getElementById('cloudSyncStatus');
  if (!el) return;
  el.style.borderColor = isErr ? '#e35c5c' : (cloudSession.unlocked ? '#3ca875' : '');
  el.textContent = msg;
}


function saveCloudCreds(pass, token) {
  try {
    if (settings.cloudRemember === false) { clearSavedCloudCreds(); return; }
    localStorage.setItem(CLOUD_CREDS_KEY, JSON.stringify({ passphrase: pass, token: token, savedAt: Date.now() }));
  } catch (e) { console.warn('Could not save cloud creds', e); }
}
function clearSavedCloudCreds() {
  try { localStorage.removeItem(CLOUD_CREDS_KEY); } catch (e) { }
}
function loadCloudCreds() {
  try { return JSON.parse(localStorage.getItem(CLOUD_CREDS_KEY) || 'null'); } catch (e) { return null; }
}
function fillCloudCredFieldsFromStorage() {
  const c = loadCloudCreds();
  if (!c) return;
  const p = document.getElementById('cloudPassphrase');
  const t = document.getElementById('cloudToken');
  if (p && !p.value && c.passphrase) p.value = c.passphrase;
  if (t && !t.value && c.token) t.value = c.token;
}
function stopCloudLiveSync() {
  if (cloudSession.pollTimer) { clearInterval(cloudSession.pollTimer); cloudSession.pollTimer = null; }
}
function startCloudLiveSync() {
  stopCloudLiveSync();
  if (!cloudSession.unlocked || settings.cloudLiveSync === false) return;
  cloudSession.pollTimer = setInterval(() => {
    if (cloudSession.unlocked && !cloudSession.pushing && !cloudSession.pulling) {
      cloudPull({ silent: true, replaceConfirm: false, onlyIfNewer: true });
    }
  }, 20000);
}
async function cloudUnlock(fromAuto) {
  fillCloudCredFieldsFromStorage();
  let pass = (document.getElementById('cloudPassphrase')?.value || '').trim();
  let token = (document.getElementById('cloudToken')?.value || '').trim();
  if (!pass || !token) {
    const c = loadCloudCreds();
    if (c) { pass = pass || c.passphrase || ''; token = token || c.token || ''; }
  }
  if (!pass || pass.length < 8) {
    if (!fromAuto) cloudSetStatus('Passphrase must be at least 8 characters.', true);
    return false;
  }
  if (!token) {
    if (!fromAuto) cloudSetStatus('GitHub token required (gist scope).', true);
    return false;
  }
  try {
    let saltB64 = localStorage.getItem('pr-tracker-cloud-salt') || '';
    let saltBuf;
    if (saltB64) {
      saltBuf = b64ToBuf(saltB64);
    } else {
      saltBuf = crypto.getRandomValues(new Uint8Array(16)).buffer;
      saltB64 = bufToB64(saltBuf);
      localStorage.setItem('pr-tracker-cloud-salt', saltB64);
    }
    const key = await deriveCloudKey(pass, saltBuf);
    cloudSession.unlocked = true;
    cloudSession.token = token;
    cloudSession.passphrase = pass;
    cloudSession.key = key;
    cloudSession.saltB64 = saltB64;
    saveCloudCreds(pass, token);
    // also persist gist id field
    saveSettings();
    cloudSetStatus(fromAuto ? 'Auto-unlocked.' : 'Unlocked — credentials saved on this browser.', false);
    updateCloudSyncUI();
    stopCloudLiveSync();
    return true;
  } catch (e) {
    console.error(e);
    if (!fromAuto) cloudSetStatus('Unlock failed: ' + (e.message || e), true);
    return false;
  }
}
function cloudLock() {
  cloudSession.unlocked = false;
  cloudSession.token = '';
  cloudSession.passphrase = '';
  cloudSession.key = null;
  stopCloudLiveSync();
  const remember = settings.cloudRemember !== false;
  if (!remember) {
    clearSavedCloudCreds();
    const p = document.getElementById('cloudPassphrase'); if (p) p.value = '';
    const t = document.getElementById('cloudToken'); if (t) t.value = '';
  }
  updateCloudSyncUI();
  cloudSetStatus(remember ? 'Locked (saved credentials kept for next visit).' : 'Locked — saved credentials cleared.', false);
}

function cloudHeaders() {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + cloudSession.token,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
}

function cloudPlainBackup() {
  return {
    version: 6,
    section: 'all',
    exportedAt: new Date().toISOString(),
    data: JSON.parse(JSON.stringify(data)),
    settings: exportableSettings(),
    // salt must travel with ciphertext so other devices can derive the same key
    _salt: cloudSession.saltB64 || localStorage.getItem('pr-tracker-cloud-salt') || ''
  };
}

async function cloudPush(manual) {
  if (!cloudSession.unlocked || !cloudSession.key || !cloudSession.token) {
    if (manual) cloudSetStatus('Unlock first (passphrase + token).', true);
    return;
  }
  if (cloudSession.pushing) return;
  cloudSession.pushing = true;
  try {
    saveSettings();
    if (manual) cloudSetStatus('Encrypting and pushing…', false);
    const plain = cloudPlainBackup();
    if (!plain._salt) {
      const saltBuf = crypto.getRandomValues(new Uint8Array(16)).buffer;
      plain._salt = bufToB64(saltBuf);
      cloudSession.saltB64 = plain._salt;
      localStorage.setItem('pr-tracker-cloud-salt', plain._salt);
      const pass = cloudSession.passphrase || (document.getElementById('cloudPassphrase')?.value || '').trim();
      if (!pass) throw new Error('Passphrase required to establish salt');
      cloudSession.key = await deriveCloudKey(pass, saltBuf);
    }
    const salt = plain._salt;
    delete plain._salt;
    const enc = await encryptPayload(plain, cloudSession.key);
    const fileBody = JSON.stringify({ salt, ciphertext: enc, savedAt: new Date().toISOString() }, null, 2);

    // Dated backup snapshot (same encryption)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = 'backup-' + stamp + '.enc.json';

    const gistId = (settings.cloudGistId || '').trim();
    let res, json;
    if (!gistId) {
      res = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: cloudHeaders(),
        body: JSON.stringify({
          description: 'PR Tracker encrypted sync (do not share)',
          public: false,
          files: {
            'pr-tracker.enc.json': { content: fileBody },
            [backupName]: { content: fileBody }
          }
        })
      });
    } else {
      // Fetch existing files to prune old backups
      let existingFiles = {};
      try {
        const gr = await fetch('https://api.github.com/gists/' + encodeURIComponent(gistId), { headers: cloudHeaders() });
        if (gr.ok) {
          const gj = await gr.json();
          existingFiles = gj.files || {};
        }
      } catch (e) { }
      const filesUpdate = {
        'pr-tracker.enc.json': { content: fileBody },
        [backupName]: { content: fileBody }
      };
      // Keep only last 5 backup-* files (delete older via null)
      const backupKeys = Object.keys(existingFiles).filter(k => /^backup-.*\.enc\.json$/i.test(k)).sort();
      const toRemove = backupKeys.slice(0, Math.max(0, backupKeys.length - 4)); // leave room for new one → ~5 total
      toRemove.forEach(k => { filesUpdate[k] = null; });

      res = await fetch('https://api.github.com/gists/' + encodeURIComponent(gistId), {
        method: 'PATCH',
        headers: cloudHeaders(),
        body: JSON.stringify({ files: filesUpdate })
      });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('GitHub HTTP ' + res.status + ': ' + t.slice(0, 200));
    }
    json = await res.json();
    if (json.id && json.id !== settings.cloudGistId) {
      settings.cloudGistId = json.id;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      const g = document.getElementById('cloudGistId'); if (g) g.value = json.id;
    }
    cloudSession.lastPush = new Date().toLocaleString();
    cloudSession.lastPushMs = Date.now();
    cloudSession.lastCloudAt = new Date().toISOString();
    cloudSetStatus('Synced to Gist · ' + settings.cloudGistId + (manual ? ' (manual)' : ''), false);
    updateCloudSyncUI();
  } catch (e) {
    console.error(e);
    cloudSetStatus('Push failed: ' + (e.message || e), true);
  } finally {
    cloudSession.pushing = false;
  }
}

async function cloudPull(opts) {
  opts = opts || {};
  if (!cloudSession.unlocked || !cloudSession.key || !cloudSession.token) {
    if (!opts.silent) cloudSetStatus('Unlock first (passphrase + token).', true);
    return;
  }
  if (cloudSession.pulling || cloudSession.pushing) return;
  const gistId = (settings.cloudGistId || document.getElementById('cloudGistId')?.value || '').trim();
  if (!gistId) {
    if (!opts.silent) cloudSetStatus('Enter a Gist ID to pull (from your other device).', true);
    return;
  }
  // Local has unsaved cloud push pending — push first instead of overwriting
  if (opts.onlyIfNewer && cloudSession.lastLocalEditMs > (cloudSession.lastPushMs || 0) + 800) {
    scheduleCloudPush();
    return;
  }
  if (opts.replaceConfirm !== false) {
    if (!confirm('Pull from cloud and replace local data with the cloud copy? (Export all first if unsure.)')) return;
  }
  cloudSession.pulling = true;
  if (!opts.silent) cloudSetStatus('Pulling…', false);
  try {
    const res = await fetch('https://api.github.com/gists/' + encodeURIComponent(gistId), { headers: cloudHeaders() });
    if (!res.ok) throw new Error('GitHub HTTP ' + res.status);
    const gist = await res.json();
    const file = gist.files && (gist.files['pr-tracker.enc.json'] || Object.values(gist.files || {}).find(f => f && f.filename && !String(f.filename).startsWith('backup-')));
    if (!file) throw new Error('No main file in gist');
    let content = file.content;
    if (file.truncated && file.raw_url) {
      const r2 = await fetch(file.raw_url, { headers: { 'Authorization': 'Bearer ' + cloudSession.token, 'Accept': 'application/vnd.github.raw' } });
      if (!r2.ok) throw new Error('Could not download gist file');
      content = await r2.text();
    }
    const parsed = JSON.parse(content);
    if (!parsed.ciphertext || !parsed.salt) throw new Error('Gist is not a valid PR Tracker encrypted blob');
    const cloudSavedAt = parsed.savedAt || '';
    if (opts.onlyIfNewer && cloudSavedAt && cloudSession.lastCloudAt && cloudSavedAt <= cloudSession.lastCloudAt) {
      return; // already up to date
    }
    const pass = cloudSession.passphrase || (document.getElementById('cloudPassphrase')?.value || '').trim();
    if (!pass) throw new Error('Passphrase required');
    const saltBuf = b64ToBuf(parsed.salt);
    cloudSession.key = await deriveCloudKey(pass, saltBuf);
    cloudSession.saltB64 = parsed.salt;
    localStorage.setItem('pr-tracker-cloud-salt', parsed.salt);
    let plain;
    try {
      plain = await decryptPayload(parsed.ciphertext, cloudSession.key);
    } catch (e) {
      throw new Error('Decrypt failed — wrong passphrase or corrupted data');
    }
    const x = plain.data || plain;
    const base = {
      issues: x.issues || [],
      destinations: x.destinations || [],
      prs: x.prs || [],
      versions: x.versions || data.versions,
      companies: x.companies || data.companies,
      statuses: x.statuses || data.statuses,
      tagsCatalog: x.tagsCatalog || data.tagsCatalog
    };
    data = migrateData(base);
    if (plain.settings) {
      const keepGist = settings.cloudGistId;
      applyExportedSettings(plain.settings);
      if (keepGist) settings.cloudGistId = keepGist;
    }
    settings.cloudGistId = gistId;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    cloudSession.suppressPush = true;
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } finally {
      setTimeout(() => { cloudSession.suppressPush = false; }, 800);
    }
    cloudSession.lastPull = new Date().toLocaleString();
    cloudSession.lastCloudAt = cloudSavedAt || plain.exportedAt || cloudSession.lastCloudAt;
    cloudSession.lastPushMs = Date.now(); // local matches cloud
    refreshAllPages();
    if (!opts.silent || !opts.onlyIfNewer) {
      cloudSetStatus(opts.silent ? 'Synced from Gist.' : 'Pulled and decrypted OK.', false);
    }
    updateCloudSyncUI();
  } catch (e) {
    console.error(e);
    if (!opts.silent) cloudSetStatus('Pull failed: ' + (e.message || e), true);
  } finally {
    cloudSession.pulling = false;
  }
}

function scheduleCloudPush() {
  if (cloudSession.pushTimer) clearTimeout(cloudSession.pushTimer);
  cloudSession.pushTimer = setTimeout(() => { cloudPush(false); }, 1500);
}

// Restore token from session if user refreshed same tab
(function restoreCloudSessionToken() {
  try {
    const t = sessionStorage.getItem('pr-tracker-cloud-token');
    if (t) {
      // still need passphrase to unlock key — token alone is not enough
    }
  } catch (e) { }
})();

function exportableSettings() {
  return {
    jiraBaseUrl: settings.jiraBaseUrl || '',
    azureRepoUrl: settings.azureRepoUrl || '',
    azureMasterPath: settings.azureMasterPath || '',
    azureTempPath: settings.azureTempPath || '',
    azureSimpleBranches: settings.azureSimpleBranches || '',
    savedViews: settings.savedViews || [],
    darkMode: !!settings.darkMode,
    autoBackup: !!settings.autoBackup,
    backupMinutes: settings.backupMinutes || 60,
    cloudGistId: settings.cloudGistId || '',
    cloudAutoSync: settings.cloudAutoSync !== false,
    cloudPullOnUnlock: settings.cloudPullOnUnlock !== false,
    cloudRemember: settings.cloudRemember !== false,
    cloudLiveSync: settings.cloudLiveSync !== false
  };
}
function applyExportedSettings(s) {
  if (!s || typeof s !== 'object') return;
  ['jiraBaseUrl', 'azureRepoUrl', 'azureMasterPath', 'azureTempPath', 'azureSimpleBranches'].forEach(k => {
    if (s[k] != null) settings[k] = s[k];
  });
  if (Array.isArray(s.savedViews)) settings.savedViews = s.savedViews;
  if (s.darkMode != null) settings.darkMode = !!s.darkMode;
  if (s.autoBackup != null) settings.autoBackup = !!s.autoBackup;
  if (s.backupMinutes != null) settings.backupMinutes = Number(s.backupMinutes) || 60;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  applyTheme();
}
function buildSectionPayload(section) {
  const exportedAt = new Date().toISOString();
  if (section === 'all') {
    return { version: 6, section: 'all', exportedAt, data: JSON.parse(JSON.stringify(data)), settings: exportableSettings() };
  }
  const slice = {};
  if (section === 'issues') { slice.issues = data.issues; }
  else if (section === 'prs') { slice.prs = data.prs; }
  else if (section === 'destinations') { slice.destinations = data.destinations; }
  else if (section === 'versions') { slice.versions = data.versions; }
  else if (section === 'lists') {
    slice.companies = data.companies;
    slice.statuses = data.statuses;
    slice.tagsCatalog = data.tagsCatalog;
  }
  else if (section === 'settings') { return { version: 6, section: 'settings', exportedAt, settings: exportableSettings() }; }
  else throw new Error('Unknown section');
  return { version: 6, section, exportedAt, data: JSON.parse(JSON.stringify(slice)) };
}
function sectionFilename(section) {
  const map = { all: 'pr-tracker-all', issues: 'pr-tracker-issues', prs: 'pr-tracker-prs', destinations: 'pr-tracker-destinations', versions: 'pr-tracker-versions', lists: 'pr-tracker-lists', settings: 'pr-tracker-settings' };
  return (map[section] || ('pr-tracker-' + section)) + '.json';
}
function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
function exportSection(section) {
  try {
    const payload = buildSectionPayload(section);
    downloadJson(payload, sectionFilename(section));
  } catch (e) {
    alert('Export failed: ' + (e.message || e));
  }
}
function exportData() { exportSection('all'); }

let _importSection = 'all';
function triggerImport(section) {
  _importSection = section || 'all';
  let el = document.getElementById('importFile');
  if (!el) {
    el = document.createElement('input');
    el.type = 'file';
    el.id = 'importFile';
    el.accept = '.json,application/json,text/json';
    el.className = 'hidden';
    el.style.display = 'none';
    el.addEventListener('change', importSectionFile);
    document.body.appendChild(el);
  }
  el.value = '';
  el.click();
}
function mergeById(existing, incoming, idKey = 'id') {
  const map = new Map((existing || []).map(x => [x[idKey], x]));
  (incoming || []).forEach(x => {
    if (!x || x[idKey] == null) return;
    if (map.has(x[idKey])) Object.assign(map.get(x[idKey]), x);
    else map.set(x[idKey], x);
  });
  return [...map.values()];
}
function mergeNamedList(existing, incoming) {
  const toObj = arr => (arr || []).map(x => {
    if (x && typeof x === 'object' && x.name != null) return x;
    return { name: String(x || '').trim(), color: '' };
  }).filter(x => x.name);
  const map = new Map(toObj(existing).map(x => [x.name.toLowerCase(), { ...x }]));
  toObj(incoming).forEach(x => {
    const k = x.name.toLowerCase();
    if (map.has(k)) Object.assign(map.get(k), x);
    else map.set(k, x);
  });
  return [...map.values()];
}
function mergeCompanies(existing, incoming) {
  const map = new Map((existing || []).map(c => [String(c.name).toLowerCase(), { ...c }]));
  (incoming || []).forEach(c => {
    if (!c || !c.name) return;
    const k = String(c.name).toLowerCase();
    if (map.has(k)) Object.assign(map.get(k), c);
    else map.set(k, { name: c.name, active: c.active !== false, color: c.color || '' });
  });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function refreshAllPages() {
  try { renderIssues(); } catch (e) { }
  try { renderPRs(); } catch (e) { }
  try { renderDestinations(); } catch (e) { }
  try { renderVersions(); } catch (e) { }
  try { renderLists(); } catch (e) { }
  try { renderSettings(); } catch (e) { }
}

function matchDestByBranch(branch) {
  if (!branch) return null;
  const n = String(branch).trim().toLowerCase();
  const list = data.destinations || [];
  let d = list.find(x => (x.branch || '').toLowerCase() === n);
  if (d) return d;
  d = list.find(x => (x.name || '').toLowerCase() === n);
  if (d) return d;
  d = list.find(x => destLabel(x).toLowerCase() === n);
  if (d) return d;
  if (n === 'developer') {
    d = list.find(x => (x.branch || '').toLowerCase() === 'developer' || (x.name || '').toLowerCase() === 'developer');
    if (d) return d;
  }
  if (n === 'parsian') {
    d = list.find(x => (x.company || '').toLowerCase() === 'parsian' && x.kind === 'temp');
    if (d) return d;
    d = list.find(x => (x.branch || '').toLowerCase().includes('parsian'));
  }
  // case-insensitive temp_ vs Temp_
  d = list.find(x => (x.branch || '').toLowerCase() === n || (x.name || '').toLowerCase() === n);
  return d || null;
}
function linkPrDestinationBranches(prList) {
  let linked = 0, unmatched = 0;
  (prList || []).forEach(p => {
    if (p.destinationId && dest(p.destinationId)) { linked++; return; }
    const br = p.destinationBranch || p.branch || '';
    if (!br) { unmatched++; return; }
    const d = matchDestByBranch(br);
    if (d) { p.destinationId = d.id; linked++; }
    else {
      unmatched++;
      const note = 'Unmatched dest: ' + br;
      p.notes = p.notes ? (p.notes + ' | ' + note) : note;
    }
  });
  return { linked, unmatched };
}

function normalizeImportPayload(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('File is not a JSON object');
  // Encrypted gist blob by mistake
  if (raw.ciphertext && raw.salt) {
    throw new Error('This looks like an encrypted Gist file. Use Cloud sync → Unlock → Pull, or Export all for a plain JSON backup.');
  }
  // Full export: { section, data, settings }
  if (raw.data && typeof raw.data === 'object') {
    return { section: raw.section || 'all', data: raw.data, settings: raw.settings || null, raw };
  }
  // Bare dataset: { issues, destinations, prs, ... }
  if (Array.isArray(raw.issues) || Array.isArray(raw.destinations) || Array.isArray(raw.prs)) {
    return { section: 'all', data: raw, settings: raw.settings || null, raw };
  }
  // Settings-only
  if (raw.section === 'settings' || (raw.settings && !raw.data && !raw.issues)) {
    return { section: 'settings', data: {}, settings: raw.settings || raw, raw };
  }
  // Section slice without wrapper
  if (Array.isArray(raw.versions) && !raw.issues) {
    return { section: 'versions', data: { versions: raw.versions }, settings: null, raw };
  }
  if (Array.isArray(raw.companies) || Array.isArray(raw.statuses) || Array.isArray(raw.tagsCatalog)) {
    return { section: 'lists', data: raw, settings: null, raw };
  }
  throw new Error('Unrecognized backup format (need issues/destinations/prs or a PR Tracker export).');
}

function importSectionFile(e) {
  const file = (e && e.target && e.target.files && e.target.files[0]) || null;
  if (!file) { alert('No file selected.'); return; }
  const expected = _importSection || 'all';
  const r = new FileReader();
  r.onerror = () => alert('Could not read file.');
  r.onload = () => {
    try {
      let textContent = r.result;
      if (typeof textContent !== 'string') textContent = String(textContent || '');
      textContent = textContent.replace(/^\uFEFF/, ''); // strip BOM
      const raw = JSON.parse(textContent);
      const norm = normalizeImportPayload(raw);
      let section = norm.section || expected;
      const incoming = norm.data || {};

      // Full replace path
      if (expected === 'all' || section === 'all') {
        if (!confirm('Import ALL data? This replaces your current issues, PRs, destinations, versions, and lists on this browser.')) return;
        const x = incoming;
        const base = {
          issues: Array.isArray(x.issues) ? x.issues : [],
          destinations: Array.isArray(x.destinations) ? x.destinations : [],
          prs: Array.isArray(x.prs) ? x.prs : [],
          versions: Array.isArray(x.versions) && x.versions.length ? x.versions : (data.versions || []),
          companies: Array.isArray(x.companies) ? x.companies : (data.companies || []),
          statuses: Array.isArray(x.statuses) ? x.statuses : (data.statuses || []),
          tagsCatalog: Array.isArray(x.tagsCatalog) ? x.tagsCatalog : (data.tagsCatalog || [])
        };
        if (!base.issues.length && !base.prs.length && !base.destinations.length) {
          if (!confirm('This file has 0 issues, 0 PRs, and 0 destinations. Import anyway?')) return;
        }
        // Keep catalogs/destinations if the import file left them empty (NeedRegister)
        if ((!base.destinations || !base.destinations.length) && (data.destinations || []).length) base.destinations = data.destinations;
        if ((!base.versions || !base.versions.length) && (data.versions || []).length) base.versions = data.versions;
        if ((!base.companies || !base.companies.length) && (data.companies || []).length) base.companies = data.companies;
        if ((!base.statuses || !base.statuses.length) && (data.statuses || []).length) base.statuses = data.statuses;
        if ((!base.tagsCatalog || !base.tagsCatalog.length) && (data.tagsCatalog || []).length) base.tagsCatalog = data.tagsCatalog;
        data = migrateData(base);
        const link = linkPrDestinationBranches(data.prs);
        if (norm.settings) applyExportedSettings(norm.settings);
        try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (err) { throw new Error('Saved data but localStorage failed: ' + err.message); }
        refreshAllPages();
        alert('Full import complete.\nIssues: ' + data.issues.length + '\nPRs: ' + data.prs.length + '\nDestinations: ' + data.destinations.length + '\nLinked PR branches: ' + link.linked + '\nUnmatched: ' + link.unmatched);
        return;
      }

      if (section !== expected && section !== 'all') {
        if (!confirm('This file is tagged as "' + section + '" but you chose "' + expected + '". Import using the file’s section?')) return;
        // keep file section
      } else {
        section = expected;
      }

      if (section === 'issues') {
        if (!Array.isArray(incoming.issues)) throw new Error('No issues array in file');
        data.issues = mergeById(data.issues, incoming.issues);
        if (Array.isArray(incoming.prs) && incoming.prs.length) {
          linkPrDestinationBranches(incoming.prs);
          data.prs = mergeById(data.prs, incoming.prs);
        }
      } else if (section === 'prs') {
        if (!Array.isArray(incoming.prs)) throw new Error('No PRs array in file');
        linkPrDestinationBranches(incoming.prs);
        data.prs = mergeById(data.prs, incoming.prs);
      } else if (section === 'destinations') {
        if (!Array.isArray(incoming.destinations)) throw new Error('No destinations array in file');
        data.destinations = mergeById(data.destinations, incoming.destinations);
      } else if (section === 'versions') {
        if (!Array.isArray(incoming.versions)) throw new Error('No versions array in file');
        data.versions = mergeNamedList(data.versions, incoming.versions);
      } else if (section === 'lists') {
        if (incoming.companies) data.companies = mergeCompanies(data.companies, incoming.companies);
        if (incoming.statuses) data.statuses = mergeNamedList(data.statuses, incoming.statuses);
        if (incoming.tagsCatalog) data.tagsCatalog = mergeNamedList(data.tagsCatalog, incoming.tagsCatalog);
      } else if (section === 'settings') {
        applyExportedSettings(norm.settings || incoming);
        refreshAllPages();
        alert('Settings imported.');
        return;
      } else {
        throw new Error('Unknown section: ' + section);
      }

      data = migrateData(data);
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (err) { console.error(err); }
      refreshAllPages();
      alert('Imported ' + section + ' (merged with existing data).');
    } catch (err) {
      console.error(err);
      alert('Import failed: ' + (err.message || err));
    }
  };
  r.readAsText(file, 'utf-8');
  if (e && e.target) e.target.value = '';
}
function importData(e) { _importSection = 'all'; importSectionFile(e); }





try {
  applyTheme();
  scheduleAutoBackup();
  restoreBackupDirHandle();
} catch (e) { console.error('Startup prep error', e); }
try {
  renderIssues();
} catch (e) {
  console.error('Startup render error', e);
}
try {
  document.querySelectorAll('.nav button').forEach(btn => {
    if (!btn.onclick && btn.dataset.page) {
      btn.addEventListener('click', () => showPage(btn.dataset.page));
    }
  });
} catch (e) { }

// Auto-unlock if credentials were remembered (does NOT pull — use Pull now on other devices)
(async function cloudAutoBoot() {
  try {
    fillCloudCredFieldsFromStorage();
    const c = loadCloudCreds();
    if (c && c.passphrase && c.token && settings.cloudRemember !== false) {
      await cloudUnlock(true);
    }
  } catch (e) { console.warn('cloud auto-unlock', e); }
})();
