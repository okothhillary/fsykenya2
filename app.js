const FB = { app: null, auth: null, fs: null, user: null };
function appConfig() { try { return FIREBASE_CONFIG; } catch (e) { try { return firebaseConfig; } catch (e2) { return null; } } }
function ownerEmails() { try { return OWNER_EMAILS; } catch (e) { return []; } }
/* Each session keeps its own participants, check-ins, groups, staff, headcounts and medical notes.
   The first session ("main") lives at the top level; sessions made by splitting live under sessions/<id>/.
   Accounts, profiles, requests and the session list are shared by all sessions. */
const SCOPED = new Set(['roster', 'state', 'staff', 'org', 'config', 'headcount', 'medical', 'share', 'intake', 'reports', 'audit']);
function rawPath(sid, p) { return !sid || sid === 'main' ? p : `sessions/${sid}/${p}`; }
function scoped(p) { return SCOPED.has(String(p).split('/')[0]) ? rawPath(S.sid, p) : p; }
function fbErr(cb) { return e => { console.error(e); if (cb) cb({ code: e && e.code === 'permission-denied' ? 'invalid_argument' : 'unavailable', message: String(e && e.message) }); }; }
function fbSnap(s) { return { id: s.id, exists: s.exists, data: () => (s.exists ? s.data() : undefined), metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } }; }
function wrapWrite(p) { return p.catch(e => { throw { code: e && e.code === 'permission-denied' ? 'invalid_argument' : (e && e.code === 'resource-exhausted' ? 'quota_exceeded' : 'unavailable'), message: String(e && e.message) }; }); }
function shimDoc(path) {
  const r = FB.fs.doc(scoped(path));
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
  const r = FB.fs.collection(scoped(path));
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

/* Core logic */
/* FSY Check-in core logic (pure functions, no DOM) */
const NBUCKETS = 32;
const APP_VERSION = '2026-11-17h · see newest staff';
const BANDS = { Y: '13–15', O: '16–18' };
const GENDERS = { F: 'Female', M: 'Male' };
const ROLES = {
  regadmin: 'Registration admin', sdc: 'Session Directing Couple', seventy: 'Area Seventy', loghead: 'Head of Logistics', coordinator: 'Coordinator',
  ac: 'Assistant coordinator', counselor: 'Counselor', logistics: 'Logistics', wellness: 'Wellness coordinator'
};
const STAFF_ROLES = ['counselor', 'ac', 'coordinator', 'sdc', 'logistics', 'wellness'];
const ROLE_PLURAL = { counselor: 'Counselors', ac: 'Assistant coordinators', coordinator: 'Coordinators', sdc: 'Session Directing Couple', logistics: 'Logistics', wellness: 'Wellness coordinators' };
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const SIZE_LABEL = { XS: 'Extra small', S: 'Small', M: 'Medium', L: 'Large', XL: 'XL', XXL: 'XXL', '3XL': '3XL', '': 'Not given' };
const DEFAULT_CONFIG = { sessionName: 'FSY Kenya 2nd 2026', sessionStart: '', hcStart: '2026-12-07', hcEnd: '2026-12-11', groupSize: 10, excludedStakes: [], excludedUnits: [], excludedStatuses: ['CANCELLED'] };

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
  if (/WELL|HEALTH|NURSE|MEDIC|FIRST ?AID/.test(t)) return 'wellness';
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

/* Column mapping */
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

/* Medical & dietary cleanup */
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

/* Staff sign-up forms (Google Forms and similar).
   Different from the portal export: one name column, day/month/year birthdays, free-typed ward or
   branch, people who submitted more than once. Everything here is pure so it can be tested alone. */

// Units that are not in the participant export. Staff can come from stakes that send no youth.
const BUILTIN_UNITS = [
  ['Nairobi Kenya South Stake', 'Nairobi 2nd Ward (Buruburu)', ['buruburu', 'buru buru']],
  ['Nairobi Kenya South Stake', 'Nairobi 1st Ward', []],
  ['Nairobi Kenya South Stake', 'South B Ward', ['southb']]
];
const SF_FIELDS = [
  ['ts', /timestamp|submitted|submission/],
  ['email', /e-?mail/],
  ['bday', /birth|\bdob\b/],
  ['phone', /phone|mobile|tel(e|\b)|contact/],
  ['stake', /stake|district/],
  ['unit', /ward|branch|unit|congregation/],
  ['tshirt', /shirt|size/],
  ['gender', /gender|\bsex\b/],
  ['diet', /food|allerg|diet/],
  ['med', /medic|health/],
  ['role', /\brole\b|\btype\b|position|calling|assignment|category/],
  ['name', /name/]
];
function sfMap(headers) {
  const map = {}, used = new Set();
  headers.forEach((h, i) => { const n = clean(h).toLowerCase(); for (const [k, re] of SF_FIELDS) if (!used.has(k) && re.test(n)) { map[i] = k; used.add(k); return; } });
  return map;
}
function sfName(s) {
  s = clean(s).replace(/([A-Za-z]{2,})\.(?=\s|[A-Za-z])/g, '$1 ').replace(/\b([A-Za-z])\.\s*/g, '$1. ').replace(/\s+/g, ' ').trim().replace(/[.,]+$/, '');
  const c = s.match(/^([^,]+),\s*(.+)$/); // "Kadenge, Sammy Kadenge"
  if (c) s = c[2].toLowerCase().includes(c[1].toLowerCase().trim()) ? c[2] : c[2] + ' ' + c[1];
  return s.split(' ').filter(Boolean).map(w => (w === w.toUpperCase() || w === w.toLowerCase()) && w.length > 1 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1)).join(' ');
}
function nameTokens(s) { return uniq(String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(t => t.length >= 2)).sort(); }
function sfPhone(s) {
  const first = clean(s).split(/[\/,;]|\bor\b/)[0]; let d = first.replace(/\D/g, '').replace(/^0+(?=254)/, '');
  if (/^254\d{9}$/.test(d)) d = '0' + d.slice(3);
  if (/^[17]\d{8}$/.test(d)) d = '0' + d;
  return d;
}
function sfEmail(s) {
  let e = clean(s).toLowerCase().replace(/\s/g, '');
  const parts = e.split('@'); if (parts.length > 2) e = parts[0] + '@' + parts[1];
  return e;
}
const okEmail = e => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e);
const okPhone = p => /^0[17]\d{8}$/.test(p);
function sfStamp(s) { // "12/11/2026 12:59:33" -> sortable number
  const m = clean(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const d = Date.parse(s); return isNaN(d) ? 0 : d;
}
const DIET_NONE = /^(no+|non|none|nil+|nll|nul+|null|n ?\/? ?[al]|not ?applicable|nothing|no ?one|no ?body|0|-+|x|no ?thing)$/;
function sfDiet(raw) {
  let s = clean(raw).toLowerCase().replace(/[’']/g, '').replace(/[.,;!]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/\b(i (dont|do not|dnt) have any|i have no|i am not allergic to any|im not allergic to any|not allergic to any|no any|no known|no)\s+(food\s+)?(allergies|allergy|alleries|allergic|alergies|alergy|allegies|food)\b( \w+)?/g, ' ')
    .replace(/\b(none|nil+|n\/a|not applicable)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || DIET_NONE.test(s)) return '';
  return clean(raw).replace(/[.,\s]+$/, '');
}
function sfRow(o, refDate) {
  const issues = [];
  const name = sfName(o.name);
  let bday = parseDate(o.bday);
  const rawY = (clean(o.bday).match(/(\d+)\s*$/) || [])[1] || '';
  if (bday && rawY && !/^(19|20)\d\d$/.test(rawY)) issues.push(`Birth year written as "${rawY}", read as ${bday.slice(0, 4)}`);
  const age = bday ? ageOn(bday, refDate) : null;
  if (o.bday && (!bday || age == null || age < 16 || age > 80)) { issues.push(`Birthday "${clean(o.bday)}" is not possible`); bday = ''; }
  else if (!o.bday) issues.push('No birthday');
  const gRaw = clean(o.gender); const gender = normGender(gRaw);
  if (!gender) issues.push(gRaw ? `Gender "${gRaw}" is unclear` : 'No gender');
  const email = sfEmail(o.email); if (email && !okEmail(email)) issues.push(`Email "${email}" looks wrong`);
  const phone = sfPhone(o.phone); if (o.phone && !okPhone(phone)) issues.push(`Phone "${clean(o.phone)}" looks wrong`);
  return {
    name, toks: nameTokens(name), bday, gender, email: okEmail(email) ? email : '', emailRaw: email, phone, phoneOk: okPhone(phone),
    unitRaw: clean(o.unit), stakeRaw: clean(o.stake), tshirt: normSize(o.tshirt), diet: sfDiet(o.diet), dietRaw: clean(o.diet),
    med: clean(o.med), role: normType(o.role), ts: sfStamp(o.ts), issues
  };
}
/** Same person? Shared contact details only count when the names also overlap, because
    families sometimes share one phone. */
function samePerson(a, b) {
  const shared = a.toks.filter(t => b.toks.includes(t)).length;
  if (!shared) return false;
  if (a.email && a.email === b.email) return true;
  if (a.phoneOk && a.phone === b.phone) return true;
  const small = Math.min(a.toks.length, b.toks.length);
  const nameSame = shared === small && shared >= 2;
  if (nameSame && (a.bday && a.bday === b.bday)) return true;
  const uc = x => x.uc != null ? x.uc : (x.uc = unitCore(x.unitRaw).core);
  if (nameSame && a.toks.length === b.toks.length && uc(a) && uc(a) === uc(b)) return true;
  return false;
}
/** Merge several submissions from one person: newest valid answer wins; food notes are all kept. */
function mergeSubs(list) {
  list = list.slice().sort((a, b) => a.ts - b.ts || a.row - b.row);
  const latest = k => { for (let i = list.length - 1; i >= 0; i--) if (list[i][k]) return list[i][k]; return ''; };
  const m = Object.assign({}, list[list.length - 1]);
  for (const k of ['bday', 'gender', 'email', 'tshirt', 'unitRaw', 'stakeRaw', 'med', 'role']) m[k] = latest(k);
  const ph = list.filter(x => x.phoneOk); m.phone = ph.length ? ph[ph.length - 1].phone : m.phone; m.phoneOk = !!ph.length;
  m.name = list.map(x => x.name).reduce((best, n) => nameTokens(n).length > nameTokens(best).length ? n : best, m.name);
  m.toks = nameTokens(m.name);
  const diets = uniq(list.map(x => x.diet).filter(Boolean)); m.diet = diets.join(' / ');
  // problems that the merged answer still has
  const lastIssue = re => { for (let i = list.length - 1; i >= 0; i--) { const t = list[i].issues.find(x => re.test(x)); if (t) return t; } return null; };
  m.issues = [];
  if (m.bday) { const src = list.slice().reverse().find(x => x.bday === m.bday); (src ? src.issues.filter(t => /^Birth year/.test(t)) : []).forEach(t => m.issues.push(t)); }
  else m.issues.push(lastIssue(/^Birthday|^No birthday/) || 'No birthday');
  if (!m.gender) m.issues.push(lastIssue(/Gender|No gender/) || 'No gender');
  if (!m.email) { const t = lastIssue(/^Email/); if (t) m.issues.push(t); }
  if (!m.phoneOk) { const t = lastIssue(/^Phone/); if (t) m.issues.push(t); }
  if (list.length > 1) {
    const diff = ['tshirt', 'unitRaw', 'bday', 'role'].filter(k => uniq(list.map(x => k === 'unitRaw' ? unitCore(x[k]).core : x[k]).filter(Boolean)).length > 1);
    m.dupNote = `${list.length} submissions` + (diff.length ? ` (answers differed: ${diff.map(k => ({ tshirt: 'T-shirt', unitRaw: 'ward/branch', bday: 'birthday', role: 'type' })[k]).join(', ')}; newest kept)` : '');
    if (diff.includes('role')) m.issues.push(`Type differs between submissions: ${list.map(x => x.role ? ROLES[x.role] : '(blank)').join(' → ')}. Imported as ${ROLES[m.role] || 'Counselor'}`);
    if (diets.length > 1 || (diets.length && list.some(x => !x.diet && x.dietRaw))) m.issues.push('Food answers differ between submissions: ' + list.map(x => x.dietRaw || '(blank)').join(' → '));
  }
  m.subs = list.length;
  return m;
}
function dedupeSubs(rows) {
  const parent = rows.map((_, i) => i); const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) if (samePerson(rows[i], rows[j])) parent[find(j)] = find(i);
  const g = {}; rows.forEach((r, i) => (g[find(i)] = g[find(i)] || []).push(r));
  return Object.values(g).map(mergeSubs);
}

/* Matching typed ward/branch names to the real unit and its stake or district */
const UNIT_STOP = new Set(['ward', 'wards', 'branch', 'branches', 'br', 'brnch', 'church', 'lds', 'the', 'unit', 'congregation', 'of', 'in', 'kenya']);
function unitCore(s) {
  s = String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`]/g, '');
  const hint = ((s.match(/\(([^)]*)\)/) || [])[1] || '').replace(/[^a-z0-9 ]/g, ' ').trim();
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\bmt\b\.?|\bmt\./g, 'mountain ').replace(/\bmtn\b/g, 'mountain');
  s = s.replace(/[^a-z0-9]+/g, ' ').replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2');
  const ORD = { first: '1', '1st': '1', one: '1', second: '2', '2nd': '2', two: '2', third: '3', '3rd': '3', three: '3' };
  let t = s.split(' ').filter(Boolean);
  // "1 st" / "2 nd" after splitting digits from letters
  t = t.reduce((a, w) => { if (/^(st|nd|rd|th)$/.test(w) && /^\d+$/.test(a[a.length - 1] || '')) return a; a.push(ORD[w] || w); return a; }, []);
  t = t.filter(w => !UNIT_STOP.has(w) && !(w.length >= 3 && /^[a-z]+$/.test(w) && (editDist(w, 'ward') <= 1 || editDist(w, 'branch') <= 1)));
  return { core: t.join(' '), toks: t, hint };
}
function editDist(a, b) { // Damerau (optimal string alignment)
  const d = []; for (let i = 0; i <= a.length; i++) { d[i] = [i]; } for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
/** entries: [[stake, unit]], aliases: {core: 'stake|unit'} */
function unitDirectory(entries, aliases) {
  const seen = {}, list = [];
  const add = (stake, unit) => { stake = clean(stake); unit = clean(unit); if (!stake || !unit) return; const k = stake + '|' + unit; if (seen[k]) return; seen[k] = 1; const c = unitCore(unit); list.push({ stake, unit, key: k, core: c.core, toks: c.toks, stakeToks: unitCore(stake).toks }); };
  entries.forEach(([s, u]) => add(s, u));
  const al = {};
  BUILTIN_UNITS.forEach(([s, u, extra]) => { add(s, u); extra.forEach(x => al[unitCore(x).core] = s + '|' + u); });
  Object.assign(al, aliases || {});
  for (const k in al) { const [s, u] = al[k].split('|'); add(s, u); }
  const vocab = new Set(list.flatMap(e => e.toks));
  const byKey = {}; list.forEach(e => byKey[e.key] = e);
  return { list, vocab, aliases: al, byKey };
}
/** -> { status: 'ok'|'fixed'|'choose'|'unknown', stake, unit, options:[key], why } */
function matchUnit(raw, stakeRaw, dir) {
  const c = unitCore(raw); if (!c.core) return { status: 'unknown', stake: '', unit: '', options: [], why: 'No ward or branch given' };
  const fromKey = (k, status, why) => { const e = dir.byKey[k]; return { status, stake: e.stake, unit: e.unit, options: [k], why }; };
  if (dir.aliases[c.core] && dir.byKey[dir.aliases[c.core]]) return fromKey(dir.aliases[c.core], 'ok', 'Saved match');
  let fixed = false;
  const toks = c.toks.map(t => {
    if (dir.vocab.has(t) || /\d/.test(t) || t.length < 4) return t;
    let best = null, bd = 99, tie = false;
    for (const v of dir.vocab) { if (/\d/.test(v)) continue; const d = editDist(t, v); if (d < bd) { bd = d; best = v; tie = false; } else if (d === bd) tie = true; }
    if (best && !tie && bd <= (t.length >= 7 ? 2 : 1)) { fixed = true; return best; }
    return t;
  });
  const core = toks.join(' '), nums = toks.filter(t => /^\d+$/.test(t));
  if (dir.aliases[core] && dir.byKey[dir.aliases[core]]) return fromKey(dir.aliases[core], fixed ? 'fixed' : 'ok', 'Saved match');
  let cands = dir.list.filter(e => e.core === core);
  let how = 'exact';
  if (!cands.length) {
    cands = dir.list.filter(e => toks.every(t => e.toks.includes(t)) && e.toks.filter(t => /^\d+$/.test(t)).every(n => !nums.length || nums.includes(n)));
    how = 'part';
  }
  if (!cands.length && toks.length > 1) { // e.g. "Nyalenda branch Kisumu": drop words that only name a stake or town
    const stakeWords = new Set(dir.list.flatMap(e => e.stakeToks)); const keep = toks.filter(t => !stakeWords.has(t) || dir.list.some(e => e.toks.includes(t)));
    if (keep.length && keep.length < toks.length) { cands = dir.list.filter(e => e.core === keep.join(' ') || keep.every(t => e.toks.includes(t))); how = 'part'; c.hint = (c.hint + ' ' + toks.filter(t => !keep.includes(t)).join(' ')).trim(); }
  }
  const hint = unitCore(c.hint + ' ' + (stakeRaw || '')).toks.filter(t => !/^(stake|district|mission)$/.test(t));
  if (cands.length > 1 && hint.length) { const h = cands.filter(e => hint.some(t => e.stakeToks.includes(t))); if (h.length) cands = h; }
  if (cands.length === 1) {
    const e = cands[0];
    const why = fixed ? `Spelling read as "${e.unit}"` : how === 'part' ? `Read as "${e.unit}"` : 'Matched';
    return { status: fixed || how === 'part' ? 'fixed' : 'ok', stake: e.stake, unit: e.unit, options: [e.key], why };
  }
  if (cands.length > 1) {
    const stakes = uniq(cands.map(e => e.stake));
    return { status: 'choose', stake: stakes.length === 1 ? stakes[0] : '', unit: '', options: cands.map(e => e.key), why: `Could be ${cands.map(e => e.unit).join(' or ')}` };
  }
  return { status: 'unknown', stake: '', unit: '', options: [], why: 'Not found in the participant list' };
}

/** Full pipeline. rows: arrays with header first. existing: current staff records. */
function staffIntake(rows, opts) {
  opts = opts || {};
  const map = opts.map || sfMap(rows[0] || []);
  const subs = []; let blank = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; if (!row || row.every(c => clean(c) === '')) { blank++; continue; }
    const o = {}; for (const i in map) o[map[i]] = row[i];
    if (!clean(o.name)) { blank++; continue; }
    const x = sfRow(o, opts.refDate || ''); x.row = r; subs.push(x);
  }
  const people = dedupeSubs(subs).sort((a, b) => a.name.localeCompare(b.name));
  const dir = unitDirectory(opts.units || [], opts.aliases || {});
  const units = {};
  people.forEach(p => {
    const k = unitCore(p.unitRaw).core + '|' + unitCore(p.stakeRaw).core;
    const u = units[k] = units[k] || Object.assign({ k, raw: [], n: 0 }, matchUnit(p.unitRaw, p.stakeRaw, dir));
    u.n++; if (!u.raw.includes(p.unitRaw)) u.raw.push(p.unitRaw); p.uk = k;
  });
  return { map, subs: subs.length, blank, people, units, dir };
}
/** Apply the unit choices and the role, and match each person to an existing staff record. */
function intakeRecords(res, choices, role, existing) {
  const out = [];
  const ex = (existing || []).map(s => Object.assign({ toks: nameTokens(s.name), phoneOk: okPhone(s.phone || ''), unitRaw: s.unitRaw || s.unit || '' }, s));
  for (const p of res.people) {
    const u = res.units[p.uk]; const ch = choices[p.uk];
    let stake = u.stake, unit = u.unit;
    if (ch) { const i = ch.indexOf('|'); stake = ch.slice(0, i); unit = ch.slice(i + 1); }
    else if (!unit) unit = titleCase(p.unitRaw);
    const r = role === 'column' ? (p.role && STAFF_ROLES.includes(p.role) ? p.role : 'counselor') : role;
    const old = ex.find(s => samePerson(s, p));
    out.push(Object.assign({}, old ? Object.assign({}, old) : {}, {
      id: old ? old.id : 'S' + fnv((p.email || p.toks.join(' ') + p.bday)).toString(36),
      name: p.name, gender: p.gender || (old && old.gender) || '', bday: p.bday || (old && old.bday) || '', ageCsv: p.bday ? null : (old ? old.ageCsv ?? null : null), role: r,
      addedAt: (old && old.addedAt) || Date.now(), addedBy: (old && old.addedBy) || (typeof S !== 'undefined' && S.meName) || '',
      phone: p.phone || (old && old.phone) || '', email: p.email || (old && old.email) || '', unit, stake, unitRaw: p.unitRaw, tshirt: p.tshirt || (old && old.tshirt) || '', diet: p.diet, med: p.med || '', src: 'form', test: false
    }));
    for (const k of ['toks', 'phoneOk', 'uc', 'isUpdate']) delete out[out.length - 1][k];
    out[out.length - 1].isUpdate = !!old;
  }
  return out;
}


/* Derive the working participant list */
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

/* Company / group generation */
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
function placeGroupInCompany(g, companies, groups, stakeOf) {
  const comps = Object.values(companies).filter(c => c.band === g.band);
  if (!comps.length) return null;
  // fewest groups of the same gender, then fewest groups, then least overlap of districts with this group
  const mine = (stakeOf && stakeOf[g.id]) || {};
  let best = null, bk = null;
  for (const c of shuffled(comps)) {
    const inC = Object.values(groups).filter(x => x.companyId === c.id);
    let overlap = 0; if (stakeOf) inC.forEach(x => { const o = stakeOf[x.id] || {}; for (const st in mine) overlap += mine[st] * (o[st] || 0); });
    const key = [inC.filter(x => x.gender === g.gender).length, inC.length, overlap, c.num || 0];
    if (!bk || key[0] < bk[0] || (key[0] === bk[0] && (key[1] < bk[1] || (key[1] === bk[1] && (key[2] < bk[2] || (key[2] === bk[2] && key[3] < bk[3])))))) { bk = key; best = c; }
  }
  g.companyId = best.id; return best;
}
function bandCap(groups, band) { const gs = Object.values(groups).filter(g => g.band === band); const f = gs.filter(g => g.gender === 'F').length, m = gs.filter(g => g.gender === 'M').length; return gs.length ? Math.max(1, Math.min(f, m)) : 0; }
/* Coordinators oversee every company, so companies carry no coordinator of their own. */
function assignCoordinators(companies) { Object.values(companies).forEach(c => { c.coordId = null; }); }
function renumber(groups, companies) {
  const comps = Object.values(companies).sort((a, b) => (a.band > b.band ? -1 : a.band < b.band ? 1 : 0) || (a.num || 9999) - (b.num || 9999));
  comps.forEach((c, i) => c.num = i + 1);
  const order = {}; comps.forEach(c => order[c.id] = c.num);
  const gs = Object.values(groups).sort((a, b) => (order[a.companyId] || 9999) - (order[b.companyId] || 9999) || (a.gender === b.gender ? 0 : a.gender > b.gender ? 1 : -1) || (a.num || 9999) - (b.num || 9999));
  gs.forEach((g, i) => g.num = i + 1);
}
/** The same person entered twice (same email, or the same full name) with a leadership role on one record and
    "counselor" on the other: the counselor record must not lead a group. Returns {counselorId: other record}. */
const LEAD_ROLES = ['ac', 'coordinator', 'sdc'];
function shadowedCounselors(staffList) {
  const out = {}; const lead = staffList.filter(s => LEAD_ROLES.includes(s.role) && !s.test);
  const key = s => String(s.name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');
  const em = s => String(s.email || '').toLowerCase();
  for (const c of staffList) {
    if (c.role !== 'counselor') continue;
    // same email, or the same full name when the emails do not say they are different people
    const o = lead.find(l => l.id !== c.id && ((em(c) && em(c) === em(l)) || (key(c).split(' ').length >= 2 && key(c) === key(l) && !(em(c) && em(l) && em(c) !== em(l)))));
    if (o) out[c.id] = o;
  }
  return out;
}
/** Participants per group, which can differ for young women and young men (e.g. more men counselors than needed). */
function gsize(cfg, gender) { const g = gender === 'F' ? cfg && cfg.groupSizeF : gender === 'M' ? cfg && cfg.groupSizeM : null; return +g || +(cfg && cfg.groupSize) || 10; }
/** For each gender: how many youth per counselor would give every usable counselor a group. */
function fitSizes() {
  const sh = shadowedCounselors(S.staffList), out = {};
  for (const g of ['F', 'M']) { const y = S.P.filter(p => p.elig && p.gender === g).length, c = S.staffList.filter(x => x.role === 'counselor' && x.gender === g && !x.test && !sh[x.id]).length; const now = gsize(S.config, g), f = c ? Math.max(6, Math.ceil(y / c)) : null; out[g] = { y, c, fit: f && f < now ? f : null, now, short: !!(c && Math.ceil(y / c) > now) }; }
  return out;
}
function fitHint() {
  if (!S.P.length) return '';
  const f = fitSizes(), line = (g, l) => { const x = f[g]; if (!x.c) return `<li><b>${l}:</b> ${x.y} youth, no counselors yet</li>`; const per = x.y / x.c; return `<li><b>${l}:</b> ${x.y} youth ÷ ${x.c} counselors = about <b>${per.toFixed(1)}</b> each. ${x.fit ? `More counselors than groups of ${x.now} need: a size of <b>${x.fit}</b> gives every counselor a group.` : x.short ? `Not enough counselors for groups of ${x.now}: groups stay bigger until more join (keep the size at ${x.now}).` : 'The current size fits.'}</li>`; };
  const differ = ['F', 'M'].some(g => f[g].fit);
  return `<div class="fit-hint"><p class="note" style="margin:0 0 4px"><b>Fit group sizes to your counselors</b></p><ul>${line('F', 'Young women')}${line('M', 'Young men')}</ul>${differ && can.orgEdit() ? `<button type="button" class="btn small" data-act="fitSizes">Use ${f.F.fit || f.F.now} for young women and ${f.M.fit || f.M.now} for young men</button> <small class="muted">then press Rebalance</small>` : ''}</div>`;
}
/* Mixing districts: hand people out so each group gets as few from the same district (and ward or branch) as possible.
   The biggest districts go first, in a random order, so every run is a fresh shuffle. */
function shuffled(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function mixAssign(list, ids, assign) {
  const G = ids.length; if (!G) return; const cap = Math.ceil(list.length / G);
  const cnt = ids.map(() => ({ n: 0, st: {}, un: {} }));
  const by = {}; list.forEach(p => (by[p.stake || ''] = by[p.stake || ''] || []).push(p));
  const order = shuffled(Object.values(by)).sort((a, b) => b.length - a.length).flatMap(arr => shuffled(arr));
  for (const p of order) {
    let best = -1, bk = null;
    for (const i of shuffled(ids.map((_, k) => k))) {
      const c = cnt[i]; if (c.n >= cap) continue;
      const key = [c.st[p.stake || ''] || 0, c.un[p.unitKey] || 0, c.n];
      if (!bk || key[0] < bk[0] || (key[0] === bk[0] && (key[1] < bk[1] || (key[1] === bk[1] && key[2] < bk[2])))) { bk = key; best = i; }
    }
    const c = cnt[best]; c.n++; c.st[p.stake || ''] = (c.st[p.stake || ''] || 0) + 1; c.un[p.unitKey] = (c.un[p.unitKey] || 0) + 1; assign[p.id] = ids[best];
  }
}
/** Who to move from one group to another: the person whose district (then ward or branch) the receiving group has least of. */
function pickMover(from, to) {
  const st = {}, un = {}; to.forEach(x => { st[x.stake] = (st[x.stake] || 0) + 1; un[x.unitKey] = (un[x.unitKey] || 0) + 1; });
  let best = null, bk = null; for (const p of shuffled(from)) { const k = [st[p.stake] || 0, un[p.unitKey] || 0]; if (!bk || k[0] < bk[0] || (k[0] === bk[0] && k[1] < bk[1])) { bk = k; best = p; } }
  return best;
}
function fullGenerate(P, staffList, cfg) {
  cfg = Object.assign({}, DEFAULT_CONFIG, cfg || {});
  const size = +cfg.groupSize || 10;
  const groups = {}, companies = {}, assign = {}, log = [];
  const elig = P.filter(p => p.elig);
  const shadow = shadowedCounselors(staffList); const counselors = staffList.filter(s => s.role === 'counselor' && s.gender && !shadow[s.id]);
  // Every participant goes to a counselor. With enough counselors groups are the set size; with too few,
  // there is one group per counselor and groups run larger until more counselors are added (then Rebalance).
  for (const gender of ['F', 'M']) {
    const lists = { Y: elig.filter(p => p.band === 'Y' && p.gender === gender).sort(sortForDeal), O: elig.filter(p => p.band === 'O' && p.gender === gender).sort(sortForDeal) };
    const size = gsize(cfg, gender); const ideal = { Y: Math.ceil(lists.Y.length / size), O: Math.ceil(lists.O.length / size) };
    const C = counselors.filter(c => c.gender === gender);
    let n = { Y: ideal.Y, O: ideal.O }, short = false;
    if (C.length && C.length < ideal.Y + ideal.O) {
      short = true; const tot = lists.Y.length + lists.O.length;
      if (!ideal.Y) n = { Y: 0, O: C.length }; else if (!ideal.O) n = { Y: C.length, O: 0 };
      else if (C.length === 1) n = lists.Y.length >= lists.O.length ? { Y: 1, O: ideal.O } : { Y: ideal.Y, O: 1 };
      else { const y = Math.min(Math.max(Math.round(C.length * lists.Y.length / tot), 1), C.length - 1); n = { Y: Math.min(y, ideal.Y), O: Math.min(C.length - y, ideal.O) }; if (n.Y + n.O < C.length) { const left = C.length - n.Y - n.O; if (n.Y < ideal.Y) n.Y = Math.min(ideal.Y, n.Y + left); else n.O = Math.min(ideal.O, n.O + left); } }
    }
    for (const band of ['Y', 'O']) {
      const list = lists[band], G = n[band]; if (!list.length || !G) continue; const ids = [];
      for (let i = 0; i < G; i++) { const id = rid('g'); groups[id] = { id, band, gender, counselorId: null, companyId: null, num: 0 }; ids.push(id); }
      mixAssign(list, ids, assign);
      const big = Math.ceil(list.length / G);
      log.push(`${BANDS[band]} ${gender === 'F' ? 'young women' : 'young men'}: ${list.length} participants in ${G} groups${big > size ? ` of up to ${big}` : ''}`);
    }
    if (short) log.push(`Only ${C.length} ${gender === 'F' ? 'women' : 'men'} counselors for ${ideal.Y + ideal.O} groups of ${size}: groups are larger for now. Add counselors and press Rebalance to split them.`);
    else if (!C.length && (lists.Y.length || lists.O.length)) log.push(`No ${gender === 'F' ? 'women' : 'men'} counselors yet: their groups have no counselor`);
  }
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
  const stakeOf = {}; elig.forEach(p => { const gid = assign[p.id]; if (gid) { const o = stakeOf[gid] = stakeOf[gid] || {}; o[p.stake || ''] = (o[p.stake || ''] || 0) + 1; } });
  for (const g of order) placeGroupInCompany(g, companies, groups, stakeOf);
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
    const sh = g.counselorId && shadowedCounselors(staffList)[g.counselorId];
    if (g.counselorId && (!c || c.role !== 'counselor')) { log.push(c ? `${c.name} is now ${ROLES[c.role] ? (/^[aeiou]/i.test(ROLES[c.role]) ? 'an ' : 'a ') + ROLES[c.role].toLowerCase() : 'not a counselor'}, so group ${g.num} needs a new counselor` : `Group ${g.num} lost its counselor`); g.counselorId = null; }
    else if (sh) { log.push(`${c.name} is also listed as ${ROLES[sh.role].toLowerCase()}, so they were taken off group ${g.num}`); g.counselorId = null; }
    else if (c && c.gender && c.gender !== g.gender) { log.push(`${c.name} no longer matches the gender of group ${g.num}, so they were taken off it and will get a ${c.gender === 'F' ? 'young women' : 'young men'}'s group if one is needed`); g.counselorId = null; }
  }
  // empty groups
  for (const g of Object.values(groups)) if (!members[g.id].length) { log.push(`Group ${g.num} was empty and was removed`); delete groups[g.id]; delete members[g.id]; }
  const used = new Set(Object.values(groups).map(g => g.counselorId).filter(Boolean));
  const shadow = shadowedCounselors(staffList); const counselors = staffList.filter(s => s.role === 'counselor' && s.gender && !shadow[s.id]);
  const needy = Object.values(groups).filter(g => !g.counselorId);
  assignCounselors(needy, counselors, used, cfg);
  needy.forEach(g => { if (g.counselorId) log.push(`Group ${g.num} now led by ${staffMap[g.counselorId].name}`); });
  // groups still without a counselor: their youth go to other groups (the same age band, or a new group below)
  for (const g of Object.values(groups)) {
    if (g.counselorId) continue;
    const anyLed = Object.values(groups).some(x => x.counselorId && x.gender === g.gender);
    if (!anyLed) continue; // nobody of this gender can lead yet
    members[g.id].forEach(p => cur[p.id] = null); log.push(`Group ${g.num} had no counselor; its ${members[g.id].length} members were moved to groups that have one`); delete groups[g.id]; delete members[g.id];
  }
  // share counselors between the two age bands of each gender so neither band ends up with much larger groups
  for (const gender of ['F', 'M']) {
    const tot = { Y: P.filter(p => p.elig && p.gender === gender && p.band === 'Y').length, O: P.filter(p => p.elig && p.gender === gender && p.band === 'O').length };
    const led = band => Object.values(groups).filter(g => g.gender === gender && g.band === band && g.counselorId);
    for (let guard = 0; guard < 500; guard++) {
      const n = { Y: led('Y').length, O: led('O').length };
      const load = b => tot[b] ? (n[b] ? tot[b] / n[b] : Infinity) : 0;
      const H = load('Y') >= load('O') ? 'Y' : 'O', L = H === 'Y' ? 'O' : 'Y';
      if (load(H) <= gsize(cfg, gender) || n[L] < 2) break;
      if (Math.max(tot[H] / (n[H] + 1), tot[L] / (n[L] - 1)) >= load(H)) break;
      const d = led(L).sort((a, b) => cPref(staffMap[a.counselorId], H, cfg) - cPref(staffMap[b.counselorId], H, cfg) || members[a.id].length - members[b.id].length)[0];
      members[d.id].forEach(p => cur[p.id] = null);
      const id = rid('g'); groups[id] = { id, band: H, gender, counselorId: d.counselorId, companyId: null, num: 0 }; members[id] = [];
      log.push(`${staffMap[d.counselorId].name} moved from ${BANDS[L]} group ${d.num} to a new ${BANDS[H]} group, which had too few counselors; group ${d.num}'s members joined other ${BANDS[L]} groups`);
      delete groups[d.id]; delete members[d.id];
    }
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
      const n = members[g.id].length, same = members[g.id].filter(m => m.stake === p.stake).length * 100 + members[g.id].filter(m => m.unitKey === p.unitKey).length;
      const key = [n, same];
      if (!bk || key[0] < bk[0] || (key[0] === bk[0] && key[1] < bk[1])) { bk = key; best = g; }
    }
    if (!best || members[best.id].length >= gsize(cfg, p.gender)) {
      const c = counselors.find(c => !used.has(c.id) && c.gender === p.gender && cPref(c, p.band, cfg) === 0) || counselors.find(c => !used.has(c.id) && c.gender === p.gender && cPref(c, p.band, cfg) === 1) || counselors.find(c => !used.has(c.id) && c.gender === p.gender);
      if (c || !best) {
        const id = rid('g'); groups[id] = { id, band: p.band, gender: p.gender, counselorId: c ? c.id : null, companyId: null, num: 0 }; members[id] = [];
        if (c) used.add(c.id); best = groups[id]; created++;
      } else overfull++;
    }
    members[best.id].push(p); cur[p.id] = best.id; placed++;
  }
  if (placed) log.push(`${placed} participant(s) placed into groups`);
  // even out group sizes inside each gender and age band (only where a group is over the size)
  let evened = 0;
  for (const gender of ['F', 'M']) for (const band of ['Y', 'O']) {
    const gs = () => Object.values(groups).filter(g => g.gender === gender && g.band === band && g.counselorId).sort((a, b) => members[b.id].length - members[a.id].length);
    for (let guard = 0; guard < 5000; guard++) {
      const l = gs(); if (l.length < 2) break; const big = l[0], small = l[l.length - 1];
      if (members[big.id].length <= gsize(cfg, gender) || members[big.id].length - members[small.id].length <= 1) break;
      const m = members[big.id]; const pick = pickMover(m, members[small.id]);
      m.splice(m.indexOf(pick), 1); members[small.id].push(pick); cur[pick.id] = small.id; evened++;
    }
  }
  if (evened) log.push(`${evened} participant(s) moved to even out group sizes`);
  if (created) log.push(`${created} new group(s) created`);
  // free counselors open new groups and take people from groups that are over the size
  let opened = 0;
  for (;;) {
    let best = null;
    for (const c of counselors) {
      if (used.has(c.id)) continue;
      for (const band of ['Y', 'O']) {
        const gs = Object.values(groups).filter(g => g.band === band && g.gender === c.gender);
        const over = gs.reduce((a, g) => a + Math.max(0, members[g.id].length - gsize(cfg, c.gender)), 0); if (!over) continue;
        const key = [cPref(c, band, cfg), -over];
        if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { c, band, key };
      }
    }
    if (!best) break;
    const { c, band } = best; const id = rid('g'); groups[id] = { id, band, gender: c.gender, counselorId: c.id, companyId: null, num: 0 }; members[id] = []; used.add(c.id);
    const sibs = () => Object.values(groups).filter(g => g.id !== id && g.band === band && g.gender === c.gender);
    for (;;) {
      const big = sibs().sort((a, b) => members[b.id].length - members[a.id].length)[0];
      if (!big || members[big.id].length <= members[id].length + 1 || members[id].length >= gsize(cfg, c.gender)) break;
      // move someone who is not checked in to a different group yet, preferring the unit least shared with the new group
      const m = members[big.id]; const pick = pickMover(m, members[id]);
      m.splice(m.indexOf(pick), 1); members[id].push(pick); cur[pick.id] = id;
    }
    opened++; log.push(`New ${BANDS[band]} group for ${c.name}: ${members[id].length} participants moved from groups over ${gsize(cfg, c.gender)}`);
  }
  // "fit sizes to counselors": spare counselors still get a group by taking a share from the biggest groups of their gender,
  // as long as groups stay at a sensible size
  if (cfg.useAll) for (let guard = 0; guard < 300; guard++) {
    let best = null;
    for (const c of counselors) { if (used.has(c.id)) continue;
      for (const band of ['Y', 'O']) { const gs = Object.values(groups).filter(g => g.band === band && g.gender === c.gender && g.counselorId); if (!gs.length) continue;
        const tot = gs.reduce((a, g) => a + members[g.id].length, 0), avg = tot / (gs.length + 1); if (avg < 6) continue;
        const key = [cPref(c, band, cfg), -tot / gs.length]; if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { c, band, key }; } }
    if (!best) break;
    const { c, band } = best; const id = rid('g'); groups[id] = { id, band, gender: c.gender, counselorId: c.id, companyId: null, num: 0 }; members[id] = []; used.add(c.id);
    for (;;) { const big = Object.values(groups).filter(g => g.id !== id && g.band === band && g.gender === c.gender).sort((a, b) => members[b.id].length - members[a.id].length)[0];
      if (!big || members[big.id].length <= members[id].length + 1) break;
      const m = members[big.id]; const pick = pickMover(m, members[id]);
      m.splice(m.indexOf(pick), 1); members[id].push(pick); cur[pick.id] = id; }
    log.push(`New ${BANDS[band]} group for ${c.name}: ${members[id].length} participants, one or two from each of the biggest groups`);
  }
  if (cfg.useAll) for (const gender of ['F', 'M']) for (const band of ['Y', 'O']) for (let guard = 0; guard < 2000; guard++) {
    const l = Object.values(groups).filter(g => g.gender === gender && g.band === band && g.counselorId).sort((a, b) => members[b.id].length - members[a.id].length);
    if (l.length < 2) break; const big = l[0], small = l[l.length - 1]; if (members[big.id].length - members[small.id].length <= 1) break;
    const m = members[big.id]; const pick = pickMover(m, members[small.id]);
    m.splice(m.indexOf(pick), 1); members[small.id].push(pick); cur[pick.id] = small.id;
  }
  const still = Object.values(groups).filter(g => members[g.id].length > gsize(cfg, g.gender)).length;
  if (still) log.push(`${still} group(s) are still over their group size: add counselors and press Rebalance again`);
  else if (overfull && !opened) log.push(`${overfull} placement(s) went over the group size of ${size}: add counselors to open new groups`);
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
  const stakeOfR = {}; for (const gid in members) { const o = stakeOfR[gid] = {}; members[gid].forEach(p => o[p.stake || ''] = (o[p.stake || ''] || 0) + 1); }
  let lp = 0; for (const g of loose) if (placeGroupInCompany(g, companies, groups, stakeOfR)) lp++;
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
  // numbering: existing groups keep their number; a new group takes the lowest free number (a gap left by a removed group) first
  const takenG = new Set(Object.values(groups).filter(g => g.num && g.num < 9000).map(g => g.num)); let nextG = 1;
  const seenG = new Set(); Object.values(groups).forEach(g => { if (g.num && g.num < 9000 && seenG.has(g.num)) g.num = 0; else if (g.num) seenG.add(g.num); }); // repair any duplicate
  Object.values(groups).sort((a, b) => (a.gender > b.gender ? 1 : -1)).forEach(g => { if (!g.num || g.num >= 9000) { while (takenG.has(nextG)) nextG++; g.num = nextG; takenG.add(nextG); } });
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
  const shadow = shadowedCounselors(Object.values(staffMap));
  for (const g of Object.values(groups)) { const c = g.counselorId && staffMap[g.counselorId]; if (!c) continue;
    if (c.role !== 'counselor') w.push(['bad', `Group ${g.num} is led by ${c.name}, who is now ${ROLES[c.role] ? (/^[aeiou]/i.test(ROLES[c.role]) ? 'an ' : 'a ') + ROLES[c.role].toLowerCase() : 'not a counselor'}. Press Rebalance.`]);
    else if (shadow[c.id]) { const co = Object.values(companies).find(x => x.acId === shadow[c.id].id); w.push(['bad', `${c.name} leads group ${g.num} but is also listed as ${ROLES[shadow[c.id].role].toLowerCase()}${co ? ' (Company ' + co.num + ')' : ''}. Press Rebalance, then delete the extra counselor record on the Staff page.`]); } }
  const noCoun = Object.values(groups).filter(g => !(g.counselorId && staffMap[g.counselorId])).length;
  if (noCoun) w.push(['bad', `${noCoun} group(s) have no counselor. Press Rebalance: their youth move into same-gender groups of the same age that have a counselor, and those groups grow until you add counselors.`]);
  for (const g of Object.values(groups)) {
    const c = g.counselorId && staffMap[g.counselorId];
    if (!c) w.push(['bad', `Group ${g.num} has no counselor`]);
    else if (c.gender && c.gender !== g.gender) w.push(['bad', `Group ${g.num}: counselor ${c.name} is not the same gender as the group`]);
    if (mem[g.id].some(p => p.gender !== g.gender)) w.push(['bad', `Group ${g.num} mixes young men and young women`]);
    if (mem[g.id].some(p => p.band && p.band !== g.band)) w.push(['bad', `Group ${g.num} mixes the 13–15 and 16–18 age groups`]);
    if (mem[g.id].length > gsize(cfg, g.gender)) w.push(['warn', `Group ${g.num} has ${mem[g.id].length} participants (size is ${gsize(cfg, g.gender)})`]);
    if (!g.companyId || !companies[g.companyId]) w.push(['warn', `Group ${g.num} is not in a company`]);
    else if (companies[g.companyId].band !== g.band) w.push(['bad', `Group ${g.num} is in a company of the other age group`]);
  }
  const noG = Object.values(staffMap).filter(s => s.role === 'counselor' && !s.gender).length;
  if (noG) w.push(['warn', `${noG} counselor(s) have no gender, so they cannot lead a group. Open them on the Staff page to fix.`]);
  for (const c of Object.values(companies)) {
    const gs = Object.values(groups).filter(g => g.companyId === c.id);
    if (!c.acId || !staffMap[c.acId]) w.push(['bad', `Company ${c.num} has no assistant coordinator`]);
    if (!gs.some(g => g.gender === 'F') || !gs.some(g => g.gender === 'M')) w.push(['bad', `Company ${c.num} does not have both young men and young women`]);
  }
  return w;
}

