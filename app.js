
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBr69YFaKKYoa2VovDJBPPTwS3mjFgu0Co",
  authDomain: "fsykenya2.firebaseapp.com",
  projectId: "fsykenya2",
  storageBucket: "fsykenya2.firebasestorage.app",
  messagingSenderId: "922718506149",
  appId: "1:922718506149:web:26e2b68af9c2880885514c",
  measurementId: "G-QGTBQ86NBD"
};
const OWNER_EMAILS = ['hillarywokoth@gmail.com', 'ryanmali001@gmail.com'];

/* ---------- Firebase layer: the small database/user/download interface the app uses ---------- */
const FB = { app: null, auth: null, fs: null, user: null };
function fbErr(cb) { return e => { console.error(e); if (cb) cb({ code: e && e.code === 'permission-denied' ? 'invalid_argument' : 'unavailable', message: String(e && e.message) }); }; }
function fbSnap(s) { return { id: s.id, exists: s.exists, data: () => (s.exists ? s.data() : undefined), metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } }; }
function wrapWrite(p) { return p.catch(e => { throw { code: e && e.code === 'permission-denied' ? 'invalid_argument' : (e && e.code === 'resource-exhausted' ? 'quota_exceeded' : 'unavailable'), message: String(e && e.message) }; }); }
function shimDoc(path) {
  const r = FB.fs.doc(path);
  return {
    id: r.id, path,
    get: async () => fbSnap(await r.get()),
    set: d => wrapWrite(r.set(d)),
    update: d => wrapWrite(r.set(d, { merge: true })),
    delete: () => wrapWrite(r.delete()),
    onSnapshot: (next, err) => r.onSnapshot({ includeMetadataChanges: true }, s => next(fbSnap(s)), fbErr(err)),
    collection: p => shimCol(path + '/' + p)
  };
}
function shimCol(path) {
  const r = FB.fs.collection(path);
  return {
    path, doc: id => shimDoc(path + '/' + id),
    onSnapshot: (next, err) => r.onSnapshot({ includeMetadataChanges: true }, s => next({ docs: s.docs.map(fbSnap), size: s.size, empty: s.empty, metadata: { fromCache: s.metadata.fromCache }, docChanges: () => [] }), fbErr(err))
  };
}
const dbShim = { doc: shimDoc, collection: shimCol };
const userShim = {
  me: async () => ({ id: S.uid, name: S.meName, email: S.email, isOwner: S.isOwner, canEdit: S.medAdmin }),
  profiles: async ids => { const out = {}; [].concat(ids).forEach(id => { const p = (S.profiles || {})[id]; out[id] = { id, name: p ? p.name || '' : '', email: p ? p.email || null : null, guest: false, isMe: id === S.uid }; }); return out; },
  search: async () => []
};
const downloadShim = {
  save: async ({ filename, data }) => {
    const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000); return { status: 'saved' };
  }
};

/* ===== Core logic ===== */
/* ===== FSY Check-in core logic (pure functions, no DOM) ===== */
const NBUCKETS = 32;
const BANDS = { Y: '13–15', O: '16–18' };
const GENDERS = { F: 'Female', M: 'Male' };
const ROLES = {
  regadmin: 'Registration admin', sdc: 'Session directing couple', coordinator: 'Coordinator',
  ac: 'Assistant coordinator', counselor: 'Counselor', logistics: 'Logistics'
};
const STAFF_ROLES = ['counselor', 'ac', 'coordinator', 'sdc', 'logistics'];
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const SIZE_LABEL = { XS: 'Extra small', S: 'Small', M: 'Medium', L: 'Large', XL: 'XL', XXL: 'XXL', '3XL': '3XL', '': 'Not given' };
const DEFAULT_CONFIG = { sessionName: 'FSY Kenya 2nd 2026', sessionStart: '', groupSize: 10, excludedStakes: [], excludedUnits: [], excludedStatuses: ['CANCELLED'] };

function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function bucketOf(id) { return 'b' + String(fnv(String(id)) % NBUCKETS).padStart(2, '0'); }
function rid(prefix) { return prefix + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7); }
function clean(s) { return s == null ? '' : String(s).replace(/\s+/g, ' ').trim(); }
function titleCase(s) {
  s = clean(s); if (!s) return s;
  if (s === s.toUpperCase() || s === s.toLowerCase()) return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return s;
}
function normGender(g) { g = clean(g).toLowerCase(); if (/^(m|male|man|boy|brother|br)$/.test(g)) return 'M'; if (/^(f|female|woman|girl|sister|sis)$/.test(g)) return 'F'; return ''; }
function normStatus(s) {
  s = clean(s).toUpperCase().replace(/[\s-]+/g, '_');
  if (!s) return '';
  if (/APPROV/.test(s) && /(WAIT|AWAIT|PEND)/.test(s)) return 'WAITING_APPROVAL';
  if (/^APPROVED$/.test(s)) return 'APPROVED';
  if (/CANCEL/.test(s)) return 'CANCELLED';
  if (/(WAIT|AWAIT|PEND)/.test(s)) return 'WAITING_APPROVAL';
  return s;
}
function normSize(s) {
  s = clean(s).toLowerCase().replace(/[\s.-]/g, '');
  if (!s) return '';
  const map = { xs: 'XS', extrasmall: 'XS', s: 'S', small: 'S', sm: 'S', m: 'M', medium: 'M', med: 'M', l: 'L', large: 'L', lg: 'L', xl: 'XL', extralarge: 'XL', xxl: 'XXL', '2xl': 'XXL', xxxl: '3XL', '3xl': '3XL' };
  return map[s] || clean(s).toUpperCase();
}
function normType(t) {
  t = clean(t).toUpperCase();
  if (!t) return '';
  if (/COUNSEL/.test(t)) return 'counselor';
  if (/ASSIST|^AC$|^ACS?$/.test(t)) return 'ac';
  if (/COORD/.test(t)) return 'coordinator';
  if (/DIRECT|^SDC$/.test(t)) return 'sdc';
  if (/LOGIST/.test(t)) return 'logistics';
  if (/PARTIC|YOUTH/.test(t)) return 'participant';
  return '';
}
function pad2(n) { return String(n).padStart(2, '0'); }
function parseDate(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  if (typeof v === 'number' && v > 10000 && v < 80000) { // Excel serial
    const d = new Date(Math.round((v - 25569) * 86400000)); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  const s = clean(v);
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseDate(Number(s));
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) { // Kenyan convention: day/month/year; if first > 12 it is clearly the day
    let d = +m[1], mo = +m[2], y = +m[3]; if (y < 100) y += y > 40 ? 1900 : 2000;
    if (mo > 12 && d <= 12) { const t = d; d = mo; mo = t; }
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }
  const d = new Date(s); if (!isNaN(d)) return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  return '';
}
function ageOn(bday, onDate) {
  if (!bday) return null; const b = bday.split('-').map(Number); if (b.length < 3 || !b[0]) return null;
  const o = onDate ? onDate.split('-').map(Number) : (() => { const d = new Date(); return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; })();
  let a = o[0] - b[0]; if (o[1] < b[1] || (o[1] === b[1] && o[2] < b[2])) a--; return a;
}
function bandOfAge(a) { if (a == null || isNaN(a)) return null; return a <= 15 ? 'Y' : 'O'; }