/* T-shirt blanks: estimate sizes from the people most like them */
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

/* SHA-256 (sign-in email matching) */
function sha256(ascii) { function rr(v, a) { return (v >>> a) | (v << (32 - a)); } var mp = Math.pow, maxWord = mp(2, 32), result = '', words = [], bitLen = ascii.length * 8, hash = [], k = [], pc = 0, isC = {}, i, j; for (var c = 2; pc < 64; c++) { if (!isC[c]) { for (i = 0; i < 313; i += c) isC[i] = c; hash[pc] = (mp(c, .5) * maxWord) | 0; k[pc++] = (mp(c, 1 / 3) * maxWord) | 0; } } ascii += '\x80'; while (ascii.length % 64 - 56) ascii += '\x00'; for (i = 0; i < ascii.length; i++) { j = ascii.charCodeAt(i); words[i >> 2] |= j << ((3 - i) % 4) * 8; } words[words.length] = ((bitLen / maxWord) | 0); words[words.length] = bitLen; for (j = 0; j < words.length;) { var w = words.slice(j, j += 16), old = hash; hash = hash.slice(0, 8); for (i = 0; i < 64; i++) { var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4], t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ ((~e) & hash[6])) + k[i] + (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0), t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2])); hash = [(t1 + t2) | 0].concat(hash); hash[4] = (hash[4] + t1) | 0; } for (i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0; } for (i = 0; i < 8; i++) for (j = 3; j + 1; j--) { var b = (hash[i] >> (j * 8)) & 255; result += ((b < 16) ? 0 : '') + b.toString(16); } return result; }
function emailKey(e) { return String(e || '').trim().toLowerCase(); }

/* CSV writer */
function toCSV(rows) { return rows.map(r => r.map(v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n'); }

/* Test staff */
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


/* Interface */
/* FSY Check-in UI */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = {
  db: null, user: null, dl: null, uid: null, isOwner: false, meName: '', noDb: false, slow: false,
  roster: {}, rosterEx: new Set(), state: {}, stateEx: new Set(), staff: {}, staffEx: false,
  org: { groups: {}, companies: {} }, orgEx: false, config: Object.assign({}, DEFAULT_CONFIG), configEx: false,
  access: {}, accessEx: false, requests: {}, loaded: {},
  P: [], staffList: [], staffMap: {}, viewAs: null, viewAsStaff: null, names: {},
  hc: {}, hcLoaded: false, sid: 'main', sessions: {}, mySessions: [],
  medAdmin: false, medRead: false, reports: {}, email: null, medical: {}, medicalEx: new Set(), intake: {}, share: null, shares: {}, invites: {}, members: {}, inviteEmails: {}, claimTried: false
};
const UI = { page: null, frameKey: '', q: '', filter: 'all', stake: '', unit: '', limit: 40, logScope: 'all', staffTab: 'counselor', open: new Set(), openStakes: new Set(), band: '', imp: null, genLog: null, pending: false };

/* roles */
/* Roles that open every session and may split or reorganise sessions. */
const TOP_ROLES = ['regadmin', 'seventy', 'loghead'];
function invSessions(i) { return i && Array.isArray(i.sessions) && i.sessions.length ? i.sessions : ['main']; }
/** Does this account belong to the session being viewed? Registration admins and the Area Seventy belong to all. */
function invHere(i) { return !!i && (TOP_ROLES.includes(i.role) || invSessions(i).includes(S.sid)); }
/** Registration admins hand out any role; the Area Seventy any but registration admin; a Session Directing Couple only session roles. */
function roleAssignable(r) { const me = realRole(); if (me === 'regadmin') return true; if (me === 'seventy' || me === 'loghead') return r !== 'regadmin'; return !['regadmin', 'seventy', 'loghead'].includes(r); }
function sessName(sid) { const x = S.sessions[sid]; return (x && x.name) || (sid === 'main' ? 'FSY Kenya 2nd 2026' : 'Session'); }
function inviteFor(uid) { const m = S.members[uid]; const i = m && m.h && S.invites[m.h] ? S.invites[m.h] : null; return invHere(i) ? i : null; }
function accountOf(uid) { if (S.access[uid]) return S.access[uid]; const i = inviteFor(uid); return i ? { role: i.role, staffId: i.staffId || null, via: 'invite' } : null; }
function realRole() { if (S.isOwner) return 'regadmin'; const a = accountOf(S.uid); return a ? a.role : null; }
function role() { return S.viewAs || realRole(); }
function myStaffId() { if (S.viewAs) return S.viewAsStaff; const a = accountOf(S.uid); return a ? a.staffId || null : null; }
function scopeCompanyIds(r, sid) { const G = Object.values(S.org.groups), C = Object.values(S.org.companies); if (r === 'counselor') return uniq(G.filter(g => sid && g.counselorId === sid).map(g => g.companyId).filter(Boolean)); if (r === 'ac') return C.filter(c => sid && c.acId === sid).map(c => c.id); return []; }
function inScopeFor(p, r, sid) { if (!['counselor', 'ac'].includes(r)) return true; const ids = scopeCompanyIds(r, sid); return (!!p.company && ids.includes(p.company.id)) || (r === 'counselor' && !!p.group && !!sid && p.group.counselorId === sid); }
function seesPrivate(p) { return inScopeFor(p, role(), myStaffId()); }
const can = {
  admin: () => ['regadmin', 'sdc', 'seventy', 'loghead'].includes(role()),
  deleteP: () => role() === 'regadmin',
  checkin: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'coordinator', 'ac', 'counselor', 'logistics'].includes(role()),
  viewAll: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'logistics'].includes(role()),
  readOnly: () => role() === 'logistics',
  staff: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'coordinator'].includes(role()),
  reset: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'coordinator'].includes(role()),
  moveAny: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'coordinator'].includes(role()),
  moveOwn: () => role() === 'ac',
  // regenerate, rebalance, add or remove companies and groups, change who leads them
  orgEdit: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'coordinator'].includes(role()),
  logistics: () => !!role() && role() !== 'wellness',
  wellness: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'wellness', 'logistics'].includes(role()),
  // resolving and following up on health concerns (logistics only looks)
  wellnessEdit: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'wellness'].includes(role()),
  report: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'coordinator', 'ac', 'counselor', 'wellness'].includes(role()),
  accounts: () => ['regadmin', 'sdc', 'seventy', 'loghead'].includes(role()),
  // the real account must be allowed to split, and a preview of another role hides it, so previews show exactly what that role sees
  split: () => [...TOP_ROLES, 'sdc'].includes(realRole()) && [...TOP_ROLES, 'sdc'].includes(role()),
  headcount: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'coordinator', 'ac', 'counselor', 'logistics'].includes(role())
};
const PAGES = [
  ['checkin', 'Check-in', () => can.checkin() || role() === 'wellness'],
  ['tally', 'Tally', () => !!role() && !['counselor', 'ac'].includes(role())],
  ['companies', 'Companies & groups', () => can.checkin()],
  ['exceptions', 'Walk-ins & exceptions', () => can.checkin() || role() === 'logistics'],
  ['logistics', 'Logistics', () => can.logistics()],
  ['headcount', 'Headcount', () => can.headcount()],
  ['staff', 'Staff', () => can.admin() || can.viewAll() || role() === 'coordinator'],
  ['wellness', 'Wellness', () => can.wellness()],
  ['data', 'Data & areas', () => can.admin() || can.viewAll()],
  ['access', 'Accounts', () => can.accounts()],
  ['sessions', 'Sessions', () => can.split()],
  ['audit', 'Audit log', () => (S.isOwner || realRole() === 'regadmin') && role() === 'regadmin']
];
function allowedPages() { return PAGES.filter(p => p[2]()); }
function currentPage() {
  const ok = allowedPages().map(p => p[0]);
  const h = (location.hash || '').slice(1);
  if (ok.includes(h)) return h;
  if (lgHash() && ok.includes('logistics')) return 'logistics';
  return ok.includes('checkin') ? 'checkin' : ok[0] || null;
}

/* helpers */
function toast(msg, err, action) {
  const box = $('#toast'); while (box.children.length > 1) box.firstChild.remove();
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : '');
  const sp = document.createElement('span'); sp.textContent = msg; t.appendChild(sp);
  if (action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = action.label; b.onclick = () => { t.remove(); action.fn(); }; t.appendChild(b); }
  box.appendChild(t); setTimeout(() => t.remove(), action || err ? 6000 : 2600);
}
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
function askText(title, label) {
  return new Promise(res => {
    openModal(`<div class="modal-head"><h2>${esc(title)}</h2></div><label class="form" style="display:block"><span class="note" style="display:block;margin-bottom:6px">${esc(label)}</span><textarea id="atText" rows="3" maxlength="400" style="width:100%"></textarea></label><div class="btnrow"><button class="btn primary" id="cfOk">Save</button><button class="btn" id="cfNo">Cancel</button></div>`);
    setTimeout(() => { const t = $('#atText'); if (t) t.focus(); }, 50);
    $('#cfOk').onclick = () => { const v = clean(($('#atText') || {}).value); closeModal(); res(v); }; $('#cfNo').onclick = () => { closeModal(); res(null); };
  });
}
function openModal(html) { $('#modalRoot').innerHTML = `<div class="modal-bg" id="mbg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`; $('#mbg').addEventListener('click', e => { if (e.target.id === 'mbg') closeModal(); }); }
function closeModal() { $('#modalRoot').innerHTML = ''; }
async function exportCSV(name, rows) {
  if (!S.dl) { toast('Downloads are not available in this view.', true); return; }
  try { await S.dl.save({ filename: name, data: '﻿' + toCSV(rows) }); } catch (e) { if (e && e.code !== 'declined') toast('The file was not saved.', true); }
}

/* writes */
const Q = {};
function serial(path, fn) { const p = (Q[path] || Promise.resolve()).catch(() => { }).then(fn); Q[path] = p; return p; }
function upd(path, data, exists) { return serial(path, () => exists ? S.db.doc(path).update(data) : S.db.doc(path).set(data)); }
function setDoc(path, data) { return serial(path, () => S.db.doc(path).set(data)); }

/* Audit log: every change anyone makes, written as one short line. Only registration admins can read it.
   Entries are only ever added, never edited or removed (the database rules enforce that). */
const AUDIT_KINDS = { checkin: 'Check-in', groups: 'Groups & companies', staff: 'Staff', accounts: 'Accounts', settings: 'Settings & data', health: 'Health', headcount: 'Headcount', session: 'Sessions', signin: 'Sign-in' };
function audit(kind, text, extra) {
  try {
    if (!S.uid || !FB.fs || S.noDb) return;
    const rec = { at: Date.now(), uid: S.uid, email: S.email || '', name: S.meName || '', role: realRole() || '', kind, text: String(text || '').slice(0, 400) };
    if (S.viewAs) rec.preview = S.viewAs;
    if (extra) rec.ref = String(extra).slice(0, 120);
    FB.fs.collection(rawPath(S.sid, 'audit')).add(rec).catch(e => console.warn('audit', e));
  } catch (e) { console.warn('audit', e); }
}
const pName = id => { const p = S.P.find(x => x.id === id); return p ? p.name : 'a participant'; };
const gName = gid => { const g = gid && S.org.groups[gid]; return g ? 'G' + g.num : 'no group'; };
const stName = id => (S.staffMap[id] && S.staffMap[id].name) || 'nobody';
/** Describe a change to one participant's state (check-in, group, include/exclude, medical flags). */
function auditState(pid, before, patch) {
  const n = pName(pid), b = before || {};
  if ('s' in patch && (patch.s || '') !== (b.s || '')) audit('checkin', patch.s === 'in' ? `Checked in ${n}` : patch.s === 'out' ? `Checked out ${n}` : `Undid the check-in of ${n}`, pid);
  if ('g' in patch && (patch.g || null) !== (b.g || null)) audit('groups', `Moved ${n} from ${gName(b.g)} to ${gName(patch.g)}`, pid);
  if ('ov' in patch && (patch.ov || null) !== (b.ov || null)) audit('settings', patch.ov === 'inc' ? `Included ${n} in the session` : patch.ov === 'exc' ? `Excluded ${n} from the session` : `Put ${n} back under the area rules`, pid);
  if ('mo' in patch) audit('health', patch.mo === 'n' ? `Marked ${n}'s medical note as not an issue` : `Counted ${n}'s medical note as an issue`, pid);
  if ('do' in patch) audit('health', patch.do === 'n' ? `Marked ${n}'s dietary note as not an issue` : `Counted ${n}'s dietary note as an issue`, pid);
  if (patch.del) audit('settings', `Deleted participant ${n}`, pid);
}
function setState(pid, patch) {
  try { const b0 = bucketOf(pid); auditState(pid, (S.state[b0] || {})[pid], patch); } catch (e) { }
  const b = bucketOf(pid); S.state[b] = Object.assign({}, S.state[b] || {}); S.state[b][pid] = Object.assign({}, S.state[b][pid] || {}, patch);
  recompute(true); const ex = S.stateEx.has(b); S.stateEx.add(b);
  return upd('state/' + b, { p: { [pid]: patch } }, ex).catch(fail);
}
async function setStates(map) { // pid -> patch
  const byB = {}; for (const pid in map) { const b = bucketOf(pid); (byB[b] = byB[b] || {})[pid] = map[pid]; S.state[b] = Object.assign({}, S.state[b] || {}); S.state[b][pid] = Object.assign({}, S.state[b][pid] || {}, map[pid]); }
  recompute(true);
  for (const b in byB) { const ex = S.stateEx.has(b); S.stateEx.add(b); await upd('state/' + b, { p: byB[b] }, ex); }
}
function saveOrg(org, gen) { S.org = { groups: org.groups, companies: org.companies }; S.orgEx = true; recompute(true); return setDoc('org/structure', { groups: org.groups, companies: org.companies, gen: gen || null, lock: S.orgLock || null }).catch(fail); }
function patchOrg(patch) { // {groups:{id:{...}}} merge
  const o = { groups: Object.assign({}, S.org.groups), companies: Object.assign({}, S.org.companies) };
  for (const k of ['groups', 'companies']) for (const id in (patch[k] || {})) o[k][id] = Object.assign({}, o[k][id] || {}, patch[k][id]);
  S.org = o; recompute(true); const ex = S.orgEx; S.orgEx = true; return upd('org/structure', patch, ex).catch(fail);
}
function saveStaffRec(rec) { const was = S.staff[rec.id]; audit('staff', !was ? `Added staff member ${rec.name} (${ROLES[rec.role] || rec.role})` : was.role !== rec.role ? `Changed ${rec.name}'s role from ${ROLES[was.role] || was.role} to ${ROLES[rec.role] || rec.role}` : `Edited staff record of ${rec.name}`, rec.id); S.staff = Object.assign({}, S.staff, { [rec.id]: rec }); recompute(true); const ex = S.staffEx; S.staffEx = true; return upd('staff/all', { s: { [rec.id]: rec } }, ex).catch(fail); }
/* Only the size fields change, so coordinators (who may not change other settings) can save them. */
function saveSizes(patch) { audit('groups', `Changed group sizes to ${patch.groupSizeF} young women and ${patch.groupSizeM} young men${patch.useAll ? ' (every counselor gets a group)' : ''}`); S.config = Object.assign({}, S.config, patch); recompute(true); return (S.configEx ? upd('config/session', patch, true) : setDoc('config/session', S.config)).catch(fail); }
function saveConfig(patch) { S.config = Object.assign({}, S.config, patch); recompute(true); S.configEx = true; return setDoc('config/session', S.config).catch(fail); }

/* data load */
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
  if (S.medRead) for (const b in S.medical) for (const id in S.medical[b]) src[id] = S.medical[b][id];
  for (const u in S.intake) { const p = (S.intake[u] || {}).p || {}; for (const id in p) src[id] = Object.assign({}, src[id] || {}, p[id]); }
  if (S.share && S.share.p) for (const id in S.share.p) src[id] = Object.assign({ f: 1 }, S.share.p[id]);
  const out = {};
  for (const b in S.roster) { const m = S.roster[b]; const o = out[b] = {}; for (const id in m) { const r = m[id]; if (!r) continue; const x = src[id];
    if (x) o[id] = Object.assign({}, r, { med: x.med || '', diet: x.diet || '', medF: x.f && x.med ? 1 : 0, dietF: x.f && x.diet ? 1 : 0 });
    else o[id] = S.medRead ? r : Object.assign({}, r, { med: '', diet: '' }); } }
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
    const a = accountOf(uid); if (!a || ['regadmin', 'wellness', 'logistics'].includes(a.role)) continue;
    const p = {}; S.P.forEach(x => { if ((x.medIssue || x.dietIssue) && inScopeFor(x, a.role, a.staffId)) p[x.id] = { med: x.medIssue || '', diet: x.dietIssue || '' }; });
    const h = fnv(JSON.stringify(p)).toString(36); if (S.shares[uid] === h) continue; S.shares[uid] = h;
    await setDoc('share/' + uid, { p, h });
  }
  for (const uid in S.shares) if (!uids.includes(uid) || !accountOf(uid)) { delete S.shares[uid]; await serial('share/' + uid, () => S.db.doc('share/' + uid).delete()); }
  // 4. logistics and Session Directing Couple accounts count as staff in this session (they rarely appear in the staff upload)
  await syncAccountStaff();
  // 5. link accounts to staff records whose email matches (or, failing that, the same name and role)
  await autoLinkStaff();
}
const ACCOUNT_STAFF_ROLES = ['logistics', 'sdc', 'wellness'];
const LINK_ROLES = ['counselor', 'ac', 'coordinator', 'sdc', 'logistics', 'wellness'];
let linkTried = {};
/** After staff records are deleted, free their accounts so they can be linked again (automatically after the next upload). */
async function unlinkDeleted(ids) {
  for (const h in S.invites) { const v = S.invites[h]; if (v && v.staffId && ids.has(v.staffId)) { try { await FB.fs.doc('invites/' + h).set({ staffId: null, staffAuto: null, staffManual: false }, { merge: true }); } catch (e) { console.warn(e); } } }
  linkTried = {};
}
async function autoLinkStaff() {
  if (!(S.isOwner || ['regadmin', 'sdc', 'seventy', 'loghead'].includes(realRole())) || !S.loaded.inv || !S.loaded.staff) return;
  const staff = S.staffList.filter(x => !x.test && !x.fromAccount);
  const taken = new Set(Object.values(S.invites).map(v => v && v.staffId).filter(Boolean));
  const norm = x => nameTokens(x).join(' ');
  for (const h in S.invites) {
    const v = S.invites[h]; if (!v || !LINK_ROLES.includes(v.role) || !invHere(v)) continue;
    if (v.staffId && S.staff[v.staffId]) continue;      // already linked here
    if (v.staffManual) continue; // chosen or removed by hand on the Accounts page
    const key = h + '|' + S.sid + '|' + staff.length; if (linkTried[key]) continue; linkTried[key] = 1;
    let m = staff.filter(x => x.email && x.email.toLowerCase() === h && !taken.has(x.id)), how = 'email';
    if (m.length !== 1) { m = staff.filter(x => x.role === v.role && norm(x.name) && norm(x.name) === norm(v.name) && !taken.has(x.id)); how = 'name'; }
    if (m.length !== 1) continue;
    try { await FB.fs.doc('invites/' + h).set({ staffId: m[0].id, staffAuto: how, staffManual: false }, { merge: true }); taken.add(m[0].id); } catch (e) { console.warn('auto-link', h, e); }
  }
}
async function syncAccountStaff() {
  if (!S.loaded.inv || !S.loaded.staff) return;
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z]/g, '');
  const want = {};
  for (const h in S.invites) { const v = S.invites[h]; if (v && ACCOUNT_STAFF_ROLES.includes(v.role) && invHere(v)) want['acct_' + fnv(h).toString(36)] = { h, v }; }
  const add = {}, del = [];
  for (const id in want) {
    const { h, v } = want[id], cur = S.staff[id];
    if (v.staffId && S.staff[v.staffId] && S.staff[v.staffId].role === v.role && v.staffId !== id) { if (cur && cur.fromAccount) del.push(id); continue; }
    if (!cur && S.staffList.some(s => !s.fromAccount && s.role === v.role && norm(s.name) && norm(s.name) === norm(v.name))) continue;
    const name = titleCase(v.name || h.split('@')[0]);
    const gender = v.gender || (cur && cur.gender) || '';
    if (!cur || cur.name !== name || cur.role !== v.role || (cur.gender || '') !== gender) add[id] = Object.assign({ gender: '', stake: '', unit: '', phone: '', addedAt: Date.now(), addedBy: 'Accounts' }, cur || {}, { id, name, role: v.role, gender, fromAccount: 1 });
  }
  for (const id in S.staff) { const s = S.staff[id]; if (s && s.fromAccount && !want[id]) del.push(id); }
  if (!Object.keys(add).length && !del.length) return;
  const s = Object.assign({}, S.staff, add); del.forEach(id => delete s[id]); S.staff = s;
  const ex = S.staffEx; S.staffEx = true;
  if (del.length) await setDoc('staff/all', { s }); else await upd('staff/all', { s: add }, ex);
  recompute();
}
function subscribe() {
  const db = S.db; const onErr = e => { console.error(e); if (e.code === 'revoked') { S.noDb = true; render(); } };
  const mark = (k, meta) => { if (!meta.fromCache) S.loaded[k] = true; };
  setTimeout(() => { if (!loadedAll()) { S.slow = true; render(); } }, 10000);
  db.collection('roster').onSnapshot(sn => { const r = {}; S.rosterEx = new Set(); sn.docs.forEach(d => { r[d.id] = Object.assign({}, (d.data() || {}).p || {}); S.rosterEx.add(d.id); }); S.roster = r; mark('roster', sn.metadata); recompute(); }, onErr);
  db.collection('state').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => { r[d.id] = Object.assign({}, (d.data() || {}).p || {}); S.stateEx.add(d.id); }); S.state = r; mark('state', sn.metadata); recompute(); }, onErr);
  db.doc('staff/all').onSnapshot(d => { S.staff = d.exists ? Object.assign({}, d.data().s || {}) : {}; S.staffEx = d.exists || S.staffEx; mark('staff', d.metadata); recompute(); }, onErr);
  db.doc('org/structure').onSnapshot(d => { const v = d.exists ? d.data() : {}; S.org = { groups: Object.assign({}, v.groups || {}), companies: Object.assign({}, v.companies || {}) }; S.orgGen = v.gen || null; S.orgLock = v.lock || null; S.orgEx = d.exists || S.orgEx; mark('org', d.metadata); recompute(); }, onErr);
  db.collection('headcount').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = d.data()); S.hc = r; S.hcLoaded = true; recompute(); }, onErr);
  db.doc('config/session').onSnapshot(d => { S.config = Object.assign({}, DEFAULT_CONFIG, d.exists ? d.data() : {}); S.configEx = d.exists; mark('config', d.metadata); recompute(); }, onErr);
  S.access = {}; S.loaded.access = true;
  if (S.medAdmin) {
    db.collection('requests').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = d.data()); S.requests = r; recompute(); }, onErr);
    db.collection('invites').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = d.data()); S.invites = r; mark('inv', sn.metadata); recompute(); }, onErr);
    db.collection('profiles').onSnapshot(sn => { const m = {}, p = {}; sn.docs.forEach(d => { const v = d.data() || {}; p[d.id] = v; if (v.email) m[d.id] = { h: emailKey(v.email) }; }); S.profiles = p; S.members = m; mark('mem', sn.metadata); recompute(); }, onErr);
  } else {
    S.members = { [S.uid]: { h: emailKey(S.email) } }; S.loaded.mem = true;
    db.doc('invites/' + emailKey(S.email)).onSnapshot(d => { if (!d.exists || !invHere(d.data())) { location.reload(); return; } S.invites = { [d.id]: d.data() }; mark('inv', d.metadata); recompute(); }, onErr);
  }
  if (S.medAdmin) {
    db.collection('medical').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => { r[d.id] = Object.assign({}, (d.data() || {}).p || {}); S.medicalEx.add(d.id); }); S.medical = r; mark('med', sn.metadata); recompute(); }, onErr);
    db.collection('intake').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = d.data()); S.intake = r; recompute(); }, onErr);
    db.collection('share').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = (d.data() || {}).h || ''); S.shares = r; }, onErr);
  } else if (S.medRead) {
    db.collection('medical').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => { r[d.id] = Object.assign({}, (d.data() || {}).p || {}); }); S.medical = r; mark('med', sn.metadata); recompute(); }, onErr);
    db.collection('intake').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = d.data()); S.intake = r; recompute(); }, onErr);
  } else if (S.uid) {
    db.doc('share/' + S.uid).onSnapshot(d => { S.share = d.exists ? d.data() : null; mark('med', d.metadata); recompute(); }, onErr);
    db.doc('intake/' + S.uid).onSnapshot(d => { S.intake = d.exists ? { [S.uid]: d.data() } : {}; S.intakeEx = d.exists; recompute(); }, onErr);
  } else S.loaded.med = true;
  // health concerns reported by counselors: wellness coordinators and admins see all, others their own
  if (S.medRead) db.collection('reports').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => r[d.id] = (d.data() || {}).r || {}); S.reports = r; recompute(); }, onErr);
  else if (S.uid) db.doc('reports/' + S.uid).onSnapshot(d => { S.reports = d.exists ? { [S.uid]: (d.data() || {}).r || {} } : {}; S.reportsEx = d.exists; recompute(); }, () => { });
}
async function boot() {
  window.addEventListener('hashchange', () => { closeModal(); render(); });
  const CFG = appConfig(); if (!window.firebase || !CFG || !CFG.apiKey || /PASTE/.test(CFG.apiKey)) { S.setupNeeded = true; render(); return; }
  FB.app = firebase.initializeApp(CFG); FB.auth = firebase.auth(); FB.fs = firebase.firestore();
  try { FB.fs.settings({ ignoreUndefinedProperties: true, merge: true }); } catch (e) { }
  try { await FB.fs.enablePersistence({ synchronizeTabs: true }); } catch (e) { }
  FB.auth.getRedirectResult().catch(e => toast(signInError(e), true));
  FB.auth.onAuthStateChanged(async u => {
    if (S.uid && (!u || u.uid !== S.uid)) { location.reload(); return; }
    if (!u) { S.signedOut = true; UI.frameKey = ''; render(); return; }
    S.signedOut = false; FB.user = u;
    S.uid = u.uid; S.email = (u.email || '').toLowerCase(); S.meName = u.displayName || S.email;
    S.isOwner = ownerEmails().map(x => String(x).trim().toLowerCase()).includes(S.email);
    S.db = dbShim; S.user = userShim; S.dl = downloadShim;
    FB.fs.doc('profiles/' + u.uid).set({ name: S.meName, email: S.email, at: Date.now() }, { merge: true }).catch(console.error);
    let inv = null; try { const d = await FB.fs.doc('invites/' + emailKey(S.email)).get(); inv = d.exists ? d.data() : null; } catch (e) { console.error(e); }
    const top = S.isOwner || !!(inv && TOP_ROLES.includes(inv.role));
    let reg = {}; try { const d = await FB.fs.doc('meta/sessions').get(); reg = d.exists ? (d.data().s || {}) : {}; } catch (e) { console.error(e); }
    S.sessions = Object.assign({ main: { name: 'FSY Kenya 2nd 2026', at: 0 } }, reg);
    S.mySessions = (top ? Object.keys(S.sessions) : invSessions(inv)).filter(id => S.sessions[id]).sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : (S.sessions[a].at || 0) - (S.sessions[b].at || 0)));
    let pick = null; try { pick = localStorage.getItem('fsy.session.' + u.uid); } catch (e) { }
    S.sid = S.mySessions.includes(pick) ? pick : (S.mySessions[0] || 'main');
    S.medAdmin = S.isOwner || !!(inv && ['regadmin', 'sdc', 'seventy', 'loghead'].includes(inv.role));
    S.medRead = S.medAdmin || !!(inv && ['wellness', 'logistics'].includes(inv.role)); S.myRole = inv ? inv.role : (S.isOwner ? 'regadmin' : null);
    if (!S.isOwner && !inv) { subscribeGuest(); render(); return; }
    subscribe(); render(); setTimeout(() => { try { const k = 'fsy.seen.' + S.uid + '.' + S.sid, d = new Date().toISOString().slice(0, 10); if (localStorage.getItem(k) !== d) { localStorage.setItem(k, d); audit('signin', 'Opened the app'); } } catch (e) { audit('signin', 'Opened the app'); } }, 3000);
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

/* shell */
const I = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  checkin: I('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.6 2.6L16.5 9"/>'),
  tally: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  companies: I('<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 13.6c2.7.2 4.5 2.2 4.5 5"/>'),
  exceptions: I('<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c0-3.6 2.9-6 6.5-6 1.4 0 2.6.3 3.6.9"/><path d="M18 14v6M15 17h6"/>'),
  wellness: I('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/><path d="M12 10v5M9.5 12.5h5"/>'),
  logistics: I('<path d="M9 4h6v3H9z"/><path d="M8 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-2"/><path d="M12 11v6M9 14h6"/>'),
  staff: I('<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7.5 18c.6-2.3 2.4-3.5 4.5-3.5s3.9 1.2 4.5 3.5"/>'),
  data: I('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  access: I('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M18 5l2 2"/>'),
  headcount: I('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/><path d="m10 13 2 2 4-4"/>'),
  more: I('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'),
  audit: I('<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 12h6M10 15h6M10 18h4"/>'),
  sessions: I('<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>'),
  print: I('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  signout: I('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>')
};
const SHORT = { audit: 'Audit', wellness: 'Wellness', sessions: 'Sessions', headcount: 'Headcount', checkin: 'Check-in', tally: 'Tally', companies: 'Groups', exceptions: 'Walk-ins', logistics: 'Logistics', staff: 'Staff', data: 'Data', access: 'Accounts' };
const NAV_ORDER = { wellness: ['checkin', 'wellness', 'tally'], logistics: ['checkin', 'logistics', 'exceptions', 'tally', 'companies', 'headcount', 'staff', 'wellness', 'data'], counselor: ['checkin', 'companies', 'headcount', 'logistics', 'exceptions'], ac: ['checkin', 'companies', 'headcount', 'logistics', 'exceptions'] };
function navPages() { const ok = allowedPages().map(p => p[0]).filter(k => k !== 'audit'); /* the audit log opens from the account menu */ const pref = NAV_ORDER[role()] || []; return pref.filter(k => ok.includes(k)).concat(ok.filter(k => !pref.includes(k))); }
function initials(n) { return (String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('') || '?').toUpperCase(); }
function renderHeader() {
  $('#sessName').textContent = (!S.config.sessionName || S.config.sessionName === 'FSY Kenya 2') ? 'FSY Kenya 2nd 2026' : S.config.sessionName;
  if (!S.uid) { $('#who').innerHTML = ''; } else {
    const r = role();
    const live = loadedAll() ? 'live' : S.slow ? 'slow' : '';
    $('#who').innerHTML = `<span class="dot ${live}" title="${live === 'live' ? 'Live' : 'Syncing'}"></span><span class="livelabel">${live === 'live' ? 'Live' : S.slow ? 'Still connecting' : 'Syncing'}</span>${r ? `<span class="rolechip${S.viewAs ? ' preview' : ''}">${esc(S.viewAs ? 'Preview: ' + SHORT_ROLE[r] : SHORT_ROLE[r])}</span>` : ''}<button class="avatar" data-act="acct" aria-label="Your account">${esc(initials(S.meName))}</button>`;
  }
  const top = $('#top'); if (top) { document.documentElement.style.setProperty('--toph', top.offsetHeight + 'px'); const sticky = getComputedStyle(top).position === 'sticky'; const tabs = document.querySelector('.tabs'); document.documentElement.style.setProperty('--stick', sticky ? (top.offsetHeight + (tabs ? tabs.offsetHeight : 0)) + 'px' : '0px'); }
}
const SHORT_ROLE = { wellness: 'Wellness', regadmin: 'Reg admin', sdc: 'Session Directing Couple', seventy: 'Area Seventy', loghead: 'Logistics head', coordinator: 'Coordinator', ac: 'Asst. coordinator', counselor: 'Counselor', logistics: 'Logistics' };
function renderNav() {
  const cur = currentPage(); const keys = navPages();
  $('#nav').innerHTML = keys.map(k => `<button class="tab" data-act="nav" data-v="${k}" ${k === cur ? 'aria-current="page"' : ''}>${esc(PAGES.find(p => p[0] === k)[1])}</button>`).join('');
  fitWidth();
  const bn = $('#bnav');
  if (!keys.length || gateView()) { bn.hidden = true; return; }
  const main = keys.length <= 5 ? keys : keys.slice(0, 4), rest = keys.length <= 5 ? [] : keys.slice(4);
  bn.hidden = false;
  bn.innerHTML = main.map(k => `<button data-act="nav" data-v="${k}" ${k === cur ? 'aria-current="page"' : ''}><span class="ic">${ICONS[k]}</span>${SHORT[k]}</button>`).join('')
    + (rest.length ? `<button data-act="moreNav" ${rest.includes(cur) ? 'aria-current="page"' : ''}><span class="ic">${ICONS.more}</span>${rest.includes(cur) ? SHORT[cur] : 'More'}</button>` : '');
}
function openMore() {
  const keys = navPages(); const rest = keys.length <= 5 ? [] : keys.slice(4); const cur = currentPage();
  openModal(`<div class="modal-head"><h2>More</h2><button class="x" data-act="close" aria-label="Close">×</button></div>
  <div class="sheetlist">${rest.map(k => `<button data-act="nav" data-v="${k}" ${k === cur ? 'aria-current="page"' : ''}>${ICONS[k]}${esc(PAGES.find(p => p[0] === k)[1])}</button>`).join('')}</div>`);
}
function openAccount() {
  const r = realRole();
  openModal(`<div class="modal-head"><div class="acct"><span class="avatar" style="width:46px;height:46px;cursor:default">${esc(initials(S.meName))}</span><div><h2>${esc(S.meName || 'Signed in')}</h2><small class="muted">${esc(S.email || '')}</small></div></div><button class="x" data-act="close" aria-label="Close">×</button></div>
  <p style="margin:0">Role: <span class="rolechip">${esc(r ? ROLES[r] : 'No role yet')}</span></p>
  ${r === 'regadmin' ? `<label class="form" style="display:block"><span class="note" style="display:block;margin-bottom:4px">See the app the way someone else does</span><select id="viewAs" aria-label="Preview as role" style="width:100%">${opt('', 'Viewing as myself', !S.viewAs)}${Object.keys(ROLES).filter(k => k !== 'regadmin').map(k => opt(k, 'Preview: ' + ROLES[k], S.viewAs === k)).join('')}</select></label>` : ''}
  ${S.mySessions.length > 1 ? `<div><p class="th" style="margin-bottom:6px">Session</p><div class="sheetlist">${S.mySessions.map(id => `<button data-act="switchSession" data-v="${esc(id)}" ${id === S.sid ? 'aria-current="page"' : ''}>${ICONS.checkin}${esc(sessName(id))}${id === S.sid ? ' · open now' : ''}</button>`).join('')}</div></div>` : ''}
  <div class="sheetlist">${allowedPages().some(p => p[0] === 'audit') ? `<button data-act="nav" data-v="audit" ${currentPage() === 'audit' ? 'aria-current="page"' : ''}>${ICONS.audit}Audit log</button>` : ''}<button data-act="signOut">${ICONS.signout}Sign out</button></div>
  <p class="note" style="margin:0;text-align:center">App version ${esc(APP_VERSION)}</p>`);
}
function gateView() {
  const ident = `<picture><img class="identifier" src="assets/identifier-light.webp" width="380" height="410" alt="2026 youth theme identifier: Walk with Me, Moses 6:34"></picture>`;
  if (S.setupNeeded) return `<div class="gate">${ident}<h1>Finish setting up</h1><p class="note">Put your Firebase settings and owner emails in <b>config.js</b>, upload it next to index.html, then reload.</p></div>`;
  if (S.signedOut) return `<div class="gate">${ident}<p class="tag">FSY Kenya 2nd 2026 · Check-in</p><h1>Welcome, let's get everyone checked in</h1><p class="note">Sign in with the Google account your registration admin set up for you.</p><button class="btn primary gbtn" data-act="signIn"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.6a4.8 4.8 0 0 1-2.1 3.1v2.6h3.4c2-1.8 3.1-4.5 3.1-7.5z"/><path fill="#34A853" d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-.9.6-2.1 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.7v2.7A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.2 13.6a6 6 0 0 1 0-3.8V7.1H2.7a10 10 0 0 0 0 9.2z"/><path fill="#EA4335" d="M12 5.9c1.5 0 2.9.5 4 1.5l3-3A10 10 0 0 0 2.7 7.1l3.5 2.7C7 7.7 9.3 5.9 12 5.9z"/></svg>Sign in with Google</button></div>`;
  if (!S.uid) return `<div class="empty"><h3>Checking your sign-in…</h3>One moment.</div>`;
  if (!loadedAll() && !S.slow) return `<div class="empty"><h3>Loading the session…</h3>Participants, groups and check-ins appear here once the data connects.</div>`;
  if (!role()) {
    const mine = S.requests[S.uid];
    return `<div class="gate">${ident}<h1>No account for you yet</h1>
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
  if (ae && $('#main').contains(ae) && (ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && (ae.dataset.region || ae.dataset.hcreason)))) { UI.pending = true; ae.addEventListener('blur', () => { setTimeout(() => { UI.pending = false; render(); }, 250); }, { once: true }); return; }
  renderHeader(); renderNav();
  const gate = gateView();
  if (gate) { const gk = 'gate' + fnv(gate); if (UI.frameKey !== gk) { $('#main').innerHTML = gate; UI.frameKey = gk; } return; }
  const pg = currentPage(); const key = pg + '|' + role() + '|' + (myStaffId() || '');
  const page = PAGE_IMPL[pg];
  if (UI.frameKey !== key) { $('#main').innerHTML = page.frame(); UI.frameKey = key; window.scrollTo(0, 0); }
  page.update();
  if (can.readOnly()) lockReadOnly(pg); else if (pg === 'headcount' && hcViewOnly()) lockReadOnly(pg);
}

function lockReadOnly(pg) {
  const m = $('#main');
  m.querySelectorAll('.adm,.adm-hc').forEach(el => el.hidden = true);
  if (pg === 'staff' || pg === 'data') m.querySelectorAll('input,select,textarea').forEach(el => { if (el.id !== 'ciQ') el.disabled = true; });
  if (pg === 'headcount') m.querySelectorAll('.hc-toggle button,.hc-reason,[data-hcnote]').forEach(el => el.disabled = true);
}

function resetPanel() {
  const nG = Object.keys(S.org.groups).length, nC = Object.keys(S.org.companies).length, nT = S.staffList.filter(x => x.test).length, nS = S.staffList.length;
  return `<section class="panel danger-zone"><div class="panel-head"><h2>Start over</h2><span class="chip bad">Can't be undone</span></div>
    <p class="note" style="margin-top:-4px">For registration admins, the Session Directing Couple, the Area Seventy and coordinators. Check-ins, participants and headcounts already submitted are kept.</p>
    <div class="dz-list">
      <div class="dz"><div><b>Undo all groups and companies</b><small class="muted">${nG} groups and ${nC} companies are removed and every participant goes back to "no group". Generate again afterwards.</small></div><button class="btn danger" data-act="resetOrg" ${nG || nC ? '' : 'disabled'}>Undo groups</button></div>
      <div class="dz"><div><b>Delete test staff</b><small class="muted">${nT} staff marked Test.</small></div><button class="btn danger" data-act="resetTest" ${nT ? '' : 'disabled'}>Delete test staff</button></div>
      <div class="dz"><div><b>Delete staff of one type</b><small class="muted">For example every counselor, before uploading a corrected list. Everyone else stays. Logistics and Session Directing Couple members who have an account are always kept.</small><select id="rsType" style="margin-top:8px;max-width:280px">${STAFF_ROLES.map(r => { const n = S.staffList.filter(x => x.role === r && !x.fromAccount).length; return opt(r, `${ROLES[r]}s · ${n}`, r === (UI.rsType || 'counselor')); }).join('')}</select></div><button class="btn danger" data-act="resetType">Delete this type</button></div>
      <div class="dz"><div><b>Delete all staff</b><small class="muted">All ${nS} staff, real and test. Groups and companies lose their counselors and ACs. Accounts stay and link again automatically to the new list where the email or name matches.</small></div><button class="btn danger" data-act="resetStaff" ${nS ? '' : 'disabled'}>Delete all staff</button></div>
    </div></section>`;
}
function confirmTyped(title, body, word, okLabel) {
  return new Promise(res => {
    openModal(`<div class="modal-head"><h2>${esc(title)}</h2><button class="x" data-act="close" aria-label="Close">×</button></div><p class="note" style="margin:0">${body}</p>
      <label class="form" style="display:block"><span class="note" style="display:block;margin-bottom:4px">Type <b>${esc(word)}</b> to confirm</span><input id="cfWord" autocomplete="off" autocapitalize="characters" style="width:100%"></label>
      <div class="btnrow"><button class="btn danger" id="cfOk" disabled>${esc(okLabel)}</button><button class="btn" id="cfNo">Cancel</button></div>`);
    const inp = $('#cfWord'), ok = $('#cfOk'); inp.focus();
    inp.addEventListener('input', () => { ok.disabled = inp.value.trim().toUpperCase() !== word; });
    ok.onclick = () => { closeModal(); res(true); }; $('#cfNo').onclick = () => { closeModal(); res(false); };
  });
}
async function resetOrg() {
  const ch = {}; S.P.forEach(p => { if (p.g) ch[p.id] = { g: null }; });
  UI.genLog = null; UI.open = new Set(); UI.hcGroup = null;
  await saveOrg({ groups: {}, companies: {} }, null);
  await setStates(ch).catch(fail);
}

/* participant scope helpers */
function myGroups() { const sid = myStaffId(); return Object.values(S.org.groups).filter(g => g.counselorId && g.counselorId === sid); }
function myCompanies() { const sid = myStaffId(); const r = role(); if (r === 'coordinator') return Object.values(S.org.companies); return Object.values(S.org.companies).filter(c => sid && ((r === 'ac' && c.acId === sid) || (r === 'coordinator' && c.coordId === sid))); }
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

/* page: check-in */
const PAGE_IMPL = {};
PAGE_IMPL.checkin = {
  frame() {
    if (!UI.filterSet) { UI.filterSet = true; if (['counselor', 'ac'].includes(role())) UI.filter = 'mine'; }
    const r = role();
    const mineLabel = r === 'counselor' ? 'My group' : r === 'ac' ? 'My company' : null;
    const segs = [['all', 'Everyone'], ['arrive', 'Not arrived'], ['in', 'Checked in'], ['out', 'Checked out']].concat(mineLabel ? [['mine', mineLabel]] : []);
    return `<section class="hero ci-hero"><div class="ci-top"><div><p class="eyebrow" id="ciEye">Check-in${r === 'counselor' || r === 'ac' ? '' : ' · whole session'}</p><div class="bignum"><b id="ciNum">0</b><span id="ciOf"></span></div></div></div><div class="prog"><i id="ciProg" style="width:0"></i></div><div class="hstats" id="ciK"></div></section>
    <div id="ciAnchor"></div>
    <div class="searchbar" id="ciBar">
      <div class="searchrow">${ICONS.search}<input type="search" id="ciQ" placeholder="Search name, unit or G12" value="${esc(UI.q)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search participants"><span id="ciCount" class="count"></span><button type="button" class="clr" data-act="ciClear" aria-label="Clear search">×</button></div>
      <div class="segscroll"><div class="chips" role="group" aria-label="Filter by status">${segs.map(([v, l]) => `<button data-act="ciF" data-v="${v}" aria-pressed="${UI.filter === v}">${l}</button>`).join('')}</div></div>
    </div>
    <div id="ciSelHead"></div>
    <div id="ciList"></div><div class="more" id="ciMore"></div>`;
  },
  update() {
    const P = S.P;
    const exp = P.filter(p => p.elig && p.src !== 'walkin').length;
    const inn = P.filter(p => p.s === 'in').length, out = P.filter(p => p.s === 'out').length, wk = P.filter(p => p.src === 'walkin' && p.s).length;
    const arrived = P.filter(p => p.elig && p.src !== 'walkin' && p.s).length;
    const mineGs = role() === 'counselor' ? myGroups() : role() === 'ac' ? Object.values(S.org.groups).filter(g => myCompanies().some(c => c.id === g.companyId)) : [];
    if (mineGs.length) { // counselors and ACs: live numbers for their own group or company first
      const ids = new Set(mineGs.map(g => g.id)), M = P.filter(p => p.g && ids.has(p.g) && (p.inc || p.s));
      const mIn = M.filter(p => p.s === 'in').length, mOut = M.filter(p => p.s === 'out').length, mArr = M.filter(p => p.s).length;
      const cos = uniq(mineGs.map(g => g.companyId)).map(id => S.org.companies[id]).filter(Boolean);
      $('#ciEye').textContent = role() === 'counselor' ? `Your group${mineGs.length > 1 ? 's' : ''} · ${mineGs.map(g => 'G' + g.num).join(', ')} · live` : `Your company · ${cos.map(c => 'Company ' + c.num).join(', ')} · live`;
      $('#ciNum').textContent = mIn; $('#ciOf').textContent = `of ${M.length} checked in`;
      $('#ciProg').style.width = pct(mArr, M.length) + '%';
      const perG = role() === 'ac' ? `<div class="ci-mine">${mineGs.sort((a, b) => a.gender.localeCompare(b.gender) || a.num - b.num).map(g => { const gp = M.filter(p => p.g === g.id), gi = gp.filter(p => p.s === 'in').length; return `<span class="ci-g ${gi === gp.length && gp.length ? 'full' : ''}"><b>G${g.num}</b> ${gi}/${gp.length}</span>`; }).join('')}</div>` : '';
      $('#ciK').innerHTML = `<span class="hstat y"><b>${M.length - mArr}</b> not here yet</span><span class="hstat"><b>${mOut}</b> checked out</span><span class="hstat"><b>${inn}</b> in the whole session</span>${perG}`;
    } else {
    $('#ciNum').textContent = inn; $('#ciOf').textContent = `checked in · ${exp} expected`;
    $('#ciProg').style.width = pct(arrived, exp) + '%';
    $('#ciK').innerHTML = `<span class="hstat y"><b>${pct(arrived, exp)}%</b> arrived</span><span class="hstat"><b>${exp - arrived}</b> not here yet</span><span class="hstat"><b>${wk}</b> walk-ins</span><span class="hstat"><b>${out}</b> checked out</span>`;
    }
    const toks = UI.q.toLowerCase().split(/\s+/).filter(Boolean);
    const browsing = !toks.length && !UI.stake && UI.filter === 'all';
    // selection header (a stake or a unit is open)
    if (UI.stake) {
      const inSel = P.filter(p => (p.inc || p.s) && areaOf(p).st === UI.stake && (!UI.unit || areaOf(p).un === UI.unit));
      const units = uniq(P.filter(p => (p.inc || p.s) && areaOf(p).st === UI.stake).map(p => areaOf(p).un)).sort();
      $('#ciSelHead').innerHTML = `<section class="panel ci-sel"><div class="ci-sel-top"><button class="btn small" data-act="ciBack">‹ All stakes</button><button class="btn primary" data-act="ciPrint" data-stake="${esc(UI.stake)}" data-unit="${esc(UI.unit)}">${ICONS.print}Print check-in form</button></div>
        <div><p class="th">${UI.unit ? esc(UI.stake) : 'Stake / district'}</p><h2>${esc(UI.unit || UI.stake)}</h2><small class="muted">${inSel.length} participants · ${inSel.filter(p => p.s === 'in').length} checked in${UI.unit ? '' : ' · ' + units.length + ' wards and branches'}</small></div>
        ${units.length > 1 ? `<div class="segscroll"><div class="chips">${['', ...units].map(u => `<button data-act="ciPick" data-stake="${esc(UI.stake)}" data-unit="${esc(u)}" aria-pressed="${(UI.unit || '') === u}">${u ? esc(u) : 'All units'}</button>`).join('')}</div></div>` : ''}</section>`;
    } else $('#ciSelHead').innerHTML = '';
    if (browsing) {
      $('#ciCount').textContent = ''; $('#ciMore').innerHTML = '';
      $('#ciList').innerHTML = P.length ? areaBrowser() : `<div class="empty"><h3>No participants yet</h3>${can.admin() ? 'Upload the FSY portal export on the Data & areas tab to start.' : 'The registration admin has not uploaded participants yet.'}</div>`;
      return;
    }
    let list = P.filter(p => {
      if (UI.filter === 'arrive' && p.s) return false;
      if (UI.filter === 'in' && p.s !== 'in') return false;
      if (UI.filter === 'out' && p.s !== 'out') return false;
      if (UI.filter === 'mine' && !inMine(p)) return false;
      if (UI.stake && areaOf(p).st !== UI.stake) return false;
      if (UI.unit && areaOf(p).un !== UI.unit) return false;
      if (UI.stake && !toks.length && !(p.inc || p.s)) return false;
      if (toks.length) { const hay = (p.name + ' ' + (p.pref || '') + ' ' + p.unit + ' ' + p.stake + ' ' + p.id + ' ' + (p.group ? 'g' + p.group.num : '') + ' ' + (p.phone || '')).toLowerCase(); return toks.every(t => hay.includes(t)); }
      return true;
    });
    if (UI.filter === 'arrive' && !toks.length) list = list.filter(p => p.elig);
    const lim = UI.stake ? 400 : UI.limit, shown = list.slice(0, lim);
    $('#ciCount').textContent = toks.length ? list.length + (list.length === 1 ? ' match' : ' matches') : '';
    $('#ciList').innerHTML = shown.length ? `<div class="cards">${shown.map(pCard).join('')}</div>` : `<div class="empty"><h3>No one matches</h3>Try fewer letters, or switch the filter to Everyone. Someone who is not on the list can be added as a walk-in.</div>`;
    $('#ciMore').innerHTML = list.length > lim ? `<button class="btn" data-act="ciMore">Show more (${list.length - lim} left)</button>` : '';
  }
};
const NO_STAKE = '(No stake given)', NO_UNIT = '(No ward or branch given)';
function areaOf(p) { return { st: p.stake || NO_STAKE, un: p.unit || NO_UNIT }; }
function areaBrowser() {
  const T = {};
  S.P.filter(p => p.inc || p.s).forEach(p => { const { st, un } = areaOf(p); const x = T[st] = T[st] || { n: 0, inn: 0, u: {} }; const u = x.u[un] = x.u[un] || { n: 0, inn: 0 }; x.n++; u.n++; if (p.s === 'in') { x.inn++; u.inn++; } });
  const open = UI.ciOpen || (UI.ciOpen = new Set());
  const row = (kind, name, v, st, un, sub) => `<div class="ar ${kind}${v.n && v.inn >= v.n ? ' done' : ''}">
      <button class="ar-name" data-act="${kind === 'st' ? 'ciToggle' : 'ciPick'}" data-stake="${esc(st)}" data-unit="${esc(un || '')}">${kind === 'st' ? `<span class="caret">${open.has(st) ? '▾' : '▸'}</span>` : ''}<span class="ar-t"><b>${esc(name)}</b>${sub ? `<small>${sub}</small>` : ''}<span class="bar"><i style="width:${pct(v.inn, v.n)}%"></i></span></span></button>
      <span class="ar-num"><b>${v.inn}</b>/${v.n}</span>
      <button class="ar-print" data-act="ciPrint" data-stake="${esc(st)}" data-unit="${esc(un || '')}" aria-label="Print check-in form for ${esc(name)}" title="Print check-in form">${ICONS.print}</button></div>`;
  let h = `<section class="panel ci-areas"><div class="panel-head"><h2>Stakes & districts</h2><small class="muted">Checked in / registered</small></div><div class="area-list">`;
  for (const st of Object.keys(T).sort()) {
    const x = T[st]; const nu = Object.keys(x.u).length;
    h += row('st', st, x, st, '', `${nu} ward${nu === 1 ? '' : 's'} and branch${nu === 1 ? '' : 'es'}`);
    if (open.has(st)) {
      h += `<button class="ar-all" data-act="ciPick" data-stake="${esc(st)}" data-unit="">See everyone in ${esc(st)} (${x.n}) ›</button>`;
      for (const un of Object.keys(x.u).sort()) h += row('un', un, x.u[un], st, un, '');
    }
  }
  return h + `</div><p class="note" style="margin:10px 0 0">Tap a stake to see its wards and branches, then a unit to check its youth in. Use search above to find anyone by name.</p></section>`;
}
function ciRow(p, showUnit) {
  const ck = can.checkin();
  const tee = p.tshirt ? esc(p.tshirt) : esc(((S.tee && S.tee.perPerson[p.id]) || '?')) + ' est.';
  const act = !ck ? '' : p.s === 'in' ? `<span class="pill in">In ${esc(fmtTime(p.ti))}</span><button class="btn small" data-act="ciUndo" data-id="${esc(p.id)}">Undo</button>`
    : p.s === 'out' ? `<span class="pill out">Out</span><button class="btn small go" data-act="ciIn" data-id="${esc(p.id)}">Check in</button>`
    : `<button class="btn go" data-act="ciIn" data-id="${esc(p.id)}">Check in</button>`;
  const issues = seesPrivate(p) ? (p.medIssue ? ' <span class="chip warn">Med</span>' : '') + (p.dietIssue ? ' <span class="chip warn">Diet</span>' : '') : '';
  return `<div class="crow st-${p.s || 'none'}"><button class="crow-name" data-act="detail" data-id="${esc(p.id)}"><b>${esc(p.name)}</b>${issues}<small>${p.age ?? '?'} yrs · ${p.gender === 'F' ? 'Female' : p.gender === 'M' ? 'Male' : '?'} · ${p.group ? 'G' + p.group.num + (p.company ? ' · Co ' + p.company.num : '') : 'No group yet'} · Size ${tee}</small>${showUnit ? `<small>${esc(p.unit || '—')} · ${esc(p.stake || '—')}</small>` : ''}${p.flags.some(f => ['walkin', 'area', 'status', 'pending'].includes(f)) ? `<span class="flags">${flagChips(p, ['walkin', 'area', 'status', 'pending'])}</span>` : ''}</button><div class="crow-act">${act}</div></div>`;
}

/* printable check-in form (PDF) */
function loadScript(src) { return new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = rej; document.head.appendChild(el); }); }
async function loadPdfLib() {
  if (window.PDFLib) return window.PDFLib;
  try { await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js'); } catch (e) { await loadScript('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'); }
  return window.PDFLib;
}
async function logoPngBytes() {
  const img = new Image(); img.src = 'assets/mark-light.webp'; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/png')); return new Uint8Array(await blob.arrayBuffer());
}
function pdfSafe(t) { return String(t == null ? '' : t).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, ''); }
async function printForm(stake, unit) {
  const people = S.P.filter(p => (p.inc || p.s) && areaOf(p).st === stake && (!unit || areaOf(p).un === unit));
  if (!people.length) { toast('There is nobody to print for this selection.', true); return; }
  toast('Preparing the check-in form…');
  let L; try { L = await loadPdfLib(); } catch (e) { toast('Could not load the PDF tool. Check your connection and try again.', true); return; }
  const { PDFDocument, StandardFonts, rgb } = L;
  const C = h => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  const doc = await PDFDocument.create();
  const sess = (!S.config.sessionName || S.config.sessionName === 'FSY Kenya 2') ? 'FSY Kenya 2nd 2026' : S.config.sessionName;
  doc.setTitle(pdfSafe(`${sess} check-in form - ${unit || stake}`)); doc.setAuthor(pdfSafe(sess)); doc.setCreator('FSY Check-in');
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let logo = null; try { logo = await doc.embedPng(await logoPngBytes()); } catch (e) { console.warn('logo', e); }
  const W = 595.28, H = 841.89, M = 36, ROW = 21;
  const fit = (t, f, size, max) => { t = pdfSafe(t); if (f.widthOfTextAtSize(t, size) <= max) return t; while (t.length > 1 && f.widthOfTextAtSize(t + '...', size) > max) t = t.slice(0, -1); return t + '...'; };
  const COLS = { num: M + 4, name: M + 34, age: M + 340, gender: M + 388, box: W - M - 70 };
  const printed = new Date().toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const byUnit = {}; people.forEach(p => (byUnit[areaOf(p).un] = byUnit[areaOf(p).un] || []).push(p));
  const unitNames = Object.keys(byUnit).sort();
  const pages = [];
  const startPage = (un, n, cont) => {
    const pg = doc.addPage([W, H]); pages.push(pg);
    const bandH = 84, top = H - M;
    pg.drawRectangle({ x: M, y: top - bandH, width: W - 2 * M, height: bandH, color: C('#f6faf4') });
    pg.drawRectangle({ x: M, y: top - bandH - 4, width: W - 2 * M, height: 4, color: C('#fcb449') });
    let tx = M + 16;
    if (logo) { const s = 62; pg.drawImage(logo, { x: M + 10, y: top - bandH + (bandH - s) / 2, width: s, height: s }); tx = M + 84; }
    pg.drawText(pdfSafe(`${sess.toUpperCase()}  -  CHECK-IN FORM`), { x: tx, y: top - 22, size: 8, font: bold, color: C('#007da5') });
    pg.drawText(fit(un + (cont ? ' (continued)' : ''), bold, 19, W - M - tx - 120), { x: tx, y: top - 46, size: 19, font: bold, color: C('#002846') });
    pg.drawText(fit(stake, font, 11.5, W - M - tx - 120), { x: tx, y: top - 64, size: 11.5, font, color: C('#005175') });
    const rt = `${n} participant${n === 1 ? '' : 's'}`; pg.drawText(rt, { x: W - M - 14 - bold.widthOfTextAtSize(rt, 11), y: top - 46, size: 11, font: bold, color: C('#002846') });
    const pr = pdfSafe('Printed ' + printed); pg.drawText(pr, { x: W - M - 14 - font.widthOfTextAtSize(pr, 8), y: top - 62, size: 8, font, color: C('#4f6f84') });
    let y = top - bandH - 30;
    pg.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 22, color: C('#005175') });
    const hd = (t, x) => pg.drawText(t, { x, y: y + 1, size: 9, font: bold, color: C('#ffffff') });
    hd('#', COLS.num); hd('NAME', COLS.name); hd('AGE', COLS.age); hd('GENDER', COLS.gender); hd('CHECKED IN', COLS.box - 8);
    return { pg, y: y - 6 - ROW };
  };
  for (const un of unitNames) {
    const list = byUnit[un].slice().sort((a, b) => a.name.localeCompare(b.name));
    let { pg, y } = startPage(un, list.length, false);
    list.forEach((p, i) => {
      if (y < M + 70) ({ pg, y } = startPage(un, list.length, true));
      if (i % 2 === 1) pg.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: ROW, color: C('#f6faf4') });
      pg.drawLine({ start: { x: M, y: y - 6 }, end: { x: W - M, y: y - 6 }, thickness: 0.5, color: C('#d2e5ee') });
      pg.drawText(String(i + 1), { x: COLS.num + 14 - font.widthOfTextAtSize(String(i + 1), 9.5), y, size: 9.5, font, color: C('#4f6f84') });
      pg.drawText(fit(p.name, bold, 10.5, COLS.age - COLS.name - 10), { x: COLS.name, y, size: 10.5, font: bold, color: C('#002846') });
      pg.drawText(p.age != null ? String(p.age) : '-', { x: COLS.age, y, size: 10, font, color: C('#002846') });
      pg.drawText(p.gender === 'F' ? 'Female' : p.gender === 'M' ? 'Male' : '-', { x: COLS.gender, y, size: 10, font, color: C('#002846') });
      pg.drawRectangle({ x: COLS.box + 12, y: y - 2, width: 12, height: 12, borderColor: C('#005175'), borderWidth: 1.2, color: C('#ffffff') });
      y -= ROW;
    });
    if (y < M + 70) ({ pg, y } = startPage(un, list.length, true));
    y -= 18;
    pg.drawText(pdfSafe(`Checked in: ________ of ${list.length}`), { x: M + 4, y, size: 10.5, font: bold, color: C('#002846') });
    pg.drawText('Checked by: ______________________________', { x: M + 230, y, size: 10.5, font, color: C('#002846') });
  }
  pages.forEach((pg, i) => {
    const t = pdfSafe(`${sess}  -  ${unit || stake}`), pn = `Page ${i + 1} of ${pages.length}`;
    pg.drawLine({ start: { x: M, y: M + 14 }, end: { x: W - M, y: M + 14 }, thickness: 0.5, color: C('#cfe3ec') });
    pg.drawText(fit(t, font, 8, W - 2 * M - 80), { x: M, y: M, size: 8, font, color: C('#4f6f84') });
    pg.drawText(pn, { x: W - M - font.widthOfTextAtSize(pn, 8), y: M, size: 8, font, color: C('#4f6f84') });
  });
  const bytes = await doc.save();
  const name = pdfSafe(`Check-in form - ${unit ? unit + ' - ' : ''}${stake}.pdf`).replace(/[\\/:*?"<>|]+/g, '');
  await S.dl.save({ filename: name, data: new Blob([bytes], { type: 'application/pdf' }) });
  toast(`Check-in form ready: ${people.length} participants${unitNames.length > 1 ? ' in ' + unitNames.length + ' units' : ''}`);
}
/** Printable staff list (A4) for one role, grouped by stake or district and then ward or branch. */
async function printStaffList(role, onlyStake) {
  const list = S.staffList.filter(s => s.role === role && (!onlyStake || (s.stake || NO_STAFF_STAKE) === onlyStake));
  if (!list.length) { toast('There is nobody to print for this selection.', true); return; }
  toast('Preparing the list…');
  let L; try { L = await loadPdfLib(); } catch (e) { toast('Could not load the PDF tool. Check your connection and try again.', true); return; }
  const { PDFDocument, StandardFonts, rgb } = L;
  const C = h => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  const doc = await PDFDocument.create();
  const sess = (!S.config.sessionName || S.config.sessionName === 'FSY Kenya 2') ? 'FSY Kenya 2nd 2026' : S.config.sessionName;
  const PLR = ROLE_PLURAL[role] || ROLES[role];
  doc.setTitle(pdfSafe(`${sess} - ${PLR} - ${onlyStake || 'all stakes and districts'}`)); doc.setAuthor(pdfSafe(sess)); doc.setCreator('FSY Check-in');
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let logo = null; try { logo = await doc.embedPng(await logoPngBytes()); } catch (e) { console.warn('logo', e); }
  const W = 595.28, H = 841.89, M = 36, ROW = 19;
  const fit = (t, f, size, max) => { t = pdfSafe(t); if (f.widthOfTextAtSize(t, size) <= max) return t; while (t.length > 1 && f.widthOfTextAtSize(t + '...', size) > max) t = t.slice(0, -1); return t + '...'; };
  const X = { num: M + 4, name: M + 30, gender: M + 228, age: M + 278, phone: M + 312, size: M + 400, food: M + 438 };
  const printed = new Date().toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const T = staffByArea(list); const pages = [];
  let pg, y, curStake;
  const colHead = () => {
    pg.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 20, color: C('#005175') });
    const hd = (t, x) => pg.drawText(t, { x, y: y, size: 8.5, font: bold, color: C('#ffffff') });
    hd('#', X.num); hd('NAME', X.name); hd('GENDER', X.gender); hd('AGE', X.age); hd('PHONE', X.phone); hd('SIZE', X.size); hd('FOOD NEEDS', X.food);
    y -= ROW + 4;
  };
  const newPage = (stake, cont) => {
    pg = doc.addPage([W, H]); pages.push(pg); curStake = stake;
    const bandH = 78, top = H - M;
    pg.drawRectangle({ x: M, y: top - bandH, width: W - 2 * M, height: bandH, color: C('#f6faf4') });
    pg.drawRectangle({ x: M, y: top - bandH - 4, width: W - 2 * M, height: 4, color: C('#fcb449') });
    let tx = M + 16;
    if (logo) { const s = 58; pg.drawImage(logo, { x: M + 10, y: top - bandH + (bandH - s) / 2, width: s, height: s }); tx = M + 80; }
    pg.drawText(pdfSafe(`${sess.toUpperCase()}  -  ${PLR.toUpperCase()}`), { x: tx, y: top - 22, size: 8, font: bold, color: C('#007da5') });
    pg.drawText(fit(stake + (cont ? ' (continued)' : ''), bold, 17, W - M - tx - 110), { x: tx, y: top - 45, size: 17, font: bold, color: C('#002846') });
    const n = Object.values(T[stake]).reduce((a, l) => a + l.length, 0);
    pg.drawText(pdfSafe(`${n} ${n === 1 ? PLR.toLowerCase().replace(/s$/, '') : PLR.toLowerCase()} in ${Object.keys(T[stake]).length} ward${Object.keys(T[stake]).length === 1 ? '' : 's'} or branch${Object.keys(T[stake]).length === 1 ? '' : 'es'}`), { x: tx, y: top - 62, size: 10, font, color: C('#005175') });
    const pr = pdfSafe('Printed ' + printed); pg.drawText(pr, { x: W - M - 14 - font.widthOfTextAtSize(pr, 8), y: top - 22, size: 8, font, color: C('#4f6f84') });
    y = top - bandH - 28; colHead();
  };
  for (const st of Object.keys(T).sort(areaSort)) {
    newPage(st, false);
    for (const un of Object.keys(T[st]).sort(areaSort)) {
      const people = T[st][un];
      if (y < M + 60 + ROW * Math.min(2, people.length)) { newPage(st, true); }
      pg.drawText(fit(un, bold, 11, W - 2 * M - 60), { x: M + 4, y, size: 11, font: bold, color: C('#002846') });
      const cnt = String(people.length); pg.drawText(cnt, { x: W - M - 6 - bold.widthOfTextAtSize(cnt, 11), y, size: 11, font: bold, color: C('#007da5') });
      pg.drawLine({ start: { x: M, y: y - 5 }, end: { x: W - M, y: y - 5 }, thickness: 1, color: C('#fcb449') });
      y -= ROW + 2;
      people.forEach((s, i) => {
        if (y < M + 40) { newPage(st, true); pg.drawText(fit(un + ' (continued)', bold, 11, W - 2 * M), { x: M + 4, y, size: 11, font: bold, color: C('#002846') }); y -= ROW + 2; }
        if (i % 2 === 1) pg.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: ROW, color: C('#f6faf4') });
        const a = staffAge(s, S.config);
        pg.drawText(String(i + 1), { x: X.num + 12 - font.widthOfTextAtSize(String(i + 1), 9), y, size: 9, font, color: C('#4f6f84') });
        pg.drawText(fit(s.name, bold, 9.5, X.gender - X.name - 8), { x: X.name, y, size: 9.5, font: bold, color: C('#002846') });
        pg.drawText(s.gender === 'F' ? 'Female' : s.gender === 'M' ? 'Male' : '-', { x: X.gender, y, size: 9, font, color: C('#002846') });
        pg.drawText(a != null ? String(a) : '-', { x: X.age, y, size: 9, font, color: C('#002846') });
        pg.drawText(fit(s.phone || '-', font, 9, X.size - X.phone - 6), { x: X.phone, y, size: 9, font, color: C('#002846') });
        pg.drawText(fit(s.tshirt || '-', font, 9, X.food - X.size - 6), { x: X.size, y, size: 9, font, color: C('#002846') });
        pg.drawText(fit(s.diet || '', font, 8.5, W - M - X.food - 4), { x: X.food, y, size: 8.5, font, color: C('#a8452b') });
        y -= ROW;
      });
      y -= 10;
    }
  }
  pages.forEach((p, i) => {
    const t = pdfSafe(`${sess}  -  ${PLR}`), pn = `Page ${i + 1} of ${pages.length}`;
    p.drawLine({ start: { x: M, y: M + 14 }, end: { x: W - M, y: M + 14 }, thickness: 0.5, color: C('#cfe3ec') });
    p.drawText(fit(t, font, 8, W - 2 * M - 80), { x: M, y: M, size: 8, font, color: C('#4f6f84') });
    p.drawText(pn, { x: W - M - font.widthOfTextAtSize(pn, 8), y: M, size: 8, font, color: C('#4f6f84') });
  });
  const bytes = await doc.save();
  const name = pdfSafe(`${PLR} - ${onlyStake || 'all stakes'}.pdf`).replace(/[\\/:*?"<>|]+/g, '');
  await S.dl.save({ filename: name, data: new Blob([bytes], { type: 'application/pdf' }) });
  toast(`List ready: ${list.length} ${PLR.toLowerCase()}`);
}
function pCard(p) {
  const st = p.s === 'in' ? `<span class="pill in">In ${esc(fmtTime(p.ti))}</span>` : p.s === 'out' ? `<span class="pill out">Out ${esc(fmtTime(p.to))}</span>` : '<span class="pill none">Not arrived</span>';
  const issues = !seesPrivate(p) ? '' : (p.medIssue ? '<span class="chip warn">Medical</span>' : '') + (p.dietIssue ? '<span class="chip warn">Diet</span>' : '');
  const ck = can.checkin();
  const acts = !ck ? '' : p.s === 'in' ? `<button class="btn" data-act="ciUndo" data-id="${esc(p.id)}">Undo</button><button class="btn" data-act="ciOut" data-id="${esc(p.id)}">Check out</button>` : p.s === 'out' ? `<button class="btn go" data-act="ciIn" data-id="${esc(p.id)}">Check in again</button>` : `<button class="btn go" data-act="ciIn" data-id="${esc(p.id)}">Check in</button>`;
  const tee = p.tshirt ? esc(SIZE_LABEL[p.tshirt] || p.tshirt) : `<span class="est">${esc(SIZE_LABEL[(S.tee && S.tee.perPerson[p.id]) || ''] || 'Not given')}</span> <small class="muted">est.</small>`;
  return `<article class="pcard st-${p.s || 'none'}">
    <div class="pc-top"><div style="min-width:0"><h3>${esc(p.name)}</h3><div class="sub"><span class="chip">${p.age != null ? p.age + ' yrs' : 'Age ?'}</span>${chipG(p.gender)}${chipBand(p.band)}${issues}</div></div>${st}</div>
    <div class="pc-lines">
      <div><span class="k">Group</span><span>${p.group ? '<b>G' + p.group.num + '</b> · ' + esc(p.counselor ? p.counselor.name : 'No counselor') + (p.company ? ' · <b>Co ' + p.company.num + '</b>' : '') : '<span class="muted">Not assigned yet</span>'}</span></div>
      <div><span class="k">Unit</span><span>${esc(p.unit || '—')}<span class="muted"> · ${esc(p.stake || '—')}</span></span></div>
      <div><span class="k">Size</span><span>${tee}</span></div>
    </div>
    ${(p.flags.length || p.ov) && flagChips(p, ['walkin', 'area', 'status', 'pending', 'gender', 'age', 'agerange']) ? `<div class="flags">${flagChips(p, ['walkin', 'area', 'status', 'pending', 'gender', 'age', 'agerange'])}</div>` : ''}
    ${repChip(p)}<div class="pc-actions">${acts}${can.report() && seesPrivate(p) ? `<button class="btn" data-act="repNew" data-id="${esc(p.id)}" style="flex:0 0 auto" title="Report a health concern">Health</button>` : ''}<button class="btn" data-act="detail" data-id="${esc(p.id)}" style="flex:0 0 auto">Details</button></div></article>`;
}

/* page: tally */
PAGE_IMPL.tally = {
  frame() { return `<section class="pagehead"><div><h1>Tally</h1><p class="note" style="margin:4px 0 0">Live counts for the session, each stake and each ward or branch. Tap a stake to see its units.</p></div><button class="btn" data-act="tallyCsv">Export CSV</button></section><div id="tK" class="kpis"></div><div class="panel"><div class="panel-head"><h2>Everyone at the session</h2></div><div id="tAll"></div></div><div class="grid2"><div class="panel"><h2>By age group and gender</h2><div id="tBG"></div></div><div class="panel"><h2>By company</h2><div id="tCo"></div></div></div><div class="panel"><h2>By stake, ward and branch</h2><div id="tSt"></div></div>`; },
  update() {
    const P = S.P;
    const exp = p => p.elig && p.src !== 'walkin';
    const T = { exp: P.filter(exp).length, inn: P.filter(p => p.s === 'in').length, out: P.filter(p => p.s === 'out').length, arrived: P.filter(p => exp(p) && p.s).length, wk: P.filter(p => p.src === 'walkin' && p.s).length, exc: P.filter(p => !p.inc && p.s).length };
    $('#tK').innerHTML = `<div class="kpi hero"><span>Checked in now</span><b>${T.inn}</b></div><div class="kpi"><span>Expected</span><b>${T.exp}</b></div><div class="kpi"><span>Everyone, with staff</span><b>${P.filter(p => exp(p) || (p.src === 'walkin' && p.s)).length + S.staffList.filter(x => !x.test).length}</b></div><div class="kpi"><span>Arrived of expected</span><b>${T.arrived} <small class="muted">${pct(T.arrived, T.exp)}%</small></b></div><div class="kpi"><span>Not arrived</span><b>${T.exp - T.arrived}</b></div><div class="kpi"><span>Walk-ins</span><b>${T.wk}</b></div><div class="kpi"><span>From excluded list</span><b>${T.exc}</b></div><div class="kpi"><span>Checked out</span><b>${T.out}</b></div>`;
    const ST = S.staffList.filter(x => !x.test);
    const gc = (list, g) => list.filter(x => x.gender === g).length;
    const yp = P.filter(p => exp(p) || (p.src === 'walkin' && p.s));
    const rowsAll = [['Participants expected', P.filter(exp)], ['Walk-ins checked in', P.filter(p => p.src === 'walkin' && p.s)]].map(([l, L]) => [l, gc(L, 'F'), gc(L, 'M'), L.length])
      .concat(STAFF_ROLES.map(r => { const L = ST.filter(x => x.role === r); return [ROLE_PLURAL[r], gc(L, 'F'), gc(L, 'M'), L.length]; }));
    const stN = ST.length, allN = yp.length + stN;
    $('#tAll').innerHTML = `<div class="tablewrap"><table><thead><tr><th></th><th class="n">Women</th><th class="n">Men</th><th class="n">Total</th></tr></thead><tbody>${rowsAll.map(([l, f, m, t], i) => `<tr${i === 2 ? ' class="divide"' : ''}><td>${esc(l)}</td><td class="n">${f}</td><td class="n">${m}</td><td class="n"><b>${t}</b></td></tr>`).join('')}
      <tr class="subtot"><td><b>Youth</b></td><td class="n">${gc(yp, 'F')}</td><td class="n">${gc(yp, 'M')}</td><td class="n"><b>${yp.length}</b></td></tr><tr class="subtot"><td><b>Staff</b></td><td class="n">${gc(ST, 'F')}</td><td class="n">${gc(ST, 'M')}</td><td class="n"><b>${stN}</b></td></tr>
      <tr class="total"><td>Everyone</td><td class="n">${gc(yp, 'F') + gc(ST, 'F')}</td><td class="n">${gc(yp, 'M') + gc(ST, 'M')}</td><td class="n">${allN}</td></tr></tbody></table></div><p class="note">Youth expected plus walk-ins, and every staff member on the Staff page (test staff left out). ${ST.filter(x => !x.gender).length ? `${ST.filter(x => !x.gender).length} staff with no gender are only in the totals.` : ''}</p>`;
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

/* Repeated checks (one line per group) fold into a single line that opens to show them. */
const CHECK_KINDS = [[/^Group \d+ has \d+ participants/, n => `${n} groups are over the group size`], [/^Group \d+ has no counselor/, n => `${n} groups have no counselor`], [/^Group \d+ is not in a company/, n => `${n} groups are not in a company`], [/^Company \d+ has no assistant/, n => `${n} companies have no assistant coordinator`], [/^Company \d+ does not have both/, n => `${n} companies do not have both young men and young women`]];
function checksList(w) {
  const li = ([lv, t]) => `<li><span class="chip ${lv}">${lv === 'bad' ? 'Fix' : 'Check'}</span><span>${esc(t)}</span></li>`;
  const out = [], kinds = {};
  w.forEach(x => { const k = CHECK_KINDS.findIndex(([re]) => re.test(x[1])); if (k < 0) out.push(['one', x]); else { if (!kinds[k]) { kinds[k] = []; out.push(['many', k]); } kinds[k].push(x); } });
  return `<ul class="warnlist">${out.map(([t, x]) => {
    if (t === 'one') return li(x);
    const list = kinds[x]; if (list.length < 3) return list.map(li).join('');
    const lv = list.some(y => y[0] === 'bad') ? 'bad' : 'warn';
    return `<li class="wgroup"><details><summary><span class="chip ${lv}">${lv === 'bad' ? 'Fix' : 'Check'}</span><span>${esc(CHECK_KINDS[x][1](list.length))}</span></summary><ul class="warnlist sub">${list.map(li).join('')}</ul></details></li>`;
  }).join('')}</ul>`;
}

/* page: companies */
PAGE_IMPL.companies = {
  frame() {
    // counselors and ACs land on their own group or company, with a counselor's group list already open
    if (!UI.coMineSet && ['counselor', 'ac'].includes(role())) { UI.coMineSet = true; UI.band = 'mine'; if (role() === 'counselor') myGroups().forEach(g => UI.open.add(g.id)); }
    const adm = can.orgEdit();
    return `<section class="pagehead"><div><h1>Companies & groups</h1><p class="note" style="margin:4px 0 0">Groups of ${gsize(S.config, 'F') === gsize(S.config, 'M') ? esc(gsize(S.config, 'F')) : `${gsize(S.config, 'F')} young women or ${gsize(S.config, 'M')} young men`} share a gender and age group, each led by a counselor of the same gender. Companies keep 13–15 and 16–18 apart and mix young men and young women.</p></div>
    <div class="btnrow">${adm ? `<button class="btn primary" data-act="rebalance">Rebalance, keep groups</button><button class="btn" data-act="renumber">Renumber groups by company</button><button class="btn" data-act="regen">Regenerate all</button><button class="btn" data-act="addCo">Add company</button>` : ''}<button class="btn" data-act="rosterCsv">Export rosters</button></div></section>
    ${adm ? foldSec('co-sizes', 'Group sizes', 'coSizeN', '', '<div id="coSizes"></div>') : ''}
    <div id="coLog"></div><div class="co-top"><div class="panel"><h2>Leadership</h2><div id="coChart"></div></div><details class="panel checks" id="coChecks" ${UI.checksOpen === false ? '' : 'open'}><summary><h2>Checks</h2><span id="coWarnSum" class="checks-sum"></span></summary><div id="coWarn"></div></details></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Age group">${[['', 'All companies'], ['Y', '13–15'], ['O', '16–18']].concat(['ac', 'counselor'].includes(role()) ? [['mine', 'Mine']] : []).map(([v, l]) => `<button data-act="coBand" data-v="${v}" aria-pressed="${UI.band === v}">${l}</button>`).join('')}</div><input id="coQ" class="co-q" type="search" placeholder="Find a counselor, AC, youth, group (G12) or company (Co 3)" autocomplete="off" value="${esc(UI.coQ || '')}"></div>
    <div id="coFind"></div><div id="coGrid" class="companies"></div>
    ${can.reset() ? resetPanel() : ''}`;
  },
  update() {
    const G = S.org.groups, C = S.org.companies, adm = can.orgEdit();
    $('#coLog').innerHTML = (S.orgLock && adm ? `<p class="note lockline">Group numbers are locked${S.orgLock.at ? ' since ' + esc(fmtWhen(S.orgLock.at)) : ''}. Rebalance keeps them; new groups take free numbers first.</p>` : '') + (UI.genLog ? `<div class="log"><button class="x log-x" data-act="logClose" aria-label="Dismiss">×</button><b>${esc(UI.genLog.title)}</b><ul>${UI.genLog.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '');
    const by = r => S.staffList.filter(s => s.role === r);
    const node = (s, extra) => `<div class="node"><b>${esc(s.name)}</b>${extra || ''}</div>`;
    const acs = by('ac'), acUsed = new Set(Object.values(C).map(c => c.acId));
    // counselors without a group, and why
    const ledIds = new Set(Object.values(G).map(g => g.counselorId).filter(Boolean)), shadowC = shadowedCounselors(S.staffList);
    const memN = {}; S.P.forEach(p => { if (p.g) memN[p.g] = (memN[p.g] || 0) + 1; });
    const spare = by('counselor').filter(c => !ledIds.has(c.id)).map(c => {
      if (c.test) return [c, 'test record'];
      if (shadowC[c.id]) return [c, `extra record: also listed as ${ROLES[shadowC[c.id].role].toLowerCase()}. Delete this record on the Staff page`];
      if (!c.gender) return [c, 'no gender on their record, so they cannot be matched to a group. Add it on the Staff page'];
      const sizeN = gsize(S.config, c.gender); const over = Object.values(G).filter(g => g.gender === c.gender && (memN[g.id] || 0) > sizeN).length;
      return [c, over ? `${over} ${c.gender === 'F' ? "young women's" : "young men's"} group(s) are over ${sizeN}. Press Rebalance to give them a group` : `spare: every ${c.gender === 'F' ? "young women's" : "young men's"} group already has ${sizeN} or fewer. Available as a reserve or to swap in`];
    }).sort((a, b) => a[1].localeCompare(b[1]) || a[0].name.localeCompare(b[0].name));
    $('#coChart').innerHTML = `<div class="orgchart lead-grid"><div class="lead-col"><div class="tierlabel">Session Directing Couple</div><div class="tier">${by('sdc').map(s => node(s, `<small class="muted">${s.gender === 'F' ? 'Sister' : s.gender === 'M' ? 'Brother' : ''}</small>`)).join('') || '<span class="muted">Not added yet</span>'}</div>
</div>
      <div class="lead-col"><div class="tierlabel">Coordinators</div><div class="tier">${by('coordinator').map(s => node(s, '<small class="muted">All companies</small>')).join('') || '<span class="muted">Not added yet</span>'}</div>
</div>
      <div class="lead-col lead-wide"><div class="tierlabel">Assistant coordinators and counselors</div><div class="tier stat-tier">
        <div class="statnode"><div class="sn-top"><b>${acs.length}</b><span>assistant coordinators</span></div><ul><li><b>${acs.filter(a => acUsed.has(a.id)).length}</b> lead a company</li><li class="${acs.filter(a => !acUsed.has(a.id)).length ? 'warn' : ''}"><b>${acs.filter(a => !acUsed.has(a.id)).length}</b> spare</li></ul></div>
        <div class="statnode"><div class="sn-top"><b>${by('counselor').length}</b><span>counselors</span></div><ul><li><b>${by('counselor').length - spare.length}</b> lead a group</li><li class="${spare.length ? 'warn' : ''}"><b>${spare.length}</b> without a group${spare.length && can.orgEdit() ? ` <button class="linkbtn" data-act="spareToggle">${UI.spareOpen ? 'Hide reasons' : 'See why'}</button>` : ''}</li></ul></div></div></div>${spare.length && UI.spareOpen && can.orgEdit() ? `<div class="spare-list">${fitHint()}<p class="note" style="margin:10px 0 6px"><b>Why ${spare.length} counselor${spare.length === 1 ? ' has' : 's have'} no group</b></p><ul>${spare.map(([c, why]) => `<li><b>${esc(c.name)}</b> ${c.gender ? chipG(c.gender) : ''} · ${esc(why)}</li>`).join('')}</ul></div>` : ''}</div>`;
    if ($('#coSizes')) {
      $('#coSizeN').textContent = `${gsize(S.config, 'F')} young women · ${gsize(S.config, 'M')} young men`;
      if (!$('#sizeForm')) $('#coSizes').innerHTML = `<form id="sizeForm" class="form size-form"><label>Young women per group<input id="szF" type="number" min="4" max="25" value="${gsize(S.config, 'F')}"></label><label>Young men per group<input id="szM" type="number" min="4" max="25" value="${gsize(S.config, 'M')}"></label><div class="size-go"><button class="btn primary" type="submit">Save sizes</button></div></form><p class="note" style="margin:6px 0 10px">After changing sizes, press <b>Rebalance, keep groups</b>. Groups over the new size get a free counselor of the same gender; nobody already in a group under the size is moved.</p><div id="coFit"></div>`;
      $('#coFit').innerHTML = fitHint();
    }
    let w = validate(S.P, S.org, S.staffMap, S.config);
    const limW = ['counselor', 'ac'].includes(role());
    if (limW) { // counselors and ACs only see checks about their own group or company, worded for passing on
      const gs = role() === 'counselor' ? myGroups() : Object.values(G).filter(g => myCompanies().some(c => c.id === g.companyId));
      const gn = new Set(gs.map(g => g.num)), cn = new Set(role() === 'ac' ? myCompanies().map(c => c.num) : []);
      w = w.filter(([, t]) => { const gm = [...t.matchAll(/\b[Gg]roup (\d+)/g)].map(m => +m[1]); const cm = t.match(/^Company (\d+)/); return gm.some(n => gn.has(n)) || (cm && cn.has(+cm[1])); })
        .map(([lv, t, x]) => [lv, t.replace(/\s*Press Rebalance[^.]*\.?(\s*then[^.]*\.)?/g, '').replace(/,\s*then delete[^.]*\./, '.').trim(), x]);
    }
    $('#coWarnSum').innerHTML = Object.keys(G).length ? (w.length ? `${w.filter(x => x[0] === 'bad').length ? `<span class="chip bad">${w.filter(x => x[0] === 'bad').length} to fix</span>` : ''}${w.filter(x => x[0] !== 'bad').length ? `<span class="chip warn">${w.filter(x => x[0] !== 'bad').length} to check</span>` : ''}` : '<span class="chip good">All good</span>') : '';
    if (limW && Object.keys(G).length) { $('#coWarn').innerHTML = (w.length ? `<p class="note" style="margin:0 0 8px">These affect your ${role() === 'counselor' ? 'group' : 'company'}. Let your coordinator know so they can fix them.</p>` + checksList(w) : `<p><span class="chip good">All good</span> Nothing to report for your ${role() === 'counselor' ? 'group' : 'company'}.</p>`); } else
    $('#coWarn').innerHTML = !Object.keys(G).length ? `<p class="note">No groups yet. ${adm ? 'Upload participants, add counselors and assistant coordinators on the Staff tab (or generate test staff), then press Regenerate all.' : 'The registration admin will generate them.'}</p>` : w.length ? checksList(w) : '<p><span class="chip good">All good</span> Every group and company follows the rules.</p>';
    const mem = {}; for (const id in G) mem[id] = []; S.P.forEach(p => { if (p.g && mem[p.g]) mem[p.g].push(p); });
    let comps = Object.values(C).sort((a, b) => a.num - b.num);
    const lim = ['counselor', 'ac'].includes(role()); if (lim) { const ids = scopeCompanyIds(role(), myStaffId()); comps = comps.filter(c => ids.includes(c.id)); }
    if (UI.band === 'Y' || UI.band === 'O') comps = comps.filter(c => c.band === UI.band);
    if (UI.band === 'mine') { const mineIds = role() === 'counselor' ? myGroups().map(g => g.companyId) : myCompanies().map(c => c.id); comps = comps.filter(c => mineIds.includes(c.id)); }
    // search: an AC shows their whole company; a counselor, youth or group number shows just that group
    const q = (UI.coQ || '').toLowerCase().trim(); let only = null, hits = null, find = '';
    if (q) {
      only = {}; hits = new Set(); const lines = [];
      const has = x => String(x || '').toLowerCase().includes(q);
      const mg = q.match(/^g(?:roup)?\s*(\d+)$/), mc = q.match(/^c(?:o|ompany)?\.?\s*(\d+)$/);
      const all = id => { only[id] = 'all'; };
      const one = (cid, gid) => { if (only[cid] === 'all') return; (only[cid] = only[cid] || new Set()).add(gid); };
      for (const c of Object.values(C)) { const a = S.staffMap[c.acId]; if ((a && has(a.name)) || (mc && +mc[1] === c.num)) { all(c.id); lines.push(a && has(a.name) ? `AC <b>${esc(a.name)}</b> → Company ${c.num} (all ${Object.values(G).filter(g => g.companyId === c.id).length} groups)` : `Company ${c.num}`); } }
      for (const g of Object.values(G)) {
        const cn = S.staffMap[g.counselorId]; const cid = g.companyId && C[g.companyId] ? g.companyId : '_loose';
        if ((cn && has(cn.name)) || (mg && +mg[1] === g.num)) { one(cid, g.id); hits.add(g.id); lines.push(cn && has(cn.name) ? `Counselor <b>${esc(cn.name)}</b> → G${g.num}${C[g.companyId] ? ' · Company ' + C[g.companyId].num : ''}` : `G${g.num}${C[g.companyId] ? ' · Company ' + C[g.companyId].num : ''}`); }
      }
      if (q.length >= 3 && !mg && !mc && !lines.length) { const ys = S.P.filter(p => p.g && G[p.g] && has(p.name)).slice(0, 12); ys.forEach(p => { const g = G[p.g]; one(g.companyId && C[g.companyId] ? g.companyId : '_loose', g.id); hits.add(g.id); lines.push(`Youth <b>${esc(p.name)}</b> → G${g.num}${C[g.companyId] ? ' · Company ' + C[g.companyId].num : ''}`); }); }
      const shq = shadowedCounselors(S.staffList); const sp = S.staffList.filter(s => ['ac', 'counselor'].includes(s.role) && !shq[s.id] && has(s.name) && !Object.values(G).some(g => g.counselorId === s.id) && !Object.values(C).some(c => c.acId === s.id));
      sp.forEach(s => lines.push(`<b>${esc(s.name)}</b> (${esc(ROLES[s.role].toLowerCase())}) has no ${s.role === 'ac' ? 'company' : 'group'} yet`));
      find = `<div class="findbar">${lines.length ? `<b>${lines.length} match${lines.length === 1 ? '' : 'es'}</b><ul>${lines.slice(0, 15).map(l => `<li>${l}</li>`).join('')}</ul>` : `<b>No matches for "${esc(UI.coQ)}"</b>`}<button class="btn small" data-act="coQClear">Clear search</button></div>`;
      comps = comps.filter(c => only[c.id]);
    }
    if (UI.band === 'mine' && role() === 'counselor' && !only) { // a counselor's "Mine" shows just their own group(s), inside their company
      only = {}; myGroups().forEach(g => { const cid = g.companyId && C[g.companyId] ? g.companyId : '_loose'; (only[cid] = only[cid] || new Set()).add(g.id); });
    }
    $('#coFind').innerHTML = find;
    const looseN = Object.values(G).filter(g => (!g.companyId || !C[g.companyId]) && (!only || (only._loose && only._loose.has(g.id)))).length;
    const solo = comps.length === 1 && !(looseN && UI.band !== 'mine' && !lim);
    const coCard = c => {
      const gs = Object.values(G).filter(g => g.companyId === c.id && (!only || only[c.id] === 'all' || (only[c.id] && only[c.id].has(g.id)))).sort((a, b) => a.gender.localeCompare(b.gender) || a.num - b.num);
      const ps = gs.flatMap(g => mem[g.id]);
      const acSel = adm ? `<select data-act="coAc" data-id="${c.id}" aria-label="Assistant coordinator">${opt('', '— None')}${acs.map(a => opt(a.id, a.name + (acUsed.has(a.id) && a.id !== c.acId ? ' (Co ' + (Object.values(C).find(x => x.acId === a.id) || {}).num + ')' : ''), a.id === c.acId)).join('')}</select>` : esc(sName(c.acId) || '—');
      return `<section class="company"><div class="co-head"><div class="co-title"><h2>Company ${c.num}</h2><div class="inline"><span class="chip band">${BANDS[c.band]}</span><span class="chip F">${gs.filter(g => g.gender === 'F').length} YW</span><span class="chip M">${gs.filter(g => g.gender === 'M').length} YM</span>${adm ? `<button class="btn small danger" data-act="delCo" data-id="${c.id}">Remove</button>` : ''}</div></div>
      <div class="co-meta"><span class="muted">AC</span>${acSel}<span class="muted">In now</span><span class="num">${ps.filter(p => p.s === 'in').length} / ${ps.length}</span></div></div>
      ${only && only[c.id] !== 'all' ? `<p class="note" style="padding:6px 14px 0;margin:0">Showing ${gs.length} of ${Object.values(G).filter(g => g.companyId === c.id).length} groups</p>` : ''}${!gs.length ? '<p class="note" style="padding:0 14px">No groups yet.</p>' : solo ? `<div class="co-cols">${[['F', 'Young women'], ['M', 'Young men']].map(([gen, l]) => { const x = gs.filter(g => g.gender === gen); return x.length ? `<div class="co-col"><h3 class="co-colh">${l} <span class="muted">· ${x.length} group${x.length === 1 ? '' : 's'} · ${x.reduce((a, g) => a + mem[g.id].length, 0)} youth</span></h3>${x.map(g => grpBlock(g, mem[g.id], hits && hits.has(g.id))).join('')}</div>` : ''; }).join('')}</div>` : gs.map(g => grpBlock(g, mem[g.id], hits && hits.has(g.id))).join('')}</section>`;
    };
    let html = comps.map(coCard).join('');
    $('#coGrid').classList.toggle('solo', solo);
    const loose = Object.values(G).filter(g => (!g.companyId || !C[g.companyId]) && (!only || (only._loose && only._loose.has(g.id))));
    if (loose.length && UI.band !== 'mine' && !lim) html += `<section class="company"><div class="co-head"><div class="co-title"><h2>Groups without a company</h2><span class="chip warn">${loose.length}</span></div></div>${loose.map(g => grpBlock(g, mem[g.id])).join('')}</section>`;
    $('#coGrid').innerHTML = html || (q ? '' : `<div class="empty" style="grid-column:1/-1"><h3>No companies yet</h3>${adm ? 'Companies are formed from the assistant coordinators on the Staff tab. Press Regenerate all once participants, counselors and ACs are in.' : 'The registration admin will generate companies.'}</div>`);
  }
};
function grpBlock(g, mem, hit) {
  const adm = can.orgEdit(), open = UI.open.has(g.id), size = gsize(S.config, g.gender);
  const cn = g.counselorId && S.staffMap[g.counselorId];
  const counsSel = adm ? `<select data-act="grpCoun" data-id="${g.id}" aria-label="Counselor for G${g.num}">${opt('', '— No counselor')}${S.staffList.filter(s => s.role === 'counselor' && (s.gender === g.gender || s.id === g.counselorId)).map(s => { const other = Object.values(S.org.groups).find(x => x.counselorId === s.id && x.id !== g.id); const a = staffAge(s, S.config); return opt(s.id, `${s.name}${a != null ? ' (' + a + ')' : ''}${other ? ' · G' + other.num : ''}${cPref(s, g.band, S.config) === 2 ? ' · other age pref' : ''}`, s.id === g.counselorId); }).join('')}</select>` : '';
  const coSel = adm ? `<select data-act="grpCo" data-id="${g.id}" aria-label="Company for G${g.num}">${opt('', '— No company')}${Object.values(S.org.companies).sort((a, b) => a.num - b.num).map(c => opt(c.id, `Company ${c.num} · ${BANDS[c.band]}${c.band !== g.band ? ' ⚠' : ''}`, c.id === g.companyId)).join('')}</select>` : '';
  return `<div class="grp${hit ? ' hit' : ''}"><div class="grp-row" data-act="toggleGrp" data-id="${g.id}" role="button" tabindex="0" aria-expanded="${open}"><span class="gnum">G${g.num}</span>${chipG(g.gender)}<span class="cn">${cn ? esc(cn.name) : '<span class="chip bad">No counselor</span>'}</span><span class="num ${mem.length > size ? '' : 'muted'}" style="${mem.length > size ? 'color:var(--warn)' : ''}">${mem.length}/${size}</span><span class="num muted" title="Checked in">✓${mem.filter(p => p.s === 'in').length}</span><span class="muted">${open ? '▾' : '▸'}</span></div>
  ${open ? `<div class="grp-body">${adm ? `<div class="form" style="margin-bottom:6px"><label>Counselor${counsSel}</label><label>Company${coSel}</label></div>` : ''}
   ${mem.sort((a, b) => a.name.localeCompare(b.name)).map(p => `<div class="mem"><span class="sdot ${p.s}" title="${p.s === 'in' ? 'Checked in' : p.s === 'out' ? 'Checked out' : 'Not arrived'}"></span><span class="mn"><a href="#" data-act="detail" data-id="${esc(p.id)}">${esc(p.name)}</a> <small class="muted">${p.age ?? '?'} · ${esc(p.unit)}</small>${(p.medIssue || p.dietIssue) && seesPrivate(p) ? ' <span class="chip warn">!</span>' : ''}</span>${moveSelect(p)}</div>`).join('') || '<span class="muted">Empty group</span>'}
   ${adm ? `<div><button class="btn small danger" data-act="delGrp" data-id="${g.id}">Remove group</button></div>` : ''}</div>` : ''}</div>`;
}

/* tally by stake and unit (used on several pages) */
function areaTally(items, cols, setName) {
  const T = {};
  items.forEach(it => { const st = it.stake || '(No stake given)', un = it.unit || '(No ward or branch given)'; const s = T[st] = T[st] || { t: {}, u: {} }; const u = s.u[un] = s.u[un] || {}; s.t[it.key] = (s.t[it.key] || 0) + 1; u[it.key] = (u[it.key] || 0) + 1; });
  if (!Object.keys(T).length) return '<p class="note">Nothing to count yet.</p>';
  const open = UI[setName] || (UI[setName] = new Set());
  const sum = o => cols.reduce((a, [k]) => a + (o[k] || 0), 0); const tot = {};
  let h = `<div class="tablewrap"><table><thead><tr><th>Stake · ward or branch</th>${cols.map(([, l]) => `<th class="n">${esc(l)}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>`;
  for (const st of Object.keys(T).sort()) {
    const x = T[st]; cols.forEach(([k]) => tot[k] = (tot[k] || 0) + (x.t[k] || 0)); const isOpen = open.has(st);
    h += `<tr class="click" data-act="toggleArea" data-set="${setName}" data-v="${esc(st)}"><td><b>${isOpen ? '▾' : '▸'} ${esc(st)}</b> <small class="muted">${Object.keys(x.u).length} unit${Object.keys(x.u).length === 1 ? '' : 's'}</small></td>${cols.map(([k]) => `<td class="n">${x.t[k] || ''}</td>`).join('')}<td class="n"><b>${sum(x.t)}</b></td></tr>`;
    if (isOpen) for (const un of Object.keys(x.u).sort()) { const u = x.u[un]; h += `<tr class="sub"><td>${esc(un)}</td>${cols.map(([k]) => `<td class="n">${u[k] || ''}</td>`).join('')}<td class="n">${sum(u)}</td></tr>`; }
  }
  return h + `<tr class="total"><td>All stakes</td>${cols.map(([k]) => `<td class="n">${tot[k] || 0}</td>`).join('')}<td class="n">${sum(tot)}</td></tr></tbody></table></div><p class="note" style="margin:6px 0 0">Tap a stake to see its wards and branches.</p>`;
}

/* page: exceptions */
PAGE_IMPL.exceptions = {
  frame() {
    const stakes = uniq(S.P.map(p => p.stake).filter(Boolean)).sort(), units = uniq(S.P.map(p => p.unit).filter(Boolean)).sort();
    const ck = can.checkin();
    return `<section class="pagehead"><div><p class="th">Walk-ins & exceptions</p><h1>Everyone outside the plan</h1><p class="note">Youth who came without registering, and anyone checked in who is not on the approved list. ${ck ? 'Place them in a group here.' : ''}</p></div>${can.admin() ? '<button class="btn primary" data-act="rebalance">Place everyone waiting into groups</button>' : ''}</section>
    <div id="exK" class="kpis"></div>
    <div id="exLog"></div>
    ${ck ? `<details class="panel" ${S.P.some(p => p.src === 'walkin') ? '' : 'open'}><summary><h2 style="display:inline">Add a walk-in</h2></summary>
    <form id="wkForm" class="form" style="margin-top:12px">
      <label>First name<input id="wkFirst" required autocomplete="off"></label><label>Last name<input id="wkLast" required autocomplete="off"></label>
      <label>Gender<select id="wkGender" required>${opt('', 'Choose…')}${opt('F', 'Female')}${opt('M', 'Male')}</select></label>
      <label>Birthday<input id="wkBday" type="date"></label><label>Age (if no birthday)<input id="wkAge" type="number" min="10" max="30" inputmode="numeric"></label>
      <label>Stake / district<input id="wkStake" list="dlStakes" autocomplete="off"></label><label>Ward / branch<input id="wkUnit" list="dlUnits" autocomplete="off"></label>
      <label>T-shirt size<select id="wkSize">${opt('', 'Not given')}${SIZES.map(s => opt(s, SIZE_LABEL[s])).join('')}</select></label>
      <label>Phone<input id="wkPhone" inputmode="tel"></label><label>Parent / guardian<input id="wkC1"></label><label>Guardian phone<input id="wkC1p" inputmode="tel"></label>
      <label class="span2">Medical information<input id="wkMed" placeholder="Leave blank if none"></label><label class="span2">Dietary information<input id="wkDiet" placeholder="Leave blank if none"></label>
      <label class="inline" style="flex-direction:row;color:var(--ink)"><input type="checkbox" id="wkIn" checked> Check in now</label>
      <div class="span2"><button class="btn go" type="submit" style="width:100%">Add walk-in</button></div>
    </form><datalist id="dlStakes">${stakes.map(s => `<option value="${esc(s)}">`).join('')}</datalist><datalist id="dlUnits">${units.map(s => `<option value="${esc(s)}">`).join('')}</datalist></details>` : ''}
    <section class="panel"><div class="panel-head"><h2>By stake and unit</h2><button class="btn small" data-act="exCsv">Export CSV</button></div><div id="exTally"></div></section>
    <div id="exList" style="display:flex;flex-direction:column;gap:14px"></div>`;
  },
  lists() {
    const P = S.P;
    const walk = P.filter(p => p.src === 'walkin');
    const off = P.filter(p => p.src !== 'walkin' && p.s && (p.flags.includes('area') || p.flags.includes('status') || p.flags.includes('pending') || p.ov === 'exc'));
    const nog = P.filter(p => p.s === 'in' && !p.g && p.src !== 'walkin' && !off.includes(p));
    return { walk, off, nog };
  },
  update() {
    $('#exLog').innerHTML = UI.genLog ? `<div class="log"><b>${esc(UI.genLog.title)}</b><ul>${UI.genLog.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '';
    const { walk, off, nog } = this.lists();
    $('#exK').innerHTML = `<div class="kpi"><span>Walk-ins</span><b>${walk.length}</b><small>${walk.filter(p => p.s === 'in').length} checked in</small></div><div class="kpi"><span>Not on the approved list</span><b>${off.length}</b><small>but checked in</small></div><div class="kpi"><span>Checked in, no group</span><b>${nog.length}</b><small>need placing</small></div>`;
    const items = walk.map(p => ({ stake: p.stake, unit: p.unit, key: 'walk' })).concat(off.map(p => ({ stake: p.stake, unit: p.unit, key: 'off' })), nog.map(p => ({ stake: p.stake, unit: p.unit, key: 'nog' })));
    $('#exTally').innerHTML = areaTally(items, [['walk', 'Walk-ins'], ['off', 'Not approved'], ['nog', 'No group']], 'openEx');
    const sec = (title, note, list, empty) => `<section class="panel"><div class="panel-head"><h2>${esc(title)} <span class="chip">${list.length}</span></h2></div>${note ? `<p class="note" style="margin-top:-6px">${note}</p>` : ''}${list.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Why</th><th>Unit · stake</th><th>Status</th><th>Group</th>${can.admin() ? '<th></th>' : ''}</tr></thead><tbody>${list.map(exRow).join('')}</tbody></table></div>` : `<p class="note">${empty}</p>`}</section>`;
    $('#exList').innerHTML = sec('Walk-ins', 'Added at the desk. They count in the tally and can be placed in groups like anyone else.', walk, 'No walk-ins yet.')
      + sec('Checked in but not on the approved list', 'From an excluded stake or unit, cancelled, or still waiting for approval. An admin can include them so the generator places them in a group.', off, 'Nobody from outside the approved list has checked in.')
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

/* page: logistics */
function lgHash() { const h = (location.hash || '').slice(1); return /^(med|diet|tee)-[a-z0-9-]+$/.test(h) ? h : ''; }
function registered() { return S.P.filter(p => p.inc || p.s); }
PAGE_IMPL.logistics = {
  frame() { return `<section class="pagehead"><div><p class="th">Logistics${role() === 'counselor' ? ' · your group only' : role() === 'ac' ? ' · your company only' : ' · whole session'}</p><h1>Medical, dietary and T-shirts</h1><p class="note" style="margin:4px 0 0">Built from the upload, before anyone checks in. Notes such as "none", "N/A", "nil" or "fit" are left out. Tap an issue to see exactly who has it.</p></div><div class="seg" role="group" aria-label="Who to count">${[['all', 'Everyone registered'], ['in', 'Checked in now']].map(([v, l]) => `<button data-act="logScope" data-v="${v}" aria-pressed="${UI.logScope === v}">${l}</button>`).join('')}</div></section>
  <div id="lgK" class="kpis"></div>
  ${foldSec('sec-med', 'Medical', 'lgMedN', '<button class="btn small" data-act="lgCsv" data-v="med">Export CSV</button>', '<div id="lgMed"></div>')}
  ${foldSec('sec-diet', 'Dietary', 'lgDietN', '<button class="btn small" data-act="lgCsv" data-v="diet">Export CSV</button>', '<div id="lgDiet"></div>')}
  ${foldSec('sec-tee', 'T-shirts', 'lgTeeN', '<button class="btn small" data-act="lgCsv" data-v="size">Export order</button><button class="btn small" data-act="lgCsv" data-v="blank">Export blanks</button>', '<div id="lgSize"></div>')}
  ${['counselor', 'ac'].includes(role()) ? '' : foldSec('sec-steee', 'Staff T-shirts', 'lgStN', '<button class="btn small" data-act="lgCsv" data-v="staffsize">Export staff and full order</button>', '<div id="lgStaffSize"></div>')}`; },
  scope() { const mine = role() === 'counselor' ? new Set(myGroups().map(g => g.id)) : null; return (UI.logScope === 'in' ? S.P.filter(p => p.s === 'in') : registered()).filter(p => seesPrivate(p) && (!mine || (p.g && mine.has(p.g)))); },
  update() {
    const L = this.scope(), H = lgHash();
    const med = L.filter(p => p.medIssue), diet = L.filter(p => p.dietIssue), blanks = L.filter(p => !p.tshirt);
    const href = h => '#' + h;
    const kb = (v, cls, l, n) => `<button class="kpi kpi-btn ${cls}" data-act="lgGo" data-v="${v}"><span>${l}</span><b>${n}</b><small>Show list ›</small></button>`;
    $('#lgK').innerHTML = `<div class="kpi"><span>${UI.logScope === 'in' ? 'Checked in' : 'Registered'}${['counselor', 'ac'].includes(role()) ? ' (yours)' : ''}</span><b>${L.length}</b></div>` + kb('med', 'hero', 'Medical needs', med.length) + kb('diet', 'hero', 'Dietary needs', diet.length) + kb('tee', '', 'Sizes given', L.length - blanks.length) + kb('blank', '', 'Blank sizes', blanks.length) + ($('#sec-steee') ? kb('steee', '', 'Staff T-shirts', S.staffList.filter(x => !x.test).length) : '');
    $('#lgMedN').textContent = med.length; $('#lgDietN').textContent = diet.length; $('#lgTeeN').textContent = `${L.length - blanks.length} given · ${blanks.length} blank`; if ($('#lgStN')) $('#lgStN').textContent = S.staffList.filter(x => !x.test).length;
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
    if ($('#lgStaffSize')) $('#lgStaffSize').innerHTML = staffTeeBlock(L);
    if (H && UI.lgLast !== H) { const sec = document.getElementById(H.startsWith('tee') ? 'sec-tee' : 'sec-' + H.split('-')[0]); if (sec && !sec.open) { sec.open = true; UI.foldSet = Object.assign(UI.foldSet || {}, { [sec.id]: true }); } const el = document.getElementById(H.startsWith('tee') ? 'tee-list' : H.split('-')[0] + '-list'); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
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

/** Staff sizes. Blanks get a size in the proportions of staff of the same gender who gave one. */
function staffTee() {
  const ST = S.staffList.filter(x => !x.test);
  const est = {}, perPerson = {};
  for (const g of ['F', 'M', '']) {
    const known = ST.filter(x => x.tshirt && (g ? x.gender === g : true)), blanks = ST.filter(x => !x.tshirt && (x.gender || '') === g);
    if (!blanks.length) continue;
    const w = {}; (known.length ? known : ST.filter(x => x.tshirt)).forEach(x => w[x.tshirt] = (w[x.tshirt] || 0) + 1);
    const alloc = largestRemainder(Object.keys(w).length ? w : { L: 1 }, blanks.length);
    const bag = []; Object.keys(alloc).sort((a, b) => sizeRank(a) - sizeRank(b)).forEach(k => { for (let i = 0; i < alloc[k]; i++) bag.push(k); });
    blanks.sort((a, b) => a.name.localeCompare(b.name)).forEach((x, i) => { perPerson[x.id] = bag[i]; est[bag[i]] = (est[bag[i]] || 0) + 1; });
  }
  return { ST, est, perPerson };
}
function staffTeeBlock(L) {
  const { ST, est, perPerson } = staffTee();
  if (!ST.length) return '<p class="note">Staff sizes appear here once staff are added on the Staff page.</p>';
  const R = teeRedistribute(L);
  const giv = {}; ST.forEach(x => { if (x.tshirt) giv[x.tshirt] = (giv[x.tshirt] || 0) + 1; });
  const sizes = sizesIn(giv, est, R.totals);
  const g = (s, gen) => ST.filter(x => x.tshirt === s && x.gender === gen).length;
  let h = `<p class="th" style="margin:0 0 6px">Staff sizes</p><div class="tablewrap"><table><thead><tr><th>Size</th><th class="n">Women given</th><th class="n">Men given</th><th class="n">Given</th><th class="n">Blanks, estimated</th><th class="n">Staff to order</th></tr></thead><tbody>`;
  let tg = 0, te = 0;
  for (const s of sizes) { const a = giv[s] || 0, b = est[s] || 0; if (!a && !b) continue; tg += a; te += b; h += `<tr><td><b>${esc(SIZE_LABEL[s] || s)}</b></td><td class="n">${g(s, 'F')}</td><td class="n">${g(s, 'M')}</td><td class="n">${a}</td><td class="n est">+${b}</td><td class="n"><b>${a + b}</b></td></tr>`; }
  h += `<tr><td><b>All</b></td><td class="n">${ST.filter(x => x.tshirt && x.gender === 'F').length}</td><td class="n">${ST.filter(x => x.tshirt && x.gender === 'M').length}</td><td class="n">${tg}</td><td class="n est">+${te}</td><td class="n"><b>${tg + te}</b></td></tr></tbody></table></div>`;
  const blanks = ST.filter(x => !x.tshirt);
  h += `<p class="note">${blanks.length ? `${blanks.length} staff gave no size (${blanks.slice(0, 6).map(x => esc(x.name)).join(', ')}${blanks.length > 6 ? ' and ' + (blanks.length - 6) + ' more' : ''}). Each blank is estimated from staff of the same gender who did give a size.` : 'Every staff member gave a size.'} Test staff are left out.</p>`;
  h += `<p class="th" style="margin:18px 0 6px">Full order: youth and staff</p><div class="tablewrap"><table><thead><tr><th>Size</th><th class="n">Youth</th><th class="n">Staff</th><th class="n">Total to order</th></tr></thead><tbody>`;
  let ty = 0, ts = 0;
  for (const s of sizes) { const y = R.totals[s] ? R.totals[s].given + R.totals[s].est : 0, st = (giv[s] || 0) + (est[s] || 0); if (!y && !st) continue; ty += y; ts += st; h += `<tr><td><b>${esc(SIZE_LABEL[s] || s)}</b></td><td class="n">${y}</td><td class="n">${st}</td><td class="n"><b>${y + st}</b></td></tr>`; }
  h += `<tr class="total"><td>All</td><td class="n">${ty}</td><td class="n">${ts}</td><td class="n">${ty + ts}</td></tr></tbody></table></div><p class="note">Youth follow the "${UI.logScope === 'in' ? 'Checked in now' : 'Everyone registered'}" choice at the top of the page.</p>`;
  return h;
}

/** Optional email alert for access requests: set NOTIFY_URL in config.js to a Google Apps Script web app (see notify.gs). */
function notifyRequest(note) {
  const url = typeof NOTIFY_URL !== 'undefined' ? NOTIFY_URL : (window.NOTIFY_URL || '');
  if (!url) return;
  const body = JSON.stringify({ type: 'access-request', name: S.meName || '', email: S.email || '', note: String(note || '').slice(0, 200), session: sessName(S.sid), site: location.origin + location.pathname, at: new Date().toISOString() });
  fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body }).catch(() => { });
}

/* Page width follows the menu: wide enough for every tab plus some breathing room, never narrower than 1280px. */
let fitKey = '';
function fitWidth() {
  const nav = $('#nav'); if (!nav) return;
  const key = nav.children.length + ':' + window.innerWidth; if (key === fitKey) return; fitKey = key;
  requestAnimationFrame(() => {
    let w = 0; for (const b of nav.children) w += b.getBoundingClientRect().width; w += Math.max(0, nav.children.length - 1) * 4;
    if (!w) { document.documentElement.style.removeProperty('--wrapmax'); fitKey = ''; return; }
    const target = Math.round(Math.min(1680, Math.max(1280, w * 1.12 + 96)));
    document.documentElement.style.setProperty('--wrapmax', target + 'px');
  });
}
window.addEventListener('resize', () => { fitKey = ''; fitWidth(); });

/* health concerns (reported by counselors, followed up by wellness coordinators) */
const REP_KINDS = [['medical', 'Medical'], ['dietary', 'Dietary'], ['injury', 'Injury or illness'], ['emotional', 'Emotional wellbeing'], ['other', 'Other']];
const repKind = k => (REP_KINDS.find(x => x[0] === k) || [k, k])[1];
function allReports() { const out = []; for (const u in S.reports || {}) for (const id in S.reports[u] || {}) { const r = S.reports[u][id]; if (r) out.push(Object.assign({ id, owner: u }, r)); } return out.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || b.at - a.at); }
function repChip(p) { const open = allReports().filter(r => r.pid === p.id && r.status === 'open'); return open.length ? `<div class="flags"><span class="chip bad">${open.length} open health concern${open.length > 1 ? 's' : ''}</span></div>` : ''; }
function repHistory(p) {
  const list = allReports().filter(r => r.pid === p.id);
  return `<div class="rep-hist"><div class="panel-head" style="margin:0 0 6px"><b>Health concerns</b>${can.report() ? `<button class="btn small" data-act="repNew" data-id="${esc(p.id)}">+ Report a concern</button>` : ''}</div>${list.length ? list.map(repCard).join('') : '<p class="note" style="margin:0">None reported.</p>'}</div>`;
}
function repCard(r) {
  const p = S.P.find(x => x.id === r.pid); const w = can.wellness(), we = can.wellnessEdit();
  return `<div class="rep ${r.status === 'open' ? 'open' : 'done'}${r.urgent && r.status === 'open' ? ' urgent' : ''}">
    <div class="rep-top">${r.urgent ? '<span class="chip bad">Urgent</span>' : ''}<span class="chip">${esc(repKind(r.kind))}</span>${r.status === 'open' ? '<span class="chip warn">Open</span>' : '<span class="chip good">Resolved</span>'}<small class="muted">${esc(fmtWhen(r.at))} · ${esc(r.byName || '')}</small></div>
    ${w ? `<div class="rep-who"><a href="#" data-act="detail" data-id="${esc(r.pid)}"><b>${esc(p ? p.name : r.pname || 'Participant')}</b></a> <small class="muted">${p ? `${p.age ?? '?'} yrs · ${p.gender === 'F' ? 'YW' : p.gender === 'M' ? 'YM' : '?'} · ${p.group ? 'G' + p.group.num + (p.counselor ? ' (' + esc(p.counselor.name) + ')' : '') + (p.company ? ' · Co ' + p.company.num : '') : 'no group'} · ${p.s === 'in' ? 'checked in' : p.s === 'out' ? 'checked out' : 'not arrived'}` : ''}</small></div>` : ''}
    <p class="rep-text">${esc(r.text)}</p>
    ${r.resNote || r.status !== 'open' ? `<p class="rep-res"><b>${r.status === 'open' ? 'Follow-up' : 'Resolved'}${r.resByName ? ' by ' + esc(r.resByName) : ''}${r.resAt ? ' · ' + esc(fmtWhen(r.resAt)) : ''}:</b> ${esc(r.resNote || '—')}</p>` : ''}
    ${we ? `<div class="btnrow">${r.status === 'open' ? `<button class="btn small primary" data-act="repResolve" data-id="${esc(r.owner)}" data-v="${esc(r.id)}">Mark resolved</button><button class="btn small" data-act="repNote" data-id="${esc(r.owner)}" data-v="${esc(r.id)}">Add follow-up</button>` : `<button class="btn small" data-act="repReopen" data-id="${esc(r.owner)}" data-v="${esc(r.id)}">Reopen</button>`}</div>` : ''}</div>`;
}
function fmtWhen(t) { if (!t) return ''; const d = new Date(t); return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function openReportForm(pid) {
  const p = S.P.find(x => x.id === pid); if (!p) return;
  openModal(`<div class="modal-head"><div><h2>Report a health concern</h2><div class="sub"><b>${esc(p.name)}</b> ${chipG(p.gender)}${chipBand(p.band)}</div></div><button class="x" data-act="close" aria-label="Close">×</button></div>
  <form id="repForm" class="form" data-id="${esc(p.id)}">
    <label class="span2">What kind of concern?<select id="repKind">${REP_KINDS.map(([k, l]) => opt(k, l)).join('')}</select></label>
    <label class="span2">What happened, or what should the wellness team know?<textarea id="repText" rows="4" maxlength="600" required placeholder="For example: headache since lunch, has not taken medicine; cannot eat beans"></textarea></label>
    <label class="span2 chkrow"><input type="checkbox" id="repUrgent"> Urgent: needs attention now</label>
    <p class="note span2" style="margin:0">Only the wellness coordinators and the session leaders see this. In an emergency, also call the wellness team straight away.</p>
    <div class="span2"><button class="btn primary" type="submit" style="width:100%">Send to the wellness team</button></div></form>`);
  setTimeout(() => { const t = $('#repText'); if (t) t.focus(); }, 60);
}
async function saveReport(form) {
  const p = S.P.find(x => x.id === form.dataset.id); const text = clean(($('#repText') || {}).value); if (!p || !text) { toast('Describe the concern first', true); return; }
  const id = rid('r'); const rec = { pid: p.id, pname: p.name, kind: ($('#repKind') || {}).value || 'other', text: text.slice(0, 600), urgent: !!($('#repUrgent') || {}).checked, at: Date.now(), by: S.uid, byName: S.meName || S.email, status: 'open' };
  const mine = Object.assign({}, (S.reports || {})[S.uid] || {}, { [id]: rec }); S.reports = Object.assign({}, S.reports, { [S.uid]: mine });
  closeModal(); recompute(true);
  try { await S.db.doc('reports/' + S.uid).set({ r: { [id]: rec } }, { merge: true }); audit('health', `Reported a ${repKind(rec.kind).toLowerCase()} concern for ${p.name}${rec.urgent ? ' (urgent)' : ''}`, p.id); toast('Sent to the wellness team'); } catch (e) { fail(e); }
}
async function updateReport(owner, id, patch) { const r0 = ((S.reports || {})[owner] || {})[id]; if (r0) audit('health', patch.status === 'resolved' ? `Resolved the health concern for ${r0.pname}` : patch.status === 'open' ? `Reopened the health concern for ${r0.pname}` : `Added a follow-up to the health concern for ${r0.pname}`, r0.pid);
  const cur = ((S.reports || {})[owner] || {})[id]; if (!cur) return;
  S.reports = Object.assign({}, S.reports, { [owner]: Object.assign({}, S.reports[owner], { [id]: Object.assign({}, cur, patch) }) }); recompute(true);
  try { await S.db.doc('reports/' + owner).set({ r: { [id]: patch } }, { merge: true }); } catch (e) { fail(e); }
}

/* page: wellness */
function wlOpen(id) { return foldOpen(id); }
function foldOpen(id) { const o = UI.foldSet || {}; return id in o ? o[id] : ['wl-rep', 'hc-missing', 'hc-late'].includes(id); }
function foldSec(id, title, countId, tools, body) { return `<details class="panel fold" id="${id}" ${foldOpen(id) ? 'open' : ''}><summary><h2>${title}</h2><span class="chip" id="${countId}"></span></summary><div class="fold-body">${tools ? `<div class="fold-tools">${tools}</div>` : ''}${body}</div></details>`; }
function openFold(id) { UI.foldSet = Object.assign(UI.foldSet || {}, { [id]: true }); const d = document.getElementById(id); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }
PAGE_IMPL.wellness = {
  frame() {
    return `<section class="pagehead"><div><p class="th">Wellness · whole session</p><h1>Health and wellbeing</h1><p class="note" style="margin:4px 0 0">Concerns reported by counselors, and every medical and dietary note for youth and staff. Notes such as "none" or "N/A" are left out.</p></div><div class="btnrow"><button class="btn" data-act="wlCsv">Export CSV</button></div></section>
    <div id="wlK" class="kpis"></div>
    ${[['wl-rep', 'Reported concerns', 'wlRepN', `<div class="chips wl-tabs" id="wlRepTabs"></div><div id="wlRep"></div>`],
      ['wl-youth', 'Youth: medical and dietary', 'wlYN', `<div class="chips wl-tabs" id="wlYTabs"></div><input id="wlQ" type="search" placeholder="Search by name, unit or note" autocomplete="off" value="${esc(UI.wlQ || '')}" style="width:100%;margin-bottom:10px"><div id="wlYouth"></div>`],
      ['wl-staff', 'Staff: medical and dietary', 'wlSN', `<div id="wlStaff"></div>`]].map(([id, t, n, body]) => `<details class="panel fold" id="${id}" ${wlOpen(id) ? 'open' : ''}><summary><h2>${t}</h2><span class="chip" id="${n}"></span></summary><div class="fold-body">${body}</div></details>`).join('')}`;
  },
  update() {
    const R = allReports(), open = R.filter(r => r.status === 'open');
    const Y = registered().filter(p => p.medIssue || p.dietIssue);
    const ST = S.staffList.filter(x => !x.test && (x.diet || x.med));
    const kb = (v, cls, l, n) => `<button class="kpi kpi-btn ${cls}" data-act="wlGo" data-v="${v}"><span>${l}</span><b>${n}</b><small>Show list ›</small></button>`;
    $('#wlK').innerHTML = kb('open', 'hero', 'Open concerns', open.length) + kb('urgent', '', 'Urgent and open', open.filter(r => r.urgent).length) + kb('med', '', 'Youth with medical notes', Y.filter(p => p.medIssue).length) + kb('diet', '', 'Youth with dietary needs', Y.filter(p => p.dietIssue).length) + kb('staff', '', 'Staff with notes', ST.length);
    $('#wlRepN').textContent = `${open.length} open`; $('#wlYN').textContent = Y.length; $('#wlSN').textContent = ST.length;
    const rt = UI.wlRep || 'open';
    $('#wlRepTabs').innerHTML = [['open', `Open · ${open.length}`], ['urgent', `Urgent · ${open.filter(r => r.urgent).length}`], ['done', `Resolved · ${R.length - open.length}`], ['all', `All · ${R.length}`]].map(([v, l]) => `<button data-act="wlRep" data-v="${v}" aria-pressed="${rt === v}">${l}</button>`).join('');
    const shown = R.filter(r => rt === 'all' || (rt === 'urgent' ? r.status === 'open' && r.urgent : rt === 'open' ? r.status === 'open' : r.status !== 'open'));
    $('#wlRep').innerHTML = shown.length ? `<div class="rep-list">${shown.map(repCard).join('')}</div>` : `<p class="note">${rt === 'open' ? 'No open concerns. Counselors report them from a participant\'s card or details.' : 'Nothing here yet.'}</p>`;
    const yt = UI.wlY || 'all', q = (UI.wlQ || '').toLowerCase().trim();
    $('#wlYTabs').innerHTML = [['all', `All · ${Y.length}`], ['med', `Medical · ${Y.filter(p => p.medIssue).length}`], ['diet', `Dietary · ${Y.filter(p => p.dietIssue).length}`], ['in', `Checked in · ${Y.filter(p => p.s === 'in').length}`]].map(([v, l]) => `<button data-act="wlY" data-v="${v}" aria-pressed="${yt === v}">${l}</button>`).join('');
    const yl = Y.filter(p => (yt === 'all' || (yt === 'med' && p.medIssue) || (yt === 'diet' && p.dietIssue) || (yt === 'in' && p.s === 'in')) && (!q || [p.name, p.unit, p.stake, p.medIssue, p.dietIssue].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => (a.group ? a.group.num : 9999) - (b.group ? b.group.num : 9999) || a.name.localeCompare(b.name));
    $('#wlYouth').innerHTML = yl.length ? `<div class="tablewrap"><table class="wl-t"><thead><tr><th>Participant</th><th>Medical</th><th>Dietary</th><th>Group</th></tr></thead><tbody>${yl.slice(0, UI.wlMore ? 9999 : 150).map(p => `<tr><td><a href="#" data-act="detail" data-id="${esc(p.id)}"><b>${esc(p.name)}</b></a><br><small class="muted">${p.age ?? '?'} yrs · ${p.gender === 'F' ? 'YW' : p.gender === 'M' ? 'YM' : '?'} · ${p.s === 'in' ? 'checked in' : p.s === 'out' ? 'checked out' : 'not arrived'}<br>${esc(p.unit || '')}${p.stake ? ' · ' + esc(p.stake) : ''}</small></td><td data-l="Medical" class="${p.medIssue ? '' : 'nil'}">${p.medIssue ? esc(p.medIssue) + `<div class="flags">${cats(p.medIssue, MED_CATS).map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : '<span class="muted">—</span>'}</td><td data-l="Dietary" class="${p.dietIssue ? '' : 'nil'}">${p.dietIssue ? esc(p.dietIssue) + `<div class="flags">${cats(p.dietIssue, DIET_CATS).map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : '<span class="muted">—</span>'}</td><td data-l="Group">${p.group ? `<b>G${p.group.num}</b>${p.company ? ' · Co ' + p.company.num : ''}<br><small class="muted">${esc(p.counselor ? p.counselor.name : 'No counselor')}</small>` : '<span class="muted">Not in a group</span>'}</td></tr>`).join('')}</tbody></table></div>${yl.length > 150 && !UI.wlMore ? `<button class="btn small" data-act="wlMore" style="margin-top:8px">Show all ${yl.length}</button>` : ''}` : `<p class="note">${S.P.length ? 'Nobody matches.' : 'Participants appear here once they are uploaded.'}</p>`;
    $('#wlStaff').innerHTML = ST.length ? `<div class="tablewrap"><table class="wl-t"><thead><tr><th>Staff member</th><th>Medical</th><th>Dietary</th><th>Phone</th></tr></thead><tbody>${ST.sort((a, b) => a.name.localeCompare(b.name)).map(x => `<tr><td><b>${esc(x.name)}</b><br><small class="muted">${esc(ROLES[x.role] || x.role)}${x.unit ? ' · ' + esc(x.unit) : ''}</small></td><td data-l="Medical" class="${x.med ? '' : 'nil'}">${x.med ? esc(x.med) : '<span class="muted">—</span>'}</td><td data-l="Dietary" class="${x.diet ? '' : 'nil'}">${x.diet ? esc(x.diet) : '<span class="muted">—</span>'}</td><td data-l="Phone" class="${x.phone ? '' : 'nil'}">${esc(x.phone || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">No staff have medical or dietary notes. Staff notes come from the staff sign-up form (food allergies) or the staff record.</p>';
  }
};

/* page: staff */
PAGE_IMPL.staff = {
  frame() {
    const real = S.staffList.filter(s => !s.test && !s.fromAccount).length;
    return `<section class="pagehead"><div><p class="th">Staff</p><h1>Counselors and leaders</h1><p class="note">Counselors aged 19–22 are matched to 13–15 groups first, 23 and over to 16–18. Import the staff sign-up form below or add people one at a time.</p></div><div class="btnrow">${can.staff() ? '<button class="btn adm" data-act="sfPick">Import staff</button>' : ''}<button class="btn primary adm" data-act="stAdd">+ Add staff member</button></div></section>
    ${can.staff() ? `<section class="panel adm" id="sfPanel"><div class="panel-head"><h2>Import staff</h2><label class="btn primary" for="sfFile">Choose a file to import</label></div>
      <p class="note" style="margin-top:-4px">Excel or .csv, such as the Google Form responses for counselors, ACs and coordinators. A Type column (AC, Counselor or Coordinator) sets each person's role. Blank rows are skipped, people who sent the form more than once are merged, and each ward or branch is matched to its stake or district. You can import again at any time: people already on the list are updated, not added twice.</p>
      <input type="file" id="sfFile" class="vh" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"><div id="sfBox"></div></section>` : ''}
    <div id="stK" class="kpis"></div>
    <section class="panel"><div class="panel-head"><h2>By stake and unit</h2><button class="btn small" data-act="stCsv">Export CSV</button></div><div id="stTally"></div></section>
    <section class="panel"><div class="panel-head"><h2>Staff list</h2><button class="btn small primary adm" data-act="stAdd">+ Add</button></div><input id="stQ" type="search" placeholder="Search staff by name, phone, email, ward or stake" autocomplete="off" value="${esc(UI.stQ || '')}" style="width:100%;margin-bottom:10px"><div class="segscroll" style="margin-bottom:10px"><div class="chips" id="stTabs"></div></div><div id="stView" class="stview"></div><div id="stList"></div></section>
    <details class="panel adm"><summary><h2 style="display:inline">Test staff</h2></summary><p class="note">No counselors yet? Generate clearly marked test counselors, ACs, coordinators and a Session Directing Couple to try the company generator. Delete them when the real list is in, then press Rebalance or Regenerate.</p>
      <div class="inline"><label class="inline">ACs to create <input id="tsAcs" type="number" min="1" max="40" value="${Math.max(2, Math.round(S.P.filter(p => p.elig).length / 100))}" style="width:80px"></label><button class="btn" data-act="testGen">Generate test staff</button><button class="btn danger" data-act="testDel">Delete test staff</button></div></details>
    ${can.reset() ? resetPanel() : ''}`;
  },
  update() {
    const cnt = r => S.staffList.filter(s => s.role === r).length;
    const PL = ROLE_PLURAL;
    $('#stK').innerHTML = STAFF_ROLES.map(r => `<div class="kpi"><span>${PL[r]}</span><b>${cnt(r)}</b></div>`).join('');
    $('#stTally').innerHTML = areaTally(S.staffList.map(s => ({ stake: s.stake, unit: s.unit, key: s.role })), STAFF_ROLES.map(r => [r, ({ counselor: 'Counselors', ac: 'ACs', coordinator: 'Coord.', sdc: 'SDC', logistics: 'Logistics', wellness: 'Wellness' })[r]]), 'openStaff');
    const sq = (UI.stQ || '').toLowerCase().trim();
    const sm = s => !sq || [s.name, s.phone, s.email, s.unit, s.stake, s.unitRaw].join(' ').toLowerCase().includes(sq) || String(s.phone || '').replace(/\D/g, '').includes(sq.replace(/\D/g, '') || '~');
    const qc = r => S.staffList.filter(s => s.role === r && sm(s)).length;
    if (sq && !qc(UI.staffTab)) { const other = STAFF_ROLES.find(r => qc(r)); if (other) UI.staffTab = other; }
    $('#stTabs').innerHTML = STAFF_ROLES.map(r => `<button data-act="stTab" data-v="${r}" aria-pressed="${UI.staffTab === r}">${esc(ROLES[r])} · ${sq ? qc(r) + ' found' : cnt(r)}</button>`).join('');
    const list = S.staffList.filter(s => s.role === UI.staffTab && sm(s));
    const byArea = UI.staffView === 'area';
    const plural = PL[UI.staffTab] || ROLES[UI.staffTab] + 's';
    $('#stView').innerHTML = list.length ? `<div class="chips"><button data-act="stView" data-v="az" aria-pressed="${!byArea}">A–Z</button><button data-act="stView" data-v="area" aria-pressed="${byArea}">By stake and unit</button><button data-act="stView" data-v="new" aria-pressed="${UI.staffView === 'new'}">Newest first</button></div><button class="btn small" data-act="stPdf" data-v="">Print ${esc(plural.toLowerCase())} list (PDF)</button>` : '';
    const G = Object.values(S.org.groups), C = Object.values(S.org.companies);
    const where = s => { if (s.role === 'counselor') { const g = G.find(g => g.counselorId === s.id); return g ? `G${g.num} · ${BANDS[g.band]}` : '<span class="chip warn">Unassigned</span>'; } if (s.role === 'ac') { const c = C.find(c => c.acId === s.id); return c ? `Company ${c.num}` : '<span class="chip warn">Spare</span>'; } if (s.role === 'coordinator') return 'All companies'; return '—'; };
    const isC = UI.staffTab === 'counselor', ncol = isC ? 7 : 6;
    const shadowS = shadowedCounselors(S.staffList);
    const linkedIds = new Set(Object.values(S.invites || {}).map(v => v && v.staffId).filter(Boolean));
    const DAY = 86400000, newest = UI.staffView === 'new';
    const addedTxt = s => s.addedAt ? `Added ${fmtWhen(s.addedAt)}${s.addedBy ? ' by ' + s.addedBy : ''}` : '';
    const row = s => { const a = staffAge(s, S.config); return `<tr><td><a href="#" data-act="stEdit" data-id="${esc(s.id)}"><b>${esc(s.name)}</b></a> ${s.addedAt && Date.now() - s.addedAt < DAY ? `<span class="chip good" title="${esc(addedTxt(s))}">New</span>` : ''}${s.test ? '<span class="chip info">Test</span>' : ''}${s.fromAccount ? '<span class="chip">From Accounts</span>' : ''}${shadowS[s.id] ? ` <span class="chip bad" title="The same person has two staff records">Also listed as ${esc(ROLES[shadowS[s.id].role].toLowerCase())}: delete this record</span>` : ''}<br><small class="muted">${byArea ? '' : esc([s.unit, s.stake].filter(Boolean).join(' · ') || 'No unit given') + (s.phone ? ' · ' : '')}${s.phone ? esc(s.phone) : ''}${s.email ? ' · ' + esc(s.email) : ''}${newest && s.addedAt ? '<br>' + esc(addedTxt(s)) : ''}</small>${linkedIds.has(s.id) ? ' <span class="chip good">Account linked</span>' : ''}${s.diet ? `<br><span class="chip warn" title="Food needs">Food: ${esc(s.diet)}</span>` : ''}</td><td>${chipG(s.gender)}</td><td class="n">${a ?? '—'}</td>${isC ? `<td>${a == null ? '<span class="muted">Unknown age</span>' : a >= 23 ? '16–18' : a >= 19 ? '13–15' : '<span class="chip warn">Under 19</span>'}</td>` : ''}<td>${where(s)}</td><td><select data-act="stRole" data-id="${esc(s.id)}" aria-label="Role"${s.fromAccount ? ' disabled title="Change the role under Accounts"' : ''}>${STAFF_ROLES.map(r => opt(r, ROLES[r], r === s.role)).join('')}</select></td><td><button class="btn small danger adm" data-act="stDel" data-id="${esc(s.id)}">Delete</button></td></tr>`; };
    let body = '';
    if (byArea) {
      const T = staffByArea(list);
      for (const st of Object.keys(T).sort(areaSort)) {
        const units = T[st], n = Object.values(units).reduce((a, l) => a + l.length, 0);
        body += `<tr class="st-h"><td colspan="${ncol}"><b>${esc(st)}</b> <span class="muted">· ${n}</span> <button class="btn small" data-act="stPdf" data-v="${esc(st)}">Print</button></td></tr>`;
        for (const un of Object.keys(units).sort(areaSort)) body += `<tr class="un-h"><td colspan="${ncol}">${esc(un)} <span class="muted">· ${units[un].length}</span></td></tr>` + units[un].map(row).join('');
      }
    } else body = (newest ? list.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || a.name.localeCompare(b.name)) : list).map(row).join('');
    const withT = list.filter(x => x.addedAt).sort((a, b) => b.addedAt - a.addedAt), recent = withT.filter(x => Date.now() - x.addedAt < DAY);
    const latestLine = withT.length ? `<p class="note st-latest">Latest ${esc((ROLES[UI.staffTab] || '').toLowerCase())} added: <b>${esc(withT[0].name)}</b> · ${esc(fmtWhen(withT[0].addedAt))}${withT[0].addedBy ? ' by ' + esc(withT[0].addedBy) : ''}${recent.length > 1 ? ` · <b>${recent.length}</b> added in the last 24 hours` : ''}${newest ? '' : ' · <a href="#" data-act="stView" data-v="new">See newest first</a>'}</p>` : '';
    $('#stList').innerHTML = latestLine + (list.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Gender</th><th class="n">Age</th>${isC ? '<th>Best fit</th>' : ''}<th>Assigned</th><th>Role</th><th></th></tr></thead><tbody>${body}</tbody></table></div>` : sq ? `<div class="empty"><h3>No staff match "${esc(UI.stQ)}"</h3></div>` : `<div class="empty"><h3>No ${esc(ROLES[UI.staffTab].toLowerCase())}s yet</h3><button class="btn primary" data-act="stAdd">+ Add staff member</button></div>`);
    renderSf();
  }
};
const NO_STAFF_STAKE = 'Stake or district not known', NO_STAFF_UNIT = 'Ward or branch not given';
function areaSort(a, b) { const z = x => x === NO_STAFF_STAKE || x === NO_STAFF_UNIT ? 1 : 0; return z(a) - z(b) || a.localeCompare(b); }
function staffByArea(list) {
  const T = {};
  list.forEach(s => { const st = s.stake || NO_STAFF_STAKE, un = s.unit || NO_STAFF_UNIT; ((T[st] = T[st] || {})[un] = T[st][un] || []).push(s); });
  for (const st in T) for (const un in T[st]) T[st][un].sort((a, b) => a.name.localeCompare(b.name));
  return T;
}

/* staff sign-up form import (Staff page) */
function sfKnownUnits() { return S.P.filter(p => p.src !== 'walkin' && p.stake && p.unit).map(p => [p.stake, p.unit]); }
async function sfRead(file) {
  if (typeof XLSX === 'undefined') { toast('The spreadsheet reader did not load. Check your connection and reload.', true); return; }
  const buf = await file.arrayBuffer(); let wb;
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') wb = XLSX.read(new TextDecoder('utf-8').decode(buf).replace(/^﻿/, ''), { type: 'string', raw: true });
  else wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }).map(r => r.map(c => c instanceof Date ? parseDate(c) : c));
  if (rows.length < 2) { toast('That file has no rows.', true); return; }
  const map = sfMap(rows[0]);
  if (!Object.values(map).includes('name')) { toast('No name column found in that file.', true); return; }
  const hasRole = Object.values(map).includes('role'); const roleCol = hasRole ? clean(rows[0][Object.keys(map).find(i => map[i] === 'role')]) : '';
  UI.sf = { name: file.name, rows, map, roleCol, role: hasRole ? 'column' : (['counselor', 'ac', 'coordinator'].includes(UI.staffTab) ? UI.staffTab : 'counselor'), hasRole, choices: {}, adding: null };
  sfRun(); renderSf();
}
function sfRun() { const F = UI.sf; const al = Object.assign({}, S.config.unitAliases || {}); for (const k in F.choices) al[k.split('|')[0]] = F.choices[k]; F.res = staffIntake(F.rows, { map: F.map, units: sfKnownUnits(), aliases: al, refDate: S.config.sessionStart || '' }); }
function sfDirOpts(dir, sel) {
  const by = {}; dir.list.forEach(e => (by[e.stake] = by[e.stake] || []).push(e));
  return Object.keys(by).sort().map(st => `<optgroup label="${esc(st)}">${by[st].sort((a, b) => a.unit.localeCompare(b.unit)).map(e => opt(e.key, e.unit, e.key === sel)).join('')}</optgroup>`).join('');
}
function renderSf() {
  const box = $('#sfBox'); if (!box) return; const F = UI.sf;
  if (!F) { box.innerHTML = ''; return; }
  if (F.done) { box.innerHTML = `<div class="callout info" style="margin-top:10px">${F.done}</div>`; return; }
  const R = F.res, recs = intakeRecords(R, F.choices, F.role, S.staffList.filter(s => !s.fromAccount && !s.test));
  const merged = R.subs - R.people.length, upd8 = recs.filter(r => r.isUpdate).length;
  const need = u => !F.choices[u.k] && (u.status === 'choose' || u.status === 'unknown');
  const rank = { unknown: 0, choose: 1, fixed: 2, ok: 3 };
  const U = Object.values(R.units).sort((a, b) => need(b) - need(a) || rank[a.status] - rank[b.status] || b.n - a.n);
  const nNeed = U.filter(need).reduce((a, u) => a + u.n, 0);
  const roleName = F.role === 'column' ? 'staff' : ROLES[F.role].toLowerCase() + 's';
  const chip = u => F.choices[u.k] ? '<span class="chip good">Chosen</span>' : u.status === 'ok' ? '<span class="chip good">Matched</span>' : u.status === 'fixed' ? '<span class="chip info">Spelling fixed</span>' : u.status === 'choose' ? '<span class="chip warn">Choose one</span>' : '<span class="chip bad">Not found</span>';
  const stakes = uniq(R.dir.list.map(e => e.stake)).sort();
  const unitRow = u => {
    const sel = F.choices[u.k] || (u.unit ? u.stake + '|' + u.unit : '');
    const first = sel ? '' : opt('', u.status === 'choose' ? `Choose: ${u.why.replace(/^Could be /, '')}` : 'Choose the ward or branch…', true);
    const add = F.adding === u.k ? `<div class="sf-add"><input id="sfNewStake" list="sfStakes" placeholder="Stake or district" value="${esc(u.stake || '')}" autocomplete="off"><input id="sfNewUnit" placeholder="Ward or branch" value="${esc(sfName(u.raw[0]))}" autocomplete="off"><button class="btn small primary" data-act="sfNewSave" data-v="${esc(u.k)}">Use this</button><button class="btn small" data-act="sfNewCancel">Cancel</button></div>` : '';
    return `<tr${need(u) ? ' class="needs"' : ''}><td><b>${u.raw.map(esc).join('</b>, <b>')}</b><br><small class="muted">${u.n} ${u.n === 1 ? 'person' : 'people'}${u.status === 'fixed' && !F.choices[u.k] ? ' · ' + esc(u.why) : ''}</small></td><td>${chip(u)}</td><td><select data-act="sfUnit" data-v="${esc(u.k)}" aria-label="Ward or branch for ${esc(u.raw[0])}">${first}${sfDirOpts(R.dir, sel)}${opt('__new', '+ Add a ward or branch not on this list')}</select>${sel ? `<small class="muted sf-stake">${esc(sel.split('|')[0])}</small>` : u.stake ? `<small class="muted sf-stake">${esc(u.stake)}</small>` : ''}${add}</td></tr>`;
  };
  const issues = R.people.filter(p => p.issues.length), dups = R.people.filter(p => p.subs > 1), diets = R.people.filter(p => p.diet);
  box.innerHTML = `<div class="inline" style="margin-bottom:10px;flex-wrap:wrap"><b>${esc(F.name)}</b>
    <label class="inline">Everyone in this file is <select id="sfRole">${['counselor', 'ac', 'coordinator'].map(r => opt(r, 'a ' + ROLES[r].toLowerCase(), F.role === r)).join('')}${F.hasRole ? opt('column', `as given in the ${F.roleCol || 'Type'} column`, F.role === 'column') : ''}</select></label></div>
    <div class="kpis sf-k"><div class="kpi"><span>Responses</span><b>${R.subs}</b></div><div class="kpi"><span>People</span><b>${R.people.length}</b></div><div class="kpi"><span>Duplicates merged</span><b>${merged}</b></div><div class="kpi"><span>Already on staff list</span><b>${upd8}</b></div></div>
    ${F.role === 'column' ? `<p class="note"><b>By type:</b> ${['counselor', 'ac', 'coordinator'].map(r => `${recs.filter(x => x.role === r).length} ${esc(ROLES[r].toLowerCase())}s`).join(', ')}${R.people.filter(p => !p.role).length ? ` · <span class="chip warn">${R.people.filter(p => !p.role).length} with no type, imported as counselors</span>` : ''}</p>` : ''}
    <p class="note">${R.blank ? `${R.blank} blank row${R.blank === 1 ? '' : 's'} skipped. ` : ''}Phone numbers are written as 07… or 01…, names are capitalised and "None", "N/A" and similar food answers are cleared.</p>
    <h3 style="margin:14px 0 6px">Wards and branches</h3>
    ${nNeed ? `<div class="callout" style="margin-bottom:8px">${nNeed} ${nNeed === 1 ? 'person needs' : 'people need'} a ward or branch chosen below. Choices are remembered for the next upload.</div>` : '<p class="note">Every ward and branch is matched. Check the spelling fixes, then import.</p>'}
    ${(() => { const hd = '<thead><tr><th>Typed in the form</th><th></th><th>Ward or branch · stake or district</th></tr></thead>'; const rev = U.filter(u => u.status !== 'ok' || F.choices[u.k] || F.adding === u.k), ok = U.filter(u => !rev.includes(u)); return (rev.length ? `<div class="tablewrap"><table class="sf-units">${hd}<tbody>${rev.map(unitRow).join('')}</tbody></table></div>` : '') + (ok.length ? `<details class="sf-d" ${rev.length ? '' : 'open'}><summary><b>Matched exactly</b> <span class="chip good">${ok.length} wards and branches · ${ok.reduce((a, u) => a + u.n, 0)} people</span></summary><div class="tablewrap" style="margin-top:8px"><table class="sf-units">${hd}<tbody>${ok.map(unitRow).join('')}</tbody></table></div></details>` : ''); })()}
    <datalist id="sfStakes">${stakes.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
    ${issues.length ? `<details open class="sf-d"><summary><b>Check these people</b> <span class="chip warn">${issues.length}</span></summary><ul class="sf-list">${issues.map(p => `<li><b>${esc(p.name)}</b> · ${p.issues.map(esc).join('; ')}</li>`).join('')}</ul><p class="note">They are imported as they are. Open them on the staff list afterwards to fix the details.</p></details>` : ''}
    ${dups.length ? `<details class="sf-d"><summary><b>People who sent the form more than once</b> <span class="chip">${dups.length}</span></summary><ul class="sf-list">${dups.map(p => `<li><b>${esc(p.name)}</b> · ${esc(p.dupNote)}</li>`).join('')}</ul></details>` : ''}
    ${diets.length ? `<details class="sf-d"><summary><b>Food needs</b> <span class="chip">${diets.length}</span></summary><ul class="sf-list">${diets.map(p => `<li><b>${esc(p.name)}</b> · ${esc(p.diet)}</li>`).join('')}</ul></details>` : ''}
    <div class="btnrow" style="margin-top:14px"><button class="btn primary" data-act="sfGo" ${F.busy ? 'disabled' : ''}>${F.busy ? esc(F.busy) : `Import ${R.people.length} ${esc(roleName)}`}</button><button class="btn" data-act="sfCancel">Cancel</button></div>`;
}
async function sfImport() {
  const F = UI.sf; if (!F || F.busy) return;
  const R = F.res;
  const recs = intakeRecords(R, F.choices, F.role, S.staffList.filter(s => !s.fromAccount && !s.test));
  const nUpd = recs.filter(r => r.isUpdate).length;
  F.busy = 'Saving…'; renderSf();
  try {
    const s = {}; recs.forEach(r => { const x = Object.assign({}, r); delete x.isUpdate; s[x.id] = x; });
    S.staff = Object.assign({}, S.staff, s); const ex = S.staffEx; S.staffEx = true;
    await upd('staff/all', { s }, ex);
    const al = Object.assign({}, S.config.unitAliases || {}); let n = 0;
    for (const k in F.choices) { const core = k.split('|')[0]; if (core && al[core] !== F.choices[k]) { al[core] = F.choices[k]; n++; } }
    if (n && can.admin()) await saveConfig({ unitAliases: al }); else recompute(true);
    audit('staff', `Imported ${recs.length} staff from ${F.name} (${recs.length - nUpd} new, ${nUpd} updated)`);
    const role = F.role === 'column' ? 'counselor' : F.role; UI.staffTab = role; UI.staffView = 'area';
    const merged = R.subs - R.people.length;
    UI.sf = { done: `Imported ${recs.length} ${F.role === 'column' ? 'staff' : esc(ROLES[F.role].toLowerCase()) + 's'}: ${recs.length - nUpd} new${nUpd ? `, ${nUpd} updated` : ''}.${merged ? ` ${merged} duplicate submission${merged === 1 ? ' was' : 's were'} merged.` : ''} The list below is sorted by stake and unit. Use <b>Choose a file to import</b> above to import another file.` };
    const f = $('#sfFile'); if (f) f.value = '';
  } catch (e) { fail(e); F.busy = null; }
  render();
}
function openStaffForm(id) {
  const s = id ? S.staffMap[id] : null;
  const stakes = uniq(S.P.map(p => p.stake).concat(S.staffList.map(x => x.stake)).filter(Boolean)).sort();
  const units = uniq(S.P.map(p => p.unit).concat(S.staffList.map(x => x.unit)).filter(Boolean)).sort();
  openModal(`<div class="modal-head"><h2>${s ? 'Edit ' + esc(s.name) : 'Add a staff member'}</h2><button class="x" data-act="close" aria-label="Close">×</button></div>
  <form id="stForm" class="form" data-id="${s ? esc(s.id) : ''}">
    <label class="span2">Full name<input id="stName" required value="${esc(s ? s.name : '')}" autocomplete="off"></label>
    <label>Role<select id="stRole">${STAFF_ROLES.map(r => opt(r, ROLES[r], r === (s ? s.role : UI.staffTab))).join('')}</select></label>
    <label>Gender<select id="stGender" required>${opt('', 'Choose…', !(s && s.gender))}${opt('F', 'Female', s && s.gender === 'F')}${opt('M', 'Male', s && s.gender === 'M')}</select></label>
    <label>Age<input id="stAge" type="number" min="16" max="90" inputmode="numeric" value="${esc(s ? (staffAge(s, S.config) ?? '') : '')}"></label>
    <label>Phone<input id="stPhone" inputmode="tel" value="${esc(s ? s.phone || '' : '')}"></label>
    <label class="span2">Google email <small class="muted" style="font-weight:600">· links their sign-in account to this record</small><input id="stEmail" type="email" inputmode="email" autocomplete="off" placeholder="name@gmail.com" value="${esc(s ? s.email || '' : '')}"></label>
    <label>Stake / district<input id="stStake" list="dlStStakes" value="${esc(s ? s.stake || '' : '')}" autocomplete="off"></label>
    <label>Ward / branch<input id="stUnit" list="dlStUnits" value="${esc(s ? s.unit || '' : '')}" autocomplete="off"></label>
    <label>T-shirt size<select id="stSize">${opt('', 'Not given', !(s && s.tshirt))}${SIZES.map(z => opt(z, SIZE_LABEL[z], s && s.tshirt === z)).join('')}</select></label>
    <div class="span2"><button class="btn primary" type="submit" style="width:100%">${s ? 'Save changes' : 'Add staff member'}</button></div>
  </form><datalist id="dlStStakes">${stakes.map(x => `<option value="${esc(x)}">`).join('')}</datalist><datalist id="dlStUnits">${units.map(x => `<option value="${esc(x)}">`).join('')}</datalist>`);
  setTimeout(() => { const n = $('#stName'); if (n && !s) n.focus(); }, 60);
}

/* page: headcount (nightly, Dec 7–11) */
/** Who each role reports the headcount to. The Session Directing Couple, Area Seventy and logistics only view. */
function hcChain() { const r = role(); return r === 'counselor' ? 'your AC' : r === 'ac' ? 'your coordinator' : r === 'coordinator' ? 'the Session Directing Couple' : ''; }
function hcViewOnly() { return can.readOnly() || ['sdc', 'seventy', 'loghead'].includes(role()); }
const DAYNAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function isoUTC(d) { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }
/** Tonight's date in Kenya time. Reports made after midnight but before 6 am count for the night before. */
function nightOf(ts) { const t = new Date((ts || Date.now()) + 3 * 3600e3); if (t.getUTCHours() < 6) t.setUTCDate(t.getUTCDate() - 1); return isoUTC(t); }
function hcNights() { const a = S.config.hcStart || DEFAULT_CONFIG.hcStart, b = S.config.hcEnd || DEFAULT_CONFIG.hcEnd; const out = []; const d = new Date(a + 'T00:00:00Z'), e = new Date(b + 'T00:00:00Z'); for (let i = 0; d <= e && i < 31; i++) { out.push(isoUTC(d)); d.setUTCDate(d.getUTCDate() + 1); } return out; }
function nightLabel(iso, long) { const d = new Date(iso + 'T00:00:00Z'); return long ? `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}` : `${DAYNAME[d.getUTCDay()]} ${d.getUTCDate()}`; }
function hcDay() { const ns = hcNights(), t = nightOf(); if (UI.hcDay && ns.includes(UI.hcDay)) return UI.hcDay; if (ns.includes(t)) return t; return t < ns[0] ? ns[0] : ns[ns.length - 1]; }
function hcDoc(day, gid) { return S.hc[day + '_' + gid] || null; }
/** Everything about one group's headcount for one night. */
function hcGroup(g, day) {
  const doc = hcDoc(day, g.id);
  const live = S.P.filter(p => p.g === g.id && p.s === 'in');
  const ids = doc && doc.submitted && Array.isArray(doc.expected) ? doc.expected : live.map(p => p.id);
  const byId = {}; S.P.forEach(p => byId[p.id] = p);
  const people = ids.map(id => byId[id]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const marks = (doc && doc.marks) || {};
  const present = people.filter(p => marks[p.id] === 'p'), missing = people.filter(p => marks[p.id] === 'm'), unmarked = people.filter(p => !marks[p.id]);
  const notCounted = S.P.filter(p => p.g === g.id && p.s !== 'in');
  return { g, doc, people, present, missing, unmarked, notCounted, submitted: !!(doc && doc.submitted), expected: people.length };
}
function hcScopeGroups() {
  const r = role(), G = Object.values(S.org.groups).sort((a, b) => a.num - b.num);
  if (r === 'counselor') return myGroups();
  if (r === 'ac') { const ids = myCompanies().map(c => c.id); return G.filter(g => ids.includes(g.companyId)); }
  return G;
}
PAGE_IMPL.headcount = {
  frame() {
    const r = role(), scope = r === 'counselor' ? 'Your group' : r === 'ac' ? 'Your company' : 'Whole session · live' + (hcViewOnly() ? ' · view only' : '');
    return `<section class="pagehead"><div><p class="th">Headcount · ${scope}</p><h1 id="hcTitle">Tonight's headcount</h1><p class="note">${r === 'counselor' ? 'Before bed, mark each youth in your group present or missing, then submit to your assistant coordinator.' : r === 'ac' ? 'Your counselors report their groups here. Check your groups, then submit any group yourself to your coordinator if needed. Missing youth and groups that have not reported are highlighted.' : r === 'coordinator' ? 'Every company, live as counselors and ACs report. Check the night, then report to the Session Directing Couple.' : 'Every group, company and missing youth for the night, updating live as counselors, ACs and coordinators report.'}</p></div>${['regadmin', 'sdc', 'seventy', 'coordinator', 'logistics'].includes(r) ? '<button class="btn" data-act="hcCsv">Export night</button>' : ''}</section>
    <div class="segscroll"><div class="chips" id="hcDays"></div></div>
    <div id="hcBody" style="display:flex;flex-direction:column;gap:14px"></div>`;
  },
  update() {
    const day = hcDay(), tonight = nightOf(), r = role();
    $('#hcTitle').textContent = (day === tonight ? 'Tonight · ' : '') + nightLabel(day, true);
    const groups = hcScopeGroups();
    $('#hcDays').innerHTML = hcNights().map(d => { const st = groups.map(g => hcGroup(g, d)).filter(x => x.expected); const done = st.length && st.every(x => x.submitted); const any = st.some(x => x.submitted); const n = st.filter(x => x.submitted).length; return `<button data-act="hcDay" data-v="${d}" aria-pressed="${d === day}">${nightLabel(d)}${d === tonight ? ' · tonight' : ''}${done ? ' ✓' : any ? ` · ${n}/${st.length}` : ''}</button>`; }).join('');
    const body = $('#hcBody');
    if (!Object.keys(S.org.groups).length) { body.innerHTML = '<div class="empty"><h3>No groups yet</h3>Headcounts start once companies and groups are generated.</div>'; return; }
    if (UI.hcGroup && S.org.groups[UI.hcGroup] && groups.some(g => g.id === UI.hcGroup)) { body.innerHTML = (r === 'counselor' ? '' : `<button class="btn" data-act="hcBack" style="align-self:flex-start">‹ Back to ${r === 'ac' ? 'your company' : 'all companies'}</button>`) + hcForm(hcGroup(S.org.groups[UI.hcGroup], day), day); return; }
    if (r === 'counselor' && !can.readOnly()) { body.innerHTML = groups.length ? groups.map(g => hcForm(hcGroup(g, day), day)).join('') : '<div class="empty"><h3>No group linked to your account</h3>Ask the registration admin to link your account to your staff record on the Accounts tab.</div>'; return; }
    body.innerHTML = hcOverview(groups, day);
  }
};
function hcForm(x, day) {
  const g = x.g, c = g.companyId && S.org.companies[g.companyId], cn = g.counselorId && S.staffMap[g.counselorId];
  const d = x.doc || {}, marks = d.marks || {}, reasons = d.reasons || {};
  const status = x.submitted ? `<span class="chip good">Submitted ${esc(fmtTime(d.at))} · ${esc(d.byName || 'someone')}</span>${d.counselorId && d.byStaff && d.byStaff !== d.counselorId ? ' <span class="chip info">Reported for the counselor</span>' : ''}` : x.doc ? '<span class="chip warn">Not submitted yet</span>' : '<span class="chip bad">Not reported</span>';
  const rows = x.people.map(p => { const m = marks[p.id]; return `<div class="hc-row ${m === 'm' ? 'is-missing' : m === 'p' ? 'is-present' : ''}">
      <div class="hc-name"><b>${esc(p.name)}</b><small class="muted">${p.age ?? '?'} · ${esc(p.unit)}</small></div>
      <div class="hc-toggle" role="group" aria-label="${esc(p.name)}"><button data-act="hcMark" data-v="p" data-id="${esc(p.id)}" data-g="${g.id}" aria-pressed="${m === 'p'}">Present</button><button data-act="hcMark" data-v="m" data-id="${esc(p.id)}" data-g="${g.id}" aria-pressed="${m === 'm'}">Missing</button></div>
      ${m === 'm' ? `<input class="hc-reason" data-hcreason="${esc(p.id)}" data-g="${g.id}" placeholder="Where are they? (optional)" value="${esc(reasons[p.id] || '')}" autocomplete="off">` : ''}</div>`; }).join('');
  const nc = x.notCounted;
  return `<section class="panel hc-card">
    <div class="hc-head"><div><h2>G${g.num} · ${esc(cn ? cn.name : 'No counselor')}</h2><small class="muted">${c ? 'Company ' + c.num + ' · AC ' + esc(sName(c.acId) || '—') : 'No company'} · ${BANDS[g.band]} ${g.gender === 'F' ? 'young women' : 'young men'}</small></div><div>${status}</div></div>
    <div class="hc-count"><div><b class="${x.missing.length ? 'bad' : ''}">${x.present.length}</b><span> of ${x.expected} present</span></div><div class="hstats">${x.missing.length ? `<span class="chip bad">${x.missing.length} missing</span>` : ''}${x.unmarked.length ? `<span class="chip warn">${x.unmarked.length} not marked</span>` : ''}${!x.missing.length && !x.unmarked.length && x.expected ? '<span class="chip good">Everyone accounted for</span>' : ''}</div></div>
    ${x.expected ? `${x.unmarked.length ? `<button class="btn adm-hc" data-act="hcAll" data-g="${g.id}">Mark everyone else present</button>` : ''}<div class="hc-list">${rows}</div>` : '<p class="note">No one in this group is checked in, so there is nobody to count.</p>'}
    ${nc.length ? `<p class="note" style="margin:0">Not counted tonight: ${nc.map(p => esc(p.first) + (p.s === 'out' ? ' (checked out)' : ' (never arrived)')).join(', ')}.</p>` : ''}
    <label class="form" style="display:block"><span class="note" style="display:block;margin-bottom:4px">${hcChain() ? 'Note for ' + hcChain() : 'Note'} (optional)</span><textarea data-hcnote="${g.id}" rows="2" placeholder="Anything they should know">${esc(d.note || '')}</textarea></label>
    <button class="btn go hc-submit adm-hc" data-act="hcSubmit" data-g="${g.id}" ${!x.expected || x.unmarked.length ? 'disabled' : ''}>${x.submitted ? 'Update headcount' : hcChain() ? 'Submit to ' + hcChain() : 'Save headcount'}${x.unmarked.length ? ` · mark ${x.unmarked.length} more` : ''}</button>
  </section>`;
}
function hcOverview(groups, day) {
  const r = role(); const all = groups.map(g => hcGroup(g, day)); const xs = all.filter(x => x.expected || x.doc);
  const reported = xs.filter(x => x.submitted), late = xs.filter(x => !x.submitted);
  const pres = reported.reduce((a, x) => a + x.present.length, 0), exp = reported.reduce((a, x) => a + x.expected, 0), allIn = xs.reduce((a, x) => a + (x.submitted ? x.expected : S.P.filter(p => p.g === x.g.id && p.s === 'in').length), 0);
  const missing = xs.flatMap(x => x.missing.map(p => ({ p, x }))).concat(xs.filter(x => x.submitted).flatMap(x => x.unmarked.map(p => ({ p, x, unmarked: true }))));
  const comps = uniq(groups.map(g => g.companyId)).map(id => S.org.companies[id]).filter(Boolean).sort((a, b) => a.num - b.num);
  let h = `<div class="kpis"><div class="kpi"><span>Groups reported</span><b>${reported.length} / ${xs.length}</b></div><div class="kpi"><span>Present</span><b>${pres} / ${exp}</b><small>in groups that reported · ${allIn} checked in</small></div><div class="kpi" style="${missing.length ? 'background:var(--bad);color:#fff' : ''}"><span>Missing</span><b>${missing.length}</b></div><div class="kpi"><span>Not reported yet</span><b>${late.length}</b></div></div>`;
  h += `${missing.length ? `<details class="panel fold hc-alert on" id="hc-missing" ${foldOpen('hc-missing') ? 'open' : ''}><summary><h2>Missing youth</h2><span class="chip bad">${missing.length}</span></summary>` : `<section class="panel hc-alert"><div class="panel-head"><h2>Missing youth</h2><span class="chip good">0</span></div>`}${missing.length ? `<div class="hc-miss">${missing.map(({ p, x, unmarked }) => { const c = x.g.companyId && S.org.companies[x.g.companyId]; const why = unmarked ? 'Not marked when submitted' : ((x.doc && x.doc.reasons && x.doc.reasons[p.id]) || 'No reason given'); return `<button class="hc-mi" data-act="hcOpen" data-g="${x.g.id}"><b>${esc(p.name)}</b><span>G${x.g.num} · ${esc(sName(x.g.counselorId) || 'No counselor')}${c ? ' · Company ' + c.num : ''}</span><span class="why">${esc(why)}</span><small class="muted">${esc(p.age ?? '?')} yrs · ${esc(p.unit)}${x.doc && x.doc.at ? ' · reported ' + esc(fmtTime(x.doc.at)) + ' by ' + esc(x.doc.byName || '') : ''}</small></button>`; }).join('')}</div>` : '<p class="note">Nobody has been reported missing for this night.</p>'}${missing.length ? '</details>' : '</section>'}`;
  h += `${late.length ? `<details class="panel fold hc-alert warn" id="hc-late" ${foldOpen('hc-late') ? 'open' : ''}><summary><h2>Groups that haven't reported</h2><span class="chip warn">${late.length}</span></summary>` : `<section class="panel hc-alert"><div class="panel-head"><h2>Groups that haven't reported</h2><span class="chip good">0</span></div>`}${late.length ? `<div class="flags">${late.map(x => `<button class="chip warn" data-act="hcOpen" data-g="${x.g.id}" style="cursor:pointer;padding:6px 11px">G${x.g.num} · ${esc(sName(x.g.counselorId) || 'No counselor')}${x.doc ? ' · started' : ''}</button>`).join('')}</div>` : '<p class="note">Every group has reported.</p>'}${late.length ? '</details>' : '</section>'}`;
  h += `<div class="companies">${comps.map(c => { const cxAll = all.filter(x => x.g.companyId === c.id), cx = cxAll.filter(x => x.expected || x.doc), cr = cx.filter(x => x.submitted); const cp = cr.reduce((a, x) => a + x.present.length, 0), ce = cr.reduce((a, x) => a + x.expected, 0), cIn = S.P.filter(p => p.company && p.company.id === c.id && p.s === 'in').length, cm = cx.reduce((a, x) => a + x.missing.length, 0); const allDone = cx.length && cr.length === cx.length;
    return `<section class="company"><div class="co-head"><div class="co-title"><h2>Company ${c.num}</h2><div class="inline">${cm ? `<span class="chip bad">${cm} missing</span>` : ''}${cx.length ? `<span class="chip ${allDone ? 'good' : 'warn'}">${cr.length}/${cx.length} reported</span>` : '<span class="chip">Nobody checked in</span>'}</div></div>
      <div class="co-meta"><span class="muted">AC</span><span>${esc(sName(c.acId) || '—')}</span><span class="muted">Present</span><span class="num"><b>${cp}</b> of ${ce} in reported groups · ${cIn} checked in${allDone && ce !== cIn ? ' <span class="chip warn">totals differ from check-in</span>' : ''}</span></div></div>
      ${cxAll.map(x => `<div class="grp"><div class="grp-row" data-act="hcOpen" data-g="${x.g.id}" role="button" tabindex="0"><span class="gnum">G${x.g.num}</span>${chipG(x.g.gender)}<span class="cn">${esc(sName(x.g.counselorId) || 'No counselor')}</span>${x.submitted ? `<span class="num">${x.present.length}/${x.expected}</span>${x.missing.length ? `<span class="chip bad">${x.missing.length} missing</span>` : '<span class="chip good">✓</span>'}` : !x.expected && !x.doc ? '<span class="chip">Nobody checked in</span>' : `<span class="chip ${x.doc ? 'warn' : 'bad'}">${x.doc ? 'Started' : 'Not reported'}</span>`}<span class="muted">›</span></div></div>`).join('')}</section>`; }).join('')}</div>`;
  return h;
}
let hcNoteT = {};
async function hcWrite(gid, patch, submit) {
  const day = hcDay(), id = day + '_' + gid, g = S.org.groups[gid]; if (!g) return;
  const base = { date: day, groupId: gid, groupNum: g.num, companyId: g.companyId || null, counselorId: g.counselorId || null, by: S.uid, byName: S.meName || S.email || '', byRole: role(), byStaff: myStaffId() || null, updatedAt: Date.now() };
  const cur = S.hc[id] || {};
  const next = Object.assign({}, cur, base, patch, { marks: Object.assign({}, cur.marks || {}, patch.marks || {}), reasons: Object.assign({}, cur.reasons || {}, patch.reasons || {}) });
  if (submit) Object.assign(next, { submitted: true, at: Date.now(), expected: hcGroup(g, day).people.map(p => p.id) });
  S.hc = Object.assign({}, S.hc, { [id]: next }); render();
  await setDoc('headcount/' + id, next).catch(fail);
}

/* page: sessions (split and move participants) */
/* Audit log page: registration admins only */
let audUnsub = null, audKey = '';
function audSubscribe() {
  const key = S.sid + '|' + (UI.audLimit || 500); if (audKey === key) return; audKey = key;
  if (audUnsub) { try { audUnsub(); } catch (e) { } }
  UI.audRows = null;
  audUnsub = FB.fs.collection(rawPath(S.sid, 'audit')).orderBy('at', 'desc').limit(UI.audLimit || 500).onSnapshot(sn => { UI.audRows = sn.docs.map(d => Object.assign({ id: d.id }, d.data())); if (currentPage() === 'audit') PAGE_IMPL.audit.update(); }, e => { console.error(e); UI.audRows = []; UI.audErr = true; if (currentPage() === 'audit') PAGE_IMPL.audit.update(); });
}
function audFiltered() {
  const rows = UI.audRows || [], q = (UI.audQ || '').toLowerCase().trim(), k = UI.audK || 'all', who = UI.audWho || '', day = UI.audDay || '';
  return rows.filter(r => (k === 'all' || r.kind === k) && (!who || r.uid === who) && (!day || new Date(r.at).toISOString().slice(0, 10) === day) && (!q || [r.text, r.name, r.email, ROLES[r.role] || r.role].join(' ').toLowerCase().includes(q)));
}
PAGE_IMPL.audit = {
  frame() {
    return `<section class="pagehead"><div><p class="th">Audit log · registration admins only</p><h1>Who did what, and when</h1><p class="note" style="margin:4px 0 0">Every change made in this session: check-ins, groups, staff, accounts, settings, health concerns and headcounts. Entries cannot be edited or deleted, not even by an admin.</p></div><button class="btn" data-act="audCsv">Export CSV</button></section>
    <section class="panel"><div class="acc-tools"><input id="audQ" type="search" placeholder="Search by name, email or what was done" autocomplete="off" value="${esc(UI.audQ || '')}"><select id="audWho" aria-label="Person"></select><select id="audDay" aria-label="Day"></select></div><div class="chips aud-kinds" id="audKinds"></div><div id="audList" style="margin-top:10px"></div></section>`;
  },
  update() {
    audSubscribe();
    const rows = UI.audRows;
    if (!rows) { $('#audList').innerHTML = '<p class="note">Loading…</p>'; return; }
    if (UI.audErr) { $('#audList').innerHTML = '<div class="callout">The audit log could not be read. Check that the latest security rules are published in Firebase.</div>'; return; }
    const people = {}; rows.forEach(r => { if (!people[r.uid]) people[r.uid] = r.name || r.email; });
    const days = uniq(rows.map(r => new Date(r.at).toISOString().slice(0, 10)));
    const w = $('#audWho'); if (w && document.activeElement !== w) w.innerHTML = opt('', 'Everyone') + Object.entries(people).sort((a, b) => a[1].localeCompare(b[1])).map(([u, n]) => opt(u, n, UI.audWho === u)).join('');
    const d = $('#audDay'); if (d && document.activeElement !== d) d.innerHTML = opt('', 'Any day') + days.map(x => opt(x, new Date(x + 'T12:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }), UI.audDay === x)).join('');
    const k = UI.audK || 'all'; const cnt = kk => rows.filter(r => r.kind === kk).length;
    $('#audKinds').innerHTML = [['all', 'All · ' + rows.length]].concat(Object.keys(AUDIT_KINDS).filter(kk => cnt(kk)).map(kk => [kk, AUDIT_KINDS[kk] + ' · ' + cnt(kk)])).map(([v, l]) => `<button data-act="audK" data-v="${v}" aria-pressed="${k === v}">${esc(l)}</button>`).join('');
    const list = audFiltered();
    const fmt = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#audList').innerHTML = list.length ? `<div class="tablewrap"><table class="aud-t"><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${list.map(r => `<tr><td class="nowrap" data-l="When">${esc(fmt(r.at))}</td><td data-l="Who"><b>${esc(r.name || r.email)}</b><br><small class="muted">${esc(ROLES[r.role] || r.role || '')}${r.preview ? ' · previewing as ' + esc(ROLES[r.preview] || r.preview) : ''}</small></td><td data-l="What"><span class="chip">${esc(AUDIT_KINDS[r.kind] || r.kind)}</span> ${esc(r.text)}</td></tr>`).join('')}</tbody></table></div>
      ${rows.length >= (UI.audLimit || 500) ? `<button class="btn small" data-act="audMore" style="margin-top:10px">Load older entries</button>` : ''}<p class="note">Showing ${list.length} of the latest ${rows.length} entries.</p>` : '<p class="note">Nothing matches.</p>';
  }
};
PAGE_IMPL.sessions = {
  frame() {
    UI.split = UI.split || { dest: 'new', name: '', team: 'same', sel: new Set() };
    return `<section class="pagehead"><div><p class="th">Sessions · registration admin, Area Seventy, Head of Logistics & Session Directing Couple</p><h1>Split or reorganise</h1><p class="note">Move participants by stake, district, ward or branch into a new session or another existing one. Only participants move: staff for the new session come from its own staff upload.</p></div></section>
    <section class="panel"><div class="panel-head"><h2>Sessions</h2></div><div id="sessList" class="sess-list"></div></section>
    <section class="panel" id="splitPanel"></section>`;
  },
  update() {
    if (!UI.sessCounts) { UI.sessCounts = {}; loadSessionCounts(); }
    $('#sessList').innerHTML = Object.keys(S.sessions).filter(id => S.mySessions.includes(id)).map(id => { const cur = id === S.sid; const n = cur ? registered().length : UI.sessCounts[id], left = cur ? S.P.length - registered().length : (UI.sessLeft || {})[id]; const x = S.sessions[id];
      return `<div class="sess ${cur ? 'cur' : ''}"><div><b>${esc(sessName(id))}</b><small class="muted">${n == null ? 'Counting…' : n + ' participants'}${left ? ` <span class="muted">(+${left} cancelled or left out)</span>` : ''}${x.from ? ' · split from ' + esc(sessName(x.from)) : ''}${x.at ? ' · ' + esc(fmtTime(x.at)) : ''}</small></div>${cur ? '<span class="chip good">Open now</span>' : `<button class="btn small" data-act="switchSession" data-v="${esc(id)}">Open</button>`}</div>`; }).join('');
    const sp = UI.split, others = S.mySessions.filter(id => id !== S.sid);
    const T = {}; S.P.forEach(p => { const { st, un } = areaOf(p); const x = T[st] = T[st] || { n: 0, u: {} }; x.n++; const u = x.u[un] = x.u[un] || { n: 0, inn: 0 }; u.n++; if (p.s === 'in') u.inn++; });
    const picked = S.P.filter(p => sp.sel.has(areaOf(p).st + '|' + areaOf(p).un)), pIn = picked.filter(p => p.s === 'in').length;
    const tree = Object.keys(T).sort().map(st => { const units = Object.keys(T[st].u).sort(); const all = units.every(u => sp.sel.has(st + '|' + u)), some = units.some(u => sp.sel.has(st + '|' + u));
      return `<div class="sp-stake"><label class="sp-row st"><input type="checkbox" data-act="spStake" data-v="${esc(st)}" ${all ? 'checked' : ''} ${!all && some ? 'data-mixed="1"' : ''}><b>${esc(st)}</b><span class="cnt">${T[st].n}</span></label>${units.map(u => `<label class="sp-row un"><input type="checkbox" data-act="spUnit" data-v="${esc(st + '|' + u)}" ${sp.sel.has(st + '|' + u) ? 'checked' : ''}><span>${esc(u)}</span><span class="cnt">${T[st].u[u].n}${T[st].u[u].inn ? ` · ${T[st].u[u].inn} in` : ''}</span></label>`).join('')}</div>`; }).join('');
    $('#splitPanel').innerHTML = `<div class="panel-head"><h2>Move participants out of ${esc(sessName(S.sid))}</h2></div>
      <div class="form">
        <label>Move them to<select id="spDest" data-region="1">${opt('new', 'A new session', sp.dest === 'new')}${others.map(id => opt(id, sessName(id), sp.dest === id)).join('')}</select></label>
        ${sp.dest === 'new' ? `<label>New session name<input id="spName" data-region="1" value="${esc(sp.name)}" placeholder="e.g. FSY Kenya 2026 · Western" autocomplete="off"></label>` : ''}
        <div class="span2"><span class="note" style="display:block;margin-bottom:6px;font-weight:700">Staff team for ${sp.dest === 'new' ? 'the new session' : esc(sessName(sp.dest))}</span>
          <label class="radio"><input type="radio" name="spTeam" value="same" ${sp.team === 'same' ? 'checked' : ''}><span>The same Session Directing Couple <small class="muted">· they get access to both sessions</small></span></label>
          <label class="radio"><input type="radio" name="spTeam" value="new" ${sp.team === 'new' ? 'checked' : ''}><span>A different staff team <small class="muted">· upload their staff file and create their accounts in that session</small></span></label></div>
      </div>
      <p class="th" style="margin:16px 0 6px">Choose stakes, districts, wards and branches</p>
      <div class="sp-tree">${tree || '<p class="note">No participants in this session.</p>'}</div>
      <div class="sp-sum"><div><b>${picked.length}</b> participants selected${pIn ? ` · <b>${pIn}</b> already checked in (their check-ins move with them)` : ''}</div>
      <button class="btn primary" data-act="spGo" ${picked.length && (sp.dest !== 'new' || sp.name.trim()) ? '' : 'disabled'}>Move ${picked.length || ''} participants</button></div>
      <p class="note" style="margin:8px 0 0">Moved youth leave their groups here. Press Rebalance afterwards in both sessions. Registration admins and the Area Seventy can open every session.</p>`;
    document.querySelectorAll('[data-mixed]').forEach(el => el.indeterminate = true);
  }
};
async function loadSessionCounts() {
  UI.sessLeft = UI.sessLeft || {};
  for (const id of S.mySessions) { if (id === S.sid) continue; try {
    // count the way the open session does: cancelled statuses and left-out areas are not participants
    const cd = await FB.fs.doc(rawPath(id, 'config/session')).get(); const cfg = Object.assign({}, DEFAULT_CONFIG, cd.exists ? cd.data() : {});
    const exS = new Set(cfg.excludedStatuses || []), exSt = new Set(cfg.excludedStakes || []), exU = new Set(cfg.excludedUnits || []);
    const sn = await FB.fs.collection(rawPath(id, 'roster')).get(); let n = 0, out = 0;
    sn.docs.forEach(d => { const m = (d.data() || {}).p || {}; for (const k in m) { const r = m[k]; if (!r) continue; const st = normStatus(r.status); if ((st && exS.has(st)) || exSt.has(r.stake) || exU.has((r.stake || '') + '|' + (r.unit || ''))) out++; else n++; } });
    UI.sessCounts[id] = n; UI.sessLeft[id] = out;
  } catch (e) { UI.sessCounts[id] = '?'; } }
  if (currentPage() === 'sessions') render();
}
async function moveParticipants(list, target, opts) {
  audit('session', `Moved ${list.length} participants from ${sessName(S.sid)} to ${opts.isNew ? 'a new session, ' + opts.name : sessName(target)}`);
  const src = S.sid, del = firebase.firestore.FieldValue.delete;
  const isSdc = realRole() === 'sdc', myKey = emailKey(S.email || '');
  const byB = {}; list.forEach(p => (byB[bucketOf(p.id)] = byB[bucketOf(p.id)] || []).push(p.id));
  const intake = {}; for (const u in S.intake) Object.assign(intake, (S.intake[u] || {}).p || {});
  // 1. the session list first (a Session Directing Couple may only open a new session they created)
  const entry = { [src]: { name: S.config.sessionName || sessName(src), at: (S.sessions[src] || {}).at || 0 } };
  if (opts.isNew) entry[target] = { name: opts.name, at: Date.now(), by: S.meName || '', creator: S.email || '', from: src };
  await FB.fs.doc('meta/sessions').set({ s: entry }, { merge: true });
  Object.assign(S.sessions, entry);
  // 2. access: a directing couple adds the new session to their own account, then to the other directing couple of this session
  if (isSdc && opts.isNew) { const mine = invSessions(S.invites[myKey] || {}); if (!mine.includes(target)) await FB.fs.doc('invites/' + myKey).set({ sessions: mine.concat(target) }, { merge: true }); }
  if (opts.team === 'same') for (const e in S.invites) { const v = S.invites[e]; if (e !== myKey || !isSdc) if (v.role === 'sdc' && invSessions(v).includes(src) && !invSessions(v).includes(target)) await FB.fs.doc('invites/' + e).set({ sessions: invSessions(v).concat(target) }, { merge: true }).catch(err => console.warn('access', e, err)); }
  if (opts.isNew) await FB.fs.doc(rawPath(target, 'config/session')).set(Object.assign({}, S.config, { sessionName: opts.name, excludedStakes: [], excludedUnits: [] }));
  // 3. copy into the destination
  for (const b in byB) {
    const r = {}, st = {}, md = {};
    byB[b].forEach(id => {
      const rec = (S.roster[b] || {})[id]; if (rec) { const x = Object.assign({}, rec); delete x.med; delete x.diet; r[id] = x; }
      const s0 = (S.state[b] || {})[id]; if (s0) st[id] = Object.assign({}, s0, { g: null });
      const m0 = (S.medical[b] || {})[id] || intake[id] || (rec && (rec.med || rec.diet) ? { med: rec.med || '', diet: rec.diet || '' } : null); if (m0) md[id] = { med: m0.med || '', diet: m0.diet || '' };
    });
    await FB.fs.doc(rawPath(target, 'roster/' + b)).set({ p: r }, { merge: true });
    if (Object.keys(st).length) await FB.fs.doc(rawPath(target, 'state/' + b)).set({ p: st }, { merge: true });
    if (Object.keys(md).length) await FB.fs.doc(rawPath(target, 'medical/' + b)).set({ p: md }, { merge: true });
  }
  // 4. remove from this session (field by field, so check-ins made meanwhile elsewhere are untouched)
  for (const b in byB) {
    const gone = {}; byB[b].forEach(id => gone['p.' + id] = del());
    await FB.fs.doc(rawPath(src, 'roster/' + b)).update(gone);
    if (S.stateEx.has(b) && byB[b].some(id => (S.state[b] || {})[id])) await FB.fs.doc(rawPath(src, 'state/' + b)).update(gone).catch(() => { });
    if (S.medicalEx.has(b) && byB[b].some(id => (S.medical[b] || {})[id])) await FB.fs.doc(rawPath(src, 'medical/' + b)).update(gone).catch(() => { });
  }
  // 5. a directing couple handing a new session to a different team steps out of it
  if (isSdc && opts.isNew && opts.team === 'new') { const mine = invSessions(S.invites[myKey] || {}).filter(x => x !== target); await FB.fs.doc('invites/' + myKey).set({ sessions: mine }, { merge: true }).catch(() => { }); }
  else if (!S.mySessions.includes(target)) S.mySessions.push(target);
}

/* page: data */
PAGE_IMPL.data = {
  frame() {
    return `<section class="pagehead"><div><h1>Data & areas</h1><p class="note" style="margin:4px 0 0">Upload the FSY portal export, choose which stakes and units belong to this session, and clean up problem records.</p></div></section>
    <div class="panel adm"><h2>Upload participants or staff</h2><p class="note">Excel (.xlsx, .xls) or .csv. Column headers are read from the first row and matched to fields. Rows are matched by Registration ID, so uploading a newer export updates people without losing check-ins or groups. The Type column decides who is a participant, counselor or assistant coordinator.</p>
      <input type="file" id="impFile" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"><div id="impBox" style="margin-top:12px"></div></div>
    <div class="grid2"><div class="panel"><h2>Session settings</h2><form id="cfgForm" class="form">
      <label class="span2">Session name<input id="cfName" value="${esc(S.config.sessionName)}"></label>
      <label>First day of session<input id="cfStart" type="date" value="${esc(S.config.sessionStart || '')}"></label>
      <label>First headcount night<input id="cfHcStart" type="date" value="${esc(S.config.hcStart || '')}"></label>
      <label>Last headcount night<input id="cfHcEnd" type="date" value="${esc(S.config.hcEnd || '')}"></label>
      <label>Young women per group<input id="cfSizeF" type="number" min="4" max="25" value="${esc(gsize(S.config, 'F'))}"></label>
      <label>Young men per group<input id="cfSizeM" type="number" min="4" max="25" value="${esc(gsize(S.config, 'M'))}"></label>
      <div class="span2" id="fitRow"></div>
      <p class="note span2" style="margin:0">With a first day set, ages are worked out from birthdays on that day. Without it, the Age column from the upload is used.</p>
      <div class="span2 adm"><button class="btn primary" type="submit">Save settings</button></div></form>
      <h3 style="margin:16px 0 6px">Registration statuses</h3><div id="dStat"></div></div>
    <div class="panel"><h2>Data problems</h2><div id="dIss"></div></div></div>
    <div class="panel"><div class="panel-head"><h2>Stakes, wards and branches in this session</h2><span class="note">Untick an area to leave its youth out of the expected list and the groups.</span></div><div id="dAreas" class="arealist"></div></div>`;
  },
  update() {
    if ($('#fitRow')) $('#fitRow').innerHTML = fitHint();
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
    if (rec.staff.length) { const s = {}; rec.staff.forEach(x => { if (!S.staff[x.id]) { x.addedAt = Date.now(); x.addedBy = S.meName || ''; } else if (S.staff[x.id].addedAt) x.addedAt = S.staff[x.id].addedAt; s[x.id] = x; }); const ex = S.staffEx; S.staffEx = true; await upd('staff/all', { s }, ex); }
    if (!S.configEx) await saveConfig({});
    audit('settings', `Uploaded ${I.name}: ${rec.participants.length} participants and ${rec.staff.length} staff`);
    UI.imp = { done: `Imported ${rec.participants.length} participants and ${rec.staff.length} staff. Next: untick excluded areas below, then generate companies on the Companies & groups tab.` };
  } catch (e) { fail(e); I.busy = null; }
  renderImport();
}

/* page: access */
PAGE_IMPL.access = {
  frame() {
    return `<section class="pagehead"><div><p class="th">Accounts</p><h1>Who can use the app</h1><p class="note" style="margin:4px 0 0">Create an account for each person with their Google email. When they sign in with that Google account, they get their role straight away.</p></div></section>
    <div class="callout info">Send counselors and staff the web address of this site. They press <b>Sign in with Google</b> using the email you enter below. Nobody else can see any data.</div>
    <div class="panel"><h2>Create an account</h2><form id="invForm" class="form">
      <label>Full name<input id="invName" required autocomplete="off"></label>
      <label>Google email<input id="invEmail" type="email" required autocomplete="off" placeholder="name@gmail.com"></label>
      <label>Gender<select id="invGender">${opt('', 'Choose…')}${opt('F', 'Female')}${opt('M', 'Male')}</select></label>
      <label>Role<select id="invRole" required>${opt('', 'Choose…')}${Object.keys(ROLES).filter(r => roleAssignable(r)).map(r => opt(r, ROLES[r])).join('')}</select></label>
      <label>Staff record<select id="invStaff">${opt('', '— Link later')}${S.staffList.filter(x => ['counselor', 'ac', 'coordinator', 'sdc'].includes(x.role)).map(x => opt(x.id, x.name + ' · ' + ROLES[x.role])).join('')}</select></label>
      ${S.mySessions.length > 1 ? `<div class="span2"><span class="note" style="display:block;margin-bottom:4px;font-weight:700">Sessions they can open</span><div class="flags">${S.mySessions.map(id => `<label class="chip sesschk"><input type="checkbox" class="invSessChk" value="${esc(id)}" ${id === S.sid ? 'checked' : ''}> ${esc(sessName(id))}</label>`).join('')}</div><small class="muted">Registration admins and the Area Seventy open every session.</small></div>` : ''}
      <p class="note span2" style="margin:0">Counselors and ACs must be linked to their staff record. That decides which group and company, and whose medical and dietary notes, they can see.</p>
      <div class="span2"><button class="btn primary" type="submit">Create account</button></div></form></div>
    <div class="panel"><div class="panel-head"><h2>Accounts you created</h2><span class="note" id="invCount"></span></div><div class="acc-tools"><input id="accQ" type="search" placeholder="Search accounts by name, email, role or staff record" autocomplete="off" value="${esc(UI.accQ || '')}"><div class="chips" id="accChips"></div><div id="accOC"></div></div><div id="invList"></div></div>
    <div class="panel"><h2>Sign-in requests</h2><p class="note" style="margin-top:-4px">From people whose Google email did not match an account. Choosing a role creates an account for that email.</p><div id="acReq"></div></div>
    <div class="panel"><h2>What each role sees and does</h2><div class="tablewrap"><table><thead><tr><th>Role</th><th>Sees</th><th>Can</th></tr></thead><tbody>
      <tr><td>Registration admin</td><td>Whole session</td><td>Everything, including deleting participants and managing accounts. Only a registration admin can make someone else a registration admin.</td></tr>
      <tr><td>Session Directing Couple</td><td>Whole session</td><td>Everything except deleting participants, including creating accounts.</td></tr>
      <tr><td>Area Seventy</td><td>Every session</td><td>The same as the Session Directing Couple, in every session, plus splitting and reorganising sessions.</td></tr>
      <tr><td>Head of Logistics</td><td>Every session</td><td>The same as the Area Seventy: everything, in every session, including accounts, staff, groups and companies, and splitting and reorganising sessions.</td></tr>
      <tr><td>Coordinator</td><td>Whole session</td><td>Check in, move participants between any groups, rebalance or regenerate groups and companies, add or remove companies, choose counselors and ACs, manage staff, logistics for everyone.</td></tr>
      <tr><td>Wellness coordinator</td><td>Whole session</td><td>Sees the Wellness page: every medical and dietary note for youth and staff, and the health concerns counselors report. Can view check-in and the tally, but checks nobody in and has no group.</td></tr>
      <tr><td>Logistics</td><td>Whole session</td><td>Sees every page except Accounts: check-in, tally, companies, walk-ins, medical and dietary lists, T-shirts, headcount, staff, wellness (view only) and data. Can check youth in and add walk-ins. Cannot change companies, staff, settings or records.</td></tr>
      <tr><td>Assistant coordinator</td><td>Their company</td><td>Check in, move participants inside their company, logistics for their company.</td></tr>
      <tr><td>Counselor</td><td>Their group and company</td><td>Check in, undo and check out, add walk-ins, logistics for their company.</td></tr></tbody></table></div>
      <p class="note">These limits are enforced by the database's security rules, not only by the screens. Medical and dietary notes are stored apart; counselors, ACs, coordinators and logistics only receive the notes for the youth they are allowed to see.</p></div>`;
  },
  async update() {
    const invs = Object.entries(S.invites).filter(([, v]) => UI.accAll || invHere(v)).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
    const claimed = {}; for (const uid in S.members) { const h = S.members[uid].h; if (h) claimed[h] = uid; }
    const roleOpts = cur => Object.keys(ROLES).filter(r => r === cur || roleAssignable(r)).map(r => opt(r, ROLES[r], r === cur)).join('');
    const staffOpts = cur => opt('', '— Not linked', !cur) + S.staffList.filter(x => ['counselor', 'ac', 'coordinator', 'sdc'].includes(x.role)).map(x => opt(x.id, x.name + ' · ' + ROLES[x.role], x.id === cur)).join('');
    if (!$('#invList')) return;
    if (!$('#accAllWrap') && can.split() && $('#invCount')) $('#invCount').insertAdjacentHTML('afterend', `<label class="inline note" id="accAllWrap" style="margin:0"><input type="checkbox" id="accAll" ${UI.accAll ? 'checked' : ''}> Show every session</label>`);
    $('#invCount').textContent = invs.length ? `${Object.keys(claimed).filter(h => S.invites[h]).length} of ${invs.length} signed in` : '';
    const rowOf = ([h, v]) => `<tr><td><b>${esc(v.name)}</b></td><td class="mono" style="font-size:.84rem">${esc(S.inviteEmails[h] || h)}</td><td><select data-act="invRole" data-id="${h}" aria-label="Role">${roleOpts(v.role)}</select>${ACCOUNT_STAFF_ROLES.includes(v.role) ? `<select data-act="invGender" data-id="${h}" aria-label="Gender" class="inv-g${v.gender ? '' : ' missing'}">${opt('', 'Gender?', !v.gender)}${opt('F', 'Female', v.gender === 'F')}${opt('M', 'Male', v.gender === 'M')}</select>` : ''}</td><td>${['counselor', 'ac', 'coordinator', 'sdc'].includes(v.role) ? `<select data-act="invStaff" data-id="${h}" aria-label="Staff record">${staffOpts(v.staffId)}</select>` : '<span class="muted">Not needed</span>'}${['counselor', 'ac'].includes(v.role) && !(v.staffId && S.staff[v.staffId]) ? ' <span class="chip warn">Link needed</span>' : v.staffId && S.staff[v.staffId] && v.staffAuto ? ` <span class="chip good" title="Linked automatically by matching ${v.staffAuto === 'email' ? 'email' : 'name and role'}">Auto${v.staffAuto === 'name' ? ' (name)' : ''}</span>` : ''}</td>${S.mySessions.length > 1 || UI.accAll ? `<td>${TOP_ROLES.includes(v.role) ? '<span class="muted">All sessions</span>' : `<button class="btn small" data-act="invSess" data-id="${h}">${esc(invSessions(v).map(sessName).join(', '))}</button>`}</td>` : ''}<td>${claimed[h] ? '<span class="chip good">Signed in</span>' : '<span class="chip">Waiting</span>'}</td><td><button class="btn small danger" data-act="invDel" data-id="${h}">Delete</button></td></tr>`;
    const aq = (UI.accQ || '').toLowerCase().trim(), af = UI.accF || 'all';
    const linkNeeded = v => ['counselor', 'ac'].includes(v.role) && !(v.staffId && S.staff[v.staffId]);
    const shown = invs.filter(([h, v]) => (!aq || [v.name, h, S.inviteEmails[h], ROLES[v.role], v.staffId && S.staff[v.staffId] ? S.staff[v.staffId].name : ''].join(' ').toLowerCase().includes(aq))
      && (af === 'all' || (af === 'link' && linkNeeded(v)) || (af === 'out' && !claimed[h]) || (af === 'in' && claimed[h])));
    const ncol = (S.mySessions.length > 1 || UI.accAll) ? 7 : 6;
    const open = UI.accOpen || (UI.accOpen = new Set());
    const byRole = {}; shown.forEach(x => (byRole[x[1].role] = byRole[x[1].role] || []).push(x));
    const order = Object.keys(ROLES).filter(r => byRole[r]).concat(Object.keys(byRole).filter(r => !ROLES[r]));
    $('#accChips').innerHTML = [['all', 'All · ' + invs.length], ['link', 'Link needed · ' + invs.filter(([, v]) => linkNeeded(v)).length], ['out', 'Not signed in yet · ' + invs.filter(([h]) => !claimed[h]).length], ['in', 'Signed in · ' + invs.filter(([h]) => claimed[h]).length]].map(([v, l]) => `<button data-act="accF" data-v="${v}" aria-pressed="${af === v}">${l}</button>`).join('');
    $('#accOC').innerHTML = order.length > 1 && !aq && af === 'all' ? `<div class="btnrow" style="margin:0"><button class="btn small" data-act="accAllOpen" data-v="1">Open all</button><button class="btn small" data-act="accAllOpen" data-v="">Close all</button></div>` : '';
    const body = order.map(r => { const list = byRole[r], isOpen = !!aq || af !== 'all' || open.has(r), signed = list.filter(([h]) => claimed[h]).length, need = list.filter(([, v]) => linkNeeded(v)).length;
      return `<tr class="click acc-h" data-act="accToggle" data-v="${esc(r)}"><td colspan="${ncol}"><b>${isOpen ? '▾' : '▸'} ${esc(ROLE_PLURAL[r] || ROLES[r] || r)}</b> <span class="muted">· ${list.length} · ${signed} signed in</span>${need ? ` <span class="chip warn">${need} link needed</span>` : ''}</td></tr>` + (isOpen ? list.map(rowOf).join('') : ''); }).join('');
    $('#invList').innerHTML = invs.length ? (shown.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Staff record</th>${S.mySessions.length > 1 || UI.accAll ? '<th>Sessions</th>' : ''}<th>Status</th><th></th></tr></thead><tbody>${body}</tbody></table></div>` : `<p class="note">No accounts match.</p>`) : '<p class="note">No accounts yet. Create the first one above.</p>';
    const reqIds = Object.keys(S.requests).filter(id => !S.invites[emailKey(S.requests[id].email || '')]);
    const accIds = Object.keys(S.access);
    const ps = S.user ? await S.user.profiles(uniq(reqIds.concat(accIds))) : {};
    const nm = id => (S.requests[id] && S.requests[id].name) || (ps[id] && ps[id].name) || 'Someone';
    const roleSel = (id, cur, act) => `<select data-act="${act}" data-id="${esc(id)}" aria-label="Role">${opt('', 'Choose role…', !cur)}${Object.keys(ROLES).filter(r => roleAssignable(r)).map(r => opt(r, ROLES[r], r === cur)).join('')}</select>`;
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

/* participant details */
function openDetail(id) {
  const p = S.P.find(x => x.id === id); if (!p) return;
  const adm = can.admin(), priv = seesPrivate(p);
  const row = (l, v) => v ? `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>` : '';
  const prow = (l, v) => priv ? row(l, v) : '';
  openModal(`<div class="modal-head"><div><h2>${esc(p.name)}</h2><div class="sub">${chipG(p.gender)}${chipBand(p.band)}<span class="chip">${p.age ?? '?'} yrs</span>${flagChips(p)}</div></div><button class="x" data-act="close" aria-label="Close">×</button></div>
  <dl class="pc-grid">${row('Preferred name', p.pref)}${row('Birthday', p.bday)}${row('Group', p.group ? 'G' + p.group.num + ' · ' + (p.counselor ? p.counselor.name : 'No counselor') : 'Not assigned')}${row('Company', p.company ? 'Company ' + p.company.num + ' · AC ' + (sName(p.company.acId) || '—') : '')}${row('T-shirt', SIZE_LABEL[p.tshirt] || p.tshirt || 'Not given')}${row('Ward / branch', p.unit)}${row('Stake / district', p.stake)}${row('Status', (p.status || '').replace(/_/g, ' ').toLowerCase())}${prow('Phone', p.phone)}${prow('Email', p.email)}${prow('Contact 1', [p.c1n, p.c1p, p.c1e].filter(Boolean).join(' · '))}${prow('Contact 2', [p.c2n, p.c2p, p.c2e].filter(Boolean).join(' · '))}${prow("Bishop / branch president", [p.bishopN, p.bishopE].filter(Boolean).join(' · '))}${row('Checked in', fmtTime(p.ti))}${row('Checked out', fmtTime(p.to))}${row('Registration ID', p.id)}</dl>
  ${priv ? '' : '<p class="note" style="margin:0">Medical, dietary and contact details are only shown for youth in your company.</p>'}<dl class="pc-grid" ${priv ? '' : 'hidden'}><div class="wide"><dt>Medical${adm ? ' (as entered)' : ''}</dt><dd>${esc(p.med || '—')} ${p.medIssue ? '<span class="chip warn">Counted</span>' : ''}</dd></div><div class="wide"><dt>Dietary${adm ? ' (as entered)' : ''}</dt><dd>${esc(p.diet || '—')} ${p.dietIssue ? '<span class="chip warn">Counted</span>' : ''}</dd></div></dl>
  ${priv ? repHistory(p) : ''}
  ${can.checkin() ? `<div class="btnrow">${p.s === 'in' ? `<button class="btn" data-act="ciUndo" data-id="${esc(p.id)}">Undo check-in</button><button class="btn" data-act="ciOut" data-id="${esc(p.id)}">Check out</button>` : `<button class="btn go" data-act="ciIn" data-id="${esc(p.id)}">Check in</button>`}</div>` : ''}
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

/* generator actions */
async function runRebalance() {
  const r = rebalance(S.P, S.staffList, S.org, S.config);
  UI.genLog = { title: 'Rebalanced. Existing groups were kept.', lines: r.log }; audit('groups', `Pressed Rebalance: ${Object.keys(r.changes).length} participant(s) moved`);
  await saveOrg(r.org, { at: Date.now(), mode: 'rebalance' });
  const ch = {}; for (const id in r.changes) ch[id] = { g: r.changes[id] };
  await setStates(ch).catch(fail); toast('Groups and companies updated');
}
async function runRenumber() {
  const gs = Object.values(S.org.groups); if (!gs.length) { toast('There are no groups to number yet.', true); return; }
  const inN = S.P.filter(p => p.s).length;
  const ok = await confirmBox('Renumber groups by company?', `Groups are numbered in company order: Company 1's groups first (young women, then young men), then Company 2, and so on. Companies are numbered 13–15 first, then 16–18. Nobody changes group or counselor, only the numbers.${inN ? ` <br><br><b>${inN} youth have already checked in.</b> Counselors and printed rosters may already use the old numbers.` : ''}<br><br>Numbers are then <b>locked</b>: Rebalance keeps them, and new groups fill free numbers first.`, 'Renumber and lock', !!inN);
  if (!ok) return;
  const o = JSON.parse(JSON.stringify(S.org)); const before = {}; Object.values(o.groups).forEach(g => before[g.id] = g.num);
  renumber(o.groups, o.companies);
  const changed = Object.values(o.groups).filter(g => before[g.id] !== g.num).length;
  S.orgLock = { at: Date.now(), by: S.meName || S.email || '' }; audit('groups', `Renumbered groups by company (${changed} of ${gs.length} got a new number) and locked the numbers`);
  await saveOrg(o, Object.assign({}, S.orgGen || {}, { renumbered: Date.now() }));
  UI.genLog = null;
  render(); toast(`Groups renumbered by company: ${changed} of ${gs.length} got a new number. Numbers are now locked.`);
}
async function runRegen() {
  if (!S.staffList.some(s => s.role === 'counselor')) { toast('Add counselors on the Staff tab first (or generate test staff).', true); return; }
  const ok = await confirmBox('Regenerate all groups and companies?', `Every participant is placed again from scratch. Check-ins are kept, but group and company assignments, including manual moves, are replaced.${S.orgLock ? ' <b>Group numbers are locked: regenerating gives every group a new number</b>, so rosters and what counselors were told will no longer match.' : ''} To keep current groups and numbers, use Rebalance instead.`, 'Regenerate', true);
  if (!ok) return;
  const r = fullGenerate(S.P, S.staffList, S.config);
  UI.genLog = { title: 'Generated new groups and companies', lines: r.log }; audit('groups', `Regenerated all groups and companies: ${Object.keys(r.org.groups).length} groups, ${Object.keys(r.org.companies).length} companies`);
  await saveOrg(r.org, { at: Date.now(), mode: 'full' });
  const ch = {}; S.P.forEach(p => { const g = r.assign[p.id] || null; if ((p.g || null) !== g) ch[p.id] = { g }; });
  await setStates(ch).catch(fail); toast('Companies generated');
}

/* events */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act, v = t.dataset.v, id = t.dataset.id;
  if (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type === 'checkbox')) return;
  if (t.tagName === 'A') e.preventDefault();
  const now = Date.now();
  switch (act) {
    case 'nav': closeModal(); location.hash = v; break;
    case 'home': location.hash = ''; render(); break;
    case 'moreNav': openMore(); break;
    case 'acct': openAccount(); break;
    case 'toggleArea': { const set = UI[t.dataset.set] || (UI[t.dataset.set] = new Set()); set.has(v) ? set.delete(v) : set.add(v); render(); break; }
    case 'close': closeModal(); break;
    case 'request': { const note = ($('#reqNote') || {}).value || ''; try { await S.db.doc('requests/' + S.uid).set({ at: now, note: note.slice(0, 200), email: S.email, name: S.meName }); audit('accounts', 'Asked for access'); notifyRequest(note); toast('Request sent'); UI.frameKey = ''; } catch (err) { toast('Could not send the request. Try again.', true); } break; }
    case 'signIn': await signIn(); break;
    case 'signOut': audit('signin', 'Signed out'); closeModal(); await FB.auth.signOut(); break;
    case 'ciF': UI.filter = v; UI.limit = 40; UI.frameKey = ''; render(); break;
    case 'ciToggle': { const o = UI.ciOpen || (UI.ciOpen = new Set()); const st = t.dataset.stake; o.has(st) ? o.delete(st) : o.add(st); render(); break; }
    case 'ciPick': UI.stake = t.dataset.stake; UI.unit = t.dataset.unit || ''; UI.limit = 40; render(); pinSearch(); break;
    case 'ciBack': UI.stake = ''; UI.unit = ''; render(); break;
    case 'ciPrint': printForm(t.dataset.stake, t.dataset.unit || '').catch(err => { console.error(err); toast('Could not make the PDF. Try again.', true); }); break;
    case 'ciClear': { const q = $('#ciQ'); q.value = ''; UI.q = ''; UI.limit = 40; PAGE_IMPL.checkin.update(); q.focus(); break; }
    case 'ciMore': UI.limit += 60; render(); break;
    case 'ciIn': case 'ciUndo': case 'ciOut': {
      if ($('#mbg')) closeModal();
      const p = S.P.find(x => x.id === id); if (!p) break; const prev = { s: p.s || '', ti: p.ti || null, to: p.to || null, by: p.by || null };
      const patch = act === 'ciIn' ? { s: 'in', ti: now, by: S.uid } : act === 'ciOut' ? { s: 'out', to: now, by: S.uid } : { s: '', ti: null, by: S.uid };
      setState(id, patch);
      const msg = act === 'ciIn' ? `${p.first} checked in${p.group ? ' · G' + p.group.num : ''}` : act === 'ciOut' ? `${p.first} checked out` : `${p.first}'s check-in undone`;
      toast(msg, false, { label: 'Undo', fn: () => { setState(id, prev); toast('Undone'); } });
      break; }
    case 'detail': openDetail(id); break;
    case 'toggleStake': UI.openStakes.has(v) ? UI.openStakes.delete(v) : UI.openStakes.add(v); render(); break;
    case 'toggleGrp': if (e.target.closest('select')) return; UI.open.has(id) ? UI.open.delete(id) : UI.open.add(id); render(); break;
    case 'coBand': UI.band = v; UI.frameKey = ''; render(); break;
    case 'allWarn': UI.allWarn = true; render(); break;
    case 'rebalance': await runRebalance(); break;
    case 'renumber': await runRenumber(); break;
    case 'logClose': UI.genLog = null; render(); break;
    case 'regen': await runRegen(); break;
    case 'addCo': { const band = await new Promise(res => { openModal(`<div class="modal-head"><h2>Add a company</h2><button class="x" data-act="close" aria-label="Close">×</button></div><p class="note">An empty company is created. Move groups into it with the Company picker inside each group, or press Rebalance to fill it automatically with a spare AC.</p><div class="btnrow"><button class="btn primary" id="aY">13–15 company</button><button class="btn primary" id="aO">16–18 company</button></div>`); $('#aY').onclick = () => { closeModal(); res('Y'); }; $('#aO').onclick = () => { closeModal(); res('O'); }; }); if (!band) break; const cid = rid('c'); const num = Math.max(0, ...Object.values(S.org.companies).map(c => c.num)) + 1; await patchOrg({ companies: { [cid]: { id: cid, band, acId: null, coordId: null, num } } }); toast('Company ' + num + ' added'); break; }
    case 'delCo': { const c = S.org.companies[id]; if (!await confirmBox(`Remove Company ${c.num}?`, 'Its groups stay together and move to "Groups without a company". Press Rebalance to place them in other companies.', 'Remove company', true)) break; audit('groups', `Removed Company ${c.num}`); const o = { groups: {}, companies: Object.assign({}, S.org.companies) }; for (const g of Object.values(S.org.groups)) o.groups[g.id] = g.companyId === id ? Object.assign({}, g, { companyId: null }) : g; delete o.companies[id]; await saveOrg(o, S.orgGen); toast('Company removed'); break; }
    case 'delGrp': { const g = S.org.groups[id]; if (!await confirmBox(`Remove group G${g.num}?`, 'Its participants become unassigned. Press Rebalance to place them in other groups.', 'Remove group', true)) break; audit('groups', `Removed group G${g.num}`); const o = { groups: Object.assign({}, S.org.groups), companies: S.org.companies }; delete o.groups[id]; await saveOrg(o, S.orgGen); const ch = {}; S.P.filter(p => p.g === id).forEach(p => ch[p.id] = { g: null }); await setStates(ch).catch(fail); toast('Group removed'); break; }
    case 'rosterCsv': { const rows = [['Company', 'Age group', 'AC', 'Group', 'Counselor', 'Participant', 'Gender', 'Age', 'Ward/branch', 'Stake', 'T-shirt', 'Status']]; S.P.filter(p => p.group).sort((a, b) => (a.company ? a.company.num : 999) - (b.company ? b.company.num : 999) || a.group.num - b.group.num || a.name.localeCompare(b.name)).forEach(p => rows.push([p.company ? p.company.num : '', BANDS[p.group.band], p.company ? sName(p.company.acId) : '', 'G' + p.group.num, p.counselor ? p.counselor.name : '', p.name, p.gender, p.age, p.unit, p.stake, p.tshirt, p.s || 'not arrived'])); exportCSV('fsy-rosters.csv', rows); break; }
    case 'tallyCsv': { const rows = [['Stake', 'Ward/branch', 'Expected', 'Checked in', 'Checked out']]; const m = {}; S.P.forEach(p => { const k = p.stake + '|' + p.unit; const x = m[k] = m[k] || [p.stake, p.unit, 0, 0, 0]; if (p.elig && p.src !== 'walkin') x[2]++; if (p.s === 'in') x[3]++; if (p.s === 'out') x[4]++; }); Object.values(m).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])).forEach(r => rows.push(r)); exportCSV('fsy-tally.csv', rows); break; }
    case 'logScope': UI.logScope = v; UI.frameKey = ''; render(); break;
    case 'lgCsv': { const L = PAGE_IMPL.logistics.scope(); let rows; if (v === 'staffsize') { const { ST, est, perPerson } = staffTee(); const R = teeRedistribute(L); const giv = {}; ST.forEach(x => { if (x.tshirt) giv[x.tshirt] = (giv[x.tshirt] || 0) + 1; });
      rows = [['Size', 'Youth to order', 'Staff given', 'Staff blanks estimated', 'Staff to order', 'Total to order']]; sizesIn(giv, est, R.totals).forEach(s => { const y = R.totals[s] ? R.totals[s].given + R.totals[s].est : 0, a = giv[s] || 0, b = est[s] || 0; if (y || a || b) rows.push([SIZE_LABEL[s] || s, y, a, b, a + b, y + a + b]); });
      rows.push([]); rows.push(['Staff member', 'Role', 'Gender', 'Size given', 'Estimated size', 'Ward/branch', 'Stake']); ST.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(x => rows.push([x.name, ROLES[x.role] || x.role, x.gender || '', x.tshirt || '', x.tshirt ? '' : perPerson[x.id] || '', x.unit || '', x.stake || '']));
      exportCSV('fsy-tshirts-staff-and-full-order.csv', rows); break; } if (v === 'size') { const R = teeRedistribute(L); rows = [['Size', 'Given', 'Blanks estimated', 'To order']]; sizesIn(R.totals).forEach(s => rows.push([SIZE_LABEL[s] || s, R.totals[s].given, R.totals[s].est, R.totals[s].given + R.totals[s].est])); } else if (v === 'blank') { const R = teeRedistribute(L); rows = [['Name', 'Age', 'Gender', 'Age group', 'Estimated size', 'Ward/branch', 'Stake', 'Contact', 'Contact phone']]; L.filter(p => !p.tshirt).forEach(p => rows.push([p.name, p.age, p.gender, p.band ? BANDS[p.band] : '', R.perPerson[p.id], p.unit, p.stake, p.c1n, p.c1p])); } else { const f = v === 'med' ? 'medIssue' : 'dietIssue', C = v === 'med' ? MED_CATS : DIET_CATS; rows = [['Name', 'Age', 'Gender', 'Note', 'Categories', 'Group', 'Counselor', 'Company', 'Ward/branch', 'Stake', 'Status', 'Contact', 'Contact phone']]; L.filter(p => p[f]).forEach(p => rows.push([p.name, p.age, p.gender, p[f], cats(p[f], C).join('; '), p.group ? 'G' + p.group.num : '', p.counselor ? p.counselor.name : '', p.company ? p.company.num : '', p.unit, p.stake, p.s || 'not arrived', p.c1n, p.c1p])); } exportCSV(`fsy-${({ med: 'medical', diet: 'dietary', size: 'tshirt-order', blank: 'tshirt-blanks' })[v]}.csv`, rows); break; }
    case 'setTee': { const b = bucketOf(id); audit('settings', `Set ${pName(id)}'s T-shirt size to ${SIZE_LABEL[v] || v}`, id); S.roster = Object.assign({}, S.roster, { [b]: Object.assign({}, S.roster[b], { [id]: Object.assign({}, S.roster[b][id], { tshirt: v }) }) }); recompute(true); await upd('roster/' + b, { p: { [id]: { tshirt: v } } }, true).catch(fail); toast('Size set to ' + (SIZE_LABEL[v] || v)); break; }
    case 'notIssue': setState(id, { [v]: 'n' }); toast('Removed from the count'); break;
    case 'flagIssue': { const p = S.P.find(x => x.id === id); const on = v === 'mo' ? !!p.medIssue : !!p.dietIssue; await setState(id, { [v]: on ? 'n' : 'y' }); openDetail(id); break; }
    case 'ovr': await setState(id, { ov: v || null }); if ($('#mbg')) openDetail(id); toast(v === 'inc' ? 'Included in the session' : v === 'exc' ? 'Excluded from the session' : 'Area rules apply again'); break;
    case 'delP': { const p = S.P.find(x => x.id === id); if (!await confirmBox(`Delete ${p.name}?`, 'The record and check-in are removed from the app. A later upload of the same file would bring them back unless you also remove them from the file.', 'Delete participant', true)) break; const b = bucketOf(id); const m = Object.assign({}, S.roster[b]); delete m[id]; S.roster = Object.assign({}, S.roster, { [b]: m }); await setState(id, { del: true, g: null }); await setDoc('roster/' + b, { p: m }).catch(fail); toast('Participant deleted'); break; }
    case 'testGen': { const n = Math.max(1, Math.min(40, +($('#tsAcs') || {}).value || 2)); const list = makeTestStaff(S.P, S.config, n); list.forEach(x => { x.addedAt = Date.now(); x.addedBy = S.meName || ''; }); audit('staff', `Generated ${list.length} test staff`); const s = {}; list.forEach(x => s[x.id] = x); S.staff = Object.assign({}, S.staff, s); recompute(true); const ex = S.staffEx; S.staffEx = true; await upd('staff/all', { s }, ex).catch(fail); toast(`${list.length} test staff added`); break; }
    case 'testDel': { const tests = S.staffList.filter(s => s.test); if (!tests.length) { toast('There are no test staff.'); break; } if (!await confirmBox(`Delete ${tests.length} test staff?`, 'Groups and companies they lead lose their leader. Press Rebalance afterwards to hand them to real staff.', 'Delete test staff', true)) break; audit('staff', `Deleted ${tests.length} test staff`); const s = {}; S.staffList.filter(x => !x.test).forEach(x => s[x.id] = x); S.staff = s; recompute(true); await setDoc('staff/all', { s }).catch(fail); toast('Test staff deleted'); break; }
    case 'stTab': UI.staffTab = v; render(); break;
    case 'invSess': { const inv0 = S.invites[id]; if (!inv0) break; const cur = invSessions(inv0);
      openModal(`<div class="modal-head"><div><h2>${esc(inv0.name)}</h2><small class="muted">${esc(id)} · ${esc(ROLES[inv0.role] || inv0.role)}</small></div><button class="x" data-act="close" aria-label="Close">×</button></div><p class="note" style="margin:0">Sessions this account can open</p><div class="sheetlist">${S.mySessions.map(sid => `<label class="sess-pick"><input type="checkbox" class="pickSess" value="${esc(sid)}" ${cur.includes(sid) ? 'checked' : ''}> ${esc(sessName(sid))}</label>`).join('')}</div><button class="btn primary" data-act="invSessSave" data-id="${esc(id)}">Save</button>`); break; }
    case 'invSessSave': { const inv0 = S.invites[id]; const mine = new Set(S.mySessions); const keepOther = invSessions(inv0).filter(x => !mine.has(x)); const picked = [...document.querySelectorAll('.pickSess:checked')].map(x => x.value); const sessions = uniq(keepOther.concat(picked)); if (!sessions.length) { toast('Choose at least one session', true); break; } audit('accounts', `Changed which sessions ${inv0.name} can open: ${sessions.map(x => sessName(x)).join(', ')}`, id); await upd('invites/' + id, { sessions }, true).catch(fail); closeModal(); toast('Sessions updated'); break; }
    case 'switchSession': { try { localStorage.setItem('fsy.session.' + S.uid, v); } catch (e) { } closeModal(); location.hash = ''; location.reload(); break; }
    case 'spGo': { if (!can.split()) break; const sp = UI.split; const list = S.P.filter(p => sp.sel.has(areaOf(p).st + '|' + areaOf(p).un)); if (!list.length) break;
      const isNew = sp.dest === 'new', name = isNew ? clean(sp.name) : sessName(sp.dest); if (isNew && !name) { toast('Give the new session a name', true); break; }
      const units = uniq(list.map(p => areaOf(p).un)).length;
      if (!await confirmTyped(`Move ${list.length} participants to ${name}?`, `${list.length} youth from ${units} ward${units === 1 ? '' : 's'} and branch${units === 1 ? '' : 'es'} leave ${esc(sessName(S.sid))}, with their check-ins and medical notes. They leave their groups here. ${sp.team === 'same' ? 'The Session Directing Couple will be able to open both sessions.' : 'Set up the staff team and accounts in the new session.' + (realRole() === 'sdc' && isNew ? ' <b>You will not keep access to the new session</b>: a registration admin, the Area Seventy or the Head of Logistics sets up its team.' : '')}`, 'MOVE', 'Move participants')) break;
      const target = isNew ? 's' + rid('') : sp.dest; toast('Moving participants…');
      try { await moveParticipants(list, target, { isNew, name, team: sp.team }); UI.split = { dest: 'new', name: '', team: 'same', sel: new Set() }; UI.sessCounts = null; render(); toast(`${list.length} participants moved to ${name}`, false, { label: 'Open', fn: () => { try { localStorage.setItem('fsy.session.' + S.uid, target); } catch (e) { } location.hash = ''; location.reload(); } }); }
      catch (e) { fail(e); }
      break; }
    case 'resetOrg': { if (!can.reset()) break; if (!await confirmTyped('Undo all groups and companies?', `All ${Object.keys(S.org.groups).length} groups and ${Object.keys(S.org.companies).length} companies are removed, and every participant goes back to having no group. Check-ins stay. You can generate new companies afterwards.`, 'UNDO', 'Undo all groups and companies')) break; audit('groups', 'Undid all groups and companies'); await resetOrg(); toast('Groups and companies removed'); break; }
    case 'resetTest': { if (!can.reset()) break; const tests = S.staffList.filter(x => x.test); if (!await confirmTyped(`Delete ${tests.length} test staff?`, 'Groups and companies they lead lose their counselor or AC. Press Rebalance afterwards to give them to real staff, or undo all groups and generate again.', 'DELETE', 'Delete test staff')) break; audit('staff', `Deleted ${tests.length} test staff (Start over)`); const keep = {}; S.staffList.filter(x => !x.test).forEach(x => keep[x.id] = x); S.staff = keep; recompute(true); await setDoc('staff/all', { s: keep }).catch(fail); toast(`${tests.length} test staff deleted`); break; }
    case 'resetType': { if (!can.reset()) break; const r = ($('#rsType') || {}).value || 'counselor'; UI.rsType = r; const gone = S.staffList.filter(x => x.role === r && !x.fromAccount); if (!gone.length) { toast(`There are no ${ROLES[r].toLowerCase()}s to delete.`); break; }
      if (!await confirmTyped(`Delete all ${gone.length} ${ROLES[r].toLowerCase()}s?`, `Every ${esc(ROLES[r].toLowerCase())} record is deleted, real and test. Other staff types are kept.${r === 'counselor' ? ' Groups lose their counselors; press Rebalance after uploading the new list.' : r === 'ac' ? ' Companies lose their ACs; press Rebalance after uploading the new list.' : ''} Sign-in accounts are kept.`, 'DELETE', 'Delete ' + ROLES[r].toLowerCase() + 's')) break;
      audit('staff', `Deleted all ${gone.length} ${ROLES[r].toLowerCase()}s`); const ids = new Set(gone.map(x => x.id)); unlinkDeleted(ids); const s2 = {}; for (const k in S.staff) if (!ids.has(k)) s2[k] = S.staff[k]; S.staff = s2; recompute(true); await setDoc('staff/all', { s: s2 }).catch(fail);
      const o = { groups: {}, companies: {} }; let ch = false;
      for (const g of Object.values(S.org.groups)) { const x = Object.assign({}, g); if (ids.has(g.counselorId)) { x.counselorId = null; ch = true; } o.groups[g.id] = x; }
      for (const c of Object.values(S.org.companies)) { const x = Object.assign({}, c); if (ids.has(c.acId)) { x.acId = null; ch = true; } if (ids.has(c.coordId)) { x.coordId = null; ch = true; } o.companies[c.id] = x; }
      if (ch) await saveOrg(o, S.orgGen);
      toast(`${gone.length} ${ROLES[r].toLowerCase()}s deleted`); break; }
    case 'resetStaff': { if (!can.reset()) break; const n = S.staffList.length; if (!await confirmTyped(`Delete all ${n} staff?`, 'Every counselor, assistant coordinator, coordinator, logistics and Session Directing Couple record is deleted, real and test. Groups and companies lose their leaders. Sign-in accounts are kept and link again automatically when the new list is uploaded, wherever the email or name matches.', 'DELETE', 'Delete all staff')) break; audit('staff', `Deleted all ${n} staff records`);
      unlinkDeleted(new Set(Object.keys(S.staff))); S.staff = {}; recompute(true); await setDoc('staff/all', { s: {} }).catch(fail);
      const o = { groups: {}, companies: {} }; for (const g of Object.values(S.org.groups)) o.groups[g.id] = Object.assign({}, g, { counselorId: null }); for (const c of Object.values(S.org.companies)) o.companies[c.id] = Object.assign({}, c, { acId: null, coordId: null });
      if (Object.keys(o.groups).length || Object.keys(o.companies).length) await saveOrg(o, S.orgGen);
      toast(`All ${n} staff deleted`); break; }
    case 'hcDay': UI.hcDay = v; render(); break;
    case 'hcOpen': UI.hcGroup = t.dataset.g; render(); window.scrollTo(0, 0); break;
    case 'hcBack': UI.hcGroup = null; render(); break;
    case 'hcMark': { if (hcViewOnly()) break; const g = t.dataset.g; const cur = ((hcDoc(hcDay(), g) || {}).marks || {})[id]; await hcWrite(g, { marks: { [id]: cur === v ? null : v } }); break; }
    case 'hcAll': { if (hcViewOnly()) break; const x = hcGroup(S.org.groups[t.dataset.g], hcDay()); const m = {}; x.unmarked.forEach(p => m[p.id] = 'p'); await hcWrite(t.dataset.g, { marks: m }); break; }
    case 'hcSubmit': { if (hcViewOnly()) break; const g = t.dataset.g; const x = hcGroup(S.org.groups[g], hcDay()); if (x.unmarked.length) { toast('Mark everyone present or missing first', true); break; } const note = ($(`[data-hcnote="${g}"]`) || {}).value || ''; await hcWrite(g, { note: note.slice(0, 500) }, true); audit('headcount', `Submitted the ${hcDay()} headcount for G${S.org.groups[g].num}: ${x.present.length} present, ${x.missing.length} missing`); toast(`G${S.org.groups[g].num}: ${x.present.length} of ${x.expected} present${x.missing.length ? ', ' + x.missing.length + ' missing' : ''}.${hcChain() ? ' Sent to ' + hcChain() + '.' : ' Saved.'}`); break; }
    case 'hcCsv': { const day = hcDay(); const rows = [['Night', 'Company', 'Group', 'Counselor', 'Reported by', 'Reported at', 'Status', 'Expected', 'Present', 'Missing', 'Missing names', 'Note']]; Object.values(S.org.groups).sort((a, b) => a.num - b.num).forEach(g => { const x = hcGroup(g, day); if (!x.expected && !x.doc) return; const c = g.companyId && S.org.companies[g.companyId]; rows.push([day, c ? c.num : '', 'G' + g.num, sName(g.counselorId), x.doc ? x.doc.byName : '', x.doc && x.doc.at ? new Date(x.doc.at).toLocaleString() : '', x.submitted ? 'Submitted' : x.doc ? 'Started' : 'Not reported', x.expected, x.present.length, x.missing.length, x.missing.map(p => p.name + (x.doc.reasons && x.doc.reasons[p.id] ? ' (' + x.doc.reasons[p.id] + ')' : '')).join('; '), x.doc ? x.doc.note || '' : '']); }); exportCSV('fsy-headcount-' + day + '.csv', rows); break; }
    case 'stAdd': openStaffForm(null); break;
    case 'stView': UI.staffView = v; render(); break;
    case 'repNew': closeModal(); openReportForm(id); break;
    case 'repResolve': { const note = await askText('Mark as resolved', 'What was done? (optional)'); if (note === null) break; await updateReport(id, v, { status: 'resolved', resNote: note, resAt: Date.now(), resBy: S.uid, resByName: S.meName || S.email }); toast('Marked resolved'); break; }
    case 'repNote': { const note = await askText('Add a follow-up', 'Follow-up note'); if (!note) break; await updateReport(id, v, { resNote: note, resAt: Date.now(), resBy: S.uid, resByName: S.meName || S.email }); toast('Saved'); break; }
    case 'repReopen': await updateReport(id, v, { status: 'open' }); toast('Reopened'); break;
    case 'coQClear': UI.coQ = ''; { const i = $('#coQ'); if (i) i.value = ''; } render(); break;
    case 'wlRep': UI.wlRep = v; render(); break;
    case 'audK': UI.audK = v; render(); break;
    case 'audMore': UI.audLimit = (UI.audLimit || 500) + 1000; render(); break;
    case 'audCsv': { const rows = [['When', 'Who', 'Email', 'Role', 'Kind', 'What']]; audFiltered().forEach(r => rows.push([new Date(r.at).toLocaleString(), r.name || '', r.email || '', ROLES[r.role] || r.role || '', AUDIT_KINDS[r.kind] || r.kind, r.text])); exportCSV('fsy-audit-log.csv', rows); break; }
    case 'spareToggle': UI.spareOpen = !UI.spareOpen; render(); break;
    case 'fitSizes': { const f = fitSizes(); const F = f.F.fit || f.F.now, M = f.M.fit || f.M.now; if (!await confirmBox('Change group sizes?', `Young women: <b>${F}</b> per group (now ${f.F.now}). Young men: <b>${M}</b> per group (now ${f.M.now}). Press <b>Rebalance</b> afterwards: every counselor who is free gets a group, made from one or two youth from each of the biggest groups of the same gender and age band. Groups never drop below 6.`, 'Change sizes')) break; await saveSizes({ groupSizeF: F, groupSizeM: M, groupSize: F, useAll: true }); UI.frameKey = ''; render(); toast('Group sizes changed. Press Rebalance to apply them.'); break; }
    case 'lgGo': { if (v === 'blank') { UI.foldSet = Object.assign(UI.foldSet || {}, { 'sec-tee': true }); if (location.hash === '#tee-blank') openFold('sec-tee'); else location.hash = 'tee-blank'; break; } openFold({ med: 'sec-med', diet: 'sec-diet', tee: 'sec-tee', steee: 'sec-steee' }[v]); break; }
    case 'accToggle': { const o = UI.accOpen || (UI.accOpen = new Set()); o.has(v) ? o.delete(v) : o.add(v); render(); break; }
    case 'accAllOpen': { UI.accOpen = new Set(v ? Object.keys(ROLES) : []); render(); break; }
    case 'accF': UI.accF = v; render(); break;
    case 'wlGo': { const map = { open: ['wl-rep', () => UI.wlRep = 'open'], urgent: ['wl-rep', () => UI.wlRep = 'urgent'], med: ['wl-youth', () => { UI.wlY = 'med'; UI.wlMore = false; }], diet: ['wl-youth', () => { UI.wlY = 'diet'; UI.wlMore = false; }], staff: ['wl-staff', () => { }] }[v]; if (!map) break; map[1](); UI.foldSet = Object.assign(UI.foldSet || {}, { [map[0]]: true }); render(); const d = document.getElementById(map[0]); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } break; }
    case 'wlY': UI.wlY = v; UI.wlMore = false; render(); break;
    case 'wlMore': UI.wlMore = true; render(); break;
    case 'wlCsv': { const rows = [['Who', 'Name', 'Role or group', 'Unit', 'Stake', 'Medical', 'Dietary', 'Checked in']]; registered().filter(p => p.medIssue || p.dietIssue).forEach(p => rows.push(['Youth', p.name, p.group ? 'G' + p.group.num : '', p.unit, p.stake, p.medIssue || '', p.dietIssue || '', p.s === 'in' ? 'yes' : ''])); S.staffList.filter(x => !x.test && (x.med || x.diet)).forEach(x => rows.push(['Staff', x.name, ROLES[x.role] || x.role, x.unit || '', x.stake || '', x.med || '', x.diet || '', ''])); rows.push([]); rows.push(['Concern', 'Participant', 'Kind', 'Urgent', 'Status', 'Reported', 'By', 'Details', 'Follow-up']); allReports().forEach(r => rows.push(['', r.pname || '', repKind(r.kind), r.urgent ? 'yes' : '', r.status, fmtWhen(r.at), r.byName || '', r.text, r.resNote || ''])); exportCSV('fsy-wellness.csv', rows); break; }
    case 'stPdf': printStaffList(UI.staffTab, v || ''); break;
    case 'sfGo': await sfImport(); break;
    case 'sfCancel': { UI.sf = null; const f = $('#sfFile'); if (f) f.value = ''; renderSf(); break; }
    case 'sfPick': { const f = $('#sfFile'); if (f) { f.value = ''; $('#sfPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); f.click(); } break; }
    case 'sfNewCancel': UI.sf.adding = null; renderSf(); break;
    case 'sfNewSave': { const st = clean(($('#sfNewStake') || {}).value), un = sfName(($('#sfNewUnit') || {}).value || ''); if (!st || !un) { toast('Type both the stake or district and the ward or branch', true); break; } UI.sf.choices[v] = st + '|' + un; UI.sf.adding = null; sfRun(); renderSf(); break; }
    case 'stEdit': if (can.staff()) openStaffForm(id); break;
    case 'stCsv': { const rows = [['Name', 'Role', 'Gender', 'Age', 'Ward/branch', 'Stake', 'Phone', 'Email', 'T-shirt', 'Food needs']]; S.staffList.slice().sort((a, b) => (a.stake || '').localeCompare(b.stake || '') || (a.unit || '').localeCompare(b.unit || '') || a.name.localeCompare(b.name)).forEach(s => rows.push([s.name, ROLES[s.role], s.gender, staffAge(s, S.config) ?? '', s.unit || '', s.stake || '', s.phone || '', s.email || '', s.tshirt || '', s.diet || ''])); exportCSV('fsy-staff.csv', rows); break; }
    case 'exCsv': { const L = PAGE_IMPL.exceptions.lists(); const rows = [['Type', 'Name', 'Age', 'Gender', 'Ward/branch', 'Stake', 'Status', 'Group']]; [['Walk-in', L.walk], ['Not on approved list', L.off], ['Checked in, no group', L.nog]].forEach(([t, list]) => list.forEach(p => rows.push([t, p.name, p.age ?? '', p.gender, p.unit, p.stake, p.s || 'not arrived', p.group ? 'G' + p.group.num : '']))); exportCSV('fsy-walkins-exceptions.csv', rows); break; }
    case 'stDel': { const st = S.staffMap[id]; if (st && st.fromAccount) { toast('This person comes from Accounts. Delete or change their account there.', true); break; } if (!await confirmBox(`Delete ${st.name}?`, 'If they lead a group or company, it loses its leader. Press Rebalance afterwards to fill the gap.', 'Delete', true)) break; audit('staff', `Deleted staff member ${st.name}`, id); const s = Object.assign({}, S.staff); delete s[id]; S.staff = s; recompute(true); await setDoc('staff/all', { s }).catch(fail); toast('Deleted'); break; }
    case 'impGo': await doImport(); break;
    case 'impCancel': UI.imp = null; renderImport(); const f = $('#impFile'); if (f) f.value = ''; break;
    case 'reqDel': audit('accounts', `Dismissed the sign-in request from ${(S.requests[id] || {}).name || (S.requests[id] || {}).email || 'someone'}`); await serial('requests/' + id, () => S.db.doc('requests/' + id).delete()).catch(fail); break;
    case 'invDel': { const v = S.invites[id]; if (!await confirmBox(`Delete ${v.name}'s account?`, 'They lose access to the app straight away. Their check-ins stay.', 'Delete account', true)) break; audit('accounts', `Deleted the account of ${v.name} (${id})`, id); await serial('invites/' + id, () => S.db.doc('invites/' + id).delete()).catch(fail); toast('Account deleted'); break; }
    case 'acDel': { if (!await confirmBox('Remove this role?', 'The person keeps access to the page but can no longer use the app until given a role again.', 'Remove role', true)) break; const u = Object.assign({}, S.access); delete u[id]; S.access = u; recompute(true); await setDoc('access/roles', { u }).catch(fail); break; }
    case 'acAdd': { const r = ($('#hitRole-' + id) || {}).value; if (!r) { toast('Choose a role first', true); break; } await setAccess(id, { role: r }); toast('Role given'); $('#acHits').innerHTML = ''; $('#acSearch').value = ''; break; }
  }
});
document.addEventListener('change', async e => {
  const t = e.target; const act = t.dataset && t.dataset.act; const id = t.dataset && t.dataset.id, v = t.dataset && t.dataset.v;
  if (t.id === 'accAll') { UI.accAll = t.checked; render(); return; }
  if (t.id === 'spDest') { UI.split.dest = t.value; t.blur(); render(); return; }
  if (t.name === 'spTeam') { UI.split.team = t.value; return; }
  if (t.dataset && t.dataset.act === 'spUnit') { t.checked ? UI.split.sel.add(t.dataset.v) : UI.split.sel.delete(t.dataset.v); render(); return; }
  if (t.dataset && t.dataset.act === 'spStake') { const st = t.dataset.v; S.P.filter(p => areaOf(p).st === st).forEach(p => { const k = st + '|' + areaOf(p).un; t.checked ? UI.split.sel.add(k) : UI.split.sel.delete(k); }); render(); return; }
  if (t.id === 'viewAs') { S.viewAs = t.value || null; S.viewAsStaff = null; UI.coMineSet = false; UI.band = ''; UI.filterSet = false; UI.filter = 'all'; if (S.viewAs && ['counselor', 'ac', 'coordinator'].includes(S.viewAs)) { const s = S.staffList.find(x => x.role === S.viewAs && (S.viewAs !== 'counselor' || Object.values(S.org.groups).some(g => g.counselorId === x.id)) && (S.viewAs !== 'ac' || Object.values(S.org.companies).some(c => c.acId === x.id))); S.viewAsStaff = s ? s.id : null; if (s) toast('Previewing as ' + s.name); } UI.frameKey = ''; closeModal(); render(); return; }
  if (t.id === 'ciStake') { UI.stake = t.value; UI.unit = ''; UI.limit = 40; t.blur(); render(); return; }
  if (t.id === 'ciUnit') { UI.unit = t.value; UI.limit = 40; t.blur(); render(); return; }
  if (t.id === 'impFile') { if (t.files[0]) readFile(t.files[0]).catch(err => { console.error(err); toast('Could not read that file. Save it as .xlsx or .csv and try again.', true); }); return; }
  if (t.id === 'impMode') { UI.imp.mode = t.value; renderImport(); return; }
  if (t.id === 'sfFile') { const f = t.files[0]; if (f) sfRead(f).catch(err => { console.error(err); toast('Could not read that file. Save it as .xlsx or .csv and try again.', true); }).finally(() => { t.value = ''; }); return; }
  if (t.id === 'audWho') { UI.audWho = t.value; PAGE_IMPL.audit.update(); return; }
  if (t.id === 'audDay') { UI.audDay = t.value; PAGE_IMPL.audit.update(); return; }
  if (t.id === 'rsType') { UI.rsType = t.value; return; }
  if (t.id === 'sfRole') { UI.sf.role = t.value; renderSf(); return; }
  if (act === 'sfUnit') { const F = UI.sf; if (t.value === '__new') F.adding = v; else if (t.value) { F.choices[v] = t.value; F.adding = null; } else delete F.choices[v]; t.blur(); renderSf(); if (F.adding) setTimeout(() => { const i = $('#sfNewStake'); if (i) i.focus(); }, 30); return; }
  if (!act) return;
  switch (act) {
    case 'moveP': { const g = t.value || null; t.blur(); await setState(id, { g }); toast(g ? 'Moved to G' + S.org.groups[g].num : 'Taken out of group'); break; }
    case 'grpCoun': { const g = S.org.groups[id], c = t.value || null; t.blur(); audit('groups', `Set the counselor of G${g.num} to ${stName(c)}`); const patch = { groups: { [id]: { counselorId: c } } }; const other = c && Object.values(S.org.groups).find(x => x.counselorId === c && x.id !== id); if (other) patch.groups[other.id] = { counselorId: g.counselorId || null }; await patchOrg(patch); toast(other ? `Swapped counselors with G${other.num}` : 'Counselor updated'); break; }
    case 'grpCo': { t.blur(); audit('groups', `Moved ${gName(id)} to ${t.value && S.org.companies[t.value] ? 'Company ' + S.org.companies[t.value].num : 'no company'}`); await patchOrg({ groups: { [id]: { companyId: t.value || null } } }); toast('Group moved'); break; }
    case 'coAc': { const c = S.org.companies[id], a = t.value || null; t.blur(); audit('groups', `Set the assistant coordinator of Company ${c.num} to ${stName(a)}`); const patch = { companies: { [id]: { acId: a } } }; const other = a && Object.values(S.org.companies).find(x => x.acId === a && x.id !== id); if (other) patch.companies[other.id] = { acId: c.acId || null }; await patchOrg(patch); toast(other ? `Swapped ACs with Company ${other.num}` : 'Assistant coordinator updated'); break; }
    case 'coCoord': { t.blur(); await patchOrg({ companies: { [id]: { coordId: t.value || null } } }); toast('Coordinator updated'); break; }
    case 'stat': { audit('settings', `${t.checked ? 'Counted' : 'Stopped counting'} the status ${v.replace(/_/g, ' ').toLowerCase()} as registered`); const ex = new Set(S.config.excludedStatuses || []); t.checked ? ex.delete(v) : ex.add(v); await saveConfig({ excludedStatuses: [...ex] }); break; }
    case 'areaS': { audit('settings', `${t.checked ? 'Included' : 'Excluded'} the area ${v}`); const ex = new Set(S.config.excludedStakes || []); t.checked ? ex.delete(v) : ex.add(v); await saveConfig({ excludedStakes: [...ex] }); break; }
    case 'areaU': { audit('settings', `${t.checked ? 'Included' : 'Excluded'} the unit ${v.replace('|', ' · ')}`); const ex = new Set(S.config.excludedUnits || []); t.checked ? ex.delete(v) : ex.add(v); await saveConfig({ excludedUnits: [...ex] }); break; }
    case 'impMap': { const i = +v; if (t.value) { for (const k in UI.imp.map) if (UI.imp.map[k] === t.value) delete UI.imp.map[k]; UI.imp.map[i] = t.value; } else delete UI.imp.map[i]; renderImport(); break; }
    case 'stRole': { t.blur(); await saveStaffRec(Object.assign({}, S.staffMap[id], { role: t.value })); toast('Role changed'); break; }
    case 'reqRole': { if (!t.value) break; const rq = S.requests[id] || {}; if (!rq.email) { toast('This request has no email.', true); break; } audit('accounts', `Gave ${rq.name || rq.email} (${rq.email}) access as ${ROLES[t.value] || t.value}`); await setDoc('invites/' + emailKey(rq.email), { name: rq.name || rq.email, role: t.value, staffId: null, sessions: [S.sid], at: Date.now() }).catch(fail); await serial('requests/' + id, () => S.db.doc('requests/' + id).delete()).catch(() => { }); toast('Access given'); break; }
    case 'acRole': { if (!t.value) break; await setAccess(id, { role: t.value }); toast('Role changed'); break; }
    case 'invGender': { audit('accounts', `Set the gender on ${(S.invites[id] || {}).name || id}'s account to ${t.value === 'F' ? 'female' : t.value === 'M' ? 'male' : 'not given'}`, id); await upd('invites/' + id, { gender: t.value || '' }, true).catch(fail); toast('Gender saved'); break; }
    case 'invRole': { audit('accounts', `Changed ${(S.invites[id] || {}).name || id}'s role from ${ROLES[(S.invites[id] || {}).role] || '?'} to ${ROLES[t.value] || t.value}`, id); await upd('invites/' + id, { role: t.value }, true).catch(fail); toast('Role changed'); break; }
    case 'invStaff': { audit('accounts', t.value ? `Linked ${(S.invites[id] || {}).name || id}'s account to staff record ${stName(t.value)}` : `Removed the staff link from ${(S.invites[id] || {}).name || id}'s account`, id); await upd('invites/' + id, { staffId: t.value || null, staffAuto: null, staffManual: true }, true).catch(fail); toast(t.value ? 'Staff record linked' : 'Link removed'); break; }
    case 'acStaff': { await setAccess(id, { staffId: t.value || null }); toast('Linked'); break; }
  }
});
document.addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target; const val = id => ($('#' + id) || {}).value || '';
  if (f.id === 'wkForm') { audit('checkin', `Added a walk-in: ${titleCase(val('wkFirst'))} ${titleCase(val('wkLast'))}`);
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
  if (f.id === 'repForm') { await saveReport(f); return; }
  if (f.id === 'sizeForm') { const F = Math.max(4, Math.min(25, parseInt(val('szF'), 10) || 10)), M = Math.max(4, Math.min(25, parseInt(val('szM'), 10) || 10)); await saveSizes({ groupSizeF: F, groupSizeM: M, groupSize: F, useAll: false }); UI.frameKey = ''; render(); toast(`Sizes saved: ${F} young women, ${M} young men. Press Rebalance to apply them.`); return; }
  if (f.id === 'stForm') {
    const name = titleCase(val('stName')), gender = val('stGender'); if (!name || !gender) { toast('Name and gender are needed', true); return; }
    const age = parseInt(val('stAge'), 10), sid = f.dataset.id; const old = sid ? S.staffMap[sid] || {} : {};
    const email = sfEmail(val('stEmail')); if (email && !okEmail(email)) { toast('That email does not look right', true); return; }
    const dupE = email && S.staffList.find(x => x.id !== sid && (x.email || '').toLowerCase() === email); if (dupE) { toast(`${dupE.name} already has that email`, true); return; }
    const rec = Object.assign({ addedAt: Date.now(), addedBy: S.meName || S.email || '' }, old, { id: sid || rid('S'), name, gender, ageCsv: isNaN(age) ? null : age, bday: sid && staffAge(old, S.config) === age ? old.bday || '' : '', role: val('stRole'), phone: sfPhone(val('stPhone')) || clean(val('stPhone')), email, tshirt: val('stSize'), stake: clean(val('stStake')), unit: clean(val('stUnit')) });
    await saveStaffRec(rec); linkTried = {}; UI.staffTab = rec.role; closeModal(); toast(sid ? 'Saved' : name + ' added');
  }
  if (f.id === 'invForm') {
    const name = titleCase(val('invName')), email = clean(val('invEmail')).toLowerCase(), r = val('invRole'), sid = val('invStaff') || null;
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !r) { toast('Enter a name, a valid email and a role', true); return; }
    const h = emailKey(email); if (S.invites[h]) { toast('There is already an account for ' + email, true); return; }
    const chosen = [...document.querySelectorAll('.invSessChk:checked')].map(x => x.value); const sessions = chosen.length ? chosen : [S.sid];
    try { await setDoc('invites/' + h, { name, role: r, gender: val('invGender') || '', staffId: sid, sessions, at: Date.now() }); audit('accounts', `Created an account for ${name} (${email}) as ${ROLES[r] || r}`, h); f.reset(); toast('Account created for ' + name); } catch (err) { fail(err); }
  }
  if (f.id === 'cfgForm') { audit('settings', 'Saved the session settings'); if (can.split() && clean(val('cfName'))) FB.fs.doc('meta/sessions').set({ s: { [S.sid]: { name: clean(val('cfName')), at: (S.sessions[S.sid] || {}).at || 0 } } }, { merge: true }).then(() => { S.sessions[S.sid] = Object.assign({}, S.sessions[S.sid], { name: clean(val('cfName')) }); }).catch(console.error); await saveConfig({ sessionName: clean(val('cfName')) || 'FSY Kenya 2nd 2026', sessionStart: val('cfStart'), hcStart: val('cfHcStart') || DEFAULT_CONFIG.hcStart, hcEnd: val('cfHcEnd') || DEFAULT_CONFIG.hcEnd, useAll: false, groupSizeF: Math.max(4, Math.min(25, parseInt(val('cfSizeF'), 10) || 10)), groupSizeM: Math.max(4, Math.min(25, parseInt(val('cfSizeM'), 10) || 10)), groupSize: Math.max(4, Math.min(25, parseInt(val('cfSizeF'), 10) || 10)) }); toast('Settings saved. Press Rebalance on Companies & groups to apply group sizes.'); }
  if (f.id === 'edForm') { audit('settings', `Edited the record of ${pName(f.dataset.id)}`, f.dataset.id);
    const id = f.dataset.id, b = bucketOf(id); const age = parseInt(val('edAge'), 10);
    const patch = { first: titleCase(val('edFirst')), last: titleCase(val('edLast')), gender: val('edGender'), bday: val('edBday'), ageCsv: isNaN(age) ? null : age, tshirt: val('edSize'), stake: clean(val('edStake')), unit: clean(val('edUnit')) }; const md = { med: val('edMed'), diet: val('edDiet') };
    S.roster = Object.assign({}, S.roster, { [b]: Object.assign({}, S.roster[b], { [id]: Object.assign({}, S.roster[b][id], patch) }) }); recompute(true);
    S.medical = Object.assign({}, S.medical, { [b]: Object.assign({}, S.medical[b] || {}, { [id]: md }) });
    await upd('roster/' + b, { p: { [id]: patch } }, true).catch(fail); const mx = S.medicalEx.has(b); S.medicalEx.add(b); await upd('medical/' + b, { p: { [id]: md } }, mx).catch(fail); toast('Saved'); openDetail(id);
  }
});
let qT = null;
document.addEventListener('input', e => { if (e.target.id === 'spName') { UI.split.name = e.target.value; const b = $('[data-act=spGo]'); if (b) b.disabled = !(e.target.value.trim() && S.P.some(p => UI.split.sel.has(areaOf(p).st + '|' + areaOf(p).un))); } });
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'coQ') { UI.coQ = t.value; clearTimeout(UI.coT); UI.coT = setTimeout(() => PAGE_IMPL.companies.update(), 200); return; }
  if (t.id === 'stQ') { UI.stQ = t.value; clearTimeout(UI.stT); UI.stT = setTimeout(() => PAGE_IMPL.staff.update(), 200); return; }
  if (t.id === 'audQ') { UI.audQ = t.value; clearTimeout(UI.audT); UI.audT = setTimeout(() => PAGE_IMPL.audit.update(), 200); return; }
  if (t.id === 'accQ') { UI.accQ = t.value; clearTimeout(UI.accT); UI.accT = setTimeout(() => PAGE_IMPL.access.update(), 200); return; }
  if (t.id === 'wlQ') { UI.wlQ = t.value; clearTimeout(UI.wlT); UI.wlT = setTimeout(() => { PAGE_IMPL.wellness.update(); }, 200); return; }
  if (t.dataset && t.dataset.hcreason) { const g = t.dataset.g, id = t.dataset.hcreason; clearTimeout(hcNoteT[id]); hcNoteT[id] = setTimeout(() => { const cur = hcDoc(hcDay(), g) || {}; const next = Object.assign({}, cur, { reasons: Object.assign({}, cur.reasons || {}, { [id]: t.value.slice(0, 200) }) }); S.hc[hcDay() + '_' + g] = next; setDoc('headcount/' + hcDay() + '_' + g, Object.assign(next, { by: S.uid, byName: S.meName || '', updatedAt: Date.now() })).catch(fail); }, 700); }
});
function pinSearch() { const a = $('#ciAnchor'); if (!a) return; const stick = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stick')) || 0; const y = a.getBoundingClientRect().top + window.scrollY - stick; if (Math.abs(window.scrollY - y) > 4) window.scrollTo({ top: y, behavior: 'smooth' }); }
document.addEventListener('focusin', e => { if (e.target.id === 'ciQ' && window.matchMedia('(max-width: 899px)').matches) setTimeout(pinSearch, 250); });
document.addEventListener('keydown', e => { if (e.target.id === 'ciQ' && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
document.addEventListener('input', e => {
  if (e.target.id === 'ciQ') { clearTimeout(qT); qT = setTimeout(() => { UI.q = e.target.value; UI.limit = 40; PAGE_IMPL.checkin.update(); if (window.matchMedia('(max-width: 899px)').matches && document.activeElement === e.target) pinSearch(); }, 120); }
  if (e.target.id === 'acSearch' && S.user) {
    const q = e.target.value;
    S.user.search(q).then(hits => { const box = $('#acHits'); if (!box) return; box.innerHTML = hits.filter(h => !h.isMe).map(h => `<div class="inline" style="padding:4px 0"><b style="flex:1">${esc(h.name)}</b>${S.access[h.id] ? `<span class="chip">${esc(ROLES[S.access[h.id].role])}</span>` : `<select id="hitRole-${esc(h.id)}" aria-label="Role">${opt('', 'Role…')}${Object.keys(ROLES).filter(r => roleAssignable(r)).map(r => opt(r, ROLES[r])).join('')}</select><button class="btn small primary" data-act="acAdd" data-id="${esc(h.id)}">Add</button>`}</div>`).join('') || (q ? '<p class="note">No one found. People outside your workspace must open the page and send a request.</p>' : ''); });
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#mbg')) closeModal(); if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.act === 'toggleGrp') { e.preventDefault(); e.target.click(); } });


boot();
document.addEventListener('toggle', e => { if (e.target && e.target.id === 'coChecks') UI.checksOpen = e.target.open; }, true);
document.addEventListener('toggle', e => { const t = e.target; if (t && t.classList && t.classList.contains('fold') && t.id) UI.foldSet = Object.assign(UI.foldSet || {}, { [t.id]: t.open }); }, true);