/* ---- Column mapping ---- */
const FIELDS = [
  ['first', 'First name', ['first name', 'firstname', 'given name', 'first']],
  ['last', 'Last name', ['last name', 'lastname', 'surname', 'family name', 'last']],
  ['pref', 'Preferred name', ['preferred name', 'nickname']],
  ['fullname', 'Full name', ['full name', 'name', 'participant name', 'counselor name']],
  ['bday', 'Birthday', ['birthday', 'birthdate', 'birth date', 'date of birth', 'dob']],
  ['gender', 'Gender', ['gender', 'sex']],
  ['phone', 'Phone', ['phone', 'phone number', 'mobile', 'telephone']],
  ['email', 'Email', ['email', 'email address', 'e-mail']],
  ['med', 'Medical information', ['medical information', 'medical', 'medical info', 'health', 'medical conditions']],
  ['tshirt', 'T-shirt size', ['t-shirt size', 'tshirt size', 't shirt size', 'tshirt', 't-shirt', 'shirt size', 'size']],
  ['diet', 'Dietary information', ['dietary information', 'dietary', 'diet', 'dietary needs', 'dietary info']],
  ['c1n', 'Contact 1 name', ['contact 1 name', 'emergency contact', 'parent name', 'guardian name']],
  ['c1e', 'Contact 1 email', ['contact 1 email', 'parent email']],
  ['c1p', 'Contact 1 phone', ['contact 1 phone', 'parent phone', 'emergency phone']],
  ['c2n', 'Contact 2 name', ['contact 2 name']],
  ['c2e', 'Contact 2 email', ['contact 2 email']],
  ['c2p', 'Contact 2 phone', ['contact 2 phone']],
  ['age', 'Age', ['age']],
  ['regDate', 'Registration date', ['date', 'registration date', 'registered']],
  ['status', 'Status', ['status', 'registration status']],
  ['type', 'Type', ['type', 'role', 'registration type']],
  ['stake', 'Stake / district', ['stake - district name', 'stake', 'district', 'stake/district', 'stake name']],
  ['unit', 'Ward / branch', ['ward - branch name', 'ward', 'branch', 'unit', 'ward/branch', 'ward name']],
  ['bishopE', "Bishop's email", ["bishop's email", 'bishop email', 'bishops email']],
  ['bishopN', "Bishop's name", ["bishop's name", 'bishop name', 'bishops name', 'branch president']],
  ['regId', 'Registration ID', ['registration id', 'reg id', 'id', 'registration number']]
];
function autoMap(headers) {
  const used = new Set(); const map = {};
  const norm = h => clean(h).toLowerCase().replace(/[’`]/g, "'");
  headers.forEach((h, i) => {
    const n = norm(h);
    for (const [key, , aliases] of FIELDS) { if (!used.has(key) && aliases.includes(n)) { map[i] = key; used.add(key); return; } }
  });
  headers.forEach((h, i) => { // loose second pass
    if (map[i]) return; const n = norm(h);
    for (const [key, , aliases] of FIELDS) { if (!used.has(key) && aliases.some(a => a.length > 3 && n.includes(a))) { map[i] = key; used.add(key); return; } }
  });
  return map;
}
/** rows: array of arrays; rows[0] = header. mapping: colIndex->field. mode: 'auto'|'participant'|role */
function rowsToRecords(rows, mapping, mode, now) {
  const out = { participants: [], staff: [], skipped: 0 };
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row || row.every(c => clean(c) === '')) continue;
    const o = {};
    for (const i in mapping) { const k = mapping[i]; if (k) o[k] = row[i]; }
    let first = titleCase(o.first), last = titleCase(o.last);
    if (!first && !last && o.fullname) { const parts = titleCase(o.fullname).split(' '); first = parts.shift() || ''; last = parts.join(' '); }
    if (!first && !last) { out.skipped++; continue; }
    const bday = parseDate(o.bday);
    const ageNum = parseInt(clean(o.age), 10);
    const rec = {
      first, last, pref: titleCase(o.pref), bday, gender: normGender(o.gender),
      phone: clean(o.phone).replace(/\.0$/, ''), email: clean(o.email).toLowerCase(),
      med: clean(o.med), diet: clean(o.diet), tshirt: normSize(o.tshirt),
      c1n: titleCase(o.c1n), c1e: clean(o.c1e).toLowerCase(), c1p: clean(o.c1p).replace(/\.0$/, ''),
      c2n: titleCase(o.c2n), c2e: clean(o.c2e).toLowerCase(), c2p: clean(o.c2p).replace(/\.0$/, ''),
      ageCsv: isNaN(ageNum) ? null : ageNum, regDate: clean(o.regDate), status: normStatus(o.status),
      stake: clean(o.stake), unit: clean(o.unit), bishopE: clean(o.bishopE).toLowerCase(), bishopN: titleCase(o.bishopN)
    };
    const kind = mode === 'auto' ? (normType(o.type) || 'participant') : mode;
    const regId = clean(o.regId);
    if (kind === 'participant') {
      rec.id = regId ? regId.replace(/[^A-Za-z0-9_\-.~:@+]/g, '') : 'X' + fnv((first + last + bday + rec.unit).toLowerCase()).toString(36);
      rec.src = 'import'; rec.imp = now || Date.now();
      out.participants.push(rec);
    } else {
      out.staff.push({
        id: 'S' + (regId ? regId.replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40) : fnv((first + last + bday).toLowerCase()).toString(36)),
        name: (first + ' ' + last).trim(), gender: rec.gender, bday, ageCsv: rec.ageCsv, role: kind,
        phone: rec.phone, email: rec.email, unit: rec.unit, stake: rec.stake, tshirt: rec.tshirt, med: rec.med, diet: rec.diet
      });
    }
  }
  return out;
}

/* ---- Medical & dietary cleanup ---- */
const BENIGN_PHRASES = [
  /\b(physically |medically )?(fit|fine|healthy|well|okay|ok|okey|good|normal)\b/g, /\bn ?[\/\\]? ?a\b/g, /\bnil+\b/g, /\bnone\b/g,
  /no (known )?allerg(y|ies)/g, /not sick/g, /good health/g, /perfect condition/g, /no medical( \w+)*/g,
  /no special die?a?t(ary)?( \w+)*/g, /no spcial diiet/g, /no diet(ary|ery)?( \w+)*/g, /no diatery( \w+)*/g,
  /no complications?/g, /no issues?/g, /no problems?/g, /have no problem/g, /okay with all meals/g, /good with anything/g,
  /anything works/g, /normal diet/g, /no restrictions?( noted)?/g, /not applicable/g, /not available/g
];
const MED_CATS = [
  ['Allergies', /allerg|alerg|allag|rhinitis|pollen|dust/],
  ['Asthma / chest', /asthm|chest|lung|breath|wheez/],
  ['Ulcers / gastric', /ulcer|gastr|pylori|acid|reflux|stomach/],
  ['Diabetes', /diabet|diebat|sugar|insulin/],
  ['Eyes / vision', /\beyes?\b|vision|sight/],
  ['Epilepsy / seizures', /epilep|seiz|convuls/],
  ['Sickle cell / blood', /sickle|anemi|anaemi|blood/],
  ['Takes medication', /medicat|tablet|inhaler|drug|pills?/]
];
const DIET_CATS = [
  ['Vegetarian', /vegetar|vegan/],
  ['No eggs', /egg/],
  ['No meat / chicken / fish', /meat|chicken|fish|pork|mutton|beef|protein/],
  ['No milk / dairy', /milk|dairy|yog|youg|lactose/],
  ['No beans / legumes', /bean|ndengu|githeri|legume|lentil/],
  ['No sukuma / kales', /sukuma|sikuma|kale/],
  ['No Blue Band / margarine', /blue ?band|margarine/],
  ['Acidic / spicy foods', /acid|spic|garlic/],
  ['Sugar / diabetic diet', /sugar|diabet|diebat/],
  ['Fruit restrictions', /watermelon|paw ?p[ao]w|fruit|honey/]
];
const ISSUE_RE = /allerg|alerg|allag|asthm|ulcer|diabet|diebat|eye|pylori|gastr|acid|reflux|chest|lung|sick|rhinit|pollen|dust|epilep|seiz|sickle|anemi|anaemi|medicat|inhaler|vegetar|vegan|egg|bean|milk|dairy|meat|fish|chicken|pork|mutton|beef|sukuma|sikuma|kale|blue ?band|garlic|honey|protein|spic|yog|youg|watermelon|paw ?p[ao]w|ndengu|githeri|sugar|cold|condition|pain|disab|heart|kidney|liver|hiv|surgery|fracture|cannot|can't|cant|doesn|does not|don't take|do not|not eat|prohibit/;
function issueText(raw) {
  let s = clean(raw).toLowerCase(); if (!s) return null;
  for (const re of BENIGN_PHRASES) s = s.replace(re, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s || !ISSUE_RE.test(s)) return null;
  return clean(raw);
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function cats(text, list) { if (!text) return []; const s = text.toLowerCase(); const r = list.filter(([, re]) => re.test(s)).map(([n]) => n); return r.length ? r : ['Other']; }

/* ---- Derive the working participant list ---- */
function derive(rosterBuckets, stateBuckets, cfg, org, staffMap) {
  cfg = Object.assign({}, DEFAULT_CONFIG, cfg || {});
  const exStake = new Set(cfg.excludedStakes || []), exUnit = new Set(cfg.excludedUnits || []), exStatus = new Set(cfg.excludedStatuses || []);
  const st = {}; for (const b in stateBuckets) Object.assign(st, stateBuckets[b] || {});
  const groups = (org && org.groups) || {}, companies = (org && org.companies) || {};
  const list = [];
  for (const b in rosterBuckets) {
    const m = rosterBuckets[b] || {};
    for (const id in m) {
      const base = m[id]; if (!base) continue;
      const s = st[id] || {};
      if (s.del) continue;
      const p = Object.assign({}, base, { id, s: s.s || '', ti: s.ti || null, to: s.to || null, by: s.by || null, g: s.g || null, ov: s.ov || null, mo: s.mo || null, dov: s.do || null });
      p.name = (p.first + ' ' + p.last).trim();
      if (p.bday && /^\d{5}-/.test(p.bday)) { const n = +p.bday.split('-')[0]; p.bday = n > 10000 && n < 80000 ? parseDate(n) : ''; }
      p.unitKey = p.stake + '|' + p.unit;
      p.age = cfg.sessionStart && p.bday ? ageOn(p.bday, cfg.sessionStart) : (p.ageCsv != null ? p.ageCsv : ageOn(p.bday));
      p.band = bandOfAge(p.age);
      const flags = [];
      if (p.src === 'walkin') flags.push('walkin');
      if (exStake.has(p.stake) || exUnit.has(p.unitKey)) flags.push('area');
      if (p.status && exStatus.has(p.status)) flags.push('status');
      else if (p.status && p.status !== 'APPROVED' && p.src !== 'walkin') flags.push('pending');
      if (!p.gender) flags.push('gender');
      if (p.age == null) flags.push('age');
      else if (p.age < 13 || p.age > 18) flags.push('agerange');
      if (!p.tshirt) flags.push('size');
      p.flags = flags;
      p.inc = p.ov === 'inc' ? true : p.ov === 'exc' ? false : !(flags.includes('area') || flags.includes('status'));
      p.elig = p.inc && !!p.gender && !!p.band;
      p.medIssue = p.mo === 'n' ? null : (p.mo === 'y' || p.medF) ? (clean(p.med) || 'Flagged by admin') : issueText(p.med);
      p.dietIssue = p.dov === 'n' ? null : (p.dov === 'y' || p.dietF) ? (clean(p.diet) || 'Flagged by admin') : issueText(p.diet);
      p.group = p.g ? groups[p.g] || null : null;
      p.company = p.group && p.group.companyId ? companies[p.group.companyId] || null : null;
      p.counselor = p.group && p.group.counselorId && staffMap ? staffMap[p.group.counselorId] || null : null;
      list.push(p);
    }
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}
function staffAge(c, cfg) { return c.bday ? ageOn(c.bday, (cfg && cfg.sessionStart) || '') : (c.ageCsv != null ? c.ageCsv : null); }
function cPref(c, band, cfg) { // 0 = preferred, 1 = unknown age, 2 = other band
  const a = staffAge(c, cfg); if (a == null) return 1;
  if (band === 'Y') return a >= 19 && a <= 22 ? 0 : 2;
  return a >= 23 ? 0 : 2;
}

/* ---- Company / group generation ---- */
function sortForDeal(a, b) { return (a.stake || '').localeCompare(b.stake || '') || (a.unit || '').localeCompare(b.unit || '') || a.name.localeCompare(b.name); }
function assignCounselors(groupsArr, counselors, used, cfg) {
  for (let pass = 0; pass <= 2; pass++) {
    for (const g of groupsArr) {
      if (g.counselorId) continue;
      const c = counselors.find(c => !used.has(c.id) && c.gender === g.gender && cPref(c, g.band, cfg) === pass);
      if (c) { g.counselorId = c.id; used.add(c.id); }
    }
  }
}
function placeGroupInCompany(g, companies, groups) {
  const comps = Object.values(companies).filter(c => c.band === g.band);
  if (!comps.length) return null;
  let best = null, bk = null;
  for (const c of comps) {
    const inC = Object.values(groups).filter(x => x.companyId === c.id);
    const key = [inC.filter(x => x.gender === g.gender).length, inC.length, c.num || 0];
    if (!bk || key[0] < bk[0] || (key[0] === bk[0] && (key[1] < bk[1] || (key[1] === bk[1] && key[2] < bk[2])))) { bk = key; best = c; }
  }
  g.companyId = best.id; return best;
}
function bandCap(groups, band) { const gs = Object.values(groups).filter(g => g.band === band); const f = gs.filter(g => g.gender === 'F').length, m = gs.filter(g => g.gender === 'M').length; return gs.length ? Math.max(1, Math.min(f, m)) : 0; }
function assignCoordinators(companies, coords) {
  if (!coords.length) return;
  const ids = new Set(coords.map(c => c.id));
  const arr = Object.values(companies).sort((a, b) => (a.band > b.band ? -1 : a.band < b.band ? 1 : 0) || (a.num || 0) - (b.num || 0));
  const load = {}; coords.forEach(c => load[c.id] = 0);
  arr.forEach(c => { if (c.coordId && ids.has(c.coordId)) load[c.coordId]++; else c.coordId = null; });
  arr.forEach(c => { if (!c.coordId) { const pick = coords.slice().sort((a, b) => load[a.id] - load[b.id])[0]; c.coordId = pick.id; load[pick.id]++; } });
}
function renumber(groups, companies) {
  const comps = Object.values(companies).sort((a, b) => (a.band > b.band ? -1 : a.band < b.band ? 1 : 0) || (a.num || 9999) - (b.num || 9999));
  comps.forEach((c, i) => c.num = i + 1);
  const order = {}; comps.forEach(c => order[c.id] = c.num);
  const gs = Object.values(groups).sort((a, b) => (order[a.companyId] || 9999) - (order[b.companyId] || 9999) || (a.gender > b.gender ? 1 : -1) || (a.num || 9999) - (b.num || 9999));
  gs.forEach((g, i) => g.num = i + 1);
}
function fullGenerate(P, staffList, cfg) {
  cfg = Object.assign({}, DEFAULT_CONFIG, cfg || {});
  const size = +cfg.groupSize || 10;
  const groups = {}, companies = {}, assign = {}, log = [];
  const elig = P.filter(p => p.elig);
  for (const band of ['Y', 'O']) for (const gender of ['F', 'M']) {
    const list = elig.filter(p => p.band === band && p.gender === gender).sort(sortForDeal);
    const G = Math.ceil(list.length / size); const ids = [];
    for (let i = 0; i < G; i++) { const id = rid('g'); groups[id] = { id, band, gender, counselorId: null, companyId: null, num: 0 }; ids.push(id); }
    list.forEach((p, i) => assign[p.id] = ids[i % G]);
    if (G) log.push(`${BANDS[band]} ${gender === 'F' ? 'young women' : 'young men'}: ${list.length} participants in ${G} groups`);
  }
  const counselors = staffList.filter(s => s.role === 'counselor' && s.gender);
  assignCounselors(Object.values(groups), counselors, new Set(), cfg);
  const acs = staffList.filter(s => s.role === 'ac');
  const gY = Object.values(groups).filter(g => g.band === 'Y').length, gO = Object.values(groups).filter(g => g.band === 'O').length;
  const A = acs.length; let cY = 0, cO = 0;
  if (A > 0) {
    if (gY && gO) { if (A === 1) { if (gY >= gO) cY = 1; else cO = 1; } else { cY = Math.min(Math.max(Math.round(A * gY / (gY + gO)), 1), A - 1); cO = A - cY; } }
    else if (gY) cY = A; else if (gO) cO = A;
  }
  cY = Math.min(cY, bandCap(groups, 'Y')); cO = Math.min(cO, bandCap(groups, 'O'));
  let ai = 0;
  for (const [band, n] of [['Y', cY], ['O', cO]]) for (let i = 0; i < n; i++) { const id = rid('c'); companies[id] = { id, band, acId: acs[ai++].id, coordId: null, num: 0 }; }
  const order = Object.values(groups).sort((a, b) => a.gender.localeCompare(b.gender));
  for (const g of order) placeGroupInCompany(g, companies, groups);
  assignCoordinators(companies, staffList.filter(s => s.role === 'coordinator'));
  renumber(groups, companies);
  log.push(`${Object.keys(companies).length} companies formed from ${A} assistant coordinators`);
  if (A - ai > 0) log.push(`${A - ai} assistant coordinator(s) left spare: not enough groups of both genders for more companies`);
  return { org: { groups, companies }, assign, log };
}

/** Keep existing groups; repair after removals; place newcomers; balance. */
function rebalance(P, staffList, org, cfg) {
  cfg = Object.assign({}, DEFAULT_CONFIG, cfg || {});
  const size = +cfg.groupSize || 10;
  const groups = JSON.parse(JSON.stringify((org && org.groups) || {}));
  const companies = JSON.parse(JSON.stringify((org && org.companies) || {}));
  const staffMap = {}; staffList.forEach(s => staffMap[s.id] = s);
  const log = []; const cur = {};
  const members = {}; for (const id in groups) members[id] = [];
  let removed = 0;
  for (const p of P) {
    if (p.g && groups[p.g] && p.elig) { cur[p.id] = p.g; members[p.g].push(p); }
    else { cur[p.id] = null; if (p.g) removed++; }
  }
  if (removed) log.push(`${removed} participant(s) taken out of groups (deleted, excluded or group gone)`);
  // counselors still valid?
  for (const g of Object.values(groups)) {
    const c = g.counselorId && staffMap[g.counselorId];
    if (g.counselorId && (!c || c.role !== 'counselor')) { log.push(`Group ${g.num} lost its counselor`); g.counselorId = null; }
  }
  // empty groups
  for (const g of Object.values(groups)) if (!members[g.id].length) { log.push(`Group ${g.num} was empty and was removed`); delete groups[g.id]; delete members[g.id]; }
  const used = new Set(Object.values(groups).map(g => g.counselorId).filter(Boolean));
  const counselors = staffList.filter(s => s.role === 'counselor' && s.gender);
  const needy = Object.values(groups).filter(g => !g.counselorId);
  assignCounselors(needy, counselors, used, cfg);
  needy.forEach(g => { if (g.counselorId) log.push(`Group ${g.num} now led by ${staffMap[g.counselorId].name}`); });
  // dissolve groups still without counselor when siblings exist
  for (const g of Object.values(groups)) {
    if (g.counselorId) continue;
    const sib = Object.values(groups).filter(x => x.id !== g.id && x.counselorId && x.band === g.band && x.gender === g.gender);
    if (sib.length) { members[g.id].forEach(p => cur[p.id] = null); log.push(`Group ${g.num} had no counselor; its ${members[g.id].length} members were spread to other groups`); delete groups[g.id]; delete members[g.id]; }
  }
  // place unassigned eligible participants
  const waiting = P.filter(p => p.elig && !cur[p.id]).sort(sortForDeal);
  let placed = 0, created = 0, overfull = 0;
  for (const p of waiting) {
    const cands = Object.values(groups).filter(g => g.band === p.band && g.gender === p.gender);
    const withC = cands.filter(g => g.counselorId);
    const pool = withC.length ? withC : cands;
    let best = null, bk = null;
    for (const g of pool) {
      const n = members[g.id].length, same = members[g.id].filter(m => m.unitKey === p.unitKey).length;
      const key = [n, same];
      if (!bk || key[0] < bk[0] || (key[0] === bk[0] && key[1] < bk[1])) { bk = key; best = g; }
    }
    if (!best || members[best.id].length >= size) {
      const c = counselors.find(c => !used.has(c.id) && c.gender === p.gender && cPref(c, p.band, cfg) === 0) || counselors.find(c => !used.has(c.id) && c.gender === p.gender && cPref(c, p.band, cfg) === 1) || counselors.find(c => !used.has(c.id) && c.gender === p.gender);
      if (c || !best) {
        const id = rid('g'); groups[id] = { id, band: p.band, gender: p.gender, counselorId: c ? c.id : null, companyId: null, num: 0 }; members[id] = [];
        if (c) used.add(c.id); best = groups[id]; created++;
      } else overfull++;
    }
    members[best.id].push(p); cur[p.id] = best.id; placed++;
  }
  if (placed) log.push(`${placed} participant(s) placed into groups`);
  if (created) log.push(`${created} new group(s) created`);
  if (overfull) log.push(`${overfull} placement(s) went over the group size of ${size}: add counselors to open new groups`);
  // ACs
  const acs = staffList.filter(s => s.role === 'ac');
  for (const c of Object.values(companies)) {
    const a = c.acId && staffMap[c.acId];
    if (c.acId && (!a || a.role !== 'ac')) { log.push(`Company ${c.num} lost its assistant coordinator`); c.acId = null; }
  }
  const usedAc = new Set(Object.values(companies).map(c => c.acId).filter(Boolean));
  let freeAcs = acs.filter(a => !usedAc.has(a.id));
  for (const c of Object.values(companies)) if (!c.acId && freeAcs.length) { c.acId = freeAcs.shift().id; usedAc.add(c.acId); log.push(`Company ${c.num} now overseen by ${staffMap[c.acId].name}`); }
  for (const c of Object.values(companies)) if (!c.acId) {
    const others = Object.values(companies).filter(x => x.id !== c.id && x.band === c.band && x.acId);
    if (others.length) { Object.values(groups).forEach(g => { if (g.companyId === c.id) g.companyId = null; }); log.push(`Company ${c.num} had no assistant coordinator and was merged into others`); delete companies[c.id]; }
  }
  for (const g of Object.values(groups)) if (g.companyId && !companies[g.companyId]) g.companyId = null;
  // place unassigned groups (before new companies so counts are right)
  const loose = Object.values(groups).filter(g => !g.companyId);
  // bands that have groups but no company: open one if an AC is free
  for (const band of ['Y', 'O']) {
    if (loose.some(g => g.band === band) && !Object.values(companies).some(c => c.band === band) && freeAcs.length) {
      const id = rid('c'); companies[id] = { id, band, acId: freeAcs.shift().id, coordId: null, num: 9000 }; log.push(`New ${BANDS[band]} company opened`);
    }
  }
  let lp = 0; for (const g of loose) if (placeGroupInCompany(g, companies, groups)) lp++;
  if (lp) log.push(`${lp} group(s) added to companies`);
  // spare ACs open new companies and pull whole groups from the largest companies
  while (freeAcs.length) {
    let pick = null, ratio = -1;
    for (const band of ['Y', 'O']) {
      const nc = Object.values(companies).filter(c => c.band === band).length;
      const ng = Object.values(groups).filter(g => g.band === band).length;
      if (!ng || nc >= bandCap(groups, band)) continue;
      const r = ng / (nc + 1); if (r > ratio && ng / Math.max(nc, 1) >= 3) { ratio = r; pick = band; }
    }
    if (!pick) break;
    const id = rid('c'); const comp = companies[id] = { id, band: pick, acId: freeAcs.shift().id, coordId: null, num: 9000 };
    const nc = Object.values(companies).filter(c => c.band === pick).length;
    const target = Math.floor(Object.values(groups).filter(g => g.band === pick).length / nc);
    let moved = 0;
    for (let k = 0; k < target; k++) {
      const mine = Object.values(groups).filter(g => g.companyId === id);
      const needG = mine.filter(g => g.gender === 'F').length <= mine.filter(g => g.gender === 'M').length ? 'F' : 'M';
      const donors = Object.values(companies).filter(c => c.band === pick && c.id !== id).map(c => ({ c, gs: Object.values(groups).filter(g => g.companyId === c.id) })).sort((a, b) => b.gs.length - a.gs.length);
      const d = donors.find(d => d.gs.length > target && d.gs.filter(g => g.gender === needG).length > 1) || donors.find(d => d.gs.length > target);
      if (!d) break;
      const g = d.gs.filter(g => g.gender === needG).pop() || d.gs.pop(); g.companyId = id; moved++;
    }
    log.push(`New ${BANDS[pick]} company opened with ${moved} groups moved whole from the largest companies`);
  }
  if (freeAcs.length) log.push(`${freeAcs.length} assistant coordinator(s) still unassigned`);
  assignCoordinators(companies, staffList.filter(s => s.role === 'coordinator'));
  // numbering: keep existing, give new ones next numbers
  let maxG = Math.max(0, ...Object.values(groups).filter(g => g.num && g.num < 9000).map(g => g.num));
  Object.values(groups).forEach(g => { if (!g.num || g.num >= 9000) g.num = ++maxG; });
  let maxC = Math.max(0, ...Object.values(companies).filter(c => c.num && c.num < 9000).map(c => c.num));
  Object.values(companies).forEach(c => { if (!c.num || c.num >= 9000) c.num = ++maxC; });
  const changes = {}; for (const p of P) if ((p.g || null) !== (cur[p.id] || null)) changes[p.id] = cur[p.id] || null;
  if (!log.length) log.push('Nothing needed changing');
  return { org: { groups, companies }, changes, log };
}

function validate(P, org, staffMap, cfg) {
  cfg = Object.assign({}, DEFAULT_CONFIG, cfg || {});
  const size = +cfg.groupSize || 10; const w = [];
  const groups = (org && org.groups) || {}, companies = (org && org.companies) || {};
  const mem = {}; for (const id in groups) mem[id] = [];
  P.forEach(p => { if (p.g && mem[p.g]) mem[p.g].push(p); });
  const un = P.filter(p => p.elig && (!p.g || !groups[p.g])).length;
  if (un) w.push(['warn', `${un} eligible participant(s) are not in a group`, 'unassigned']);
  for (const g of Object.values(groups)) {
    const c = g.counselorId && staffMap[g.counselorId];
    if (!c) w.push(['bad', `Group ${g.num} has no counselor`]);
    else if (c.gender && c.gender !== g.gender) w.push(['bad', `Group ${g.num}: counselor ${c.name} is not the same gender as the group`]);
    if (mem[g.id].some(p => p.gender !== g.gender)) w.push(['bad', `Group ${g.num} mixes young men and young women`]);
    if (mem[g.id].some(p => p.band && p.band !== g.band)) w.push(['bad', `Group ${g.num} mixes the 13–15 and 16–18 age groups`]);
    if (mem[g.id].length > size) w.push(['warn', `Group ${g.num} has ${mem[g.id].length} participants (size is ${size})`]);
    if (!g.companyId || !companies[g.companyId]) w.push(['warn', `Group ${g.num} is not in a company`]);
    else if (companies[g.companyId].band !== g.band) w.push(['bad', `Group ${g.num} is in a company of the other age group`]);
  }
  for (const c of Object.values(companies)) {
    const gs = Object.values(groups).filter(g => g.companyId === c.id);
    if (!c.acId || !staffMap[c.acId]) w.push(['bad', `Company ${c.num} has no assistant coordinator`]);
    if (!gs.some(g => g.gender === 'F') || !gs.some(g => g.gender === 'M')) w.push(['bad', `Company ${c.num} does not have both young men and young women`]);
  }
  return w;
}

/* ---- T-shirt blanks: estimate sizes from the people most like them ---- */
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
function sizeRank(s) { const i = SIZE_ORDER.indexOf(s); return i < 0 ? 99 : i; }
function largestRemainder(weights, n) { // weights: {size: w}
  const tot = Object.values(weights).reduce((a, b) => a + b, 0); const out = {}; if (!n || !tot) return out;
  const raw = Object.entries(weights).map(([k, w]) => [k, w * n / tot]);
  let used = 0; raw.forEach(([k, v]) => { out[k] = Math.floor(v); used += out[k]; });
  raw.sort((a, b) => (b[1] - Math.floor(b[1])) - (a[1] - Math.floor(a[1]))).slice(0, n - used).forEach(([k]) => out[k]++);
  return out;
}
function teeRedistribute(list) {
  const known = list.filter(p => p.tshirt), blanks = list.filter(p => !p.tshirt);
  const dist = f => { const d = {}; known.filter(f).forEach(p => d[p.tshirt] = (d[p.tshirt] || 0) + 1); return d; };
  const n = d => Object.values(d).reduce((a, b) => a + b, 0);
  const cells = []; const perPerson = {}; const MIN = 20;
  const keys = [];
  for (const band of ['Y', 'O', null]) for (const g of ['F', 'M', '']) keys.push([band, g]);
  for (const [band, g] of keys) {
    const bl = blanks.filter(p => (p.band || null) === band && (p.gender || '') === g);
    const kn = dist(p => (p.band || null) === band && (p.gender || '') === g);
    if (!bl.length && !n(kn)) continue;
    // expected size weights: age+gender if enough data, else band+gender, else gender, else everyone
    const w = {}; const basis = {};
    for (const p of bl) {
      let d = p.age != null && g ? dist(x => x.age === p.age && x.gender === g) : {}; let why = `age ${p.age}, same gender`;
      if (n(d) < MIN) { d = kn; why = 'same age group and gender'; }
      if (n(d) < MIN && g) { d = dist(x => x.gender === g); why = 'same gender'; }
      if (n(d) < MIN) { d = dist(() => true); why = 'everyone'; }
      const t = n(d) || 1; for (const k in d) w[k] = (w[k] || 0) + d[k] / t; basis[why] = (basis[why] || 0) + 1;
    }
    const alloc = largestRemainder(w, bl.length);
    // hand out sizes youngest -> smallest within the cell
    const order = bl.slice().sort((a, b) => (a.age ?? 99) - (b.age ?? 99) || a.name.localeCompare(b.name));
    const pool = Object.entries(alloc).sort((a, b) => sizeRank(a[0]) - sizeRank(b[0])).flatMap(([k, c]) => Array(c).fill(k));
    order.forEach((p, i) => perPerson[p.id] = pool[i] || 'M');
    cells.push({ band, gender: g, known: kn, knownN: n(kn), blank: bl.length, alloc, basis });
  }
  const totals = {}; for (const s of known) totals[s.tshirt] = (totals[s.tshirt] || { given: 0, est: 0 }), totals[s.tshirt].given++;
  for (const id in perPerson) { const s = perPerson[id]; totals[s] = totals[s] || { given: 0, est: 0 }; totals[s].est++; }
  return { cells, perPerson, totals, blankN: blanks.length };
}

/* ---- SHA-256 (sign-in email matching) ---- */
function sha256(ascii) { function rr(v, a) { return (v >>> a) | (v << (32 - a)); } var mp = Math.pow, maxWord = mp(2, 32), result = '', words = [], bitLen = ascii.length * 8, hash = [], k = [], pc = 0, isC = {}, i, j; for (var c = 2; pc < 64; c++) { if (!isC[c]) { for (i = 0; i < 313; i += c) isC[i] = c; hash[pc] = (mp(c, .5) * maxWord) | 0; k[pc++] = (mp(c, 1 / 3) * maxWord) | 0; } } ascii += '\x80'; while (ascii.length % 64 - 56) ascii += '\x00'; for (i = 0; i < ascii.length; i++) { j = ascii.charCodeAt(i); words[i >> 2] |= j << ((3 - i) % 4) * 8; } words[words.length] = ((bitLen / maxWord) | 0); words[words.length] = bitLen; for (j = 0; j < words.length;) { var w = words.slice(j, j += 16), old = hash; hash = hash.slice(0, 8); for (i = 0; i < 64; i++) { var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4], t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ ((~e) & hash[6])) + k[i] + (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0), t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2])); hash = [(t1 + t2) | 0].concat(hash); hash[4] = (hash[4] + t1) | 0; } for (i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0; } for (i = 0; i < 8; i++) for (j = 3; j + 1; j--) { var b = (hash[i] >> (j * 8)) & 255; result += ((b < 16) ? 0 : '') + b.toString(16); } return result; }
function emailKey(e) { return String(e || '').trim().toLowerCase(); }

/* ---- CSV writer ---- */
function toCSV(rows) { return rows.map(r => r.map(v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n'); }

/* ---- Test staff ---- */
const TEST_F = ['Achieng', 'Wanjiru', 'Chebet', 'Njeri', 'Akinyi', 'Nafula', 'Wairimu', 'Atieno', 'Mumbua', 'Kerubo', 'Jepchirchir', 'Nekesa', 'Adhiambo', 'Wambui', 'Moraa', 'Cherono', 'Muthoni', 'Awino', 'Nyambura', 'Kemunto'];
const TEST_M = ['Otieno', 'Kamau', 'Kiprono', 'Mwangi', 'Omondi', 'Wafula', 'Kipchumba', 'Njoroge', 'Ochieng', 'Mutua', 'Barasa', 'Kibet', 'Odhiambo', 'Githinji', 'Simiyu', 'Korir', 'Onyango', 'Maina', 'Wekesa', 'Rotich'];
const TEST_LAST = ['Test', 'Sample', 'Demo'];
function makeTestStaff(P, cfg, nAcs) {
  cfg = Object.assign({}, DEFAULT_CONFIG, cfg || {}); const size = +cfg.groupSize || 10;
  const out = []; const now = new Date(); const yr = now.getFullYear();
  let k = 0;
  const mk = (role, gender, age) => { const names = gender === 'F' ? TEST_F : TEST_M; const n = names[k % names.length]; k++; out.push({ id: 'T' + rid(''), name: `${n} ${TEST_LAST[k % 3]}`, gender, ageCsv: age, bday: (yr - age) + '-06-15', role, test: true, phone: '', unit: '', stake: '' }); };
  for (const band of ['Y', 'O']) for (const g of ['F', 'M']) {
    const n = P.filter(p => p.elig && p.band === band && p.gender === g).length;
    const need = Math.ceil(n / size) + 1;
    for (let i = 0; i < need; i++) mk('counselor', g, band === 'Y' ? 19 + (i % 4) : 23 + (i % 6));
  }
  for (let i = 0; i < nAcs; i++) mk('ac', i % 2 ? 'M' : 'F', 25 + (i % 10));
  mk('coordinator', 'M', 35); mk('coordinator', 'F', 34);
  mk('sdc', 'M', 52); mk('sdc', 'F', 50);
  return out;
}


/* ===== Interface ===== */
/* ===== FSY Check-in UI ===== */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = {
  db: null, user: null, dl: null, uid: null, isOwner: false, meName: '', noDb: false, slow: false,
  roster: {}, rosterEx: new Set(), state: {}, stateEx: new Set(), staff: {}, staffEx: false,
  org: { groups: {}, companies: {} }, orgEx: false, config: Object.assign({}, DEFAULT_CONFIG), configEx: false,
  access: {}, accessEx: false, requests: {}, loaded: {},
  P: [], staffList: [], staffMap: {}, viewAs: null, viewAsStaff: null, names: {},
  medAdmin: false, email: null, medical: {}, medicalEx: new Set(), intake: {}, share: null, shares: {}, invites: {}, members: {}, inviteEmails: {}, claimTried: false
};
const UI = { page: null, frameKey: '', q: '', filter: 'all', stake: '', unit: '', limit: 40, logScope: 'all', staffTab: 'counselor', open: new Set(), openStakes: new Set(), band: '', imp: null, genLog: null, pending: false };

/* ---------- roles ---------- */
function inviteFor(uid) { const m = S.members[uid]; return m && m.h && S.invites[m.h] ? S.invites[m.h] : null; }
function accountOf(uid) { if (S.access[uid]) return S.access[uid]; const i = inviteFor(uid); return i ? { role: i.role, staffId: i.staffId || null, via: 'invite' } : null; }
function realRole() { if (S.isOwner) return 'regadmin'; const a = accountOf(S.uid); return a ? a.role : null; }
function role() { return S.viewAs || realRole(); }
function myStaffId() { if (S.viewAs) return S.viewAsStaff; const a = accountOf(S.uid); return a ? a.staffId || null : null; }
function scopeCompanyIds(r, sid) { const G = Object.values(S.org.groups), C = Object.values(S.org.companies); if (r === 'counselor') return uniq(G.filter(g => sid && g.counselorId === sid).map(g => g.companyId).filter(Boolean)); if (r === 'ac') return C.filter(c => sid && c.acId === sid).map(c => c.id); return []; }
function inScopeFor(p, r, sid) { if (!['counselor', 'ac'].includes(r)) return true; const ids = scopeCompanyIds(r, sid); return (!!p.company && ids.includes(p.company.id)) || (r === 'counselor' && !!p.group && !!sid && p.group.counselorId === sid); }
function seesPrivate(p) { return inScopeFor(p, role(), myStaffId()); }
const can = {
  admin: () => ['regadmin', 'sdc'].includes(role()),
  deleteP: () => role() === 'regadmin',
  checkin: () => ['regadmin', 'sdc', 'coordinator', 'ac', 'counselor'].includes(role()),
  moveAny: () => ['regadmin', 'sdc', 'coordinator'].includes(role()),
  moveOwn: () => role() === 'ac',
  logistics: () => !!role(),
  accounts: () => ['regadmin', 'sdc'].includes(role())
};
const PAGES = [
  ['checkin', 'Check-in', () => can.checkin()],
  ['tally', 'Tally', () => !!role()],
  ['companies', 'Companies & groups', () => can.checkin()],
  ['exceptions', 'Walk-ins & exceptions', () => can.checkin()],
  ['logistics', 'Logistics', () => can.logistics()],
  ['staff', 'Staff', () => can.admin()],
  ['data', 'Data & areas', () => can.admin()],
  ['access', 'Accounts', () => can.accounts()]
];
function allowedPages() { return PAGES.filter(p => p[2]()); }
function currentPage() {
  const ok = allowedPages().map(p => p[0]);
  const h = (location.hash || '').slice(1);
  if (ok.includes(h)) return h;
  if (lgHash() && ok.includes('logistics')) return 'logistics';
  return role() === 'logistics' ? 'logistics' : ok[0] || null;
}

/* ---------- helpers ---------- */
function toast(msg, err) { const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; $('#toast').appendChild(t); setTimeout(() => t.remove(), err ? 6000 : 2600); }
function fail(e) { console.error(e); const c = e && e.code; toast(c === 'quota_exceeded' ? 'Storage is full: delete unused records and try again.' : c === 'invalid_argument' ? 'That change was refused. Your account may not have permission to edit this artifact.' : 'Could not save. Check your connection and try again.', true); }
function fmtTime(t) { if (!t) return ''; const d = new Date(t); const today = new Date().toDateString() === d.toDateString(); return (today ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function gLabel(g) { return g ? 'G' + g.num : '—'; }
function cLabel(c) { return c ? 'Company ' + c.num : '—'; }
function sName(id) { const s = id && S.staffMap[id]; return s ? s.name : ''; }
function genderWord(g, band) { return g === 'F' ? 'Young women' : g === 'M' ? 'Young men' : 'Unknown'; }
function chipG(g) { return g ? `<span class="chip ${g}">${g === 'F' ? 'F' : 'M'}</span>` : '<span class="chip bad">Gender?</span>'; }
function chipBand(b) { return b ? `<span class="chip band">${BANDS[b]}</span>` : '<span class="chip bad">Age?</span>'; }
function pct(a, b) { return b ? Math.round(a * 100 / b) : 0; }
function opt(v, label, sel) { return `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`; }
function uniq(a) { return [...new Set(a)]; }
const FLAG_TEXT = { walkin: ['Walk-in', 'info'], area: ['Excluded area', 'bad'], status: ['Cancelled', 'bad'], pending: ['Not approved yet', 'warn'], gender: ['No gender', 'bad'], age: ['No age', 'bad'], agerange: ['Outside 13–18', 'warn'], size: ['No T-shirt size', 'warn'] };
function flagChips(p, which) {
  const fs = p.flags.filter(f => !which || which.includes(f)).map(f => `<span class="chip ${FLAG_TEXT[f][1]}">${FLAG_TEXT[f][0]}</span>`);
  if (p.ov === 'inc' && (p.flags.includes('area') || p.flags.includes('status'))) fs.push('<span class="chip good">Included by admin</span>');
  if (p.ov === 'exc') fs.push('<span class="chip bad">Excluded by admin</span>');
  return fs.join('');
}
function confirmBox(title, body, okLabel, danger) {
  return new Promise(res => {
    openModal(`<div class="modal-head"><h2>${esc(title)}</h2></div><p class="note" style="margin:0">${body}</p><div class="btnrow"><button class="btn ${danger ? 'danger' : 'primary'}" id="cfOk">${esc(okLabel)}</button><button class="btn" id="cfNo">Cancel</button></div>`);
    $('#cfOk').onclick = () => { closeModal(); res(true); }; $('#cfNo').onclick = () => { closeModal(); res(false); };
  });
}
function openModal(html) { $('#modalRoot').innerHTML = `<div class="modal-bg" id="mbg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`; $('#mbg').addEventListener('click', e => { if (e.target.id === 'mbg') closeModal(); }); }
function closeModal() { $('#modalRoot').innerHTML = ''; }
async function exportCSV(name, rows) {
  if (!S.dl) { toast('Downloads are not available in this view.', true); return; }
  try { await S.dl.save({ filename: name, data: '﻿' + toCSV(rows) }); } catch (e) { if (e && e.code !== 'declined') toast('The file was not saved.', true); }
}

/* ---------- writes ---------- */
const Q = {};
function serial(path, fn) { const p = (Q[path] || Promise.resolve()).catch(() => { }).then(fn); Q[path] = p; return p; }
function upd(path, data, exists) { return serial(path, () => exists ? S.db.doc(path).update(data) : S.db.doc(path).set(data)); }
function setDoc(path, data) { return serial(path, () => S.db.doc(path).set(data)); }
function setState(pid, patch) {
  const b = bucketOf(pid); S.state[b] = Object.assign({}, S.state[b] || {}); S.state[b][pid] = Object.assign({}, S.state[b][pid] || {}, patch);
  recompute(true); const ex = S.stateEx.has(b); S.stateEx.add(b);
  return upd('state/' + b, { p: { [pid]: patch } }, ex).catch(fail);
}
async function setStates(map) { // pid -> patch
  const byB = {}; for (const pid in map) { const b = bucketOf(pid); (byB[b] = byB[b] || {})[pid] = map[pid]; S.state[b] = Object.assign({}, S.state[b] || {}); S.state[b][pid] = Object.assign({}, S.state[b][pid] || {}, map[pid]); }
  recompute(true);
  for (const b in byB) { const ex = S.stateEx.has(b); S.stateEx.add(b); await upd('state/' + b, { p: byB[b] }, ex); }
}
function saveOrg(org, gen) { S.org = { groups: org.groups, companies: org.companies }; S.orgEx = true; recompute(true); return setDoc('org/structure', { groups: org.groups, companies: org.companies, gen: gen || null }).catch(fail); }
function patchOrg(patch) { // {groups:{id:{...}}} merge
  const o = { groups: Object.assign({}, S.org.groups), companies: Object.assign({}, S.org.companies) };
  for (const k of ['groups', 'companies']) for (const id in (patch[k] || {})) o[k][id] = Object.assign({}, o[k][id] || {}, patch[k][id]);
  S.org = o; recompute(true); const ex = S.orgEx; S.orgEx = true; return upd('org/structure', patch, ex).catch(fail);
}
function saveStaffRec(rec) { S.staff = Object.assign({}, S.staff, { [rec.id]: rec }); recompute(true); const ex = S.staffEx; S.staffEx = true; return upd('staff/all', { s: { [rec.id]: rec } }, ex).catch(fail); }
function saveConfig(patch) { S.config = Object.assign({}, S.config, patch); recompute(true); S.configEx = true; return setDoc('config/session', S.config).catch(fail); }

/* ---------- data load ---------- */
let rcT = null;
function recompute(now) {
  clearTimeout(rcT);
  const run = () => {
    S.staffList = Object.values(S.staff).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    S.staffMap = {}; S.staffList.forEach(s => S.staffMap[s.id] = s);
    S.P = derive(mergeMedical(), S.state, S.config, S.org, S.staffMap);
    S.tee = teeRedistribute(S.P.filter(p => p.inc || p.s));
    render(); autoClaim(); adminSync();
  };
  if (now) run(); else rcT = setTimeout(run, 120);
}
function loadedAll() { return ['roster', 'state', 'staff', 'org', 'config', 'access', 'med', 'inv', 'mem'].every(k => S.loaded[k]); }
/* Medical and dietary notes are stored apart from the roster. Editors read them all; everyone else
   only gets a copy of the notes for the youth in their own scope (share/<their id>). */
function mergeMedical() {
  const src = {};
  if (S.medAdmin) for (const b in S.medical) for (const id in S.medical[b]) src[id] = S.medical[b][id];
  for (const u in S.intake) { const p = (S.intake[u] || {}).p || {}; for (const id in p) src[id] = Object.assign({}, src[id] || {}, p[id]); }
  if (S.share && S.share.p) for (const id in S.share.p) src[id] = Object.assign({ f: 1 }, S.share.p[id]);
  const out = {};
  for (const b in S.roster) { const m = S.roster[b]; const o = out[b] = {}; for (const id in m) { const r = m[id]; if (!r) continue; const x = src[id];
    if (x) o[id] = Object.assign({}, r, { med: x.med || '', diet: x.diet || '', medF: x.f && x.med ? 1 : 0, dietF: x.f && x.diet ? 1 : 0 });
    else o[id] = S.medAdmin ? r : Object.assign({}, r, { med: '', diet: '' }); } }
  return out;
}
async function autoClaim() { return;
  if (S.claimTried || S.isOwner || !S.email || !S.uid || !S.loaded.inv || !S.loaded.mem) return;
  const h = emailKey(S.email); if (!S.invites[h]) return; S.claimTried = true;
  if (S.members[S.uid] && S.members[S.uid].h === h) return;
  try { await setDoc('members/' + S.uid, { h, at: Date.now() }); } catch (e) { console.error(e); S.claimFailed = true; render(); }
}
let syT = null, migrated = false;
function adminSync() { if (!S.medAdmin || !loadedAll()) return; clearTimeout(syT); syT = setTimeout(() => runAdminSync().catch(console.error), 2500); }
async function runAdminSync() {
  // 1. move any medical notes still sitting in the roster (older uploads) into the protected store
  if (!migrated) { migrated = true; for (const b in S.roster) { const m = S.roster[b]; const legacy = Object.keys(m).filter(id => m[id] && ('med' in m[id] || 'diet' in m[id])); if (!legacy.length) continue;
    const add = {}; legacy.forEach(id => { if (!(S.medical[b] || {})[id]) add[id] = { med: m[id].med || '', diet: m[id].diet || '' }; });
    if (Object.keys(add).length) { const ex = S.medicalEx.has(b); S.medicalEx.add(b); await upd('medical/' + b, { p: add }, ex); S.medical[b] = Object.assign({}, S.medical[b] || {}, add); }
    const clean2 = {}; for (const id in m) { const r = Object.assign({}, m[id]); delete r.med; delete r.diet; clean2[id] = r; } await setDoc('roster/' + b, { p: clean2 }); } }
  // 2. clear requests that now have an account
  for (const id in S.requests) { const em = S.requests[id].email; if (em && S.invites[emailKey(em)]) await serial('requests/' + id, () => S.db.doc('requests/' + id).delete()).catch(() => { }); }
  // 3. each person's copy of the medical and dietary notes they are allowed to see
  const uids = uniq(Object.keys(S.access).concat(Object.keys(S.members)));
  for (const uid of uids) {
    const a = accountOf(uid); if (!a || a.role === 'regadmin') continue;
    const p = {}; S.P.forEach(x => { if ((x.medIssue || x.dietIssue) && inScopeFor(x, a.role, a.staffId)) p[x.id] = { med: x.medIssue || '', diet: x.dietIssue || '' }; });
    const h = fnv(JSON.stringify(p)).toString(36); if (S.shares[uid] === h) continue; S.shares[uid] = h;
    await setDoc('share/' + uid, { p, h });
  }
  for (const uid in S.shares) if (!uids.includes(uid) || !accountOf(uid)) { delete S.shares[uid]; await serial('share/' + uid, () => S.db.doc('share/' + uid).delete()); }
}
function subscribe() {
  const db = S.db; const onErr = e => { console.error(e); if (e.code === 'revoked') { S.noDb = true; render(); } };
  const mark = (k, meta) => { if (!meta.fromCache) S.loaded[k] = true; };
  setTimeout(() => { if (!loadedAll()) { S.slow = true; render(); } }, 10000);
  db.collection('roster').onSnapshot(sn => { const r = {}; S.rosterEx = new Set(); sn.docs.forEach(d => { r[d.id] = Object.assign({}, (d.data() || {}).p || {}); S.rosterEx.add(d.id); }); S.roster = r; mark('roster', sn.metadata); recompute(); }, onErr);
  db.collection('state').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => { r[d.id] = Object.assign({}, (d.data() || {}).p || {}); S.stateEx.add(d.id); }); S.state = r; mark('state', sn.metadata); recompute(); }, onErr);
  db.doc('staff/all').onSnapshot(d => { S.staff = d.exists ? Object.assign({}, d.data().s || {}) : {}; S.staffEx = d.exists || S.staffEx; mark('staff', d.metadata); recompute(); }, onErr);
  db.doc('org/structure').onSnapshot(d => { const v = d.exists ? d.data() : {}; S.org = { groups: Object.assign({}, v.groups || {}), companies: Object.assign({}, v.companies || {}) }; S.orgGen = v.gen || null; S.orgEx = d.exists || S.orgEx; mark('org', d.metadata); recompute(); }, onErr);
  db.doc('config/session').onSnapshot(d => { S.config = Object.assign({}, DEFAULT_CONFIG, d.exists ? d.data() : {}); S.configEx = d.exists; mark('config', d.metadata); recompute(); }, onErr);
  S.access = {}; S.loaded.access = true;
  if (S.medAdmin) {
    db.collection('requests').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = d.data()); S.requests = r; recompute(); }, onErr);
    db.collection('invites').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = d.data()); S.invites = r; mark('inv', sn.metadata); recompute(); }, onErr);
    db.collection('profiles').onSnapshot(sn => { const m = {}, p = {}; sn.docs.forEach(d => { const v = d.data() || {}; p[d.id] = v; if (v.email) m[d.id] = { h: emailKey(v.email) }; }); S.profiles = p; S.members = m; mark('mem', sn.metadata); recompute(); }, onErr);
  } else {
    S.members = { [S.uid]: { h: emailKey(S.email) } }; S.loaded.mem = true;
    db.doc('invites/' + emailKey(S.email)).onSnapshot(d => { if (!d.exists) { location.reload(); return; } S.invites = { [d.id]: d.data() }; mark('inv', d.metadata); recompute(); }, onErr);
  }
  if (S.medAdmin) {
    db.collection('medical').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => { r[d.id] = Object.assign({}, (d.data() || {}).p || {}); S.medicalEx.add(d.id); }); S.medical = r; mark('med', sn.metadata); recompute(); }, onErr);
    db.collection('intake').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = d.data()); S.intake = r; recompute(); }, onErr);
    db.collection('share').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = (d.data() || {}).h || ''); S.shares = r; }, onErr);
  } else if (S.uid) {
    db.doc('share/' + S.uid).onSnapshot(d => { S.share = d.exists ? d.data() : null; mark('med', d.metadata); recompute(); }, onErr);
    db.doc('intake/' + S.uid).onSnapshot(d => { S.intake = d.exists ? { [S.uid]: d.data() } : {}; S.intakeEx = d.exists; recompute(); }, onErr);
  } else S.loaded.med = true;
}
async function boot() {
  window.addEventListener('hashchange', () => render());
  if (!window.firebase || !FIREBASE_CONFIG.apiKey || /PASTE/.test(FIREBASE_CONFIG.apiKey)) { S.setupNeeded = true; render(); return; }
  FB.app = firebase.initializeApp(FIREBASE_CONFIG); FB.auth = firebase.auth(); FB.fs = firebase.firestore();
  try { FB.fs.settings({ ignoreUndefinedProperties: true, merge: true }); } catch (e) { }
  try { await FB.fs.enablePersistence({ synchronizeTabs: true }); } catch (e) { }
  FB.auth.getRedirectResult().catch(e => toast(signInError(e), true));
  FB.auth.onAuthStateChanged(async u => {
    if (S.uid && (!u || u.uid !== S.uid)) { location.reload(); return; }
    if (!u) { S.signedOut = true; UI.frameKey = ''; render(); return; }
    S.signedOut = false; FB.user = u;
    S.uid = u.uid; S.email = (u.email || '').toLowerCase(); S.meName = u.displayName || S.email;
    S.isOwner = OWNER_EMAILS.map(x => x.trim().toLowerCase()).includes(S.email);
    S.db = dbShim; S.user = userShim; S.dl = downloadShim;
    FB.fs.doc('profiles/' + u.uid).set({ name: S.meName, email: S.email, at: Date.now() }, { merge: true }).catch(console.error);
    let inv = null; try { const d = await FB.fs.doc('invites/' + emailKey(S.email)).get(); inv = d.exists ? d.data() : null; } catch (e) { console.error(e); }
    S.medAdmin = S.isOwner || !!(inv && ['regadmin', 'sdc'].includes(inv.role));
    if (!S.isOwner && !inv) { subscribeGuest(); render(); return; }
    subscribe(); render();
  });
}
function subscribeGuest() {
  ['roster', 'state', 'staff', 'org', 'config', 'access', 'med', 'inv', 'mem'].forEach(k => S.loaded[k] = true);
  FB.fs.doc('invites/' + emailKey(S.email)).onSnapshot(d => { if (d.exists) location.reload(); }, () => { });
  FB.fs.doc('requests/' + S.uid).onSnapshot(d => { S.requests = d.exists ? { [S.uid]: d.data() } : {}; render(); }, () => { });
}
function signInError(e) {
  const c = e && e.code;
  if (c === 'auth/unauthorized-domain') return 'This web address is not allowed to sign in yet. Add it under Authentication › Settings › Authorized domains in Firebase.';
  if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return 'Sign-in was closed before it finished.';
  return 'Could not sign in. Check your connection and try again.';
}
async function signIn() {
  const p = new firebase.auth.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
  try { await FB.auth.signInWithPopup(p); }
  catch (e) { if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) await FB.auth.signInWithRedirect(p); else toast(signInError(e), true); }
}

/* ---------- shell ---------- */
function renderHeader() {
  $('#sessName').textContent = (!S.config.sessionName || S.config.sessionName === 'FSY Kenya 2') ? 'FSY Kenya 2nd 2026' : S.config.sessionName;
  if (!S.uid) { $('#who').innerHTML = ''; return; }
  const r = role();
  const live = loadedAll() ? 'live' : S.slow ? 'slow' : '';
  let h = `<span class="dot ${live}" title="${live === 'live' ? 'Live' : 'Syncing'}"></span><span class="muted">${live === 'live' ? 'Live' : S.slow ? 'Still connecting' : 'Syncing'}</span>`;
  if (r) h += `<span class="chip band">${esc(ROLES[r])}</span>`;
  if (S.meName) h += `<span class="nm">${esc(S.meName)}</span>`;
  if (S.uid) h += `<button class="btn small" data-act="signOut">Sign out</button>`;
  if (realRole() === 'regadmin') {
    h += `<select id="viewAs" aria-label="Preview as role" style="padding:5px 8px;font-size:.82rem">${opt('', 'Viewing as myself', !S.viewAs)}${Object.keys(ROLES).filter(k => k !== 'regadmin').map(k => opt(k, 'Preview: ' + ROLES[k], S.viewAs === k)).join('')}</select>`;
  }
  const wa = document.activeElement; if (!(wa && wa.id === 'viewAs')) $('#who').innerHTML = h;
  const top = $('#top'); if (top) { document.documentElement.style.setProperty('--toph', top.offsetHeight + 'px'); const sticky = getComputedStyle(top).position === 'sticky'; const tabs = document.querySelector('.tabs'); document.documentElement.style.setProperty('--stick', sticky ? (top.offsetHeight + (tabs ? tabs.offsetHeight : 0)) + 'px' : '0px'); }
}
function renderNav() {
  const cur = currentPage();
  $('#nav').innerHTML = allowedPages().map(([k, l]) => `<button class="tab" data-act="nav" data-v="${k}" ${k === cur ? 'aria-current="page"' : ''}>${esc(l)}</button>`).join('');
}
function gateView() {
  if (S.setupNeeded) return `<div class="gate"><h1>Finish setting up</h1><p class="note">Paste your Firebase settings into the top of <b>app.js</b> (FIREBASE_CONFIG and OWNER_EMAILS), then reload. The README walks through it.</p></div>`;
  if (S.signedOut) return `<div class="gate"><p class="th">FSY Kenya 2nd 2026</p><h1>Sign in to check in youth</h1><p class="note">Use the Google account your registration admin set up for you.</p><button class="btn primary" data-act="signIn">Sign in with Google</button></div>`;
  if (!S.uid) return `<div class="empty"><h3>Checking your sign-in…</h3>One moment.</div>`;
  if (!loadedAll() && !S.slow) return `<div class="empty"><h3>Loading the session…</h3>Participants, groups and check-ins appear here once the data connects.</div>`;
  if (!role()) {
    const mine = S.requests[S.uid];
    return `<div class="gate"><h1>No account for you yet</h1>
      <p class="note">${S.email ? `You are signed in as <b>${esc(S.email)}</b>. No account has been set up for this email. If the registration admin used a different email, sign out and sign in with that one.` : ''}</p>
      ${mine ? `<div class="callout info">Request sent ${esc(fmtTime(mine.at))}. You will get access once the registration admin approves it. This page updates by itself.</div>` : ''}
      <div class="form" style="width:100%;text-align:left"><label class="span2">Your name and role at FSY<input id="reqNote" placeholder="e.g. Brian Otieno, counselor" value="${esc(mine ? mine.note : '')}"></label></div>
      <button class="btn primary" data-act="request">${mine ? 'Update request' : 'Request access'}</button>
      <button class="btn" data-act="signOut">Use a different Google account</button></div>`;
  }
  return null;
}
function render() {
  if (UI.pending) return;
  const ae = document.activeElement;
  if (ae && $('#main').contains(ae) && (ae.tagName === 'SELECT' || (ae.tagName === 'INPUT' && ae.dataset.region))) { UI.pending = true; ae.addEventListener('blur', () => { UI.pending = false; render(); }, { once: true }); return; }
  renderHeader(); renderNav();
  const gate = gateView();
  if (gate) { const gk = 'gate' + fnv(gate); if (UI.frameKey !== gk) { $('#main').innerHTML = gate; UI.frameKey = gk; } return; }
  const pg = currentPage(); const key = pg + '|' + role() + '|' + (myStaffId() || '');
  const page = PAGE_IMPL[pg];
  if (UI.frameKey !== key) { $('#main').innerHTML = page.frame(); UI.frameKey = key; window.scrollTo(0, 0); }
  page.update();
}

/* ---------- participant scope helpers ---------- */
function myGroups() { const sid = myStaffId(); return Object.values(S.org.groups).filter(g => g.counselorId && g.counselorId === sid); }
function myCompanies() { const sid = myStaffId(); const r = role(); return Object.values(S.org.companies).filter(c => sid && ((r === 'ac' && c.acId === sid) || (r === 'coordinator' && c.coordId === sid))); }
function inMine(p) {
  const r = role();
  if (r === 'counselor') return !!p.group && p.group.counselorId === myStaffId();
  if (r === 'ac' || r === 'coordinator') { const ids = myCompanies().map(c => c.id); return !!p.company && ids.includes(p.company.id); }
  return false;
}
function groupOptionsFor(p) { // groups this viewer may move p into
  const gs = Object.values(S.org.groups).sort((a, b) => a.num - b.num);
  if (can.moveAny()) return gs;
  if (can.moveOwn()) { const ids = myCompanies().map(c => c.id); if (!p.company || !ids.includes(p.company.id)) return null; return gs.filter(g => ids.includes(g.companyId) && g.gender === p.gender && g.band === p.band); }
  return null;
}
function moveSelect(p) {
  const gs = groupOptionsFor(p); if (!gs) return '';
  const C = S.org.companies;
  return `<select data-act="moveP" data-id="${esc(p.id)}" aria-label="Move ${esc(p.name)} to group">${can.moveAny() ? opt('', '— Not in a group', !p.g) : ''}${gs.map(g => opt(g.id, `G${g.num} · ${g.gender === 'F' ? 'YW' : 'YM'} ${BANDS[g.band]}${g.companyId && C[g.companyId] ? ' · Co ' + C[g.companyId].num : ''}${g.gender !== p.gender || g.band !== p.band ? ' ⚠' : ''}`, p.g === g.id)).join('')}</select>`;
}

/* ---------- page: check-in ---------- */
const PAGE_IMPL = {};
PAGE_IMPL.checkin = {
  frame() {
    if (!UI.filterSet) { UI.filterSet = true; if (['counselor', 'ac'].includes(role())) UI.filter = 'mine'; }
    const r = role();
    const mineLabel = r === 'counselor' ? 'My group' : (r === 'ac' || r === 'coordinator') ? 'My companies' : null;
    const segs = [['all', 'Everyone'], ['arrive', 'Not arrived'], ['in', 'Checked in'], ['out', 'Checked out']].concat(mineLabel ? [['mine', mineLabel]] : []);
    return `<section class="ci-head"><h1>Check-in</h1><div class="ministats" id="ciK"></div></section>
    <div id="ciAnchor"></div>
    <div class="searchbar" id="ciBar">
      <div class="searchrow"><input type="search" id="ciQ" placeholder="Type a name, unit or G12…" value="${esc(UI.q)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search participants"><span id="ciCount" class="count"></span><button type="button" class="clr" data-act="ciClear" aria-label="Clear search">×</button></div>
      <div class="segscroll"><div class="seg" role="group" aria-label="Filter by status">${segs.map(([v, l]) => `<button data-act="ciF" data-v="${v}" aria-pressed="${UI.filter === v}">${l}</button>`).join('')}</div></div>
    </div>
    <details class="morefilters" id="ciMoreF"><summary>Stake and ward filter <span id="ciFN"></span></summary><div class="inline" id="ciSel" style="margin-top:8px"></div></details>
    <div id="ciList" class="cards"></div><div class="more" id="ciMore"></div>`;
  },
  update() {
    const P = S.P;
    const exp = P.filter(p => p.elig && p.src !== 'walkin').length;
    const inn = P.filter(p => p.s === 'in').length, out = P.filter(p => p.s === 'out').length, wk = P.filter(p => p.src === 'walkin' && p.s).length;
    $('#ciK').innerHTML = `<span class="hot"><b>${inn}</b> in</span><span><b>${exp}</b> expected</span><span><b>${pct(P.filter(p => p.elig && p.src !== 'walkin' && p.s).length, exp)}%</b> arrived</span><span><b>${wk}</b> walk-ins</span><span><b>${out}</b> out</span>`;
    $('#ciFN').textContent = UI.unit ? '· ' + UI.unit : UI.stake ? '· ' + UI.stake : '';
    const stakes = uniq(P.map(p => p.stake).filter(Boolean)).sort();
    const units = uniq(P.filter(p => !UI.stake || p.stake === UI.stake).map(p => p.unit).filter(Boolean)).sort();
    $('#ciSel').innerHTML = `<select id="ciStake" aria-label="Stake">${opt('', 'All stakes', !UI.stake)}${stakes.map(s => opt(s, s, s === UI.stake)).join('')}</select><select id="ciUnit" aria-label="Ward or branch">${opt('', 'All wards & branches', !UI.unit)}${units.map(s => opt(s, s, s === UI.unit)).join('')}</select>`;
    const toks = UI.q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = P.filter(p => {
      if (UI.filter === 'arrive' && p.s) return false;
      if (UI.filter === 'in' && p.s !== 'in') return false;
      if (UI.filter === 'out' && p.s !== 'out') return false;
      if (UI.filter === 'mine' && !inMine(p)) return false;
      if (UI.stake && p.stake !== UI.stake) return false;
      if (UI.unit && p.unit !== UI.unit) return false;
      if (toks.length) { const hay = (p.name + ' ' + (p.pref || '') + ' ' + p.unit + ' ' + p.stake + ' ' + p.id + ' ' + (p.group ? 'g' + p.group.num : '') + ' ' + (p.phone || '')).toLowerCase(); return toks.every(t => hay.includes(t)); }
      return true;
    });
    if (UI.filter === 'arrive' && !toks.length) list = list.filter(p => p.elig);
    const shown = list.slice(0, UI.limit);
    $('#ciCount').textContent = toks.length || UI.filter !== 'all' || UI.stake ? list.length + (list.length === 1 ? ' match' : ' matches') : '';
    $('#ciList').innerHTML = shown.length ? shown.map(pCard).join('') : `<div class="empty" style="grid-column:1/-1"><h3>${P.length ? 'No one matches' : 'No participants yet'}</h3>${P.length ? 'Try fewer letters, or switch the filter to Everyone. Someone who is not on the list can be added as a walk-in.' : (can.admin() ? 'Upload the FSY portal export on the Data & areas tab to start.' : 'The registration admin has not uploaded participants yet.')}</div>`;
    $('#ciMore').innerHTML = list.length > UI.limit ? `<button class="btn" data-act="ciMore">Show more (${list.length - UI.limit} left)</button>` : (list.length ? `<span class="muted">${list.length} shown</span>` : '');
  }
};
function pCard(p) {
  const st = p.s === 'in' ? `<span class="pill in">In ${esc(fmtTime(p.ti))}</span>` : p.s === 'out' ? `<span class="pill out">Out ${esc(fmtTime(p.to))}</span>` : '<span class="pill none">Not arrived</span>';
  const issues = !seesPrivate(p) ? '' : (p.medIssue ? '<span class="chip warn">Medical</span>' : '') + (p.dietIssue ? '<span class="chip warn">Diet</span>' : '');
  const ck = can.checkin();
  const acts = !ck ? '' : p.s === 'in' ? `<button class="btn" data-act="ciUndo" data-id="${esc(p.id)}">Undo check-in</button><button class="btn" data-act="ciOut" data-id="${esc(p.id)}">Check out</button>` : p.s === 'out' ? `<button class="btn primary" data-act="ciIn" data-id="${esc(p.id)}">Check in again</button>` : `<button class="btn primary" data-act="ciIn" data-id="${esc(p.id)}">Check in</button>`;
  const tee = p.tshirt ? esc(SIZE_LABEL[p.tshirt] || p.tshirt) : `<span class="est">${esc(SIZE_LABEL[(S.tee && S.tee.perPerson[p.id]) || ''] || 'Not given')}</span> <small class="muted">est.</small>`;
  return `<article class="pcard st-${p.s || 'none'}">
    <div class="pc-top"><div style="min-width:0"><h3>${esc(p.name)}</h3><div class="sub"><span class="chip">${p.age != null ? p.age + ' yrs' : 'Age ?'}</span>${chipG(p.gender)}${chipBand(p.band)}${issues}</div></div>${st}</div>
    <div class="pc-lines">
      <div><span class="k">Group</span><span>${p.group ? '<b>G' + p.group.num + '</b> · ' + esc(p.counselor ? p.counselor.name : 'No counselor') + (p.company ? ' · <b>Co ' + p.company.num + '</b>' : '') : '<span class="muted">Not assigned yet</span>'}</span></div>
      <div><span class="k">Unit</span><span>${esc(p.unit || '—')}<span class="muted"> · ${esc(p.stake || '—')}</span></span></div>
      <div><span class="k">Size</span><span>${tee}</span></div>
    </div>
    ${(p.flags.length || p.ov) && flagChips(p, ['walkin', 'area', 'status', 'pending', 'gender', 'age', 'agerange']) ? `<div class="flags">${flagChips(p, ['walkin', 'area', 'status', 'pending', 'gender', 'age', 'agerange'])}</div>` : ''}
    <div class="pc-actions">${acts}<button class="btn" data-act="detail" data-id="${esc(p.id)}" style="flex:0 0 auto">Details</button></div></article>`;
}

/* ---------- page: tally ---------- */
PAGE_IMPL.tally = {
  frame() { return `<section class="pagehead"><div><h1>Tally</h1><p class="note" style="margin:4px 0 0">Live counts for the session, each stake and each ward or branch. Tap a stake to see its units.</p></div><button class="btn" data-act="tallyCsv">Export CSV</button></section><div id="tK" class="kpis"></div><div class="grid2"><div class="panel"><h2>By age group and gender</h2><div id="tBG"></div></div><div class="panel"><h2>By company</h2><div id="tCo"></div></div></div><div class="panel"><h2>By stake, ward and branch</h2><div id="tSt"></div></div>`; },
  update() {
    const P = S.P;
    const exp = p => p.elig && p.src !== 'walkin';
    const T = { exp: P.filter(exp).length, inn: P.filter(p => p.s === 'in').length, out: P.filter(p => p.s === 'out').length, arrived: P.filter(p => exp(p) && p.s).length, wk: P.filter(p => p.src === 'walkin' && p.s).length, exc: P.filter(p => !p.inc && p.s).length };
    $('#tK').innerHTML = `<div class="kpi hero"><span>Checked in now</span><b>${T.inn}</b></div><div class="kpi"><span>Expected</span><b>${T.exp}</b></div><div class="kpi"><span>Arrived of expected</span><b>${T.arrived} <small class="muted">${pct(T.arrived, T.exp)}%</small></b></div><div class="kpi"><span>Not arrived</span><b>${T.exp - T.arrived}</b></div><div class="kpi"><span>Walk-ins</span><b>${T.wk}</b></div><div class="kpi"><span>From excluded list</span><b>${T.exc}</b></div><div class="kpi"><span>Checked out</span><b>${T.out}</b></div>`;
    let bg = '<div class="tablewrap"><table><thead><tr><th></th><th class="n">Young women</th><th class="n">Young men</th><th class="n">Total</th></tr></thead><tbody>';
    for (const b of ['Y', 'O']) { const c = g => { const e = P.filter(p => exp(p) && p.band === b && (!g || p.gender === g)).length, i = P.filter(p => p.s === 'in' && p.band === b && (!g || p.gender === g)).length; return `<td class="n">${i} / ${e}</td>`; }; bg += `<tr><td>${BANDS[b]}</td>${c('F')}${c('M')}${c('')}</tr>`; }
    bg += `</tbody></table></div><p class="note">Checked in / expected.</p>`; $('#tBG').innerHTML = bg;
    const cos = Object.values(S.org.companies).sort((a, b) => a.num - b.num);
    $('#tCo').innerHTML = cos.length ? `<div class="tablewrap"><table><thead><tr><th>Company</th><th>AC</th><th class="n">Groups</th><th class="n">In / total</th></tr></thead><tbody>${cos.map(c => { const ps = P.filter(p => p.company && p.company.id === c.id); return `<tr><td>${c.num} <span class="chip band">${BANDS[c.band]}</span></td><td>${esc(sName(c.acId) || '—')}</td><td class="n">${Object.values(S.org.groups).filter(g => g.companyId === c.id).length}</td><td class="n">${ps.filter(p => p.s === 'in').length} / ${ps.length}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="note">Companies appear here after they are generated.</p>';
    const stakes = {};
    P.forEach(p => { const s = stakes[p.stake || '(No stake)'] = stakes[p.stake || '(No stake)'] || { exp: 0, inn: 0, out: 0, units: {} }; const u = s.units[p.unit || '(No unit)'] = s.units[p.unit || '(No unit)'] || { exp: 0, inn: 0, out: 0 }; if (exp(p)) { s.exp++; u.exp++; } if (p.s === 'in') { s.inn++; u.inn++; } if (p.s === 'out') { s.out++; u.out++; } });
    const exS = new Set(S.config.excludedStakes || []), exU = new Set(S.config.excludedUnits || []);
    let h = '<div class="tablewrap"><table><thead><tr><th>Stake / unit</th><th class="n">Expected</th><th class="n">In</th><th class="n">Out</th><th style="min-width:110px">Arrived</th></tr></thead><tbody>';
    for (const s of Object.keys(stakes).sort()) {
      const v = stakes[s]; const open = UI.openStakes.has(s); const arrivedS = Math.min(v.inn + v.out, v.exp);
      h += `<tr class="click" data-act="toggleStake" data-v="${esc(s)}"><td><b class="${exS.has(s) ? 'excluded' : ''}">${open ? '▾' : '▸'} ${esc(s)}</b>${exS.has(s) ? ' <span class="chip bad">Excluded</span>' : ''}</td><td class="n">${v.exp}</td><td class="n"><b>${v.inn}</b></td><td class="n">${v.out}</td><td><div class="bar"><i style="width:${pct(arrivedS, v.exp)}%"></i></div></td></tr>`;
      if (open) for (const u of Object.keys(v.units).sort()) { const x = v.units[u]; const ex = exU.has(s + '|' + u); h += `<tr class="sub"><td class="${ex ? 'excluded' : ''}">${esc(u)}</td><td class="n">${x.exp}</td><td class="n">${x.inn}</td><td class="n">${x.out}</td><td><div class="bar"><i style="width:${pct(Math.min(x.inn + x.out, x.exp), x.exp)}%"></i></div></td></tr>`; }
    }
    h += `<tr><td><b>Whole session</b></td><td class="n"><b>${T.exp}</b></td><td class="n"><b>${T.inn}</b></td><td class="n"><b>${T.out}</b></td><td><div class="bar"><i style="width:${pct(T.arrived, T.exp)}%"></i></div></td></tr></tbody></table></div>`;
    $('#tSt').innerHTML = P.length ? h : '<p class="note">No participants uploaded yet.</p>';
  }
};

/* ---------- page: companies ---------- */
PAGE_IMPL.companies = {
  frame() {
    const adm = can.admin();
    return `<section class="pagehead"><div><h1>Companies & groups</h1><p class="note" style="margin:4px 0 0">Groups of ${esc(S.config.groupSize || 10)} share a gender and age group, each led by a counselor of the same gender. Companies keep 13–15 and 16–18 apart and mix young men and young women.</p></div>
    <div class="btnrow">${adm ? `<button class="btn primary" data-act="rebalance">Rebalance, keep groups</button><button class="btn" data-act="regen">Regenerate all</button><button class="btn" data-act="addCo">Add company</button>` : ''}<button class="btn" data-act="rosterCsv">Export rosters</button></div></section>
    <div id="coLog"></div><div class="grid2"><div class="panel"><h2>Leadership</h2><div id="coChart"></div></div><div class="panel"><div class="panel-head"><h2>Checks</h2></div><div id="coWarn"></div></div></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Age group">${[['', 'All companies'], ['Y', '13–15'], ['O', '16–18']].concat(['ac', 'coordinator', 'counselor'].includes(role()) ? [['mine', 'Mine']] : []).map(([v, l]) => `<button data-act="coBand" data-v="${v}" aria-pressed="${UI.band === v}">${l}</button>`).join('')}</div></div>
    <div id="coGrid" class="companies"></div>`;
  },
  update() {
    const G = S.org.groups, C = S.org.companies, adm = can.admin();
    $('#coLog').innerHTML = UI.genLog ? `<div class="log"><b>${esc(UI.genLog.title)}</b><ul>${UI.genLog.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '';
    const by = r => S.staffList.filter(s => s.role === r);
    const node = (s, extra) => `<div class="node"><b>${esc(s.name)}</b>${extra || ''}</div>`;
    const acs = by('ac'), acUsed = new Set(Object.values(C).map(c => c.acId));
    $('#coChart').innerHTML = `<div class="orgchart"><div class="tierlabel">Session directing couple</div><div class="tier">${by('sdc').map(s => node(s, `<small class="muted">${s.gender === 'F' ? 'Sister' : s.gender === 'M' ? 'Brother' : ''}</small>`)).join('') || '<span class="muted">Not added yet</span>'}</div>
      <div class="tierlabel">Coordinators</div><div class="tier">${by('coordinator').map(s => node(s, `<small class="muted">${Object.values(C).filter(c => c.coordId === s.id).length} companies</small>`)).join('') || '<span class="muted">Not added yet</span>'}</div>
      <div class="tierlabel">Assistant coordinators</div><div class="tier"><div class="node"><b class="num">${acs.length}</b><small class="muted">${Object.keys(C).length} companies · ${acs.filter(a => !acUsed.has(a.id)).length} spare</small></div><div class="node"><b class="num">${by('counselor').length}</b><small class="muted">counselors · ${Object.keys(G).length} groups</small></div></div></div>`;
    const w = validate(S.P, S.org, S.staffMap, S.config);
    $('#coWarn').innerHTML = !Object.keys(G).length ? `<p class="note">No groups yet. ${adm ? 'Upload participants, add counselors and assistant coordinators on the Staff tab (or generate test staff), then press Regenerate all.' : 'The registration admin will generate them.'}</p>` : w.length ? `<ul class="warnlist">${w.slice(0, UI.allWarn ? 999 : 8).map(([lv, t]) => `<li><span class="chip ${lv}">${lv === 'bad' ? 'Fix' : 'Check'}</span><span>${esc(t)}</span></li>`).join('')}</ul>${w.length > 8 && !UI.allWarn ? `<button class="btn small" data-act="allWarn" style="margin-top:8px">Show all ${w.length}</button>` : ''}` : '<p><span class="chip good">All good</span> Every group and company follows the rules.</p>';
    const mem = {}; for (const id in G) mem[id] = []; S.P.forEach(p => { if (p.g && mem[p.g]) mem[p.g].push(p); });
    let comps = Object.values(C).sort((a, b) => a.num - b.num);
    const lim = ['counselor', 'ac'].includes(role()); if (lim) { const ids = scopeCompanyIds(role(), myStaffId()); comps = comps.filter(c => ids.includes(c.id)); }
    if (UI.band === 'Y' || UI.band === 'O') comps = comps.filter(c => c.band === UI.band);
    if (UI.band === 'mine') { const mineIds = role() === 'counselor' ? myGroups().map(g => g.companyId) : myCompanies().map(c => c.id); comps = comps.filter(c => mineIds.includes(c.id)); }
    const coCard = c => {
      const gs = Object.values(G).filter(g => g.companyId === c.id).sort((a, b) => a.gender.localeCompare(b.gender) || a.num - b.num);
      const ps = gs.flatMap(g => mem[g.id]);
      const acSel = adm ? `<select data-act="coAc" data-id="${c.id}" aria-label="Assistant coordinator">${opt('', '— None')}${acs.map(a => opt(a.id, a.name + (acUsed.has(a.id) && a.id !== c.acId ? ' (Co ' + (Object.values(C).find(x => x.acId === a.id) || {}).num + ')' : ''), a.id === c.acId)).join('')}</select>` : esc(sName(c.acId) || '—');
      const coSel = adm ? `<select data-act="coCoord" data-id="${c.id}" aria-label="Coordinator">${opt('', '— None')}${by('coordinator').map(a => opt(a.id, a.name, a.id === c.coordId)).join('')}</select>` : esc(sName(c.coordId) || '—');
      return `<section class="company"><div class="co-head"><div class="co-title"><h2>Company ${c.num}</h2><div class="inline"><span class="chip band">${BANDS[c.band]}</span><span class="chip F">${gs.filter(g => g.gender === 'F').length} YW</span><span class="chip M">${gs.filter(g => g.gender === 'M').length} YM</span>${adm ? `<button class="btn small danger" data-act="delCo" data-id="${c.id}">Remove</button>` : ''}</div></div>
      <div class="co-meta"><span class="muted">AC</span>${acSel}<span class="muted">Coordinator</span>${coSel}<span class="muted">In now</span><span class="num">${ps.filter(p => p.s === 'in').length} / ${ps.length}</span></div></div>
      ${gs.map(g => grpBlock(g, mem[g.id])).join('') || '<p class="note" style="padding:0 14px">No groups yet.</p>'}</section>`;
    };
    let html = comps.map(coCard).join('');
    const loose = Object.values(G).filter(g => !g.companyId || !C[g.companyId]);
    if (loose.length && UI.band !== 'mine' && !lim) html += `<section class="company"><div class="co-head"><div class="co-title"><h2>Groups without a company</h2><span class="chip warn">${loose.length}</span></div></div>${loose.map(g => grpBlock(g, mem[g.id])).join('')}</section>`;
    $('#coGrid').innerHTML = html || `<div class="empty" style="grid-column:1/-1"><h3>No companies yet</h3>${adm ? 'Companies are formed from the assistant coordinators on the Staff tab. Press Regenerate all once participants, counselors and ACs are in.' : 'The registration admin will generate companies.'}</div>`;
  }
};
function grpBlock(g, mem) {
  const adm = can.admin(), open = UI.open.has(g.id), size = +S.config.groupSize || 10;
  const cn = g.counselorId && S.staffMap[g.counselorId];
  const counsSel = adm ? `<select data-act="grpCoun" data-id="${g.id}" aria-label="Counselor for G${g.num}">${opt('', '— No counselor')}${S.staffList.filter(s => s.role === 'counselor' && (s.gender === g.gender || s.id === g.counselorId)).map(s => { const other = Object.values(S.org.groups).find(x => x.counselorId === s.id && x.id !== g.id); const a = staffAge(s, S.config); return opt(s.id, `${s.name}${a != null ? ' (' + a + ')' : ''}${other ? ' · G' + other.num : ''}${cPref(s, g.band, S.config) === 2 ? ' · other age pref' : ''}`, s.id === g.counselorId); }).join('')}</select>` : '';
  const coSel = adm ? `<select data-act="grpCo" data-id="${g.id}" aria-label="Company for G${g.num}">${opt('', '— No company')}${Object.values(S.org.companies).sort((a, b) => a.num - b.num).map(c => opt(c.id, `Company ${c.num} · ${BANDS[c.band]}${c.band !== g.band ? ' ⚠' : ''}`, c.id === g.companyId)).join('')}</select>` : '';
  return `<div class="grp"><div class="grp-row" data-act="toggleGrp" data-id="${g.id}" role="button" tabindex="0" aria-expanded="${open}"><span class="gnum">G${g.num}</span>${chipG(g.gender)}<span class="cn">${cn ? esc(cn.name) : '<span class="chip bad">No counselor</span>'}</span><span class="num ${mem.length > size ? '' : 'muted'}" style="${mem.length > size ? 'color:var(--warn)' : ''}">${mem.length}/${size}</span><span class="num muted" title="Checked in">✓${mem.filter(p => p.s === 'in').length}</span><span class="muted">${open ? '▾' : '▸'}</span></div>
  ${open ? `<div class="grp-body">${adm ? `<div class="form" style="margin-bottom:6px"><label>Counselor${counsSel}</label><label>Company${coSel}</label></div>` : ''}
   ${mem.sort((a, b) => a.name.localeCompare(b.name)).map(p => `<div class="mem"><span class="sdot ${p.s}" title="${p.s === 'in' ? 'Checked in' : p.s === 'out' ? 'Checked out' : 'Not arrived'}"></span><span class="mn"><a href="#" data-act="detail" data-id="${esc(p.id)}">${esc(p.name)}</a> <small class="muted">${p.age ?? '?'} · ${esc(p.unit)}</small>${(p.medIssue || p.dietIssue) && seesPrivate(p) ? ' <span class="chip warn">!</span>' : ''}</span>${moveSelect(p)}</div>`).join('') || '<span class="muted">Empty group</span>'}
   ${adm ? `<div><button class="btn small danger" data-act="delGrp" data-id="${g.id}">Remove group</button></div>` : ''}</div>` : ''}</div>`;
}

/* ---------- page: exceptions ---------- */
PAGE_IMPL.exceptions = {
  frame() {
    const stakes = uniq(S.P.map(p => p.stake).filter(Boolean)).sort(), units = uniq(S.P.map(p => p.unit).filter(Boolean)).sort();
    return `<section class="pagehead"><div><h1>Walk-ins & exceptions</h1><p class="note" style="margin:4px 0 0">Youth who came without registering, and anyone checked in who is not on the approved list for this session. Assign them to a group here.</p></div>${can.admin() ? '<button class="btn primary" data-act="rebalance">Place everyone waiting into groups</button>' : ''}</section>
    <div id="exLog"></div>
    <details class="panel" ${S.P.some(p => p.src === 'walkin') ? '' : 'open'}><summary><h2 style="display:inline">Add a walk-in</h2></summary>
    <form id="wkForm" class="form" style="margin-top:12px">
      <label>First name<input id="wkFirst" required></label><label>Last name<input id="wkLast" required></label>
      <label>Gender<select id="wkGender" required>${opt('', 'Choose…')}${opt('F', 'Female')}${opt('M', 'Male')}</select></label>
      <label>Birthday<input id="wkBday" type="date"></label><label>Age (if no birthday)<input id="wkAge" type="number" min="10" max="30" inputmode="numeric"></label>
      <label>Stake / district<input id="wkStake" list="dlStakes"></label><label>Ward / branch<input id="wkUnit" list="dlUnits"></label>
      <label>T-shirt size<select id="wkSize">${opt('', 'Not given')}${SIZES.map(s => opt(s, SIZE_LABEL[s])).join('')}</select></label>
      <label>Phone<input id="wkPhone" inputmode="tel"></label><label>Parent / guardian<input id="wkC1"></label><label>Guardian phone<input id="wkC1p" inputmode="tel"></label>
      <label class="span2">Medical information<input id="wkMed" placeholder="Leave blank if none"></label><label class="span2">Dietary information<input id="wkDiet" placeholder="Leave blank if none"></label>
      <label class="inline" style="flex-direction:row;color:var(--ink)"><input type="checkbox" id="wkIn" checked> Check in now</label>
      <div class="span2"><button class="btn primary" type="submit">Add walk-in</button></div>
    </form><datalist id="dlStakes">${stakes.map(s => `<option value="${esc(s)}">`).join('')}</datalist><datalist id="dlUnits">${units.map(s => `<option value="${esc(s)}">`).join('')}</datalist></details>
    <div id="exList" style="display:flex;flex-direction:column;gap:16px"></div>`;
  },
  update() {
    $('#exLog').innerHTML = UI.genLog ? `<div class="log"><b>${esc(UI.genLog.title)}</b><ul>${UI.genLog.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '';
    const P = S.P;
    const sec = (title, note, list, empty) => `<div class="panel"><div class="panel-head"><h2>${esc(title)} <span class="chip">${list.length}</span></h2></div>${note ? `<p class="note" style="margin-top:-6px">${note}</p>` : ''}${list.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Why</th><th>Unit · stake</th><th>Status</th><th>Group</th>${can.admin() ? '<th></th>' : ''}</tr></thead><tbody>${list.map(exRow).join('')}</tbody></table></div>` : `<p class="note">${empty}</p>`}</div>`;
    const walk = P.filter(p => p.src === 'walkin');
    const off = P.filter(p => p.src !== 'walkin' && p.s && (p.flags.includes('area') || p.flags.includes('status') || p.flags.includes('pending') || p.ov === 'exc'));
    const nog = P.filter(p => p.s === 'in' && !p.g && p.src !== 'walkin' && !off.includes(p));
    $('#exList').innerHTML = sec('Walk-ins', 'Added at the desk. They count in the tally and can be placed in groups like anyone else.', walk, 'No walk-ins yet.')
      + sec('Checked in but not on the approved list', 'From an excluded stake or unit, cancelled, or still waiting for approval. Include them to let the generator place them in a group.', off, 'Nobody from outside the approved list has checked in.')
      + sec('Checked in without a group', '', nog, 'Everyone checked in has a group.');
  }
};
function exRow(p) {
  const reason = flagChips(p, ['walkin', 'area', 'status', 'pending', 'gender', 'age', 'agerange']) || '<span class="muted">—</span>';
  const st = p.s === 'in' ? '<span class="pill in">In</span>' : p.s === 'out' ? '<span class="pill out">Out</span>' : '<span class="pill none">Not arrived</span>';
  const ms = moveSelect(p);
  const incBtn = can.admin() ? (p.inc ? (p.src === 'walkin' ? '' : `<button class="btn small" data-act="ovr" data-v="exc" data-id="${esc(p.id)}">Exclude</button>`) : `<button class="btn small" data-act="ovr" data-v="inc" data-id="${esc(p.id)}">Include</button>`) : '';
  return `<tr><td><a href="#" data-act="detail" data-id="${esc(p.id)}"><b>${esc(p.name)}</b></a><br><small class="muted">${p.age ?? '?'} yrs · ${p.gender || '?'}</small></td><td><div class="flags">${reason}</div></td><td>${esc(p.unit)}<br><small class="muted">${esc(p.stake)}</small></td><td>${st}</td><td>${ms || (p.group ? 'G' + p.group.num : '<span class="muted">None</span>')}</td>${can.admin() ? `<td>${incBtn}</td>` : ''}</tr>`;
}

/* ---------- page: logistics ---------- */
function lgHash() { const h = (location.hash || '').slice(1); return /^(med|diet|tee)-[a-z0-9-]+$/.test(h) ? h : ''; }
function registered() { return S.P.filter(p => p.inc || p.s); }
PAGE_IMPL.logistics = {
  frame() { return `<section class="pagehead"><div><p class="th">Logistics${['counselor', 'ac'].includes(role()) ? ' · your company only' : ' · whole session'}</p><h1>Medical, dietary and T-shirts</h1><p class="note" style="margin:4px 0 0">Built from the upload, before anyone checks in. Notes such as "none", "N/A", "nil" or "fit" are left out. Tap an issue to see exactly who has it.</p></div><div class="seg" role="group" aria-label="Who to count">${[['all', 'Everyone registered'], ['in', 'Checked in now']].map(([v, l]) => `<button data-act="logScope" data-v="${v}" aria-pressed="${UI.logScope === v}">${l}</button>`).join('')}</div></section>
  <div id="lgK" class="kpis"></div>
  <section class="panel" id="sec-med"><div class="panel-head"><h2>Medical</h2><button class="btn small" data-act="lgCsv" data-v="med">Export CSV</button></div><div id="lgMed"></div></section>
  <section class="panel" id="sec-diet"><div class="panel-head"><h2>Dietary</h2><button class="btn small" data-act="lgCsv" data-v="diet">Export CSV</button></div><div id="lgDiet"></div></section>
  <section class="panel" id="sec-tee"><div class="panel-head"><h2>T-shirts</h2><div class="btnrow"><button class="btn small" data-act="lgCsv" data-v="size">Export order</button><button class="btn small" data-act="lgCsv" data-v="blank">Export blanks</button></div></div><div id="lgSize"></div></section>`; },
  scope() { return (UI.logScope === 'in' ? S.P.filter(p => p.s === 'in') : registered()).filter(seesPrivate); },
  update() {
    const L = this.scope(), H = lgHash();
    const med = L.filter(p => p.medIssue), diet = L.filter(p => p.dietIssue), blanks = L.filter(p => !p.tshirt);
    const href = h => '#' + h;
    $('#lgK').innerHTML = `<div class="kpi"><span>${UI.logScope === 'in' ? 'Checked in' : 'Registered'}${['counselor', 'ac'].includes(role()) ? ' (yours)' : ''}</span><b>${L.length}</b></div><a class="kpi hero" href="${href('med-all')}" style="text-decoration:none"><span>Medical needs</span><b>${med.length}</b></a><a class="kpi hero" href="${href('diet-all')}" style="text-decoration:none"><span>Dietary needs</span><b>${diet.length}</b></a><div class="kpi"><span>Sizes given</span><b>${L.length - blanks.length}</b></div><a class="kpi" href="${href('tee-blank')}" style="text-decoration:none;color:inherit"><span>Blank sizes</span><b>${blanks.length}</b></a>`;
    const block = (list, field, CATS, kind, pre) => {
      if (!S.P.length) return '<p class="note">Upload participants on the Data & areas tab and this fills in straight away.</p>';
      if (!list.length) return '<p class="note">Nobody in this view has a note that needs attention.</p>';
      const by = {}; list.forEach(p => cats(p[field], CATS).forEach(c => (by[c] = by[c] || []).push(p)));
      const sel = H.startsWith(pre + '-') ? H.slice(pre.length + 1) : '';
      const entries = Object.entries(by).sort((a, b) => b[1].length - a[1].length);
      const cards = `<a class="issue" href="#${pre}-all" aria-current="${sel === 'all' || !sel}"><span class="ih"><span>Everyone with a ${pre === 'med' ? 'medical' : 'dietary'} note</span><b>${list.length}</b></span><small>See the full list</small></a>` + entries.map(([c, ps]) => `<a class="issue" href="#${pre}-${slug(c)}" aria-current="${sel === slug(c)}"><span class="ih"><span>${esc(c)}</span><b>${ps.length}</b></span><small>${esc(ps.slice(0, 3).map(p => p.first).join(', '))}${ps.length > 3 ? ' and ' + (ps.length - 3) + ' more' : ''}</small></a>`).join('');
      const pick = sel && sel !== 'all' ? (entries.find(([c]) => slug(c) === sel) || [null, []]) : null;
      const shown = pick ? pick[1] : list;
      const rows = shown.slice().sort((a, b) => a.stake.localeCompare(b.stake) || a.unit.localeCompare(b.unit) || a.name.localeCompare(b.name)).map(p => `<tr><td><a href="#" data-act="detail" data-id="${esc(p.id)}"><b>${esc(p.name)}</b></a><br><small class="muted">${p.age ?? '?'} yrs · ${p.gender === 'F' ? 'YW' : p.gender === 'M' ? 'YM' : '?'} · ${p.s === 'in' ? 'checked in' : p.s === 'out' ? 'checked out' : 'not arrived'}</small></td><td>${esc(p[field])}<div class="flags" style="margin-top:4px">${cats(p[field], CATS).map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div></td><td>${p.group ? 'G' + p.group.num : '—'}${p.company ? ' · Co ' + p.company.num : ''}<br><small class="muted">${esc(p.counselor ? p.counselor.name : '')}</small></td><td>${esc(p.unit)}<br><small class="muted">${esc(p.stake)}</small></td><td>${esc(p.c1n || '')}<br><small class="muted">${esc(p.c1p || p.phone || '')}</small></td>${can.admin() ? `<td><button class="btn small" data-act="notIssue" data-v="${kind}" data-id="${esc(p.id)}">Not an issue</button></td>` : ''}</tr>`).join('');
      return `<div class="issuegrid">${cards}</div><div class="filterbar" id="${pre}-list"><b>${pick ? esc(pick[0] || 'Unknown issue') : 'Everyone with a ' + (pre === 'med' ? 'medical' : 'dietary') + ' note'} · ${shown.length}</b>${pick ? `<a href="#${pre}-all" class="btn small">Show all</a>` : ''}</div><div class="tablewrap"><table><thead><tr><th>Participant</th><th>Note as entered</th><th>Group</th><th>Unit</th><th>Contact</th>${can.admin() ? '<th></th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div><p class="note">One person can have more than one issue, so the cards can add up to more than ${list.length}.</p>`;
    };
    $('#lgMed').innerHTML = block(med, 'medIssue', MED_CATS, 'mo', 'med');
    $('#lgDiet').innerHTML = block(diet, 'dietIssue', DIET_CATS, 'do', 'diet');
    $('#lgSize').innerHTML = teeBlock(L, H);
    if (H && UI.lgLast !== H) { const el = document.getElementById(H.startsWith('tee') ? 'tee-list' : H.split('-')[0] + '-list'); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    UI.lgLast = H;
  }
};
const CELL_NAME = (b, g) => `${b ? BANDS[b] : 'Age unknown'} ${g === 'F' ? 'young women' : g === 'M' ? 'young men' : '(gender unknown)'}`;
function sizesIn(...objs) { const all = new Set(); objs.forEach(o => Object.keys(o).forEach(k => all.add(k))); return [...all].sort((a, b) => sizeRank(a) - sizeRank(b)); }
function teeBlock(L, H) {
  if (!S.P.length) return '<p class="note">Upload participants to see sizes.</p>';
  const R = teeRedistribute(L);
  const sizes = sizesIn(R.totals);
  const g = (s, gen, est) => L.filter(p => p.gender === gen && (est ? !p.tshirt && R.perPerson[p.id] === s : p.tshirt === s)).length;
  let h = `<p class="th" style="margin:0 0 6px">Order by size</p><div class="tablewrap"><table><thead><tr><th>Size</th><th class="n">YW given</th><th class="n">YM given</th><th class="n">Given</th><th class="n">Blanks, estimated</th><th class="n">To order</th></tr></thead><tbody>`;
  let tg = 0, te = 0;
  for (const s of sizes) { const t = R.totals[s]; tg += t.given; te += t.est; h += `<tr><td><b>${esc(SIZE_LABEL[s] || s)}</b></td><td class="n">${g(s, 'F')}</td><td class="n">${g(s, 'M')}</td><td class="n">${t.given}</td><td class="n est">+${t.est}</td><td class="n"><b>${t.given + t.est}</b></td></tr>`; }
  h += `<tr><td><b>All</b></td><td class="n">${L.filter(p => p.tshirt && p.gender === 'F').length}</td><td class="n">${L.filter(p => p.tshirt && p.gender === 'M').length}</td><td class="n">${tg}</td><td class="n est">+${te}</td><td class="n"><b>${tg + te}</b></td></tr></tbody></table></div>`;
  h += `<p class="th" style="margin:18px 0 6px">Blank sizes, shared out by age group and gender</p><p class="note" style="margin-top:0">Each blank gets a size in the same proportions as the youth most like them who did give a size: same gender and same age where there are at least 20 of them, otherwise the same age group and gender. Within each group the youngest get the smaller sizes.</p>`;
  h += `<div class="tablewrap"><table><thead><tr><th>Who</th><th class="n">Gave a size</th><th>Their sizes</th><th class="n">Blank</th><th>Blanks become</th></tr></thead><tbody>${R.cells.map(c => { const tot = c.knownN || 1; const ks = sizesIn(c.known, c.alloc); return `<tr><td><a href="#tee-${c.band || 'x'}${c.gender || 'x'}"><b>${esc(CELL_NAME(c.band, c.gender))}</b></a></td><td class="n">${c.knownN}</td><td class="sizecell">${ks.filter(k => c.known[k]).map(k => `${k} ${Math.round(c.known[k] * 100 / tot)}%`).join(' · ') || '—'}</td><td class="n"><b>${c.blank}</b></td><td class="sizecell est">${ks.filter(k => c.alloc[k]).map(k => `${k} ${c.alloc[k]}`).join(' · ') || '—'}</td></tr>`; }).join('')}</tbody></table></div>`;
  const sel = H.startsWith('tee-') ? H.slice(4) : '';
  if (sel) {
    const list = L.filter(p => !p.tshirt && (sel === 'blank' || ((p.band || 'x') + (p.gender || 'x')).toLowerCase() === sel)).sort((a, b) => (a.age ?? 99) - (b.age ?? 99) || a.name.localeCompare(b.name));
    const label = sel === 'blank' ? 'Everyone with a blank size' : CELL_NAME(sel[0] === 'x' ? null : sel[0].toUpperCase(), sel[1] === 'x' ? '' : sel[1].toUpperCase()) + ' with a blank size';
    h += `<div class="filterbar" id="tee-list"><b>${esc(label)} · ${list.length}</b><a href="#logistics" class="btn small">Hide list</a></div><div class="tablewrap"><table><thead><tr><th>Participant</th><th class="n">Age</th><th>Estimated size</th><th>Unit</th><th>Contact</th>${can.admin() ? '<th></th>' : ''}</tr></thead><tbody>${list.map(p => `<tr><td><a href="#" data-act="detail" data-id="${esc(p.id)}"><b>${esc(p.name)}</b></a> ${chipG(p.gender)}</td><td class="n">${p.age ?? '?'}</td><td class="est"><b>${esc(SIZE_LABEL[R.perPerson[p.id]] || R.perPerson[p.id])}</b></td><td>${esc(p.unit)}<br><small class="muted">${esc(p.stake)}</small></td><td>${esc(p.c1n || '')}<br><small class="muted">${esc(p.c1p || p.phone || '')}</small></td>${can.admin() ? `<td><button class="btn small" data-act="setTee" data-v="${esc(R.perPerson[p.id])}" data-id="${esc(p.id)}">Use this size</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  } else h += `<p style="margin:10px 0 0"><a href="#tee-blank">See everyone with a blank size (${R.blankN})</a></p>`;
  return h;
}

/* ---------- page: staff ---------- */
PAGE_IMPL.staff = {
  frame() {
    return `<section class="pagehead"><div><h1>Staff</h1><p class="note" style="margin:4px 0 0">Counselors, assistant coordinators, coordinators and the session directing couple. Upload them from a spreadsheet on the Data & areas tab, or add them here. Counselors aged 19–22 are matched to 13–15 groups first, 23 and over to 16–18.</p></div></section>
    <div class="grid2"><div class="panel"><h2>Add a staff member</h2><form id="stForm" class="form">
      <label class="span2">Full name<input id="stName" required></label>
      <label>Role<select id="stRole">${STAFF_ROLES.map(r => opt(r, ROLES[r], r === UI.staffTab)).join('')}</select></label>
      <label>Gender<select id="stGender" required>${opt('', 'Choose…')}${opt('F', 'Female')}${opt('M', 'Male')}</select></label>
      <label>Age<input id="stAge" type="number" min="16" max="90" inputmode="numeric"></label><label>Phone<input id="stPhone" inputmode="tel"></label>
      <label>T-shirt size<select id="stSize">${opt('', 'Not given')}${SIZES.map(s => opt(s, SIZE_LABEL[s])).join('')}</select></label>
      <div class="span2"><button class="btn primary" type="submit">Add</button></div></form></div>
    <div class="panel"><h2>Test staff</h2><p class="note">No counselors yet? Generate clearly marked test counselors, ACs, coordinators and a directing couple so you can try the company generator. Delete them when the real list is uploaded, then press Rebalance or Regenerate.</p>
      <div class="inline"><label class="inline">ACs to create <input id="tsAcs" type="number" min="1" max="40" value="${Math.max(2, Math.round(S.P.filter(p => p.elig).length / 100))}" style="width:80px"></label><button class="btn" data-act="testGen">Generate test staff</button><button class="btn danger" data-act="testDel">Delete test staff</button></div></div></div>
    <div class="seg" role="group" aria-label="Role" id="stTabs"></div><div id="stList"></div>`;
  },
  update() {
    const cnt = r => S.staffList.filter(s => s.role === r).length;
    $('#stTabs').innerHTML = STAFF_ROLES.map(r => `<button data-act="stTab" data-v="${r}" aria-pressed="${UI.staffTab === r}">${esc(ROLES[r])} · ${cnt(r)}</button>`).join('');
    const list = S.staffList.filter(s => s.role === UI.staffTab);
    const G = Object.values(S.org.groups), C = Object.values(S.org.companies);
    const where = s => { if (s.role === 'counselor') { const g = G.find(g => g.counselorId === s.id); return g ? `G${g.num} · ${BANDS[g.band]}` : '<span class="chip warn">Unassigned</span>'; } if (s.role === 'ac') { const c = C.find(c => c.acId === s.id); return c ? `Company ${c.num}` : '<span class="chip warn">Spare</span>'; } if (s.role === 'coordinator') return C.filter(c => c.coordId === s.id).map(c => c.num).join(', ') ? 'Companies ' + C.filter(c => c.coordId === s.id).map(c => c.num).sort((a, b) => a - b).join(', ') : '—'; return '—'; };
    $('#stList').innerHTML = list.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Gender</th><th class="n">Age</th>${UI.staffTab === 'counselor' ? '<th>Best fit</th>' : ''}<th>Assigned</th><th>Role</th><th></th></tr></thead><tbody>${list.map(s => { const a = staffAge(s, S.config); return `<tr><td><b>${esc(s.name)}</b> ${s.test ? '<span class="chip info">Test</span>' : ''}<br><small class="muted">${esc(s.unit || '')}${s.phone ? ' · ' + esc(s.phone) : ''}</small></td><td>${chipG(s.gender)}</td><td class="n">${a ?? '—'}</td>${UI.staffTab === 'counselor' ? `<td>${a == null ? '<span class="muted">Unknown age</span>' : a >= 23 ? '16–18' : a >= 19 ? '13–15' : '<span class="chip warn">Under 19</span>'}</td>` : ''}<td>${where(s)}</td><td><select data-act="stRole" data-id="${esc(s.id)}" aria-label="Role">${STAFF_ROLES.map(r => opt(r, ROLES[r], r === s.role)).join('')}</select></td><td><button class="btn small danger" data-act="stDel" data-id="${esc(s.id)}">Delete</button></td></tr>`; }).join('')}</tbody></table></div>` : `<div class="empty"><h3>No ${esc(ROLES[UI.staffTab].toLowerCase())}s yet</h3>Add them with the form, upload a spreadsheet on the Data & areas tab, or generate test staff.</div>`;
  }
};

/* ---------- page: data ---------- */
PAGE_IMPL.data = {
  frame() {
    return `<section class="pagehead"><div><h1>Data & areas</h1><p class="note" style="margin:4px 0 0">Upload the FSY portal export, choose which stakes and units belong to this session, and clean up problem records.</p></div></section>
    <div class="panel"><h2>Upload participants or staff</h2><p class="note">Excel (.xlsx, .xls) or .csv. Column headers are read from the first row and matched to fields. Rows are matched by Registration ID, so uploading a newer export updates people without losing check-ins or groups. The Type column decides who is a participant, counselor or assistant coordinator.</p>
      <input type="file" id="impFile" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"><div id="impBox" style="margin-top:12px"></div></div>
    <div class="grid2"><div class="panel"><h2>Session settings</h2><form id="cfgForm" class="form">
      <label class="span2">Session name<input id="cfName" value="${esc(S.config.sessionName)}"></label>
      <label>First day of session<input id="cfStart" type="date" value="${esc(S.config.sessionStart || '')}"></label>
      <label>Participants per group<input id="cfSize" type="number" min="4" max="20" value="${esc(S.config.groupSize)}"></label>
      <p class="note span2" style="margin:0">With a first day set, ages are worked out from birthdays on that day. Without it, the Age column from the upload is used.</p>
      <div class="span2"><button class="btn primary" type="submit">Save settings</button></div></form>
      <h3 style="margin:16px 0 6px">Registration statuses</h3><div id="dStat"></div></div>
    <div class="panel"><h2>Data problems</h2><div id="dIss"></div></div></div>
    <div class="panel"><div class="panel-head"><h2>Stakes, wards and branches in this session</h2><span class="note">Untick an area to leave its youth out of the expected list and the groups.</span></div><div id="dAreas" class="arealist"></div></div>`;
  },
  update() {
    const P = S.P, ex = new Set(S.config.excludedStatuses || []);
    const statuses = uniq(P.map(p => p.status).filter(Boolean)).sort();
    $('#dStat').innerHTML = statuses.length ? statuses.map(s => `<label class="inline" style="padding:3px 0"><input type="checkbox" data-act="stat" data-v="${esc(s)}" ${ex.has(s) ? '' : 'checked'}> ${esc(s.replace(/_/g, ' ').toLowerCase())} <span class="muted num">${P.filter(p => p.status === s).length}</span></label>`).join('') + '<p class="note">Ticked statuses count as registered. Unticked ones show up as exceptions if they check in.</p>' : '<p class="note">Statuses appear after the first upload.</p>';
    const exS = new Set(S.config.excludedStakes || []), exU = new Set(S.config.excludedUnits || []);
    const stakes = {}; P.filter(p => p.src !== 'walkin').forEach(p => { (stakes[p.stake] = stakes[p.stake] || {})[p.unit] = ((stakes[p.stake] || {})[p.unit] || 0) + 1; });
    $('#dAreas').innerHTML = Object.keys(stakes).length ? Object.keys(stakes).sort().map(s => { const u = stakes[s]; const tot = Object.values(u).reduce((a, b) => a + b, 0); return `<div class="st"><input type="checkbox" data-act="areaS" data-v="${esc(s)}" ${exS.has(s) ? '' : 'checked'} id="as${fnv(s)}"><label for="as${fnv(s)}" class="${exS.has(s) ? 'excluded' : ''}">${esc(s || '(No stake)')}</label><span class="cnt">${tot}</span></div>${Object.keys(u).sort().map(n => { const k = s + '|' + n; return `<div class="un"><input type="checkbox" data-act="areaU" data-v="${esc(k)}" ${exU.has(k) || exS.has(s) ? '' : 'checked'} ${exS.has(s) ? 'disabled' : ''} id="au${fnv(k)}"><label for="au${fnv(k)}" class="${exU.has(k) || exS.has(s) ? 'excluded' : ''}">${esc(n || '(No unit)')}</label><span class="cnt">${u[n]}</span></div>`; }).join('')}`; }).join('') : '<p class="note">Areas appear after the first upload.</p>';
    const dupKey = p => (p.first + p.last).toLowerCase().replace(/[^a-z]/g, '') + '|' + (p.bday || p.age);
    const dmap = {}; P.forEach(p => (dmap[dupKey(p)] = dmap[dupKey(p)] || []).push(p));
    const dups = Object.values(dmap).filter(a => a.length > 1).flat();
    const lists = [['Possible duplicates (same name and birthday)', dups], ['Outside ages 13–18', P.filter(p => p.flags.includes('agerange'))], ['No gender', P.filter(p => p.flags.includes('gender'))], ['No age or birthday', P.filter(p => p.flags.includes('age'))], ['Waiting for approval', P.filter(p => p.flags.includes('pending'))], ['Cancelled', P.filter(p => p.flags.includes('status'))]];
    $('#dIss').innerHTML = (P.length ? lists.map(([t, l]) => `<details ${l.length && l.length < 12 ? 'open' : ''} style="padding:4px 0"><summary><b>${esc(t)}</b> <span class="chip ${l.length ? 'warn' : 'good'}">${l.length}</span></summary>${l.length ? `<div class="flags" style="margin:6px 0 4px">${l.slice(0, 80).map(p => `<a href="#" class="chip" data-act="detail" data-id="${esc(p.id)}">${esc(p.name)} · ${esc(p.unit)}</a>`).join('')}</div>` : ''}</details>`).join('') : '<p class="note">Upload a file to check for problems.</p>') + `<p class="note">${P.filter(p => !p.tshirt).length} participants have no T-shirt size. Open a record to fix it.</p>`;
    renderImport();
  }
};
function renderImport() {
  const box = $('#impBox'); if (!box) return; const I = UI.imp;
  if (!I) { box.innerHTML = ''; return; }
  if (I.done) { box.innerHTML = `<div class="callout info">${esc(I.done)}</div>`; return; }
  const fieldOpts = sel => opt('', '— Ignore') + FIELDS.map(([k, l]) => opt(k, l, k === sel)).join('');
  const rec = rowsToRecords(I.rows, I.map, I.mode, Date.now());
  const byRole = {}; rec.staff.forEach(s => byRole[s.role] = (byRole[s.role] || 0) + 1);
  const mapped = Object.values(I.map);
  const missing = ['first', 'bday', 'gender', 'stake', 'unit'].filter(k => !mapped.includes(k) && !(k === 'first' && mapped.includes('fullname')));
  box.innerHTML = `<div class="inline" style="margin-bottom:10px"><b>${esc(I.name)}</b><span class="muted">${I.rows.length - 1} rows</span>
    <label class="inline">Treat rows as <select id="impMode">${opt('auto', 'Use the Type column', I.mode === 'auto')}${opt('participant', 'All participants', I.mode === 'participant')}${STAFF_ROLES.map(r => opt(r, 'All ' + ROLES[r].toLowerCase() + 's', I.mode === r)).join('')}</select></label></div>
    ${missing.length ? `<div class="callout" style="margin-bottom:10px">Not matched yet: ${missing.map(k => FIELDS.find(f => f[0] === k)[1]).join(', ')}. Pick the right column below if the file has it.</div>` : ''}
    <details ${missing.length ? 'open' : ''}><summary><b>Column matching</b> <span class="muted">${Object.keys(I.map).length} of ${I.rows[0].length} columns used</span></summary><div class="tablewrap" style="margin-top:8px;max-height:340px;overflow:auto"><table><thead><tr><th>Column in file</th><th>Example</th><th>Use as</th></tr></thead><tbody>${I.rows[0].map((h, i) => `<tr><td>${esc(h)}</td><td class="muted">${esc(String((I.rows[1] || [])[i] ?? '').slice(0, 28))}</td><td><select data-act="impMap" data-v="${i}">${fieldOpts(I.map[i])}</select></td></tr>`).join('')}</tbody></table></div></details>
    <p style="margin:12px 0"><b>${rec.participants.length}</b> participants${Object.entries(byRole).map(([r, n]) => `, <b>${n}</b> ${esc(ROLES[r].toLowerCase())}${n > 1 ? 's' : ''}`).join('')}${rec.skipped ? `, ${rec.skipped} rows skipped (no name)` : ''}.</p>
    <div class="btnrow"><button class="btn primary" data-act="impGo" ${I.busy ? 'disabled' : ''}>${I.busy ? esc(I.busy) : 'Import'}</button><button class="btn" data-act="impCancel">Cancel</button></div>`;
}
async function readFile(file) {
  if (typeof XLSX === 'undefined') { toast('The spreadsheet reader did not load. Check your connection and reload.', true); return; }
  const buf = await file.arrayBuffer();
  let wb;
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') { const text = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, ''); wb = XLSX.read(text, { type: 'string', raw: true }); }
  else wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).map(r => r.map(c => c instanceof Date ? parseDate(c) : c));
  if (!rows.length) { toast('That file has no rows.', true); return; }
  UI.imp = { name: file.name, rows, map: autoMap(rows[0]), mode: 'auto' };
  renderImport();
}
async function doImport() {
  const I = UI.imp; const rec = rowsToRecords(I.rows, I.map, I.mode, Date.now());
  I.busy = 'Saving…'; renderImport();
  try {
    const byB = {}, medB = {}; rec.participants.forEach(p => { const id = p.id; const b = bucketOf(id); const r = Object.assign({}, p); delete r.id; (medB[b] = medB[b] || {})[id] = { med: r.med || '', diet: r.diet || '' }; delete r.med; delete r.diet; (byB[b] = byB[b] || {})[id] = r; });
    const bs = Object.keys(byB); let n = 0;
    for (const b of bs) { const mx = S.medicalEx.has(b); S.medicalEx.add(b); await upd('medical/' + b, { p: medB[b] }, mx); const ex = S.rosterEx.has(b); S.rosterEx.add(b); await upd('roster/' + b, { p: byB[b] }, ex); n++; I.busy = `Saving ${n} of ${bs.length}…`; renderImport(); }
    if (rec.staff.length) { const s = {}; rec.staff.forEach(x => s[x.id] = x); const ex = S.staffEx; S.staffEx = true; await upd('staff/all', { s }, ex); }
    if (!S.configEx) await saveConfig({});
    UI.imp = { done: `Imported ${rec.participants.length} participants and ${rec.staff.length} staff. Next: untick excluded areas below, then generate companies on the Companies & groups tab.` };
  } catch (e) { fail(e); I.busy = null; }
  renderImport();
}

/* ---------- page: access ---------- */
PAGE_IMPL.access = {
  frame() {
    return `<section class="pagehead"><div><p class="th">Accounts</p><h1>Who can use the app</h1><p class="note" style="margin:4px 0 0">Create an account for each person with their Google email. When they sign in with that Google account, they get their role straight away.</p></div></section>
    <div class="callout info">Send counselors and staff the web address of this site. They press <b>Sign in with Google</b> using the email you enter below. Nobody else can see any data.</div>
    <div class="panel"><h2>Create an account</h2><form id="invForm" class="form">
      <label>Full name<input id="invName" required autocomplete="off"></label>
      <label>Google email<input id="invEmail" type="email" required autocomplete="off" placeholder="name@gmail.com"></label>
      <label>Role<select id="invRole" required>${opt('', 'Choose…')}${Object.keys(ROLES).filter(r => r !== 'regadmin' || realRole() === 'regadmin').map(r => opt(r, ROLES[r])).join('')}</select></label>
      <label>Staff record<select id="invStaff">${opt('', '— Link later')}${S.staffList.filter(x => ['counselor', 'ac', 'coordinator', 'sdc'].includes(x.role)).map(x => opt(x.id, x.name + ' · ' + ROLES[x.role])).join('')}</select></label>
      <p class="note span2" style="margin:0">Counselors and ACs must be linked to their staff record. That decides which group and company, and whose medical and dietary notes, they can see.</p>
      <div class="span2"><button class="btn primary" type="submit">Create account</button></div></form></div>
    <div class="panel"><div class="panel-head"><h2>Accounts you created</h2><span class="note" id="invCount"></span></div><div id="invList"></div></div>
    <div class="panel"><h2>Sign-in requests</h2><p class="note" style="margin-top:-4px">From people whose Google email did not match an account. Choosing a role creates an account for that email.</p><div id="acReq"></div></div>
    <div class="panel"><h2>What each role sees and does</h2><div class="tablewrap"><table><thead><tr><th>Role</th><th>Sees</th><th>Can</th></tr></thead><tbody>
      <tr><td>Registration admin</td><td>Whole session</td><td>Everything, including deleting participants and managing accounts. Only a registration admin can make someone else a registration admin.</td></tr>
      <tr><td>Session directing couple</td><td>Whole session</td><td>Everything except deleting participants, including creating accounts.</td></tr>
      <tr><td>Coordinator</td><td>Whole session</td><td>Check in, move participants between any groups, logistics for everyone.</td></tr>
      <tr><td>Logistics</td><td>Whole session</td><td>Medical, dietary and T-shirt lists and the tally.</td></tr>
      <tr><td>Assistant coordinator</td><td>Their company</td><td>Check in, move participants inside their company, logistics for their company.</td></tr>
      <tr><td>Counselor</td><td>Their group and company</td><td>Check in, undo and check out, add walk-ins, logistics for their company.</td></tr></tbody></table></div>
      <p class="note">These limits are enforced by the database's security rules, not only by the screens. Medical and dietary notes are stored apart; counselors, ACs, coordinators and logistics only receive the notes for the youth they are allowed to see.</p></div>`;
  },
  async update() {
    const invs = Object.entries(S.invites).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
    const claimed = {}; for (const uid in S.members) { const h = S.members[uid].h; if (h) claimed[h] = uid; }
    const roleOpts = cur => Object.keys(ROLES).filter(r => r !== 'regadmin' || r === cur || realRole() === 'regadmin').map(r => opt(r, ROLES[r], r === cur)).join('');
    const staffOpts = cur => opt('', '— Not linked', !cur) + S.staffList.filter(x => ['counselor', 'ac', 'coordinator', 'sdc'].includes(x.role)).map(x => opt(x.id, x.name + ' · ' + ROLES[x.role], x.id === cur)).join('');
    if (!$('#invList')) return;
    $('#invCount').textContent = invs.length ? `${Object.keys(claimed).filter(h => S.invites[h]).length} of ${invs.length} signed in` : '';
    $('#invList').innerHTML = invs.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Staff record</th><th>Status</th><th></th></tr></thead><tbody>${invs.map(([h, v]) => `<tr><td><b>${esc(v.name)}</b></td><td class="mono" style="font-size:.84rem">${esc(S.inviteEmails[h] || h)}</td><td><select data-act="invRole" data-id="${h}" aria-label="Role">${roleOpts(v.role)}</select></td><td>${['counselor', 'ac', 'coordinator', 'sdc'].includes(v.role) ? `<select data-act="invStaff" data-id="${h}" aria-label="Staff record">${staffOpts(v.staffId)}</select>` : '<span class="muted">Not needed</span>'}${['counselor', 'ac'].includes(v.role) && !v.staffId ? ' <span class="chip warn">Link needed</span>' : ''}</td><td>${claimed[h] ? '<span class="chip good">Signed in</span>' : '<span class="chip">Waiting</span>'}</td><td><button class="btn small danger" data-act="invDel" data-id="${h}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="note">No accounts yet. Create the first one above.</p>';
    const reqIds = Object.keys(S.requests).filter(id => !S.invites[emailKey(S.requests[id].email || '')]);
    const accIds = Object.keys(S.access);
    const ps = S.user ? await S.user.profiles(uniq(reqIds.concat(accIds))) : {};
    const nm = id => (S.requests[id] && S.requests[id].name) || (ps[id] && ps[id].name) || 'Someone';
    const roleSel = (id, cur, act) => `<select data-act="${act}" data-id="${esc(id)}" aria-label="Role">${opt('', 'Choose role…', !cur)}${Object.keys(ROLES).filter(r => r !== 'regadmin' || realRole() === 'regadmin').map(r => opt(r, ROLES[r], r === cur)).join('')}</select>`;
    const staffSel = (id, cur) => `<select data-act="acStaff" data-id="${esc(id)}" aria-label="Linked staff record">${staffOpts(cur)}</select>`;
    $('#acReq').innerHTML = reqIds.length ? reqIds.map(id => { const r = S.requests[id]; return `<div class="panel" style="box-shadow:none;margin-bottom:8px"><b>${esc(nm(id))}</b>${r.email ? ` <small class="muted">${esc(r.email)}</small>` : ''}<br><small class="muted">${esc(fmtTime(r.at))}</small><p style="margin:6px 0">“${esc(r.note || 'No note')}”</p><div class="inline">${roleSel(id, '', 'reqRole')}<button class="btn small danger" data-act="reqDel" data-id="${esc(id)}">Dismiss</button></div></div>`; }).join('') : '<p class="note">No pending requests.</p>';
    if ($('#acList')) $('#acList').innerHTML = accIds.length ? `<div class="tablewrap"><table><thead><tr><th>Person</th><th>Role</th><th>Staff record</th><th></th></tr></thead><tbody>${accIds.map(id => { const a = S.access[id]; return `<tr><td><b>${esc(nm(id))}</b></td><td>${roleSel(id, a.role, 'acRole')}</td><td>${['counselor', 'ac', 'coordinator', 'sdc'].includes(a.role) ? staffSel(id, a.staffId) : '<span class="muted">—</span>'}</td><td><button class="btn small danger" data-act="acDel" data-id="${esc(id)}">Remove</button></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="note">None. Roles given from a request show here.</p>';
  }
};
async function setAccess(uid, patch) {
  const cur = S.access[uid] || {}; const rec = Object.assign({}, cur, patch, { at: Date.now() });
  S.access = Object.assign({}, S.access, { [uid]: rec }); recompute(true);
  const ex = S.accessEx; S.accessEx = true;
  await upd('access/roles', { u: { [uid]: rec } }, ex).catch(fail);
}

/* ---------- participant details ---------- */
function openDetail(id) {
  const p = S.P.find(x => x.id === id); if (!p) return;
  const adm = can.admin(), priv = seesPrivate(p);
  const row = (l, v) => v ? `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>` : '';
  const prow = (l, v) => priv ? row(l, v) : '';
  openModal(`<div class="modal-head"><div><h2>${esc(p.name)}</h2><div class="sub">${chipG(p.gender)}${chipBand(p.band)}<span class="chip">${p.age ?? '?'} yrs</span>${flagChips(p)}</div></div><button class="x" data-act="close" aria-label="Close">×</button></div>
  <dl class="pc-grid">${row('Preferred name', p.pref)}${row('Birthday', p.bday)}${row('Group', p.group ? 'G' + p.group.num + ' · ' + (p.counselor ? p.counselor.name : 'No counselor') : 'Not assigned')}${row('Company', p.company ? 'Company ' + p.company.num + ' · AC ' + (sName(p.company.acId) || '—') : '')}${row('T-shirt', SIZE_LABEL[p.tshirt] || p.tshirt || 'Not given')}${row('Ward / branch', p.unit)}${row('Stake / district', p.stake)}${row('Status', (p.status || '').replace(/_/g, ' ').toLowerCase())}${prow('Phone', p.phone)}${prow('Email', p.email)}${prow('Contact 1', [p.c1n, p.c1p, p.c1e].filter(Boolean).join(' · '))}${prow('Contact 2', [p.c2n, p.c2p, p.c2e].filter(Boolean).join(' · '))}${prow("Bishop / branch president", [p.bishopN, p.bishopE].filter(Boolean).join(' · '))}${row('Checked in', fmtTime(p.ti))}${row('Checked out', fmtTime(p.to))}${row('Registration ID', p.id)}</dl>
  ${priv ? '' : '<p class="note" style="margin:0">Medical, dietary and contact details are only shown for youth in your company.</p>'}<dl class="pc-grid" ${priv ? '' : 'hidden'}><div class="wide"><dt>Medical${adm ? ' (as entered)' : ''}</dt><dd>${esc(p.med || '—')} ${p.medIssue ? '<span class="chip warn">Counted</span>' : ''}</dd></div><div class="wide"><dt>Dietary${adm ? ' (as entered)' : ''}</dt><dd>${esc(p.diet || '—')} ${p.dietIssue ? '<span class="chip warn">Counted</span>' : ''}</dd></div></dl>
  ${adm ? `<details><summary><b>Edit record</b></summary><form id="edForm" class="form" data-id="${esc(p.id)}" style="margin-top:10px">
    <label>First name<input id="edFirst" value="${esc(p.first)}"></label><label>Last name<input id="edLast" value="${esc(p.last)}"></label>
    <label>Gender<select id="edGender">${opt('', 'Unknown', !p.gender)}${opt('F', 'Female', p.gender === 'F')}${opt('M', 'Male', p.gender === 'M')}</select></label>
    <label>Birthday<input id="edBday" type="date" value="${esc(p.bday || '')}"></label><label>Age (if no birthday)<input id="edAge" type="number" value="${esc(p.ageCsv ?? '')}"></label>
    <label>T-shirt<select id="edSize">${opt('', 'Not given', !p.tshirt)}${SIZES.map(s => opt(s, SIZE_LABEL[s], s === p.tshirt)).join('')}</select></label>
    <label>Stake / district<input id="edStake" value="${esc(p.stake)}"></label><label>Ward / branch<input id="edUnit" value="${esc(p.unit)}"></label>
    <label class="span2">Medical<input id="edMed" value="${esc(p.med)}"></label><label class="span2">Dietary<input id="edDiet" value="${esc(p.diet)}"></label>
    <div class="span2 btnrow"><button class="btn primary" type="submit">Save changes</button></div></form></details>
  <div class="btnrow">${p.inc ? `<button class="btn" data-act="ovr" data-v="exc" data-id="${esc(p.id)}">Exclude from session</button>` : `<button class="btn" data-act="ovr" data-v="inc" data-id="${esc(p.id)}">Include in session</button>`}${p.ov ? `<button class="btn" data-act="ovr" data-v="" data-id="${esc(p.id)}">Use area rules</button>` : ''}
    <button class="btn" data-act="flagIssue" data-v="mo" data-id="${esc(p.id)}">${p.medIssue ? 'Medical: not an issue' : 'Medical: count as issue'}</button><button class="btn" data-act="flagIssue" data-v="do" data-id="${esc(p.id)}">${p.dietIssue ? 'Diet: not an issue' : 'Diet: count as issue'}</button>
    ${can.deleteP() ? `<button class="btn danger" data-act="delP" data-id="${esc(p.id)}">Delete participant</button>` : ''}</div>` : ''}`);
}

/* ---------- generator actions ---------- */
async function runRebalance() {
  const r = rebalance(S.P, S.staffList, S.org, S.config);
  UI.genLog = { title: 'Rebalanced. Existing groups were kept.', lines: r.log };
  await saveOrg(r.org, { at: Date.now(), mode: 'rebalance' });
  const ch = {}; for (const id in r.changes) ch[id] = { g: r.changes[id] };
  await setStates(ch).catch(fail); toast('Groups and companies updated');
}
async function runRegen() {
  if (!S.staffList.some(s => s.role === 'counselor')) { toast('Add counselors on the Staff tab first (or generate test staff).', true); return; }
  const ok = await confirmBox('Regenerate all groups and companies?', 'Every participant is placed again from scratch. Check-ins are kept, but group and company assignments, including manual moves, are replaced. To keep current groups, use Rebalance instead.', 'Regenerate', true);
  if (!ok) return;
  const r = fullGenerate(S.P, S.staffList, S.config);
  UI.genLog = { title: 'Generated new groups and companies', lines: r.log };
  await saveOrg(r.org, { at: Date.now(), mode: 'full' });
  const ch = {}; S.P.forEach(p => { const g = r.assign[p.id] || null; if ((p.g || null) !== g) ch[p.id] = { g }; });
  await setStates(ch).catch(fail); toast('Companies generated');
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act, v = t.dataset.v, id = t.dataset.id;
  if (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type === 'checkbox')) return;
  if (t.tagName === 'A') e.preventDefault();
  const now = Date.now();
  switch (act) {
    case 'nav': location.hash = v; break;
    case 'close': closeModal(); break;
    case 'request': { const note = ($('#reqNote') || {}).value || ''; try { await S.db.doc('requests/' + S.uid).set({ at: now, note: note.slice(0, 200), email: S.email, name: S.meName }); toast('Request sent'); UI.frameKey = ''; } catch (err) { toast('Could not send the request. Try again.', true); } break; }
    case 'signIn': await signIn(); break;
    case 'signOut': await FB.auth.signOut(); break;
    case 'ciF': UI.filter = v; UI.limit = 40; UI.frameKey = ''; render(); break;
    case 'ciClear': { const q = $('#ciQ'); q.value = ''; UI.q = ''; UI.limit = 40; PAGE_IMPL.checkin.update(); q.focus(); break; }
    case 'ciMore': UI.limit += 60; render(); break;
    case 'ciIn': { const p = S.P.find(x => x.id === id); setState(id, { s: 'in', ti: now, by: S.uid }); toast((p ? p.first : '') + ' checked in' + (p && p.group ? ' · G' + p.group.num : '')); break; }
    case 'ciUndo': setState(id, { s: '', ti: null, by: S.uid }); toast('Check-in undone'); break;
    case 'ciOut': setState(id, { s: 'out', to: now, by: S.uid }); toast('Checked out'); break;
    case 'detail': openDetail(id); break;
    case 'toggleStake': UI.openStakes.has(v) ? UI.openStakes.delete(v) : UI.openStakes.add(v); render(); break;
    case 'toggleGrp': if (e.target.closest('select')) return; UI.open.has(id) ? UI.open.delete(id) : UI.open.add(id); render(); break;
    case 'coBand': UI.band = v; UI.frameKey = ''; render(); break;
    case 'allWarn': UI.allWarn = true; render(); break;
    case 'rebalance': await runRebalance(); break;
    case 'regen': await runRegen(); break;
    case 'addCo': { const band = await new Promise(res => { openModal(`<div class="modal-head"><h2>Add a company</h2><button class="x" data-act="close" aria-label="Close">×</button></div><p class="note">An empty company is created. Move groups into it with the Company picker inside each group, or press Rebalance to fill it automatically with a spare AC.</p><div class="btnrow"><button class="btn primary" id="aY">13–15 company</button><button class="btn primary" id="aO">16–18 company</button></div>`); $('#aY').onclick = () => { closeModal(); res('Y'); }; $('#aO').onclick = () => { closeModal(); res('O'); }; }); if (!band) break; const cid = rid('c'); const num = Math.max(0, ...Object.values(S.org.companies).map(c => c.num)) + 1; await patchOrg({ companies: { [cid]: { id: cid, band, acId: null, coordId: null, num } } }); toast('Company ' + num + ' added'); break; }
    case 'delCo': { const c = S.org.companies[id]; if (!await confirmBox(`Remove Company ${c.num}?`, 'Its groups stay together and move to "Groups without a company". Press Rebalance to place them in other companies.', 'Remove company', true)) break; const o = { groups: {}, companies: Object.assign({}, S.org.companies) }; for (const g of Object.values(S.org.groups)) o.groups[g.id] = g.companyId === id ? Object.assign({}, g, { companyId: null }) : g; delete o.companies[id]; await saveOrg(o, S.orgGen); toast('Company removed'); break; }
    case 'delGrp': { const g = S.org.groups[id]; if (!await confirmBox(`Remove group G${g.num}?`, 'Its participants become unassigned. Press Rebalance to place them in other groups.', 'Remove group', true)) break; const o = { groups: Object.assign({}, S.org.groups), companies: S.org.companies }; delete o.groups[id]; await saveOrg(o, S.orgGen); const ch = {}; S.P.filter(p => p.g === id).forEach(p => ch[p.id] = { g: null }); await setStates(ch).catch(fail); toast('Group removed'); break; }
    case 'rosterCsv': { const rows = [['Company', 'Age group', 'AC', 'Group', 'Counselor', 'Participant', 'Gender', 'Age', 'Ward/branch', 'Stake', 'T-shirt', 'Status']]; S.P.filter(p => p.group).sort((a, b) => (a.company ? a.company.num : 999) - (b.company ? b.company.num : 999) || a.group.num - b.group.num || a.name.localeCompare(b.name)).forEach(p => rows.push([p.company ? p.company.num : '', BANDS[p.group.band], p.company ? sName(p.company.acId) : '', 'G' + p.group.num, p.counselor ? p.counselor.name : '', p.name, p.gender, p.age, p.unit, p.stake, p.tshirt, p.s || 'not arrived'])); exportCSV('fsy-rosters.csv', rows); break; }
    case 'tallyCsv': { const rows = [['Stake', 'Ward/branch', 'Expected', 'Checked in', 'Checked out']]; const m = {}; S.P.forEach(p => { const k = p.stake + '|' + p.unit; const x = m[k] = m[k] || [p.stake, p.unit, 0, 0, 0]; if (p.elig && p.src !== 'walkin') x[2]++; if (p.s === 'in') x[3]++; if (p.s === 'out') x[4]++; }); Object.values(m).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])).forEach(r => rows.push(r)); exportCSV('fsy-tally.csv', rows); break; }
    case 'logScope': UI.logScope = v; UI.frameKey = ''; render(); break;
    case 'lgCsv': { const L = PAGE_IMPL.logistics.scope(); let rows; if (v === 'size') { const R = teeRedistribute(L); rows = [['Size', 'Given', 'Blanks estimated', 'To order']]; sizesIn(R.totals).forEach(s => rows.push([SIZE_LABEL[s] || s, R.totals[s].given, R.totals[s].est, R.totals[s].given + R.totals[s].est])); } else if (v === 'blank') { const R = teeRedistribute(L); rows = [['Name', 'Age', 'Gender', 'Age group', 'Estimated size', 'Ward/branch', 'Stake', 'Contact', 'Contact phone']]; L.filter(p => !p.tshirt).forEach(p => rows.push([p.name, p.age, p.gender, p.band ? BANDS[p.band] : '', R.perPerson[p.id], p.unit, p.stake, p.c1n, p.c1p])); } else { const f = v === 'med' ? 'medIssue' : 'dietIssue', C = v === 'med' ? MED_CATS : DIET_CATS; rows = [['Name', 'Age', 'Gender', 'Note', 'Categories', 'Group', 'Counselor', 'Company', 'Ward/branch', 'Stake', 'Status', 'Contact', 'Contact phone']]; L.filter(p => p[f]).forEach(p => rows.push([p.name, p.age, p.gender, p[f], cats(p[f], C).join('; '), p.group ? 'G' + p.group.num : '', p.counselor ? p.counselor.name : '', p.company ? p.company.num : '', p.unit, p.stake, p.s || 'not arrived', p.c1n, p.c1p])); } exportCSV(`fsy-${({ med: 'medical', diet: 'dietary', size: 'tshirt-order', blank: 'tshirt-blanks' })[v]}.csv`, rows); break; }
    case 'setTee': { const b = bucketOf(id); S.roster = Object.assign({}, S.roster, { [b]: Object.assign({}, S.roster[b], { [id]: Object.assign({}, S.roster[b][id], { tshirt: v }) }) }); recompute(true); await upd('roster/' + b, { p: { [id]: { tshirt: v } } }, true).catch(fail); toast('Size set to ' + (SIZE_LABEL[v] || v)); break; }
    case 'notIssue': setState(id, { [v]: 'n' }); toast('Removed from the count'); break;
    case 'flagIssue': { const p = S.P.find(x => x.id === id); const on = v === 'mo' ? !!p.medIssue : !!p.dietIssue; await setState(id, { [v]: on ? 'n' : 'y' }); openDetail(id); break; }
    case 'ovr': await setState(id, { ov: v || null }); if ($('#mbg')) openDetail(id); toast(v === 'inc' ? 'Included in the session' : v === 'exc' ? 'Excluded from the session' : 'Area rules apply again'); break;
    case 'delP': { const p = S.P.find(x => x.id === id); if (!await confirmBox(`Delete ${p.name}?`, 'The record and check-in are removed from the app. A later upload of the same file would bring them back unless you also remove them from the file.', 'Delete participant', true)) break; const b = bucketOf(id); const m = Object.assign({}, S.roster[b]); delete m[id]; S.roster = Object.assign({}, S.roster, { [b]: m }); await setState(id, { del: true, g: null }); await setDoc('roster/' + b, { p: m }).catch(fail); toast('Participant deleted'); break; }
    case 'testGen': { const n = Math.max(1, Math.min(40, +($('#tsAcs') || {}).value || 2)); const list = makeTestStaff(S.P, S.config, n); const s = {}; list.forEach(x => s[x.id] = x); S.staff = Object.assign({}, S.staff, s); recompute(true); const ex = S.staffEx; S.staffEx = true; await upd('staff/all', { s }, ex).catch(fail); toast(`${list.length} test staff added`); break; }
    case 'testDel': { const tests = S.staffList.filter(s => s.test); if (!tests.length) { toast('There are no test staff.'); break; } if (!await confirmBox(`Delete ${tests.length} test staff?`, 'Groups and companies they lead lose their leader. Press Rebalance afterwards to hand them to real staff.', 'Delete test staff', true)) break; const s = {}; S.staffList.filter(x => !x.test).forEach(x => s[x.id] = x); S.staff = s; recompute(true); await setDoc('staff/all', { s }).catch(fail); toast('Test staff deleted'); break; }
    case 'stTab': UI.staffTab = v; render(); break;
    case 'stDel': { const st = S.staffMap[id]; if (!await confirmBox(`Delete ${st.name}?`, 'If they lead a group or company, it loses its leader. Press Rebalance afterwards to fill the gap.', 'Delete', true)) break; const s = Object.assign({}, S.staff); delete s[id]; S.staff = s; recompute(true); await setDoc('staff/all', { s }).catch(fail); toast('Deleted'); break; }
    case 'impGo': await doImport(); break;
    case 'impCancel': UI.imp = null; renderImport(); const f = $('#impFile'); if (f) f.value = ''; break;
    case 'reqDel': await serial('requests/' + id, () => S.db.doc('requests/' + id).delete()).catch(fail); break;
    case 'invDel': { const v = S.invites[id]; if (!await confirmBox(`Delete ${v.name}'s account?`, 'They lose access to the app straight away. Their check-ins stay.', 'Delete account', true)) break; await serial('invites/' + id, () => S.db.doc('invites/' + id).delete()).catch(fail); toast('Account deleted'); break; }
    case 'acDel': { if (!await confirmBox('Remove this role?', 'The person keeps access to the page but can no longer use the app until given a role again.', 'Remove role', true)) break; const u = Object.assign({}, S.access); delete u[id]; S.access = u; recompute(true); await setDoc('access/roles', { u }).catch(fail); break; }
    case 'acAdd': { const r = ($('#hitRole-' + id) || {}).value; if (!r) { toast('Choose a role first', true); break; } await setAccess(id, { role: r }); toast('Role given'); $('#acHits').innerHTML = ''; $('#acSearch').value = ''; break; }
  }
});
document.addEventListener('change', async e => {
  const t = e.target; const act = t.dataset && t.dataset.act; const id = t.dataset && t.dataset.id, v = t.dataset && t.dataset.v;
  if (t.id === 'viewAs') { S.viewAs = t.value || null; S.viewAsStaff = null; if (S.viewAs && ['counselor', 'ac', 'coordinator'].includes(S.viewAs)) { const s = S.staffList.find(x => x.role === S.viewAs && (S.viewAs !== 'counselor' || Object.values(S.org.groups).some(g => g.counselorId === x.id)) && (S.viewAs !== 'ac' || Object.values(S.org.companies).some(c => c.acId === x.id))); S.viewAsStaff = s ? s.id : null; if (s) toast('Previewing as ' + s.name); } UI.frameKey = ''; render(); return; }
  if (t.id === 'ciStake') { UI.stake = t.value; UI.unit = ''; UI.limit = 40; t.blur(); render(); return; }
  if (t.id === 'ciUnit') { UI.unit = t.value; UI.limit = 40; t.blur(); render(); return; }
  if (t.id === 'impFile') { if (t.files[0]) readFile(t.files[0]).catch(err => { console.error(err); toast('Could not read that file. Save it as .xlsx or .csv and try again.', true); }); return; }
  if (t.id === 'impMode') { UI.imp.mode = t.value; renderImport(); return; }
  if (!act) return;
  switch (act) {
    case 'moveP': { const g = t.value || null; t.blur(); await setState(id, { g }); toast(g ? 'Moved to G' + S.org.groups[g].num : 'Taken out of group'); break; }
    case 'grpCoun': { const g = S.org.groups[id], c = t.value || null; t.blur(); const patch = { groups: { [id]: { counselorId: c } } }; const other = c && Object.values(S.org.groups).find(x => x.counselorId === c && x.id !== id); if (other) patch.groups[other.id] = { counselorId: g.counselorId || null }; await patchOrg(patch); toast(other ? `Swapped counselors with G${other.num}` : 'Counselor updated'); break; }
    case 'grpCo': { t.blur(); await patchOrg({ groups: { [id]: { companyId: t.value || null } } }); toast('Group moved'); break; }
    case 'coAc': { const c = S.org.companies[id], a = t.value || null; t.blur(); const patch = { companies: { [id]: { acId: a } } }; const other = a && Object.values(S.org.companies).find(x => x.acId === a && x.id !== id); if (other) patch.companies[other.id] = { acId: c.acId || null }; await patchOrg(patch); toast(other ? `Swapped ACs with Company ${other.num}` : 'Assistant coordinator updated'); break; }
    case 'coCoord': { t.blur(); await patchOrg({ companies: { [id]: { coordId: t.value || null } } }); toast('Coordinator updated'); break; }
    case 'stat': { const ex = new Set(S.config.excludedStatuses || []); t.checked ? ex.delete(v) : ex.add(v); await saveConfig({ excludedStatuses: [...ex] }); break; }
    case 'areaS': { const ex = new Set(S.config.excludedStakes || []); t.checked ? ex.delete(v) : ex.add(v); await saveConfig({ excludedStakes: [...ex] }); break; }
    case 'areaU': { const ex = new Set(S.config.excludedUnits || []); t.checked ? ex.delete(v) : ex.add(v); await saveConfig({ excludedUnits: [...ex] }); break; }
    case 'impMap': { const i = +v; if (t.value) { for (const k in UI.imp.map) if (UI.imp.map[k] === t.value) delete UI.imp.map[k]; UI.imp.map[i] = t.value; } else delete UI.imp.map[i]; renderImport(); break; }
    case 'stRole': { t.blur(); await saveStaffRec(Object.assign({}, S.staffMap[id], { role: t.value })); toast('Role changed'); break; }
    case 'reqRole': { if (!t.value) break; const rq = S.requests[id] || {}; if (!rq.email) { toast('This request has no email.', true); break; } await setDoc('invites/' + emailKey(rq.email), { name: rq.name || rq.email, role: t.value, staffId: null, at: Date.now() }).catch(fail); await serial('requests/' + id, () => S.db.doc('requests/' + id).delete()).catch(() => { }); toast('Access given'); break; }
    case 'acRole': { if (!t.value) break; await setAccess(id, { role: t.value }); toast('Role changed'); break; }
    case 'invRole': { await upd('invites/' + id, { role: t.value }, true).catch(fail); toast('Role changed'); break; }
    case 'invStaff': { await upd('invites/' + id, { staffId: t.value || null }, true).catch(fail); toast('Staff record linked'); break; }
    case 'acStaff': { await setAccess(id, { staffId: t.value || null }); toast('Linked'); break; }
  }
});
document.addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target; const val = id => ($('#' + id) || {}).value || '';
  if (f.id === 'wkForm') {
    const first = titleCase(val('wkFirst')), last = titleCase(val('wkLast')); const gender = val('wkGender');
    if (!first || !gender) { toast('Name and gender are needed', true); return; }
    const id = rid('W'); const b = bucketOf(id); const age = parseInt(val('wkAge'), 10);
    const rec = { first, last, pref: '', bday: val('wkBday'), gender, phone: val('wkPhone'), email: '', tshirt: val('wkSize'), c1n: val('wkC1'), c1e: '', c1p: val('wkC1p'), c2n: '', c2e: '', c2p: '', ageCsv: isNaN(age) ? null : age, regDate: new Date().toISOString(), status: 'WALK_IN', stake: clean(val('wkStake')), unit: clean(val('wkUnit')), bishopE: '', bishopN: '', src: 'walkin', imp: Date.now(), addedBy: S.uid };
    S.roster = Object.assign({}, S.roster, { [b]: Object.assign({}, S.roster[b] || {}, { [id]: rec }) });
    const ex = S.rosterEx.has(b); S.rosterEx.add(b);
    const md = { med: val('wkMed'), diet: val('wkDiet') };
    try { await upd('roster/' + b, { p: { [id]: rec } }, ex);
      if (md.med || md.diet) { if (S.medAdmin) { const mx = S.medicalEx.has(b); S.medicalEx.add(b); await upd('medical/' + b, { p: { [id]: md } }, mx); } else { const ix = !!S.intakeEx; S.intakeEx = true; await upd('intake/' + S.uid, { p: { [id]: md } }, ix); } }
      if ($('#wkIn').checked) await setState(id, { s: 'in', ti: Date.now(), by: S.uid }); else recompute(true); f.reset(); toast(first + ' added as a walk-in'); } catch (err) { fail(err); }
  }
  if (f.id === 'stForm') {
    const name = titleCase(val('stName')), gender = val('stGender'); if (!name || !gender) { toast('Name and gender are needed', true); return; }
    const age = parseInt(val('stAge'), 10);
    await saveStaffRec({ id: rid('S'), name, gender, ageCsv: isNaN(age) ? null : age, bday: '', role: val('stRole'), phone: val('stPhone'), tshirt: val('stSize'), unit: '', stake: '' });
    UI.staffTab = val('stRole'); f.reset(); toast(name + ' added');
  }
  if (f.id === 'invForm') {
    const name = titleCase(val('invName')), email = clean(val('invEmail')).toLowerCase(), r = val('invRole'), sid = val('invStaff') || null;
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !r) { toast('Enter a name, a valid email and a role', true); return; }
    const h = emailKey(email); if (S.invites[h]) { toast('There is already an account for ' + email, true); return; }
    try { await setDoc('invites/' + h, { name, role: r, staffId: sid, at: Date.now() }); f.reset(); toast('Account created for ' + name); } catch (err) { fail(err); }
  }
  if (f.id === 'cfgForm') { await saveConfig({ sessionName: clean(val('cfName')) || 'FSY Kenya 2nd 2026', sessionStart: val('cfStart'), groupSize: Math.max(4, Math.min(20, parseInt(val('cfSize'), 10) || 10)) }); toast('Settings saved'); }
  if (f.id === 'edForm') {
    const id = f.dataset.id, b = bucketOf(id); const age = parseInt(val('edAge'), 10);
    const patch = { first: titleCase(val('edFirst')), last: titleCase(val('edLast')), gender: val('edGender'), bday: val('edBday'), ageCsv: isNaN(age) ? null : age, tshirt: val('edSize'), stake: clean(val('edStake')), unit: clean(val('edUnit')) }; const md = { med: val('edMed'), diet: val('edDiet') };
    S.roster = Object.assign({}, S.roster, { [b]: Object.assign({}, S.roster[b], { [id]: Object.assign({}, S.roster[b][id], patch) }) }); recompute(true);
    S.medical = Object.assign({}, S.medical, { [b]: Object.assign({}, S.medical[b] || {}, { [id]: md }) });
    await upd('roster/' + b, { p: { [id]: patch } }, true).catch(fail); const mx = S.medicalEx.has(b); S.medicalEx.add(b); await upd('medical/' + b, { p: { [id]: md } }, mx).catch(fail); toast('Saved'); openDetail(id);
  }
});
let qT = null;
function pinSearch() { const a = $('#ciAnchor'); if (!a) return; const stick = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stick')) || 0; const y = a.getBoundingClientRect().top + window.scrollY - stick; if (Math.abs(window.scrollY - y) > 4) window.scrollTo({ top: y, behavior: 'smooth' }); }
document.addEventListener('focusin', e => { if (e.target.id === 'ciQ' && window.matchMedia('(max-width: 700px)').matches) setTimeout(pinSearch, 250); });
document.addEventListener('keydown', e => { if (e.target.id === 'ciQ' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
document.addEventListener('input', e => {
  if (e.target.id === 'ciQ') { clearTimeout(qT); qT = setTimeout(() => { UI.q = e.target.value; UI.limit = 40; PAGE_IMPL.checkin.update(); if (window.matchMedia('(max-width: 700px)').matches && document.activeElement === e.target) pinSearch(); }, 120); }
  if (e.target.id === 'acSearch' && S.user) {
    const q = e.target.value;
    S.user.search(q).then(hits => { const box = $('#acHits'); if (!box) return; box.innerHTML = hits.filter(h => !h.isMe).map(h => `<div class="inline" style="padding:4px 0"><b style="flex:1">${esc(h.name)}</b>${S.access[h.id] ? `<span class="chip">${esc(ROLES[S.access[h.id].role])}</span>` : `<select id="hitRole-${esc(h.id)}" aria-label="Role">${opt('', 'Role…')}${Object.keys(ROLES).filter(r => r !== 'regadmin' || realRole() === 'regadmin').map(r => opt(r, ROLES[r])).join('')}</select><button class="btn small primary" data-act="acAdd" data-id="${esc(h.id)}">Add</button>`}</div>`).join('') || (q ? '<p class="note">No one found. People outside your workspace must open the page and send a request.</p>' : ''); });
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#mbg')) closeModal(); if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.act === 'toggleGrp') { e.preventDefault(); e.target.click(); } });


boot();
