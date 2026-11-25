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
    /* a filtered live list: only the documents that match are loaded and sent on updates */
    where: (f, op, v) => { const q = r.where(f, op, v); return { onSnapshot: (next, err) => q.onSnapshot(s => next({ docs: s.docs.map(fbSnap), size: s.size, empty: s.empty, metadata: { fromCache: s.metadata.fromCache } }), fbErr(err)), get: async () => { const s = await q.get(); return { docs: s.docs.map(fbSnap), size: s.size, empty: s.empty }; } }; },
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
const APP_VERSION = '2026-11-25e · mark staff as spare';
const BANDS = { Y: '14–15', O: '16–18' }; /* labels only: 13-year-olds turning 14 during the session are placed with the 14–15s, and every age is kept as recorded */
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
/* Church member or not, from the portal's hasMrn (the scraper writes Yes or No). Blank means not known. */
function normMember(v) { const t = clean(v).toLowerCase(); if (/^(yes|y|true|1|member)$/.test(t)) return true; if (/^(no|n|false|0|non.?member|not a member)$/.test(t)) return false; return null; }
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
/** "1 group" / "3 groups": a number with the right singular or plural word. */
function nn(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }
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
  ['member', 'Church member', ['member', 'church member', 'has mrn', 'hasmrn', 'membership', 'membership record']],
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
      stake: clean(o.stake), unit: clean(o.unit), bishopE: clean(o.bishopE).toLowerCase(), bishopN: titleCase(o.bishopN),
      member: normMember(o.member)
    };
    const kind = mode === 'auto' ? (normType(o.type) || 'participant') : mode;
    const regId = clean(o.regId);
    if (kind === 'participant') {
      rec.raw = row.map((c, i) => mapping[i] === 'med' || mapping[i] === 'diet' ? null : (c == null ? '' : String(c)));
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
    const x = sfRow(o, opts.refDate || ''); x.row = r; x.raw = row.map(c => c == null ? '' : String(c)); subs.push(x);
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
    const old = ex.find(s => samePerson(s, p));
    /* a role written in the Type column wins; otherwise someone already on the list keeps their role,
       so a counselors-only file or a blank Type never turns an AC or coordinator into a counselor */
    const typed = role === 'column' && p.role && STAFF_ROLES.includes(p.role);
    const r = typed ? p.role : (old && old.role ? old.role : (role === 'column' ? 'counselor' : role));
    const kept = !typed && old && old.role && old.role !== (role === 'column' ? 'counselor' : role);
    out.push(Object.assign({}, old ? Object.assign({}, old) : {}, {
      id: old ? old.id : 'S' + fnv((p.email || p.toks.join(' ') + p.bday)).toString(36),
      name: p.name, gender: p.gender || (old && old.gender) || '', bday: p.bday || (old && old.bday) || '', ageCsv: p.bday ? null : (old ? old.ageCsv ?? null : null), role: r,
      raw: p.raw || (old && old.raw) || null, addedAt: (old && old.addedAt) || Date.now(), addedBy: (old && old.addedBy) || (typeof S !== 'undefined' && S.meName) || '',
      phone: p.phone || (old && old.phone) || '', email: p.email || (old && old.email) || '', unit, stake, unitRaw: p.unitRaw, tshirt: p.tshirt || (old && old.tshirt) || '', diet: p.diet, med: p.med || '', src: 'form', test: false
    }));
    for (const k of ['toks', 'phoneOk', 'uc', 'isUpdate', 'keptRole']) delete out[out.length - 1][k];
    out[out.length - 1].isUpdate = !!old; if (kept) out[out.length - 1].keptRole = true;
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
      if (p.member === false && p.src !== 'walkin') flags.push('nonmember');
      p.flags = flags;
      p.inc = p.ov === 'inc' ? true : p.ov === 'exc' ? false : !(flags.includes('area') || flags.includes('status') || (cfg.excludeNonMembers && flags.includes('nonmember')));
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
  for (const g of ['F', 'M']) { const y = S.P.filter(p => p.elig && p.gender === g).length, c = S.staffList.filter(x => x.role === 'counselor' && x.gender === g && !x.test && !sh[x.id] && !x.spare).length; const now = gsize(S.config, g), f = c ? Math.max(6, Math.ceil(y / c)) : null; out[g] = { y, c, fit: f && f < now ? f : null, now, short: !!(c && Math.ceil(y / c) > now) }; }
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
  const shadow = shadowedCounselors(staffList); const counselors = staffList.filter(s => s.role === 'counselor' && s.gender && !shadow[s.id] && !s.spare);
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
  const acs = staffList.filter(s => s.role === 'ac' && !s.spare);
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
  if (A - ai > 0) log.push(`${nn(A - ai, 'assistant coordinator')} left spare: not enough groups of both genders for more companies`);
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
  let removed = 0, misfit = 0;
  for (const p of P) {
    const g = p.g && groups[p.g];
    /* someone whose age group or gender no longer matches their group (a corrected birthday, a new first day of session) is placed again */
    if (g && p.elig && (p.gender === g.gender) && (!p.band || p.band === g.band)) { cur[p.id] = p.g; members[p.g].push(p); }
    else { cur[p.id] = null; if (p.g) { if (g && p.elig) misfit++; else removed++; } }
  }
  if (removed) log.push(`${nn(removed, 'participant')} taken out of groups (deleted, excluded or group gone)`);
  if (misfit) log.push(`${nn(misfit, 'participant')} moved to a group of their own age group and gender (their age or gender no longer matched their old group)`);
  // counselors still valid?
  for (const g of Object.values(groups)) {
    const c = g.counselorId && staffMap[g.counselorId];
    const sh = g.counselorId && shadowedCounselors(staffList)[g.counselorId];
    if (c && c.spare) { log.push(`${c.name} is marked spare, so group ${g.num} needs a new counselor`); g.counselorId = null; }
    else if (g.counselorId && (!c || c.role !== 'counselor')) { log.push(c ? `${c.name} is now ${ROLES[c.role] ? (/^[aeiou]/i.test(ROLES[c.role]) ? 'an ' : 'a ') + ROLES[c.role].toLowerCase() : 'not a counselor'}, so group ${g.num} needs a new counselor` : `Group ${g.num} lost its counselor`); g.counselorId = null; }
    else if (sh) { log.push(`${c.name} is also listed as ${ROLES[sh.role].toLowerCase()}, so they were taken off group ${g.num}`); g.counselorId = null; }
    else if (c && c.gender && c.gender !== g.gender) { log.push(`${c.name} no longer matches the gender of group ${g.num}, so they were taken off it and will get a ${c.gender === 'F' ? 'young women' : 'young men'}'s group if one is needed`); g.counselorId = null; }
  }
  // empty groups
  for (const g of Object.values(groups)) if (!members[g.id].length) { log.push(`Group ${g.num} was empty and was removed`); delete groups[g.id]; delete members[g.id]; }
  const used = new Set(Object.values(groups).map(g => g.counselorId).filter(Boolean));
  const shadow = shadowedCounselors(staffList); const counselors = staffList.filter(s => s.role === 'counselor' && s.gender && !shadow[s.id] && !s.spare);
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
  if (placed) log.push(`${nn(placed, 'participant')} placed into groups`);
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
  if (evened) log.push(`${nn(evened, 'participant')} moved to even out group sizes`);
  if (created) log.push(`${nn(created, 'new group')} created`);
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
  if (cfg.useAll) for (let guard = 0; guard < 300; guard++) {
    let best = null;
    for (const c of counselors) { if (used.has(c.id)) continue;
      for (const band of ['Y', 'O']) { const gs = Object.values(groups).filter(g => g.band === band && g.gender === c.gender && g.counselorId); if (!gs.length) continue;
        const tot = gs.reduce((a, g) => a + members[g.id].length, 0), avg = tot / (gs.length + 1); if (avg < 1) continue; /* no lower limit on group size, only that every group keeps someone */
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
  if (still) log.push(`${still === 1 ? '1 group is' : still + ' groups are'} still over the group size: add counselors and press Rebalance again`);
  else if (overfull && !opened) log.push(`${nn(overfull, 'placement')} went over the group size: add counselors to open new groups`);
  // ACs
  const acs = staffList.filter(s => s.role === 'ac' && !s.spare);
  for (const c of Object.values(companies)) {
    const a = c.acId && staffMap[c.acId];
    if (c.acId && (!a || a.role !== 'ac')) { log.push(`Company ${c.num} lost its assistant coordinator`); c.acId = null; }
    else if (a && a.spare) { log.push(`${a.name} is marked spare, so company ${c.num} needs a new assistant coordinator`); c.acId = null; }
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
  if (lp) log.push(`${nn(lp, 'group')} added to ${lp === 1 ? 'a company' : 'companies'}`);
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
  if (freeAcs.length) log.push(`${nn(freeAcs.length, 'assistant coordinator')} still without a company`);
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
  if (un) w.push(['warn', `${un === 1 ? '1 eligible participant is' : un + ' eligible participants are'} not in a group`, { p: P.filter(p => p.elig && (!p.g || !groups[p.g])).map(p => p.id) }]);
  const shadow = shadowedCounselors(Object.values(staffMap));
  for (const g of Object.values(groups)) { const c = g.counselorId && staffMap[g.counselorId]; if (!c) continue;
    if (c.role !== 'counselor') w.push(['bad', `Group ${g.num} is led by ${c.name}, who is now ${ROLES[c.role] ? (/^[aeiou]/i.test(ROLES[c.role]) ? 'an ' : 'a ') + ROLES[c.role].toLowerCase() : 'not a counselor'}. Press Rebalance.`, { g: g.id }]);
    else if (shadow[c.id]) { const co = Object.values(companies).find(x => x.acId === shadow[c.id].id); w.push(['bad', `${c.name} leads group ${g.num} but is also listed as ${ROLES[shadow[c.id].role].toLowerCase()}${co ? ' (Company ' + co.num + ')' : ''}. Press Rebalance, then delete the extra counselor record on the Staff page.`, { g: g.id }]); } }
  const noCoun = Object.values(groups).filter(g => !(g.counselorId && staffMap[g.counselorId])).length;
  if (noCoun) w.push(['bad', `${noCoun === 1 ? '1 group has' : noCoun + ' groups have'} no counselor. Press Rebalance: ${noCoun === 1 ? 'its' : 'their'} youth move into groups of the same gender and age that have a counselor, and those groups grow until you add counselors.`]);
  for (const g of Object.values(groups)) {
    const c = g.counselorId && staffMap[g.counselorId];
    if (!c) w.push(['bad', `Group ${g.num} has no counselor`, { g: g.id }]);
    else if (c.gender && c.gender !== g.gender) w.push(['bad', `Group ${g.num}: counselor ${c.name} is not the same gender as the group`, { g: g.id }]);
    if (mem[g.id].some(p => p.gender !== g.gender)) w.push(['bad', `Group ${g.num} mixes young men and young women`, { g: g.id }]);
    if (mem[g.id].some(p => p.band && p.band !== g.band)) w.push(['bad', `Group ${g.num} mixes the 14–15 and 16–18 age groups`, { g: g.id }]);
    if (mem[g.id].length > gsize(cfg, g.gender)) w.push(['warn', `Group ${g.num} has ${mem[g.id].length} participants (size is ${gsize(cfg, g.gender)})`, { g: g.id }]);
    if (!g.companyId || !companies[g.companyId]) w.push(['warn', `Group ${g.num} is not in a company`, { g: g.id }]);
    else if (companies[g.companyId].band !== g.band) w.push(['bad', `Group ${g.num} is in a company of the other age group`, { g: g.id }]);
  }
  const noG = Object.values(staffMap).filter(s => s.role === 'counselor' && !s.gender).length;
  if (noG) w.push(['warn', `${noG === 1 ? '1 counselor has' : noG + ' counselors have'} no gender, so ${noG === 1 ? 'they cannot' : 'they cannot'} lead a group. Add it on the Staff page.`]);
  for (const c of Object.values(companies)) {
    const gs = Object.values(groups).filter(g => g.companyId === c.id);
    if (!c.acId || !staffMap[c.acId]) w.push(['bad', `Company ${c.num} has no assistant coordinator`, { c: c.id }]);
    if (!gs.some(g => g.gender === 'F') || !gs.some(g => g.gender === 'M')) w.push(['bad', `Company ${c.num} does not have both young men and young women`, { c: c.id }]);
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
const UI = { stFold: (() => { try { return localStorage.getItem('fsy.stFold') !== '0'; } catch (e) { return true; } })(), page: null, frameKey: '', q: '', filter: 'all', stake: '', unit: '', limit: 40, logScope: 'all', staffTab: 'counselor', open: new Set(), openStakes: new Set(), band: '', imp: null, genLog: null, pending: false };

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
  // marking companies official (which locks Regenerate and Undo all groups) is for the registration admin and the Session Directing Couple only
  lockRegen: () => ['regadmin', 'sdc'].includes(role()),
  // closing or opening the addition of staff: the registration admin, Session Directing Couple, Area Seventy and Head of Logistics
  // splitting blank T-shirt sizes by hand: admins and the logistics team
  teeEdit: () => ['regadmin', 'sdc', 'seventy', 'loghead', 'logistics', 'coordinator'].includes(role()),
  lockStaff: () => ['regadmin', 'sdc', 'seventy', 'loghead'].includes(role()),
  // adding staff (new records, imports, making someone a counselor): anyone with staff rights, but once closed only the roles above
  addStaff: () => can.staff() && (!S.config.staffLock || ['regadmin', 'sdc', 'seventy', 'loghead'].includes(role())),
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
  ['planner', 'Plan sessions', () => TOP_ROLES.includes(realRole()) && TOP_ROLES.includes(role())],
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
const FLAG_TEXT = { walkin: ['Walk-in', 'info'], area: ['Excluded area', 'bad'], status: ['Cancelled', 'bad'], pending: ['Not approved yet', 'warn'], gender: ['No gender', 'bad'], age: ['No age', 'bad'], agerange: ['Outside 13–18', 'warn'], size: ['No T-shirt size', 'warn'], nonmember: ['No MRN', 'info'] };
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
  if ('g' in patch) touchMoves();
  return upd('state/' + b, { p: { [pid]: patch } }, ex).catch(fail);
}
async function setStates(map) { // pid -> patch
  const byB = {}; for (const pid in map) { const b = bucketOf(pid); (byB[b] = byB[b] || {})[pid] = map[pid]; S.state[b] = Object.assign({}, S.state[b] || {}); S.state[b][pid] = Object.assign({}, S.state[b][pid] || {}, map[pid]); }
  recompute(true);
  for (const b in byB) { const ex = S.stateEx.has(b); S.stateEx.add(b); await upd('state/' + b, { p: byB[b] }, ex); }
  if (Object.values(map).some(x => x && 'g' in x)) touchMoves();
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
    if (SC.on) { const ms = new Set(myGroups().map(g => g.id)); S.P = S.P.filter(p => p.g && ms.has(p.g)); }
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
  // 6. the role chosen on the Accounts page wins over the role in the staff record it is linked to
  await syncLinkedRoles();
}
const PICK_ROLES = ['counselor', 'ac', 'coordinator'];
async function syncLinkedRoles() {
  if (!(S.isOwner || ['regadmin', 'sdc', 'seventy', 'loghead'].includes(realRole())) || !S.loaded.inv || !S.loaded.staff) return;
  for (const h in S.invites) {
    const v = S.invites[h]; if (!v || !PICK_ROLES.includes(v.role) || !invHere(v) || !v.staffId) continue;
    const st = S.staff[v.staffId]; if (!st || st.role === v.role || !PICK_ROLES.includes(st.role)) continue;
    await saveStaffRec(Object.assign({}, st, { role: v.role, roleFrom: 'account' }));
  }
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
    const gender = (cur && cur.selfAt && cur.gender) || v.gender || (cur && cur.gender) || ''; /* a gender the person set in My details wins */
    if (!cur || cur.name !== name || cur.role !== v.role || (cur.gender || '') !== gender || !cur.email) add[id] = Object.assign({ gender: '', stake: '', unit: '', phone: '', addedAt: Date.now(), addedBy: 'Accounts' }, cur || {}, { id, name, role: v.role, gender, email: (cur && cur.email) || h, fromAccount: 1 });
  }
  for (const id in S.staff) { const s = S.staff[id]; if (s && s.fromAccount && !want[id]) del.push(id); }
  if (!Object.keys(add).length && !del.length) return;
  const s = Object.assign({}, S.staff, add); del.forEach(id => delete s[id]); S.staff = s;
  const ex = S.staffEx; S.staffEx = true;
  if (del.length) await setDoc('staff/all', { s }); else await upd('staff/all', { s: add }, ex);
  recompute();
}
/* Counselors' phones load only the storage documents that hold their own group's youth (about 10 of 64),
   instead of the whole session, so each check-in elsewhere is not sent to every counselor. Everyone else loads everything.
   One quick look at all check-in states finds which documents those are; it is repeated only when someone is moved between groups. */
const SC = { on: false, key: null, subs: {}, busy: false, again: false, mv: null };
function scopeOn() { return S.myRole === 'counselor' && !S.isOwner; }
async function scopeRefresh(force) {
  if (!SC.on || !S.loaded.org || !S.loaded.inv) return;
  const mine = myGroups().map(g => g.id).sort(), key = mine.join(',');
  if (!force && key === SC.key) return;
  if (SC.busy) { SC.again = true; return; }
  SC.busy = true; SC.key = key;
  try {
    const ms = new Set(mine), want = new Set();
    if (mine.length) { const sn = await FB.fs.collection(scoped('state')).get(); sn.docs.forEach(d => { const p = (d.data() || {}).p || {}; for (const id in p) if (p[id] && ms.has(p[id].g)) want.add(d.id); }); }
    for (const b of Object.keys(SC.subs)) if (!want.has(b)) { SC.subs[b].forEach(u => { try { u(); } catch (e) { } }); delete SC.subs[b]; const r = Object.assign({}, S.roster), t = Object.assign({}, S.state); delete r[b]; delete t[b]; S.roster = r; S.state = t; }
    for (const b of want) if (!SC.subs[b]) SC.subs[b] = [
      S.db.doc('roster/' + b).onSnapshot(d => { S.roster = Object.assign({}, S.roster, { [b]: Object.assign({}, (d.exists && (d.data() || {}).p) || {}) }); if (d.exists) S.rosterEx.add(b); recompute(); }, e => console.error(e)),
      S.db.doc('state/' + b).onSnapshot(d => { S.state = Object.assign({}, S.state, { [b]: Object.assign({}, (d.exists && (d.data() || {}).p) || {}) }); if (d.exists) S.stateEx.add(b); recompute(); }, e => console.error(e))
    ];
    S.loaded.roster = S.loaded.state = true; recompute();
  } catch (e) { console.error(e); SC.key = null; }
  SC.busy = false; if (SC.again) { SC.again = false; scopeRefresh(true); }
}
/* tells counselors' phones that someone changed group, so they look again */
function touchMoves() { setDoc('state/_mv', { at: Date.now() }).catch(() => { }); }
function subscribe() {
  const db = S.db; const onErr = e => { console.error(e); if (e.code === 'revoked') { S.noDb = true; render(); } };
  const mark = (k, meta) => { if (!meta.fromCache) S.loaded[k] = true; };
  setTimeout(() => { if (!loadedAll()) { S.slow = true; render(); } }, 10000);
  if (scopeOn()) { SC.on = true; SC.key = null; db.doc('state/_mv').onSnapshot(d => { const v = d.exists ? d.data().at : 0; if (SC.mv != null && v !== SC.mv) scopeRefresh(true); SC.mv = v; }, () => { }); }
  else {
  db.collection('roster').onSnapshot(sn => { const r = {}; S.rosterEx = new Set(); sn.docs.forEach(d => { r[d.id] = Object.assign({}, (d.data() || {}).p || {}); S.rosterEx.add(d.id); }); S.roster = r; mark('roster', sn.metadata); recompute(); }, onErr);
  db.collection('state').onSnapshot(sn => { const r = {}; sn.docs.forEach(d => { r[d.id] = Object.assign({}, (d.data() || {}).p || {}); S.stateEx.add(d.id); }); S.state = r; mark('state', sn.metadata); recompute(); }, onErr);
  }
  db.doc('staff/all').onSnapshot(d => { S.staffCols = d.exists ? d.data().cols || null : null; S.staff = d.exists ? Object.assign({}, d.data().s || {}) : {}; S.staffEx = d.exists || S.staffEx; mark('staff', d.metadata); recompute(); }, onErr);
  db.doc('org/structure').onSnapshot(d => { const v = d.exists ? d.data() : {}; S.org = { groups: Object.assign({}, v.groups || {}), companies: Object.assign({}, v.companies || {}) }; S.orgGen = v.gen || null; S.orgLock = v.lock || null; S.orgEx = d.exists || S.orgEx; mark('org', d.metadata); recompute(); }, onErr);
  S.hcSub = null; hcSubscribe(); /* headcounts load only what this person needs (see hcSubscribe) */
  db.doc('config/tee').onSnapshot(d => { const v = d.exists ? d.data() : null; S.teeDoc = v || {}; S.teeCustom = v && (v.y || v.s) ? v : null; S.teeExtra = (v && v.extra) || {}; recompute(); }, () => { });
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
  planner: I('<path d="M4 6h16M4 12h10M4 18h6"/><path d="M17 14l3 3-3 3M14 17h6"/>'),
  sessions: I('<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>'),
  print: I('<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  me: I('<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
  signout: I('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>')
};
const SHORT = { audit: 'Audit', wellness: 'Wellness', sessions: 'Sessions', headcount: 'Headcount', checkin: 'Check-in', tally: 'Tally', companies: 'Groups', exceptions: 'Walk-ins', logistics: 'Logistics', staff: 'Staff', data: 'Data', access: 'Accounts' };
const NAV_ORDER = { wellness: ['checkin', 'wellness', 'tally'], logistics: ['checkin', 'logistics', 'exceptions', 'tally', 'companies', 'headcount', 'staff', 'wellness', 'data'], counselor: ['checkin', 'companies', 'headcount', 'logistics', 'exceptions'], ac: ['checkin', 'companies', 'headcount', 'logistics', 'exceptions'] };
function navPages() { const ok = allowedPages().map(p => p[0]).filter(k => k !== 'audit' && k !== 'planner'); /* the audit log opens from the account menu, the planner from Sessions */ const pref = NAV_ORDER[role()] || []; return pref.filter(k => ok.includes(k)).concat(ok.filter(k => !pref.includes(k))); }
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
  const cur = currentPage() === 'planner' ? 'sessions' : currentPage(); const keys = navPages();
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
/* My details: anyone whose account is linked to a staff record edits their own contact, T-shirt, birthdate, gender, home unit, food and medical notes.
   The database only lets them change these fields on their own record (see firestore.rules). */
const SELF_FIELDS = ['phone', 'email', 'tshirt', 'bday', 'ageCsv', 'gender', 'stake', 'unit', 'diet', 'med', 'selfAt'];
/* my staff record: the one linked to my account, or else the only staff record carrying my sign-in email */
function myRecord() {
  if (S.viewAs) return null; const id = myStaffId(); if (id && S.staff[id]) return S.staff[id];
  const me = String(S.email || '').toLowerCase(); if (!me) return null;
  const m = S.staffList.filter(x => !x.test && String(x.email || '').toLowerCase() === me); return m.length === 1 ? S.staff[m[0].id] || m[0] : null;
}
function myRecordByEmail() { const r = myRecord(); return !!r && r.id !== myStaffId(); }
function openMyDetails() {
  const s = myRecord();
  if (!s) {
    openModal(`<div class="modal-head"><h2>My details</h2><button class="x" data-act="close" aria-label="Close">×</button></div>
    <p>You are not on the staff list yet, so there are no details to edit.</p>
    <p class="note">The app finds your details by the staff record linked to your account, or by a staff record with your sign-in email (${esc(S.email || '')}).</p>
    ${can.staff() ? '<button class="btn primary" data-act="addMe" style="width:100%">Add me to the staff list</button>' : '<p class="note">Ask the registration admin to add you on the Staff page or link your account on the Accounts page.</p>'}`);
    return;
  }
  const byEmail = myRecordByEmail();
  const A = stAreas(), stk = s.stake || '', unt = s.unit || '';
  const stOther = !!stk && !A.stakes.includes(stk), unOther = !!unt && !(A.units[stk] || []).includes(unt);
  openModal(`<div class="modal-head"><h2>My details</h2><button class="x" data-act="close" aria-label="Close">×</button></div>
  <p class="note" style="margin:-6px 0 12px"><b>${esc(s.name)}</b> · ${esc(ROLES[s.role] || s.role)}. Changes save straight away and the registration team can see them. To change your name or role, ask the registration admin.</p>
  <form id="meForm" class="form">
    <label>Phone<input id="mePhone" inputmode="tel" placeholder="07… or 01…" value="${esc(s.phone || '')}"></label>
    <label>Email<input id="meEmail" type="email" inputmode="email" autocomplete="email" value="${esc(s.email || '')}" ${byEmail ? 'readonly title="This email connects your sign-in to this record"' : ''}></label>
    <label>Gender<select id="meGender">${opt('', 'Choose…', !s.gender)}${opt('F', 'Female', s.gender === 'F')}${opt('M', 'Male', s.gender === 'M')}</select></label>
    <label>Birthdate<input id="stBday" type="date" max="${isoUTC(new Date(Date.now() - 15 * 365.25 * 864e5))}" value="${esc(s.bday || '')}"><small class="muted st-age" id="stAgeOut">${stAgeText(s.bday || '', s.bday ? null : s.ageCsv)}</small></label>
    <label>Stake / district<select id="stStakeSel">${opt('', 'Choose…', !stk)}${A.stakes.map(x => opt(x, x, x === stk)).join('')}${opt('__other', '+ Other stake or district…', stOther)}</select>
      <input id="stStakeNew" placeholder="Type your stake or district" autocomplete="off" value="${esc(stOther ? stk : '')}" ${stOther ? '' : 'hidden'}></label>
    <label>Ward / branch<select id="stUnitSel">${stUnitOpts(stOther ? '__other' : stk, unOther ? '__other' : unt)}</select>
      <input id="stUnitNew" placeholder="Type your ward or branch" autocomplete="off" value="${esc(unOther ? unt : '')}" ${unOther || stOther ? '' : 'hidden'}></label>
    <p class="note span2" id="stOtherNote" hidden style="margin:-4px 0 0">Type it in full, for example "Kenya Nairobi South Stake" and "Nairobi 2nd Ward".</p>
    <label>T-shirt size<select id="meSize">${opt('', 'Not given', !s.tshirt)}${SIZES.map(z => opt(z, SIZE_LABEL[z], s.tshirt === z)).join('')}</select></label>
    <label class="span2">Food needs or allergies<textarea id="meDiet" rows="2" placeholder="Leave blank if none">${esc(s.diet || '')}</textarea></label>
    <label class="span2">Medical information<textarea id="meMed" rows="2" placeholder="Leave blank if none">${esc(s.med || '')}</textarea><small class="muted">Only the wellness team, logistics and the registration team use this.</small></label>
    <p class="note span2" style="margin:0">Changing your gender or birthdate can change which group you lead after the next Rebalance.</p>
    <div class="span2"><button class="btn primary" type="submit" style="width:100%">Save my details</button></div>
  </form>`);
}
async function saveMyDetails() {
  const s = myRecord(); if (!s) { toast('Your account is not linked to a staff record', true); return; }
  const val = id => clean(($('#' + id) || {}).value || '');
  const email = myRecordByEmail() ? s.email : sfEmail(val('meEmail')), phoneRaw = val('mePhone'), phone = sfPhone(phoneRaw) || phoneRaw, bday = val('stBday');
  if (email && !okEmail(email)) { toast('That email does not look right', true); return; }
  if (phoneRaw && !okPhone(sfPhone(phoneRaw))) { toast('That phone number does not look right. Use 07… or 01…', true); return; }
  const age = bday ? ageOn(bday, S.config.sessionStart || '') : null; if (bday && (age < 15 || age > 90)) { toast('That birthdate does not look right', true); return; }
  const stake = val('stStakeSel') === '__other' ? titleCase(val('stStakeNew')) : val('stStakeSel'), unit = val('stUnitSel') === '__other' || val('stStakeSel') === '__other' ? titleCase(val('stUnitNew')) : val('stUnitSel');
  const next = { phone, email, gender: val('meGender'), bday: bday || s.bday || '', stake, unit, tshirt: val('meSize'), diet: val('meDiet'), med: val('meMed') };
  if (bday) next.ageCsv = null;
  const LBL = { phone: 'phone', email: 'email', gender: 'gender', bday: 'birthdate', stake: 'stake', unit: 'ward', tshirt: 'T-shirt size', diet: 'food needs', med: 'medical information' };
  const patch = {}; for (const k in next) if ((next[k] ?? '') !== (s[k] ?? '')) patch[k] = next[k];
  if (!Object.keys(patch).length) { closeModal(); toast('Nothing changed'); return; }
  patch.selfAt = Date.now();
  S.staff = Object.assign({}, S.staff, { [s.id]: Object.assign({}, s, patch) }); recompute(true);
  try { await upd('staff/all', { selfKey: s.id, s: { [s.id]: patch } }, true); audit('staff', `${s.name} updated their own details: ${Object.keys(patch).filter(k => LBL[k]).map(k => LBL[k]).join(', ')}`, s.id); closeModal(); toast('Your details are saved'); }
  catch (e) { S.staff = Object.assign({}, S.staff, { [s.id]: s }); recompute(true); fail(e); }
}
function openAccount() {
  const r = realRole();
  openModal(`<div class="modal-head"><div class="acct"><span class="avatar" style="width:46px;height:46px;cursor:default">${esc(initials(S.meName))}</span><div><h2>${esc(S.meName || 'Signed in')}</h2><small class="muted">${esc(S.email || '')}</small></div></div><button class="x" data-act="close" aria-label="Close">×</button></div>
  <p style="margin:0">Role: <span class="rolechip">${esc(r ? ROLES[r] : 'No role yet')}</span></p>
  ${r === 'regadmin' ? `<label class="form" style="display:block"><span class="note" style="display:block;margin-bottom:4px">See the app the way someone else does</span><select id="viewAs" aria-label="Preview as role" style="width:100%">${opt('', 'Viewing as myself', !S.viewAs)}${Object.keys(ROLES).filter(k => k !== 'regadmin').map(k => opt(k, 'Preview: ' + ROLES[k], S.viewAs === k)).join('')}</select></label>` : ''}
  ${S.mySessions.length > 1 ? `<div><p class="th" style="margin-bottom:6px">Session</p><div class="sheetlist">${S.mySessions.map(id => `<button data-act="switchSession" data-v="${esc(id)}" ${id === S.sid ? 'aria-current="page"' : ''}>${ICONS.checkin}${esc(sessName(id))}${id === S.sid ? ' · open now' : ''}</button>`).join('')}</div></div>` : ''}
  ${r && !S.viewAs ? `<div class="sheetlist"><button data-act="myDetails">${ICONS.me}My details<small class="muted" style="margin-left:auto;font-weight:600">${myRecord() ? 'phone, T-shirt, ward…' : 'not on the staff list yet'}</small></button></div>` : ''}
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
/* lists that scroll inside the page (stake pickers, wide tables) keep their place when redrawn */
function scrollKey(el) { const m = $('#main'); const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).join('.'); const sel = el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() + (cls ? '.' + cls.split('.').map(c => CSS.escape(c)).join('.') : ''); const all = [...m.querySelectorAll(sel)]; return [sel, all.indexOf(el)]; }
function innerScrolls() { const m = $('#main'); if (!m) return []; const out = []; m.querySelectorAll('*').forEach(el => { if (el.scrollTop > 0 || el.scrollLeft > 0) out.push([scrollKey(el), el.scrollTop, el.scrollLeft]); }); return out; }
function restoreScrolls(list) { const m = $('#main'); if (!m || !list) return; for (const [[sel, i], t, l] of list) { const el = m.querySelectorAll(sel)[i]; if (el) { el.scrollTop = t; el.scrollLeft = l; } } }
function render() {
  if (UI.pending) return;
  const ae = document.activeElement;
  if (ae && $('#main').contains(ae) && (ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && (ae.dataset.region || ae.dataset.hcreason)))) { UI.pending = true; ae.addEventListener('blur', () => { setTimeout(() => { UI.pending = false; render(); }, 250); }, { once: true }); return; }
  if (SC.on && S.loaded && S.loaded.org) scopeRefresh(false); /* before the loading screen, so a counselor's data can start loading */
  renderHeader(); renderNav();
  const gate = gateView();
  if (gate) { const gk = 'gate' + fnv(gate); if (UI.frameKey !== gk) { $('#main').innerHTML = gate; UI.frameKey = gk; } return; }
  const pg = currentPage(); const key = pg + '|' + role() + '|' + (myStaffId() || '');
  const page = PAGE_IMPL[pg];
  if (S.loaded && S.loaded.org) hcSubscribe();
  let keepY = null, refocus = null, inner = null;
  if (UI.frameKey !== key) { $('#main').innerHTML = page.frame(); UI.frameKey = key; window.scrollTo(0, 0); }
  else {
    /* redrawing a list must not move the page (Safari has no scroll anchoring), and a ticked box keeps focus */
    keepY = window.scrollY; inner = innerScrolls();
    if (ae && ae.dataset && ae.dataset.act && ae.tagName === 'INPUT' && $('#main').contains(ae)) refocus = `input[data-act="${ae.dataset.act}"]` + (ae.dataset.v != null ? `[data-v="${CSS.escape(ae.dataset.v)}"]` : '');
  }
  page.update();
  if (keepY != null) {
    if (Math.abs(window.scrollY - keepY) > 1) window.scrollTo(0, keepY);
    restoreScrolls(inner);
    if (refocus) { const el = $('#main').querySelector(refocus); if (el && document.activeElement !== el) try { el.focus({ preventScroll: true }); } catch (e) { } }
  }
  if (can.readOnly()) lockReadOnly(pg); else if (pg === 'headcount' && hcViewOnly()) lockReadOnly(pg);
}

function lockReadOnly(pg) {
  const m = $('#main');
  m.querySelectorAll('.adm,.adm-hc').forEach(el => el.hidden = true);
  if (pg === 'staff' || pg === 'data') m.querySelectorAll('input,select,textarea').forEach(el => { if (el.type !== 'search' && !['ciQ', 'stQ'].includes(el.id)) el.disabled = true; }); /* searching stays available */
  if (pg === 'headcount') m.querySelectorAll('.hc-toggle button,.hc-reason,[data-hcnote]').forEach(el => el.disabled = true);
}

function resetPanel() {
  const nG = Object.keys(S.org.groups).length, nC = Object.keys(S.org.companies).length, nT = S.staffList.filter(x => x.test).length, nS = S.staffList.length;
  return `<section class="panel danger-zone"><div class="panel-head"><h2>Start over</h2><span class="chip bad">Can't be undone</span></div>
    <p class="note" style="margin-top:-4px">For registration admins, the Session Directing Couple, the Area Seventy and coordinators. Each action says what it removes; everything else is kept.</p>
    <div class="dz-list">
      <div class="dz"><div><b>Undo all groups and companies</b><small class="muted">${nG} groups and ${nC} companies are removed and every participant goes back to "no group". Generate again afterwards.</small></div><button class="btn danger" data-act="resetOrg" ${(nG || nC) && !S.config.regenLock ? '' : 'disabled'} ${S.config.regenLock ? 'title="Companies are official. Unlock them first."' : ''}>Undo groups</button></div>
      <div class="dz"><div><b>Delete test staff</b><small class="muted">${nT} staff marked Test.</small></div><button class="btn danger" data-act="resetTest" ${nT ? '' : 'disabled'}>Delete test staff</button></div>
      <div class="dz"><div><b>Delete staff of one type</b><small class="muted">For example every counselor, before uploading a corrected list. Everyone else stays. Logistics and Session Directing Couple members who have an account are always kept.</small><select id="rsType" style="margin-top:8px;max-width:280px">${STAFF_ROLES.map(r => { const n = S.staffList.filter(x => x.role === r && !x.fromAccount).length; return opt(r, `${ROLES[r]}s · ${n}`, r === (UI.rsType || 'counselor')); }).join('')}</select></div><button class="btn danger" data-act="resetType">Delete this type</button></div>
      ${can.deleteP() ? `<div class="dz"><div><b>Delete all participants</b><small class="muted">All ${S.P.length} youth and walk-ins in ${esc(sessName(S.sid))}, with their check-ins, medical notes and headcounts. Staff, groups and companies stay. Upload the participant file again on Data & areas, then press Rebalance.</small></div><button class="btn danger" data-act="resetPart" ${S.P.length ? '' : 'disabled'}>Delete all participants</button></div>` : ''}
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
    const exp = P.filter(isExpected).length;
    const inn = P.filter(p => p.s === 'in').length, out = P.filter(p => p.s === 'out').length, wk = P.filter(p => p.src === 'walkin').length;
    const arrived = P.filter(p => isExpected(p) && p.s).length;
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
/* The full T-shirt order as rows: size, youth (given and estimated), staff (given and estimated), total */
/* the suggested split of blank sizes, and the custom split if someone saved one that still adds up */
function teeBlanks(L) {
  const { ST, est } = staffTee(), R = teeRedistribute(L);
  const sug = { y: {}, s: Object.assign({}, est) }; for (const k in R.totals) if (R.totals[k].est) sug.y[k] = R.totals[k].est;
  const sum = o => Object.values(o || {}).reduce((a, b) => a + (+b || 0), 0), n = { y: sum(sug.y), s: sum(sug.s) };
  const C = S.teeCustom, ok = !!C && sum(C.y) === n.y && sum(C.s) === n.s;
  return { ST, R, sug, n, custom: ok ? C : null, stale: !!C && !ok, use: ok ? { y: C.y || {}, s: C.s || {} } : sug };
}
function teeOrderRows(L) {
  const B = teeBlanks(L), { ST, R } = B;
  const giv = {}; ST.forEach(x => { if (x.tshirt) giv[x.tshirt] = (giv[x.tshirt] || 0) + 1; });
  const rows = [];
  for (const s of sizesIn(giv, B.use.s, B.use.y, R.totals)) {
    const yg = R.totals[s] ? R.totals[s].given : 0, ye = +(B.use.y[s] || 0), sg = giv[s] || 0, se = +(B.use.s[s] || 0);
    if (yg + ye + sg + se) rows.push({ s, label: SIZE_LABEL[s] || s, yg, ye, sg, se, y: yg + ye, st: sg + se, t: yg + ye + sg + se });
  }
  return rows;
}
/* Edit blank sizes: decide by hand how the people who gave no size are spread across sizes */
function openTeeEditor() {
  const B = teeBlanks(UI.teeL || S.P.filter(p => p.inc || p.s)), cur = B.use, sizes = SIZE_ORDER;
  const row = (k, lbl) => `<tr><th>${lbl} <small class="muted">${B.n[k]} blank${B.n[k] === 1 ? '' : 's'}</small></th>${sizes.map(z => `<td><input type="number" min="0" inputmode="numeric" class="te-in" data-k="${k}" data-z="${z}" value="${+(cur[k][z] || 0)}" aria-label="${lbl} ${SIZE_LABEL[z] || z}"><small class="muted te-sug">${+(B.sug[k][z] || 0)}</small></td>`).join('')}<td class="te-left" id="teLeft-${k}"></td></tr>`;
  openModal(`<div class="modal-head"><h2>Edit blank sizes</h2><button class="x" data-act="close" aria-label="Close">×</button></div>
    <p class="note" style="margin-top:-6px">Spread the people who gave no size across sizes yourself. Each row must add up to its number of blanks. The small grey number under each box is the app's suggestion.</p>
    <div class="tablewrap"><table class="te-tbl"><thead><tr><th></th>${sizes.map(z => `<th class="n">${esc(SIZE_LABEL[z] || z)}</th>`).join('')}<th></th></tr></thead><tbody>${B.n.y ? row('y', 'Youth') : ''}${B.n.s ? row('s', 'Staff') : ''}</tbody></table></div>
    <div class="btnrow" style="justify-content:space-between;margin-top:12px"><button class="btn" data-act="teeSug">Use the suggestion</button><span><button class="btn" data-act="close">Cancel</button> <button class="btn primary" data-act="teeSave" id="teSave">Save split</button></span></div>`);
  UI.teeN = B.n; teeLeft();
}
function teeRead() { const o = { y: {}, s: {} }; document.querySelectorAll('.te-in').forEach(i => { const v = Math.max(0, parseInt(i.value, 10) || 0); if (v) o[i.dataset.k][i.dataset.z] = v; }); return o; }
function teeLeft() {
  const o = teeRead(), n = UI.teeN || { y: 0, s: 0 }; let ok = true;
  for (const k of ['y', 's']) { const el = $('#teLeft-' + k); if (!el) continue; const left = n[k] - Object.values(o[k]).reduce((a, b) => a + b, 0); ok = ok && left === 0;
    el.innerHTML = left === 0 ? '<span class="chip good">Adds up</span>' : left > 0 ? `<span class="chip warn">${left} still to place</span>` : `<span class="chip bad">${-left} too many</span>`; }
  const b = $('#teSave'); if (b) b.disabled = !ok;
}
async function saveTeeSplit(custom) {
  try { await setDoc('config/tee', Object.assign(custom ? Object.assign({}, custom, { at: Date.now(), by: S.meName || S.email || '' }) : { y: null, s: null }, { extra: S.teeExtra || {} })); } catch (e) { fail(e); return; }
  audit('settings', custom ? 'Saved a custom split of blank T-shirt sizes' : 'Went back to the suggested split of blank T-shirt sizes');
  closeModal(); toast(custom ? 'Custom split saved. The order and PDF use it.' : 'Back to the suggested split');
}
/** Printable T-shirt order (A4), in the same style as the check-in forms */
async function printTeeOrder() {
  const L = UI.teeL || S.P.filter(p => p.inc || p.s), rows = teeOrderRows(L);
  if (!rows.length) { toast('There are no T-shirt sizes to print yet.', true); return; }
  toast('Preparing the order…');
  let Lb; try { Lb = await loadPdfLib(); } catch (e) { toast('Could not load the PDF tool. Check your connection and try again.', true); return; }
  const { PDFDocument, StandardFonts, rgb } = Lb;
  const C = h => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  const doc = await PDFDocument.create();
  const sess = (!S.config.sessionName || S.config.sessionName === 'FSY Kenya 2') ? 'FSY Kenya 2nd 2026' : S.config.sessionName;
  doc.setTitle(pdfSafe(`${sess} T-shirt order`)); doc.setAuthor(pdfSafe(sess)); doc.setCreator('FSY Check-in');
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let logo = null; try { logo = await doc.embedPng(await logoPngBytes()); } catch (e) { }
  const W = 595.28, H = 841.89, M = 36, ROW = 26, pg = doc.addPage([W, H]), top = H - M, bandH = 84;
  const printed = new Date().toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const T = rows.reduce((a, r) => ({ yg: a.yg + r.yg, ye: a.ye + r.ye, sg: a.sg + r.sg, se: a.se + r.se, t: a.t + r.t }), { yg: 0, ye: 0, sg: 0, se: 0, t: 0 });
  pg.drawRectangle({ x: M, y: top - bandH, width: W - 2 * M, height: bandH, color: C('#f6faf4') });
  pg.drawRectangle({ x: M, y: top - bandH - 4, width: W - 2 * M, height: 4, color: C('#fcb449') });
  let tx = M + 16; if (logo) { const sz = 62; pg.drawImage(logo, { x: M + 10, y: top - bandH + (bandH - sz) / 2, width: sz, height: sz }); tx = M + 84; }
  pg.drawText(pdfSafe(`${sess.toUpperCase()}  -  T-SHIRT ORDER`), { x: tx, y: top - 22, size: 8, font: bold, color: C('#007da5') });
  pg.drawText('Full order: youth and staff', { x: tx, y: top - 46, size: 19, font: bold, color: C('#002846') });
  pg.drawText(pdfSafe(UI.logScope === 'in' ? 'Youth checked in now' : 'Everyone registered'), { x: tx, y: top - 64, size: 11.5, font, color: C('#005175') });
  const rt = `${T.t} T-shirts`; pg.drawText(rt, { x: W - M - 14 - bold.widthOfTextAtSize(rt, 13), y: top - 46, size: 13, font: bold, color: C('#002846') });
  const pr = pdfSafe('Printed ' + printed); pg.drawText(pr, { x: W - M - 14 - font.widthOfTextAtSize(pr, 8), y: top - 62, size: 8, font, color: C('#4f6f84') });
  /* columns: size | youth given | youth est | youth | staff given | staff est | staff | total */
  const X = { size: M + 10, yg: M + 190, ye: M + 245, y: M + 300, sg: M + 360, se: M + 410, st: M + 460, t: W - M - 12 };
  const right = (t, x, y, f, sz, col) => pg.drawText(String(t), { x: x - f.widthOfTextAtSize(String(t), sz), y, size: sz, font: f, color: C(col || '#002846') });
  let y = top - bandH - 36;
  pg.drawRectangle({ x: M, y: y - 8, width: W - 2 * M, height: 36, color: C('#005175') });
  const hd = (t, x, yy) => right(t, x, yy, bold, 8, '#ffffff');
  pg.drawText('SIZE', { x: X.size, y: y + 4, size: 9, font: bold, color: C('#ffffff') });
  hd('YOUTH', X.y, y + 14); hd('given', X.yg, y + 2); hd('est.', X.ye, y + 2); hd('total', X.y, y + 2);
  hd('STAFF', X.st, y + 14); hd('given', X.sg, y + 2); hd('est.', X.se, y + 2); hd('total', X.st, y + 2);
  hd('TO ORDER', X.t, y + 8);
  y -= 8 + ROW - 6;
  rows.forEach((r, i) => {
    if (i % 2 === 1) pg.drawRectangle({ x: M, y: y - 9, width: W - 2 * M, height: ROW, color: C('#f6faf4') });
    pg.drawLine({ start: { x: M, y: y - 9 }, end: { x: W - M, y: y - 9 }, thickness: 0.5, color: C('#d2e5ee') });
    pg.drawText(pdfSafe(r.label), { x: X.size, y, size: 12, font: bold, color: C('#002846') });
    right(r.yg, X.yg, y, font, 11, '#4f6f84'); right(r.ye ? '+' + r.ye : '0', X.ye, y, font, 11, '#4f6f84'); right(r.y, X.y, y, bold, 11.5);
    right(r.sg, X.sg, y, font, 11, '#4f6f84'); right(r.se ? '+' + r.se : '0', X.se, y, font, 11, '#4f6f84'); right(r.st, X.st, y, bold, 11.5);
    right(r.t, X.t, y, bold, 13);
    y -= ROW;
  });
  pg.drawRectangle({ x: M, y: y - 9, width: W - 2 * M, height: ROW + 2, color: C('#e8f3f8') });
  pg.drawText('All', { x: X.size, y, size: 12.5, font: bold, color: C('#002846') });
  right(T.yg, X.yg, y, font, 11); right('+' + T.ye, X.ye, y, font, 11); right(T.yg + T.ye, X.y, y, bold, 12);
  right(T.sg, X.sg, y, font, 11); right('+' + T.se, X.se, y, font, 11); right(T.sg + T.se, X.st, y, bold, 12);
  right(T.t, X.t, y, bold, 14);
  y -= 34;
  /* blank sizes: how many, and that they can be shared out differently */
  const nb = T.ye + T.se, Bk = teeBlanks(L);
  if (nb) {
    const msg = pdfSafe(`${nb} T-shirt${nb === 1 ? ' was' : 's were'} ordered for people who gave no size (${T.ye} youth, ${T.se} staff). ${Bk.custom ? `They were split across sizes by hand${Bk.custom.by ? ' by ' + Bk.custom.by : ''}.` : 'They are shared out above in the same proportions as everyone who did give a size. Adjust them to suit the group, for example more small sizes for younger youth.'}`);
    const lines = []; let line = ''; for (const w of msg.split(' ')) { const nx = line ? line + ' ' + w : w; if (font.widthOfTextAtSize(nx, 10) > W - 2 * M - 40) { lines.push(line); line = w; } else line = nx; } if (line) lines.push(line);
    const bh = 26 + lines.length * 14;
    pg.drawRectangle({ x: M, y: y - bh + 14, width: W - 2 * M, height: bh, color: C('#fff4e0'), borderColor: C('#fcb449'), borderWidth: 1 });
    pg.drawRectangle({ x: M, y: y - bh + 14, width: 4, height: bh, color: C('#fcb449') });
    pg.drawText(pdfSafe(`${nb} blank size${nb === 1 ? '' : 's'}`), { x: M + 16, y: y - 2, size: 11, font: bold, color: C('#7a4b00') });
    let ly = y - 18; lines.forEach(l => { pg.drawText(l, { x: M + 16, y: ly, size: 10, font, color: C('#002846') }); ly -= 14; });
    y -= bh + 14;
  }
  const notes = [
    'Given: the size each person chose. Est.: people who gave no size, shared out in the same proportions as those of the same group who did.',
    `Youth: ${UI.logScope === 'in' ? 'only those checked in now' : 'everyone registered'}. Staff: every staff member except test records.`
  ];
  notes.forEach(t => { const words = pdfSafe(t).split(' '); let line = ''; for (const w of words) { const nx = line ? line + ' ' + w : w; if (font.widthOfTextAtSize(nx, 9) > W - 2 * M - 8) { pg.drawText(line, { x: M + 4, y, size: 9, font, color: C('#4f6f84') }); y -= 13; line = w; } else line = nx; } if (line) { pg.drawText(line, { x: M + 4, y, size: 9, font, color: C('#4f6f84') }); y -= 17; } });
  y -= 10;
  pg.drawText('Ordered by: ______________________________', { x: M + 4, y, size: 10.5, font, color: C('#002846') });
  pg.drawText('Date: _______________', { x: M + 330, y, size: 10.5, font, color: C('#002846') });
  pg.drawLine({ start: { x: M, y: M + 14 }, end: { x: W - M, y: M + 14 }, thickness: 0.5, color: C('#cfe3ec') });
  pg.drawText(pdfSafe(`${sess}  -  T-shirt order`), { x: M, y: M, size: 8, font, color: C('#4f6f84') });
  const bytes = await doc.save();
  await S.dl.save({ filename: pdfSafe(`T-shirt order - ${sess}.pdf`).replace(/[\\/:*?"<>|]+/g, ''), data: new Blob([bytes], { type: 'application/pdf' }) });
  audit('settings', `Downloaded the T-shirt order (${T.t} shirts)`);
  toast(`T-shirt order ready: ${T.t} shirts`);
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
      /* the unit name, then on the right how many staff are listed and how many participants are registered there */
      const yN = S.P.filter(p => p.inc && (p.stake || '').trim() === (st === NO_STAFF_STAKE ? '' : st) && (p.unit || '').trim() === (un === NO_STAFF_UNIT ? '' : un)).length;
      const one = PLR.toLowerCase().replace(/s$/, ''), cnt = pdfSafe(`${people.length} ${people.length === 1 ? one : PLR.toLowerCase()}${st !== NO_STAFF_STAKE && un !== NO_STAFF_UNIT ? ` · ${yN} participant${yN === 1 ? '' : 's'}` : ''}`);
      pg.drawText(fit(un, bold, 11, W - 2 * M - 30 - font.widthOfTextAtSize(cnt, 9.5)), { x: M + 4, y, size: 11, font: bold, color: C('#002846') });
      pg.drawText(cnt, { x: W - M - 6 - font.widthOfTextAtSize(cnt, 9.5), y, size: 9.5, font, color: C('#007da5') });
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
  frame() { return `<section class="pagehead"><div><h1>Tally</h1><p class="note" style="margin:4px 0 0">Live counts for the session, each stake and each ward or branch. Tap a stake to see its units.</p></div><button class="btn" data-act="tallyCsv">Export CSV</button></section><div id="tK" class="kpis"></div><div class="panel"><div class="panel-head"><h2>Everyone at the session</h2></div><div id="tAll"></div><div id="orEdit"></div></div><div class="grid2"><div class="panel"><h2>By age group and gender</h2><div id="tBG"></div></div><div class="panel"><h2>By company</h2><div id="tCo"></div></div></div><div class="panel"><h2>By stake, ward and branch</h2><div id="tSt"></div></div>`; },
  update() {
    const P = S.P;
    const exp = isExpected;
    const T = { exp: P.filter(exp).length, inn: P.filter(p => p.s === 'in').length, out: P.filter(p => p.s === 'out').length, arrived: P.filter(p => exp(p) && p.s).length, wk: P.filter(p => p.src === 'walkin').length, exc: P.filter(p => !p.inc && p.s).length };
    $('#tK').innerHTML = `<div class="kpi hero"><span>Checked in now</span><b>${T.inn}</b></div><div class="kpi"><span>Expected</span><b>${T.exp}</b></div><div class="kpi"><span>Everyone, with staff</span><b>${P.filter(p => exp(p) || (p.src === 'walkin')).length + S.staffList.filter(x => !x.test).length + extraLogisticsN() + (S.config.otherRoles || []).reduce((t, o) => t + Math.max(0, +o.count || 0), 0)}</b></div><div class="kpi"><span>Arrived of expected</span><b>${T.arrived} <small class="muted">${pct(T.arrived, T.exp)}%</small></b></div><div class="kpi"><span>Not arrived</span><b>${T.exp - T.arrived}</b></div><div class="kpi"><span>Walk-ins</span><b>${T.wk}</b></div><div class="kpi"><span>From excluded list</span><b>${T.exc}</b></div><div class="kpi"><span>Checked out</span><b>${T.out}</b></div>`;
    const ST = S.staffList.filter(x => !x.test).concat(extraLogistics());
    const gc = (list, g) => list.filter(x => x.gender === g).length;
    const yp = P.filter(p => exp(p) || (p.src === 'walkin'));
    const rowsAll = [['Participants expected', P.filter(exp)], ['Walk-ins', P.filter(p => p.src === 'walkin')]].map(([l, L]) => [l, gc(L, 'F'), gc(L, 'M'), L.length])
      .concat(STAFF_ROLES.map(r => { const L = ST.filter(x => x.role === r); return [ROLE_PLURAL[r], gc(L, 'F'), gc(L, 'M'), L.length]; }));
    // other people with no role in the app (DJs, sound or PA team…): a name and a number, added to the staff total
    const others = (S.config.otherRoles || []).filter(o => o && (o.name || o.count));
    others.forEach(o => rowsAll.push([o.name || 'Other', '—', '—', Math.max(0, +o.count || 0)]));
    const otherN = others.reduce((a, o) => a + Math.max(0, +o.count || 0), 0);
    const stN = ST.length + otherN, allN = yp.length + stN;
    $('#tAll').innerHTML = `<div class="tablewrap"><table><thead><tr><th></th><th class="n">Women</th><th class="n">Men</th><th class="n">Total</th></tr></thead><tbody>${rowsAll.map(([l, f, m, t], i) => `<tr${i === 2 ? ' class="divide"' : ''}><td>${esc(l)}</td><td class="n">${f}</td><td class="n">${m}</td><td class="n"><b>${t}</b></td></tr>`).join('')}
      <tr class="subtot"><td><b>Youth</b></td><td class="n">${gc(yp, 'F')}</td><td class="n">${gc(yp, 'M')}</td><td class="n"><b>${yp.length}</b></td></tr><tr class="subtot"><td><b>Staff</b></td><td class="n">${gc(ST, 'F')}</td><td class="n">${gc(ST, 'M')}</td><td class="n"><b>${stN}</b></td></tr>
      <tr class="total"><td>Everyone</td><td class="n">${gc(yp, 'F') + gc(ST, 'F')}</td><td class="n">${gc(yp, 'M') + gc(ST, 'M')}</td><td class="n">${allN}</td></tr></tbody></table></div><p class="note">Youth expected plus walk-ins, every staff member on the Staff page (test staff left out)${otherN ? `, and ${nn(otherN, 'other person', 'other people')} in roles added below, who are in the totals but not split into women and men` : ''}. ${extraLogisticsN() ? `Logistics includes ${nn(extraLogisticsN(), 'person', 'people')} added by hand on the Logistics page, in the totals only. ` : ''}${ST.filter(x => !x.gender && !x.extra).length ? `${ST.filter(x => !x.gender && !x.extra).length} staff with no gender are only in the totals.` : ''}</p>`;
    const ed = $('#orEdit');
    if (ed && !(ed.contains(document.activeElement) && document.activeElement.tagName === 'INPUT')) {
      const list = S.config.otherRoles || [];
      ed.innerHTML = can.admin() ? `<div class="or-box"><h3>Other people at the session</h3><p class="note" style="margin:0 0 8px">For people with no role in the app, such as DJs or the sound and PA team. They count towards Staff and Everyone above.</p>
        ${list.map((o, i) => `<div class="or-row"><input class="or-name" data-i="${i}" value="${esc(o.name || '')}" placeholder="Role, e.g. Sound and PA team" aria-label="Role name" autocomplete="off"><div class="or-step"><button class="btn small" data-act="orDec" data-v="${i}" aria-label="One fewer">−</button><input class="or-count" data-i="${i}" type="number" min="0" max="500" inputmode="numeric" value="${Math.max(0, +o.count || 0)}" aria-label="How many"><button class="btn small" data-act="orInc" data-v="${i}" aria-label="One more">+</button></div><button class="btn small danger" data-act="orDel" data-v="${i}">Remove</button></div>`).join('')}
        <button class="btn small" data-act="orAdd">+ Add a role</button></div>` : (list.length ? '' : '');
    }
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
/** Short advice shown under a check. */
/* How many more counselors each gender needs so every group stays within the group size.
   Groups never mix gender or age band, so each band is counted on its own. */
function counselorGap() {
  const sh = shadowedCounselors(S.staffList), out = {};
  for (const g of ['F', 'M']) {
    const size = gsize(S.config, g), youth = S.P.filter(p => p.elig && p.gender === g);
    const need = ['Y', 'O'].reduce((a, b) => a + Math.ceil(youth.filter(p => p.band === b).length / size), 0) + Math.ceil(youth.filter(p => !p.band).length / size);
    const have = S.staffList.filter(x => x.role === 'counselor' && x.gender === g && !x.test && !sh[x.id] && !x.spare).length;
    out[g] = { size, youth: youth.length, need, have, short: Math.max(0, need - have) };
  }
  return out;
}
function gapSummary() {
  const G = counselorGap(), parts = [];
  if (G.F.short) parts.push(`${G.F.short} young women's`); if (G.M.short) parts.push(`${G.M.short} young men's`);
  if (!parts.length) return 'There are enough counselors: press Rebalance to give them groups.';
  return `Add ${parts.join(' and ')} counselor${G.F.short + G.M.short === 1 ? '' : 's'}, or raise the group size, then press Rebalance.`;
}
function gapGuide() {
  const G = counselorGap(), row = (g, l) => { const x = G[g]; return `<li><b>${l}:</b> ${x.short ? `<b class="gap-n">${nn(x.short, 'more counselor')}</b> needed` : 'enough counselors. If their groups are still over, press Rebalance'} <span class="muted">· ${x.youth} youth in groups of ${x.size} need ${nn(x.need, 'counselor')}, you have ${x.have}</span></li>`; };
  return `<div class="gap-guide"><ul>${row('F', 'Young women')}${row('M', 'Young men')}</ul><small class="muted">Counselors lead only their own gender.</small></div>`;
}
function checkHint(t) {
  if (/participants? (is|are) not in a group/.test(t)) return 'Press Rebalance to place them.';
  if (/has \d+ participants|over the group size/.test(t)) return gapSummary();
  if (/Press Rebalance/.test(t)) return '';
  if (/no counselor/.test(t)) return 'Press Rebalance, or choose a counselor inside the group.';
  if (/not in a company/.test(t)) return 'Press Rebalance, or pick a company inside the group.';
  if (/other age group/.test(t)) return 'Move the group to a company of its age group, or press Rebalance.';
  if (/mixes the 1\d/.test(t)) return 'Press Rebalance to move them to a group of their own age group.';
  if (/not the same gender|mixes young men/.test(t)) return 'Press Rebalance.';
  if (/no assistant coordinator/.test(t)) return 'Choose an AC in the company card, or press Rebalance.';
  if (/does not have both/.test(t)) return 'Press Rebalance to share groups out.';
  return '';
}
function checksList(w) {
  const lim = ['counselor', 'ac'].includes(role());
  const hint = t => { const h = lim ? '' : checkHint(t); return h ? `<small class="chk-hint">${esc(h)}</small>` : ''; };
  const link = (t, ref) => {
    if (ref && ref.g && S.org.groups[ref.g]) return `<button class="chk-link" data-act="chkGo" data-v="G${S.org.groups[ref.g].num}" data-id="${esc(ref.g)}">${esc(t)}</button>`;
    if (ref && ref.c && S.org.companies[ref.c]) return `<button class="chk-link" data-act="chkGo" data-v="Co ${S.org.companies[ref.c].num}">${esc(t)}</button>`;
    return `<span>${esc(t)}</span>`;
  };
  const chip = lv => `<span class="chip ${lv}">${lv === 'bad' ? 'Fix' : 'Check'}</span>`;
  const li = ([lv, t, ref]) => {
    if (ref && ref.p && ref.p.length) return `<li class="wgroup"><details><summary>${chip(lv)}<span>${esc(t)}${hint(t)}</span></summary><div class="flags chk-people">${ref.p.map(id => { const p = S.P.find(x => x.id === id); return p ? `<a href="#" class="chip" data-act="detail" data-id="${esc(id)}">${esc(p.name)} · ${esc(p.unit || '')}${!p.gender ? ' · no gender' : !p.band ? ' · no age' : ''}</a>` : ''; }).join('')}</div></details></li>`;
    return `<li>${chip(lv)}<span class="chk-body">${link(t, ref)}${hint(t)}</span></li>`;
  };
  const out = [], kinds = {};
  w.forEach(x => { const k = CHECK_KINDS.findIndex(([re]) => re.test(x[1])); if (k < 0) out.push(['one', x]); else { if (!kinds[k]) { kinds[k] = []; out.push(['many', k]); } kinds[k].push(x); } });
  return `<ul class="warnlist">${out.map(([t, x]) => {
    if (t === 'one') return li(x);
    const list = kinds[x]; if (list.length < 3) return list.map(li).join('');
    const lv = list.some(y => y[0] === 'bad') ? 'bad' : 'warn', head = CHECK_KINDS[x][1](list.length);
    const over = /over the group size/.test(head) && !lim;
    return `<li class="wgroup"><details><summary>${chip(lv)}<span>${esc(head)}${hint(head)}</span></summary>${over ? gapGuide() : ''}<ul class="warnlist sub">${list.map(li).join('')}</ul></details></li>`;
  }).join('')}</ul>`;
}

/* info button: a small (i) in the banner opens a short explanation card under it */
function infoBtn(key, label) { return `<button class="ibtn" type="button" data-act="info" data-v="${key}" aria-expanded="false" aria-controls="info-${key}" title="${esc(label || 'More information')}" aria-label="${esc(label || 'More information')}"><span aria-hidden="true">i</span></button>`; }
function infoCard(key, title, html) { return `<div class="infocard" id="info-${key}" hidden><button class="x log-x" data-act="info" data-v="${key}" aria-label="Close">×</button><b>${title}</b>${html}</div>`; }

/* page: companies */
PAGE_IMPL.companies = {
  frame() {
    // counselors and ACs land on their own group or company, with a counselor's group list already open
    if (!UI.coMineSet && ['counselor', 'ac'].includes(role())) { UI.coMineSet = true; UI.band = 'mine'; if (role() === 'counselor') myGroups().forEach(g => UI.open.add(g.id)); }
    const adm = can.orgEdit();
    return `<section class="pagehead"><div><h1>Companies & groups</h1><p class="note" style="margin:4px 0 0">Groups of ${gsize(S.config, 'F') === gsize(S.config, 'M') ? esc(gsize(S.config, 'F')) : `${gsize(S.config, 'F')} young women or ${gsize(S.config, 'M')} young men`} share a gender and age group, each led by a counselor of the same gender. Companies keep 14–15 and 16–18 apart and mix young men and young women.</p></div>
    <div class="btnrow">${can.lockRegen() ? (S.config.regenLock ? '<button class="btn" data-act="regenLock" data-v="off">Unlock companies</button>' : '<button class="btn" data-act="regenLock" data-v="on">Mark companies official</button>') : ''}${adm ? `<button class="btn primary" data-act="rebalance">Rebalance, keep groups</button><button class="btn" data-act="renumber" id="rnBtn">Renumber groups by company<span class="lockbadge" id="rnLock" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm2 0h6V7a3 3 0 0 0-6 0z" fill="currentColor"/></svg>Numbers locked</span></button>${S.config.regenLock ? '' : '<button class="btn" data-act="regen">Regenerate all</button>'}<button class="btn" data-act="addCo">Add company</button>` : ''}<button class="btn" data-act="rosterCsv">Export rosters</button></div></section>
    ${adm ? foldSec('co-sizes', 'Group sizes', 'coSizeN', '', '<div id="coSizes"></div>') : ''}
    <div id="coLog"></div><div class="co-top"><div class="panel"><h2>Leadership</h2><div id="coChart"></div></div><details class="panel checks" id="coChecks" ${UI.checksOpen === false ? '' : 'open'}><summary><h2>Checks</h2><span id="coWarnSum" class="checks-sum"></span></summary><div id="coWarn"></div></details></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Age group">${(SC.on ? [] : [['', 'All companies'], ['Y', '14–15'], ['O', '16–18']]).concat(['ac', 'counselor'].includes(role()) ? [['mine', 'Mine']] : []).map(([v, l]) => `<button data-act="coBand" data-v="${v}" aria-pressed="${UI.band === v}">${l}</button>`).join('')}</div><input id="coQ" class="co-q" type="search" placeholder="Find a counselor, AC, youth, group (G12) or company (Co 3)" autocomplete="off" value="${esc(UI.coQ || '')}"></div>
    <div id="coFind"></div><div id="coGrid" class="companies"></div>
    ${can.reset() ? resetPanel() : ''}`;
  },
  update() {
    const G = S.org.groups, C = S.org.companies, adm = can.orgEdit();
    { const rb = $('#rnBtn'), rl = $('#rnLock'); if (rb && rl) { rl.hidden = !S.orgLock; rb.title = S.orgLock ? `Group numbers are locked${S.orgLock.at ? ' since ' + fmtWhen(S.orgLock.at) : ''}. Rebalance keeps them; new groups take free numbers first. Renumber again to tidy the numbers.` : 'Give each company its own run of group numbers and lock them'; } }
    $('#coLog').innerHTML = (S.config.regenLock ? `<div class="callout official"><b>Companies are official.</b> ${esc(S.config.regenLock.by || 'The Session Directing Couple')} locked them on ${esc(fmtWhen(S.config.regenLock.at))}. Regenerate all and Undo all groups are switched off; use <b>Rebalance</b> for any changes.${can.lockRegen() ? ' Press <b>Unlock companies</b> to allow regenerating again.' : ' Only the registration admin or the Session Directing Couple can unlock them.'}</div>` : '') + (UI.genLog ? `<div class="log"><button class="x log-x" data-act="logClose" aria-label="Dismiss">×</button><b>${esc(UI.genLog.title)}</b><ul>${UI.genLog.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '');
    const by = r => S.staffList.filter(s => s.role === r);
    const node = (s, extra) => `<div class="node"><b>${esc(s.name)}</b>${extra || ''}</div>`;
    const acs = by('ac'), acUsed = new Set(Object.values(C).map(c => c.acId));
    // counselors without a group, and why
    const ledIds = new Set(Object.values(G).map(g => g.counselorId).filter(Boolean)), shadowC = shadowedCounselors(S.staffList);
    const memN = {}; S.P.forEach(p => { if (p.g) memN[p.g] = (memN[p.g] || 0) + 1; });
    const spare = by('counselor').filter(c => !ledIds.has(c.id)).map(c => {
      if (c.spare) return [c, 'marked spare by hand: kept in reserve, Rebalance leaves them out'];
      if (c.test) return [c, 'test record'];
      if (shadowC[c.id]) return [c, `extra record: also listed as ${ROLES[shadowC[c.id].role].toLowerCase()}. Delete this record on the Staff page`];
      if (!c.gender) return [c, 'no gender on their record, so they cannot be matched to a group. Add it on the Staff page'];
      const sizeN = gsize(S.config, c.gender); const over = Object.values(G).filter(g => g.gender === c.gender && (memN[g.id] || 0) > sizeN).length;
      if (S.config.useAll && !over) return [c, `average: there are not enough young ${c.gender === 'F' ? 'women' : 'men'} of the right age band for one more group. Press Rebalance if you just turned this on`];
      return [c, over ? `${over} ${c.gender === 'F' ? "young women's" : "young men's"} ${over === 1 ? 'group is' : 'groups are'} over ${sizeN}. Press Rebalance to give them a group` : `spare: every ${c.gender === 'F' ? "young women's" : "young men's"} group already has ${sizeN} or fewer. Available as a reserve or to swap in`];
    }).sort((a, b) => a[1].localeCompare(b[1]) || a[0].name.localeCompare(b[0].name));
    $('#coChart').innerHTML = `<div class="orgchart lead-grid"><div class="lead-col"><div class="tierlabel">Session Directing Couple</div><div class="tier">${by('sdc').map(s => node(s, `<small class="muted">${s.gender === 'F' ? 'Sister' : s.gender === 'M' ? 'Brother' : ''}</small>`)).join('') || '<span class="muted">Not added yet</span>'}</div>
</div>
      <div class="lead-col"><div class="tierlabel">Coordinators</div><div class="tier">${by('coordinator').map(s => node(s, '<small class="muted">All companies</small>')).join('') || '<span class="muted">Not added yet</span>'}</div>
</div>
      <div class="lead-col lead-wide"><div class="tierlabel">Assistant coordinators and counselors</div><div class="tier stat-tier">
        <div class="statnode"><div class="sn-top"><b>${acs.length}</b><span>assistant coordinators</span></div><ul><li><b>${acs.filter(a => acUsed.has(a.id)).length}</b> lead a company</li><li class="${acs.filter(a => !acUsed.has(a.id)).length ? 'warn' : ''}"><b>${acs.filter(a => !acUsed.has(a.id)).length}</b> spare</li></ul></div>
        <div class="statnode"><div class="sn-top"><b>${by('counselor').length}</b><span>counselors</span></div><ul><li><b>${by('counselor').length - spare.length}</b> lead a group</li><li class="${spare.length ? 'warn' : ''}"><b>${spare.length}</b> without a group${spare.length && can.orgEdit() ? ` <button class="linkbtn" data-act="spareToggle">${UI.spareOpen ? 'Hide reasons' : 'See why'}</button>` : ''}</li></ul></div></div></div>${spare.length && UI.spareOpen && can.orgEdit() ? `<div class="spare-list">${fitHint()}<p class="note" style="margin:10px 0 6px"><b>Why ${spare.length} counselor${spare.length === 1 ? ' has' : 's have'} no group</b></p><ul>${spare.map(([c, why]) => `<li><b>${esc(c.name)}</b> ${c.gender ? chipG(c.gender) : ''} · ${esc(why)}</li>`).join('')}</ul>${spare.some(x => /^spare|average/.test(x[1])) ? (S.config.useAll ? `<p class="note useall-on"><b>Every counselor gets a group</b> is on. ${spare.some(x => /^average/.test(x[1])) ? '' : 'Press <b>Rebalance, keep groups</b> to hand them out.'} <button class="linkbtn" data-act="useAll" data-v="off">Turn off</button></p>` : `<div class="useall-go"><button class="btn small primary" data-act="useAll" data-v="on">Give every counselor a group anyway</button><small class="muted">Rebalances now. Groups of that gender and age get a little smaller.</small></div>`) : ''}</div>` : ''}</div>`;
    if ($('#coSizes')) {
      $('#coSizeN').textContent = `${gsize(S.config, 'F')} young women · ${gsize(S.config, 'M')} young men`;
      if (!$('#sizeForm')) $('#coSizes').innerHTML = `<form id="sizeForm" class="form size-form"><label>Young women per group<input id="szF" type="number" min="4" max="25" value="${gsize(S.config, 'F')}"></label><label>Young men per group<input id="szM" type="number" min="4" max="25" value="${gsize(S.config, 'M')}"></label><div class="size-go"><button class="btn primary" type="submit">Save sizes</button></div></form><p class="note" style="margin:6px 0 10px">After changing sizes, press <b>Rebalance, keep groups</b>. Groups over the new size get a free counselor of the same gender; nobody already in a group under the size is moved.</p><div id="coFit"></div>`;
      $('#coFit').innerHTML = (S.config.useAll ? `<p class="note useall-on"><b>Every counselor gets a group</b> is on: groups may be smaller than the set size so no counselor is left without one. <button class="linkbtn" data-act="useAll" data-v="off">Turn off</button></p>` : '') + fitHint();
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
      <label class="chkrow" style="grid-column:1/-1"><input type="checkbox" id="wkIn" checked> Check in now</label>
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
/** Expected youth: everyone counted in this session (ticked statuses and areas), not walk-ins. The same number on every page. */
function isExpected(p) { return !!p.inc && p.src !== 'walkin'; }
PAGE_IMPL.logistics = {
  frame() { return `<section class="pagehead"><div><p class="th">Logistics${role() === 'counselor' ? ' · your group only' : role() === 'ac' ? ' · your company only' : ' · whole session'}</p><h1>Medical, dietary and T-shirts</h1><p class="note" style="margin:4px 0 0">Built from the upload, before anyone checks in. Notes such as "none", "N/A", "nil" or "fit" are left out. Tap an issue to see exactly who has it.</p></div><div class="seg" role="group" aria-label="Who to count">${[['all', 'Everyone registered'], ['in', 'Checked in now']].map(([v, l]) => `<button data-act="logScope" data-v="${v}" aria-pressed="${UI.logScope === v}">${l}</button>`).join('')}</div></section>
  <div id="lgK" class="kpis"></div>
  ${foldSec('sec-med', 'Medical', 'lgMedN', '<button class="btn small" data-act="lgCsv" data-v="med">Export CSV</button>', '<div id="lgMed"></div>')}
  ${foldSec('sec-diet', 'Dietary', 'lgDietN', '<button class="btn small" data-act="lgCsv" data-v="diet">Export CSV</button>', '<div id="lgDiet"></div>')}
  ${foldSec('sec-tee', 'T-shirts', 'lgTeeN', '<button class="btn small" data-act="lgCsv" data-v="size">Export order</button><button class="btn small" data-act="lgCsv" data-v="blank">Export blanks</button>', '<div id="lgSize"></div>')}
  ${['counselor', 'ac'].includes(role()) ? '' : foldSec('sec-steee', 'Staff T-shirts', 'lgStN', '<button class="btn small" data-act="lgCsv" data-v="staffsize">Export staff and full order</button>', '<div id="lgStaffSize"></div>')}
  ${['counselor', 'ac'].includes(role()) ? '' : foldSec('sec-strole', 'T-shirt sizes by role', 'lgSrN', `${can.teeEdit() ? '<button class="btn small" data-act="xlEdit">+ Logistics people</button>' : ''}<button class="btn small" data-act="teeRolePdf">${ICONS.print} Download order by role (PDF)</button>`, '<div id="lgStaffRole"></div>')}`; },
  scope() { const mine = role() === 'counselor' ? new Set(myGroups().map(g => g.id)) : null; return (UI.logScope === 'in' ? S.P.filter(p => p.s === 'in') : registered()).filter(p => seesPrivate(p) && (!mine || (p.g && mine.has(p.g)))); },
  update() {
    const L = this.scope(), H = lgHash();
    const med = L.filter(p => p.medIssue), diet = L.filter(p => p.dietIssue), blanks = L.filter(p => !p.tshirt);
    const href = h => '#' + h;
    const kb = (v, cls, l, n) => `<button class="kpi kpi-btn ${cls}" data-act="lgGo" data-v="${v}"><span>${l}</span><b>${n}</b><small>Show list ›</small></button>`;
    const lWk = L.filter(p => p.src === 'walkin').length;
    $('#lgK').innerHTML = `<div class="kpi"><span>${UI.logScope === 'in' ? 'Checked in' : 'Expected'}${['counselor', 'ac'].includes(role()) ? ' (yours)' : ''}</span><b>${L.length - lWk}</b>${lWk ? `<small>+ ${nn(lWk, 'walk-in')} · ${L.length} in all</small>` : ''}</div>` + kb('med', 'hero', 'Medical needs', med.length) + kb('diet', 'hero', 'Dietary needs', diet.length) + kb('tee', '', 'Sizes given', L.length - blanks.length) + kb('blank', '', 'Blank sizes', blanks.length) + ($('#sec-steee') ? kb('steee', '', 'Staff T-shirts', S.staffList.filter(x => !x.test).length) : '');
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
    if ($('#lgStaffRole')) { $('#lgStaffRole').innerHTML = staffRoleBlock(); const n = $('#lgSrN'); if (n) n.textContent = nn(teeRoleRows().rows.length, 'row'); }
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
/* logistics people added by hand (not on the staff list): counted in the T-shirt order, the Staff page and the Tally */
function extraLogistics() {
  const E = S.teeExtra || {}, out = [];
  Object.keys(E).forEach(z => { const n = Math.max(0, parseInt(E[z], 10) || 0); for (let i = 0; i < n; i++) out.push({ id: 'xlog:' + z + ':' + i, name: 'Logistics (added by hand)', role: 'logistics', gender: '', tshirt: z === 'none' ? '' : z, extra: true }); });
  return out;
}
function extraLogisticsN() { return extraLogistics().length; }
function openExtraLogistics() {
  const E = S.teeExtra || {};
  openModal(`<div class="modal-head"><h2>Logistics people added by hand</h2><button class="x" data-act="close" aria-label="Close">×</button></div>
    <p class="note" style="margin-top:-6px">For logistics helpers who are not on the staff list. They count in the T-shirt order, the Logistics number on the Staff page and the Tally totals. Enter how many need each size.</p>
    <div class="xl-grid">${SIZE_ORDER.map(z => `<label>${esc(SIZE_LABEL[z] || z)}<input type="number" min="0" inputmode="numeric" class="xl-in" data-z="${z}" value="${+(E[z] || 0)}"></label>`).join('')}<label>No size yet<input type="number" min="0" inputmode="numeric" class="xl-in" data-z="none" value="${+(E.none || 0)}"></label></div>
    <p class="xl-tot" id="xlTot"></p>
    <div class="btnrow" style="justify-content:flex-end"><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="xlSave">Save</button></div>`);
  xlTotal();
}
function xlTotal() { const t = [...document.querySelectorAll('.xl-in')].reduce((a, i) => a + Math.max(0, parseInt(i.value, 10) || 0), 0); const el = $('#xlTot'); if (el) el.innerHTML = `<b>${nn(t, 'person', 'people')}</b> added by hand`; }
async function saveExtraLogistics() {
  const E = {}; document.querySelectorAll('.xl-in').forEach(i => { const v = Math.max(0, parseInt(i.value, 10) || 0); if (v) E[i.dataset.z] = v; });
  const n = Object.values(E).reduce((a, b) => a + b, 0), doc = Object.assign({}, S.teeDoc || {}, { extra: E });
  try { await setDoc('config/tee', doc); } catch (e) { fail(e); return; }
  S.teeExtra = E; audit('staff', `Set logistics people added by hand to ${n}`); closeModal(); recompute(true); toast(n ? `${nn(n, 'logistics person', 'logistics people')} added by hand` : 'No logistics people added by hand');
}
function staffTee() {
  const ST = S.staffList.filter(x => !x.test).concat(extraLogistics());
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
/* staff T-shirt sizes for each role: the sizes people gave, plus blanks estimated the same way as the staff order */
/* each staff member's size for the order: their own, or the estimate (or the custom split) for blanks */
function staffSizesFinal() {
  const { ST, perPerson: sug } = staffTee();
  /* with a custom split of staff blanks, hand those sizes out in the same order as the suggestion (smallest suggested size first) */
  const perPerson = Object.assign({}, sug), B = teeBlanks(UI.teeL || S.P.filter(p => p.inc || p.s));
  if (B.custom && B.custom.s) { const blanks = ST.filter(x => !x.tshirt).sort((a, b) => sizeRank(sug[a.id]) - sizeRank(sug[b.id]) || a.name.localeCompare(b.name)), bag = [];
    SIZE_ORDER.forEach(z => { for (let i = 0; i < (+B.custom.s[z] || 0); i++) bag.push(z); }); blanks.forEach((x, i) => { if (bag[i]) perPerson[x.id] = bag[i]; }); }
  return { ST, perPerson, B };
}
/* the vendor order by role: participants first, then each staff role; each cell is [chosen, estimated] */
function teeRoleRows() {
  const L = UI.teeL || S.P.filter(p => p.inc || p.s), { ST, perPerson, B } = staffSizesFinal(), rows = [];
  const yc = {}; SIZE_ORDER.forEach(z => { const t = B.R.totals[z]; yc[z] = [t ? t.given : 0, +(B.use.y[z] || 0)]; });
  rows.push({ label: 'Participants', c: yc });
  STAFF_ROLES.forEach(r => { const list = ST.filter(x => x.role === r); if (!list.length) return; const c = {}; SIZE_ORDER.forEach(z => { c[z] = [list.filter(x => x.tshirt === z).length, list.filter(x => !x.tshirt && perPerson[x.id] === z).length]; }); rows.push({ label: ROLE_PLURAL[r] || ROLES[r], c }); });
  const sizes = SIZE_ORDER.filter(z => rows.some(r => r.c[z][0] + r.c[z][1]));
  rows.forEach(r => { r.t = sizes.reduce((a, z) => a + r.c[z][0] + r.c[z][1], 0); r.e = sizes.reduce((a, z) => a + r.c[z][1], 0); });
  return { rows, sizes };
}
async function printTeeByRole() {
  const { rows, sizes } = teeRoleRows(); if (!sizes.length) { toast('There are no T-shirt sizes to print yet.', true); return; }
  toast('Preparing the order…');
  let Lb; try { Lb = await loadPdfLib(); } catch (e) { toast('Could not load the PDF tool. Check your connection and try again.', true); return; }
  const { PDFDocument, StandardFonts, rgb, degrees } = Lb;
  const C = h => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
  const doc = await PDFDocument.create();
  const sess = (!S.config.sessionName || S.config.sessionName === 'FSY Kenya 2') ? 'FSY Kenya 2nd 2026' : S.config.sessionName;
  doc.setTitle(pdfSafe(`${sess} T-shirt order by role`)); doc.setAuthor(pdfSafe(sess)); doc.setCreator('FSY Check-in');
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let logo = null; try { logo = await doc.embedPng(await logoPngBytes()); } catch (e) { }
  const W = 595.28, H = 841.89, M = 36, ROW = 34, pg = doc.addPage([W, H]), top = H - M, bandH = 84;
  const printed = new Date().toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const grand = rows.reduce((a, r) => a + r.t, 0), est = rows.reduce((a, r) => a + r.e, 0);
  pg.drawRectangle({ x: M, y: top - bandH, width: W - 2 * M, height: bandH, color: C('#f6faf4') });
  pg.drawRectangle({ x: M, y: top - bandH - 4, width: W - 2 * M, height: 4, color: C('#fcb449') });
  let tx = M + 16; if (logo) { const sz = 62; pg.drawImage(logo, { x: M + 10, y: top - bandH + (bandH - sz) / 2, width: sz, height: sz }); tx = M + 84; }
  pg.drawText(pdfSafe(`${sess.toUpperCase()}  -  T-SHIRT ORDER`), { x: tx, y: top - 22, size: 8, font: bold, color: C('#007da5') });
  pg.drawText('T-shirt sizes by role', { x: tx, y: top - 46, size: 19, font: bold, color: C('#002846') });
  pg.drawText(pdfSafe(`Participants (${UI.logScope === 'in' ? 'checked in now' : 'everyone registered'}) and staff`), { x: tx, y: top - 64, size: 11.5, font, color: C('#005175') });
  const rt = `${grand} T-shirts`; pg.drawText(rt, { x: W - M - 14 - bold.widthOfTextAtSize(rt, 13), y: top - 46, size: 13, font: bold, color: C('#002846') });
  const pr = pdfSafe('Printed ' + printed); pg.drawText(pr, { x: W - M - 14 - font.widthOfTextAtSize(pr, 8), y: top - 62, size: 8, font, color: C('#4f6f84') });
  const roleW = 160, totW = 62, colW = (W - 2 * M - roleW - totW) / sizes.length;
  const right = (t, x, y, f, sz, col) => pg.drawText(String(t), { x: x - f.widthOfTextAtSize(String(t), sz), y, size: sz, font: f, color: C(col || '#002846') });
  const cx = i => M + roleW + colW * (i + 1) - 8, tX = W - M - 10;
  let y = top - bandH - 32;
  pg.drawRectangle({ x: M, y: y - 9, width: W - 2 * M, height: 26, color: C('#005175') });
  pg.drawText('ROLE', { x: M + 10, y, size: 9, font: bold, color: C('#ffffff') });
  sizes.forEach((z, i) => right(z, cx(i), y, bold, 9.5, '#ffffff')); right('TOTAL', tX, y, bold, 9, '#ffffff');
  y -= ROW;
  const drawRow = (label, vals, tot, shade, strong, colour) => {
    if (shade) pg.drawRectangle({ x: M, y: y - 11, width: W - 2 * M, height: ROW, color: C(shade) });
    pg.drawLine({ start: { x: M, y: y - 11 }, end: { x: W - M, y: y - 11 }, thickness: 0.5, color: C('#d2e5ee') });
    pg.drawText(pdfSafe(label), { x: M + 10, y: colour ? y + 4 : y, size: strong ? 12 : 11, font: bold, color: C('#002846') });
    if (colour) pg.drawText('Colour: ____________', { x: M + 10, y: y - 7, size: 7.5, font, color: C('#4f6f84') });
    vals.forEach((v, i) => right(v || '-', cx(i), y, v ? (strong ? bold : font) : font, strong ? 12 : 11.5, v ? '#002846' : '#9fb3c0'));
    right(tot, tX, y, bold, strong ? 13.5 : 12);
    y -= ROW;
  };
  rows.forEach((r, k) => drawRow(r.label, sizes.map(z => r.c[z][0] + r.c[z][1]), r.t, k % 2 ? '#f6faf4' : null, false, true));
  drawRow('Total to order', sizes.map(z => rows.reduce((a, r) => a + r.c[z][0] + r.c[z][1], 0)), grand, '#e8f3f8', true);
  y -= 16;
  const para = (t, sz, col, f) => { let line = ''; for (const w of pdfSafe(t).split(' ')) { const nx = line ? line + ' ' + w : w; if ((f || font).widthOfTextAtSize(nx, sz) > W - 2 * M - 8) { pg.drawText(line, { x: M + 4, y, size: sz, font: f || font, color: C(col) }); y -= sz + 4; line = w; } else line = nx; } if (line) { pg.drawText(line, { x: M + 4, y, size: sz, font: f || font, color: C(col) }); y -= sz + 8; } };
  if (est) para(`${est} of these are for people who gave no size; their sizes were ${teeBlanks(UI.teeL || S.P.filter(p => p.inc || p.s)).custom ? 'split by hand' : 'estimated from others in the same group'}.`, 9.5, '#4f6f84');
  para('Each row is a separate order line, one shirt colour per role. Write the colour under each role.', 9.5, '#002846');
  para('Sizes: XS extra small, S small, M medium, L large, XL extra large, XXL 2X large, 3XL 3X large. Test staff are not included.', 9, '#4f6f84');
  y -= 10;
  pg.drawText('Ordered by: ______________________________', { x: M + 4, y, size: 10.5, font, color: C('#002846') });
  pg.drawText('Date: _______________', { x: M + 330, y, size: 10.5, font, color: C('#002846') });
  pg.drawLine({ start: { x: M, y: M + 14 }, end: { x: W - M, y: M + 14 }, thickness: 0.5, color: C('#cfe3ec') });
  pg.drawText(pdfSafe(`${sess}  -  T-shirt order by role`), { x: M, y: M, size: 8, font, color: C('#4f6f84') });
  const bytes = await doc.save();
  await S.dl.save({ filename: pdfSafe(`T-shirt order by role - ${sess}.pdf`).replace(/[\\/:*?"<>|]+/g, ''), data: new Blob([bytes], { type: 'application/pdf' }) });
  audit('settings', `Downloaded the T-shirt order by role (${grand} shirts)`); toast(`Order by role ready: ${grand} shirts`);
}
function staffRoleBlock() {
  const { rows, sizes } = teeRoleRows();
  if (!sizes.length) return '<p class="note">Sizes appear here once participants or staff have T-shirt sizes.</p>';
  const cell = v => `<td class="n">${v[0] + v[1] ? `<b>${v[0] + v[1]}</b>${v[1] ? ` <small class="est">(+${v[1]})</small>` : ''}` : '<span class="muted">–</span>'}</td>`;
  const sumRow = list => { const c = {}; sizes.forEach(z => { c[z] = [list.reduce((a, r) => a + r.c[z][0], 0), list.reduce((a, r) => a + r.c[z][1], 0)]; }); return { c, t: list.reduce((a, r) => a + r.t, 0) }; };
  const tr = (label, r, cls) => `<tr${cls ? ` class="${cls}"` : ''}><td><b>${esc(label)}</b></td>${sizes.map(z => cell(r.c[z])).join('')}<td class="n"><b>${r.t}</b></td></tr>`;
  const staff = rows.slice(1);
  return `<div class="tablewrap"><table><thead><tr><th>Role</th>${sizes.map(z => `<th class="n">${esc(SIZE_LABEL[z] || z)}</th>`).join('')}<th class="n">Total</th></tr></thead><tbody>
    ${rows.map(r => tr(r.label, r)).join('')}${tr('Total to order', sumRow(rows), 'total')}</tbody></table></div>
    <p class="note">Each role is its own line, so each can be ordered in its own colour. Numbers include people whose size was estimated, shown in brackets, for example <b>12</b> (+2). The totals match the full order above, including any custom split of blanks. Participants follow the choice at the top of the page; test staff are left out.</p>`;
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
  const blanks = ST.filter(x => !x.tshirt && !x.extra), xb = ST.filter(x => !x.tshirt && x.extra).length, xn = ST.filter(x => x.extra).length;
  h += `<p class="note">${xn ? `Includes ${nn(xn, 'logistics person', 'logistics people')} added by hand${xb ? `, ${xb} with no size yet` : ''}. ` : ''}${blanks.length ? `${blanks.length} staff gave no size (${blanks.slice(0, 6).map(x => esc(x.name)).join(', ')}${blanks.length > 6 ? ' and ' + (blanks.length - 6) + ' more' : ''}). Each blank is estimated from staff of the same gender who did give a size.` : 'Every staff member gave a size.'} Test staff are left out.</p>`;
  UI.teeL = L;
  const B = teeBlanks(L), rows = teeOrderRows(L), edit = can.teeEdit();
  h += `<div class="tee-order-head"><p class="th" style="margin:18px 0 6px">Full order: youth and staff${B.custom ? ' <span class="chip info">Custom split of blanks</span>' : ''}</p><div class="btnrow">${edit && (B.n.y + B.n.s) ? `<button class="btn small" data-act="teeEdit">Edit blank sizes</button>` : ''}<button class="btn small" data-act="teePdf">${ICONS.print} Download order (PDF)</button></div></div><div class="tablewrap"><table><thead><tr><th>Size</th><th class="n">Youth</th><th class="n">Staff</th><th class="n">Total to order</th></tr></thead><tbody>`;
  let ty = 0, ts = 0;
  for (const r of rows) { ty += r.y; ts += r.st; h += `<tr><td><b>${esc(r.label)}</b></td><td class="n">${r.y}</td><td class="n">${r.st}</td><td class="n"><b>${r.t}</b></td></tr>`; }
  h += `<tr class="total"><td>All</td><td class="n">${ty}</td><td class="n">${ts}</td><td class="n">${ty + ts}</td></tr></tbody></table></div>`;
  if (B.n.y + B.n.s) h += `<div class="tee-blank"><b>${nn(B.n.y + B.n.s, 'blank size')}</b> (${B.n.y} youth, ${B.n.s} staff) ${B.n.y + B.n.s === 1 ? 'is' : 'are'} included above, ${B.custom ? `split by hand${B.custom.by ? ' by ' + esc(B.custom.by) : ''}${B.custom.at ? ' on ' + esc(fmtWhen(B.custom.at)) : ''}.` : 'shared out like everyone who gave a size.'}${B.stale ? ' <b>The custom split no longer adds up</b> because the number of blanks changed, so the suggestion is used. Edit it again.' : ''}${edit ? (B.custom ? ' <button class="linkbtn" data-act="teeEdit">Edit</button>' : ' <button class="linkbtn" data-act="teeEdit">Split them yourself</button>') : ''}</div>`;
  h += `<p class="note">Youth follow the "${UI.logScope === 'in' ? 'Checked in now' : 'Everyone registered'}" choice at the top of the page.</p>`;
  return h;
}

/** Optional email alert for access requests: set NOTIFY_URL in config.js to a Google Apps Script web app (see notify.gs). */
function notifyRequest(note) {
  const url = typeof NOTIFY_URL !== 'undefined' ? NOTIFY_URL : (window.NOTIFY_URL || '');
  if (!url) return;
  const body = JSON.stringify({ type: 'access-request', name: S.meName || '', email: S.email || '', note: String(note || '').slice(0, 200), session: sessName(S.sid), site: location.origin + location.pathname, at: new Date().toISOString() });
  fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body }).catch(() => { });
}

/** Email the person when they are given access (needs NOTIFY_URL and the updated notify.gs).
    The signed-in admin's token goes along, so the script can check the account really exists before sending. */
async function notifyGranted(email, name, role) {
  const url = typeof NOTIFY_URL !== 'undefined' ? NOTIFY_URL : (window.NOTIFY_URL || '');
  if (!url || !email) return false;
  try {
    const token = await FB.auth.currentUser.getIdToken();
    const body = JSON.stringify({ type: 'access-granted', email: emailKey(email), name: name || '', role: ROLES[role] || role, session: sessName(S.sid), site: location.origin + location.pathname, by: S.meName || '', token });
    await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body });
    return true;
  } catch (e) { console.warn('notify', e); return false; }
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
function foldSec(id, title, countId, tools, body, sub) { return `<details class="panel fold" id="${id}" ${foldOpen(id) ? 'open' : ''}><summary><h2>${title}</h2><span class="chip" id="${countId}"></span>${sub ? `<p class="note fold-sub">${sub}</p>` : ''}</summary><div class="fold-body">${tools ? `<div class="fold-tools">${tools}</div>` : ''}${body}</div></details>`; }
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
    return `<section class="pagehead"><div><p class="th">Staff</p><h1>Counselors and leaders</h1><p class="note">Import the staff sign-up form or add people one at a time.</p></div><div class="btnrow">${can.lockStaff() ? '<button class="btn" data-act="stLock" id="stLockBtn">Close addition of staff</button>' : ''}${can.staff() ? '<button class="btn adm st-add" data-act="sfPick">Import staff</button>' : ''}<button class="btn primary adm st-add" data-act="stAdd">+ Add staff member</button>${can.staff() ? infoBtn('sf', 'About importing staff') : ''}</div></section>
    <div id="stLockNote"></div>
    ${can.staff() ? infoCard('sf', 'Importing staff', `<ul><li>Pick an Excel or .csv file, such as the Google Form responses for counselors, ACs and coordinators.</li><li>A <b>Type</b> column (AC, Counselor or Coordinator) sets each person's role.</li><li>Blank rows are skipped and people who sent the form more than once are merged.</li><li>Each ward or branch is matched to its stake or district. You confirm any it can't place.</li><li>Import again any time: people already on the list are updated, not added twice.</li></ul>`) : ''}
    ${can.staff() ? `<input type="file" id="sfFile" class="vh" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"><section class="panel adm" id="sfPanel" hidden><div class="panel-head"><h2>Import staff</h2><label class="btn small" for="sfFile">Choose another file</label></div>
      <div id="sfBox"></div></section>` : ''}
    <div id="stK" class="kpis"></div>
    <section class="panel"><div class="panel-head"><h2>By stake and unit</h2><button class="btn small" data-act="stCsv">Export CSV</button></div><div id="stTally"></div></section>
    <section class="panel"><div class="panel-head"><h2>Staff list</h2><div class="btnrow"><button class="btn small fold-btn" data-act="stFold" id="stFoldBtn" aria-expanded="true" aria-controls="stList">Hide table</button><button class="btn small primary adm st-add" data-act="stAdd">+ Add</button></div></div><input id="stQ" type="search" placeholder="Search staff by name, phone, email, ward or stake" autocomplete="off" value="${esc(UI.stQ || '')}" style="width:100%;margin-bottom:10px"><div class="segscroll" style="margin-bottom:10px"><div class="chips" id="stTabs"></div></div><div id="stView" class="stview"></div><div id="stList"></div></section>
    <details class="panel adm"><summary><h2 style="display:inline">Test staff</h2></summary><p class="note">No counselors yet? Generate clearly marked test counselors, ACs, coordinators and a Session Directing Couple to try the company generator. Delete them when the real list is in, then press Rebalance or Regenerate.</p>
      <div class="inline"><label class="inline">ACs to create <input id="tsAcs" type="number" min="1" max="40" value="${Math.max(2, Math.round(S.P.filter(p => p.elig).length / 100))}" style="width:80px"></label><button class="btn" data-act="testGen">Generate test staff</button><button class="btn danger" data-act="testDel">Delete test staff</button></div></details>
    ${can.reset() ? resetPanel() : ''}`;
  },
  update() {
    { const L = S.config.staffLock, lb = $('#stLockBtn'), note = $('#stLockNote');
      if (lb) { lb.textContent = L ? 'Open addition of staff' : 'Close addition of staff'; lb.classList.toggle('danger', !L); }
      if (note) note.innerHTML = ''; }
    const cnt = r => S.staffList.filter(s => s.role === r).length;
    const PL = ROLE_PLURAL;
    $('#stK').innerHTML = STAFF_ROLES.map(r => { const x = r === 'logistics' ? extraLogisticsN() : 0; return `<div class="kpi"><span>${PL[r]}</span><b>${cnt(r) + x}</b>${x ? `<small class="muted">${x} added by hand</small>` : ''}</div>`; }).join('');
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
    const isC = UI.staffTab === 'counselor', ncol = isC ? 6 : 5;
    const shadowS = shadowedCounselors(S.staffList);
    const linkedIds = new Set(Object.values(S.invites || {}).map(v => v && v.staffId).filter(Boolean));
    const DAY = 86400000, newest = UI.staffView === 'new';
    const addedTxt = s => s.addedAt ? `Added ${fmtWhen(s.addedAt)}${s.addedBy ? ' by ' + s.addedBy : ''}` : '';
    const row = s => { const a = staffAge(s, S.config); return `<tr><td><a href="#" data-act="stEdit" data-id="${esc(s.id)}"><b>${esc(s.name)}</b></a> ${s.addedAt && Date.now() - s.addedAt < DAY ? `<span class="chip good" title="${esc(addedTxt(s))}">New</span>` : ''}${s.test ? '<span class="chip info">Test</span>' : ''}${s.spare ? '<span class="chip warn" title="Kept in reserve: Rebalance leaves them out">Spare</span>' : ''}${s.fromAccount ? '<span class="chip">From Accounts</span>' : ''}${shadowS[s.id] ? ` <span class="chip bad" title="The same person has two staff records">Also listed as ${esc(ROLES[shadowS[s.id].role].toLowerCase())}: delete this record</span>` : ''}<br><small class="muted">${byArea ? '' : esc([s.unit, s.stake].filter(Boolean).join(' · ') || 'No unit given') + (s.phone ? ' · ' : '')}${s.phone ? esc(s.phone) : ''}${s.email ? ' · ' + esc(s.email) : ''}${newest && s.addedAt ? '<br>' + esc(addedTxt(s)) : ''}</small>${linkedIds.has(s.id) ? ' <span class="chip good">Account linked</span>' : ''}${s.diet ? `<br><span class="chip warn" title="Food needs">Food: ${esc(s.diet)}</span>` : ''}</td><td>${chipG(s.gender)}</td><td class="n">${a ?? '—'}</td>${isC ? `<td class="bf">${a == null ? '<span class="muted">Unknown age</span>' : a >= 23 ? '16–18' : a >= 19 ? '14–15' : '<span class="chip warn">Under 19</span>'}</td>` : ''}<td>${where(s)}</td><td class="st-act"><select data-act="stRole" data-id="${esc(s.id)}" aria-label="Role"${s.fromAccount ? ' disabled title="Change the role under Accounts"' : ''}>${STAFF_ROLES.map(r => opt(r, ROLES[r], r === s.role)).join('')}</select>${['counselor', 'ac'].includes(s.role) ? `<button class="btn small adm st-spare" data-act="stSpare" data-id="${esc(s.id)}">${s.spare ? 'Not spare' : 'Mark spare'}</button>` : ''}<button class="btn small danger adm st-del" data-act="stDel" data-id="${esc(s.id)}">Delete</button></td></tr>`; };
    /* participants registered in the same stake or unit, to compare with the staff listed there */
    const yc = {}; S.P.forEach(p => { if (!p.inc) return; const a = (p.stake || '').trim(), b = (p.unit || '').trim(); yc[a] = (yc[a] || 0) + 1; yc[a + '|' + b] = (yc[a + '|' + b] || 0) + 1; });
    const youthNote = (st, un, n) => { if (st === NO_STAFF_STAKE || un === NO_STAFF_UNIT) return ''; const y = yc[un == null ? st : st + '|' + un] || 0; return ` <span class="yc" title="Participants registered in this ${un == null ? 'stake or district' : 'ward or branch'}">(${nn(y, 'participant')}${isC && y && n ? ` · ${Math.round(y / n * 10) / 10} per counselor` : ''})</span>`; };
    let body = '';
    if (byArea) {
      const T = staffByArea(list);
      for (const st of Object.keys(T).sort(areaSort)) {
        const units = T[st], n = Object.values(units).reduce((a, l) => a + l.length, 0);
        body += `<tr class="st-h"><td colspan="${ncol}"><b>${esc(st)}</b> <span class="muted">· ${n}</span>${youthNote(st, null, n)} <button class="btn small" data-act="stPdf" data-v="${esc(st)}">Print</button></td></tr>`;
        for (const un of Object.keys(units).sort(areaSort)) body += `<tr class="un-h"><td colspan="${ncol}">${esc(un)} <span class="muted">· ${units[un].length}</span>${youthNote(st, un, units[un].length)}</td></tr>` + units[un].map(row).join('');
      }
    } else body = (newest ? list.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || a.name.localeCompare(b.name)) : list).map(row).join('');
    const withT = list.filter(x => x.addedAt).sort((a, b) => b.addedAt - a.addedAt), recent = withT.filter(x => Date.now() - x.addedAt < DAY);
    const latestLine = withT.length ? `<p class="note st-latest">Latest ${esc((ROLES[UI.staffTab] || '').toLowerCase())} added: <b>${esc(withT[0].name)}</b> · ${esc(fmtWhen(withT[0].addedAt))}${withT[0].addedBy ? ' by ' + esc(withT[0].addedBy) : ''}${recent.length > 1 ? ` · <b>${recent.length}</b> added in the last 24 hours` : ''}${newest ? '' : ' · <a href="#" data-act="stView" data-v="new">See newest first</a>'}</p>` : '';
    const stFolded = !!UI.stFold && !clean(UI.stQ || '');
    { const L = $('#stList'), fb = $('#stFoldBtn'), fold = stFolded; L.classList.toggle('st-folded', fold); if (fb) { fb.textContent = fold ? 'Show table' : 'Hide table'; fb.setAttribute('aria-expanded', String(!fold)); } }
    $('#stList').innerHTML = latestLine + (list.length ? `<div class="tablewrap"${stFolded ? ' hidden style="display:none"' : ''}><table><thead><tr><th>Name</th><th>Gender</th><th class="n">Age</th>${isC ? '<th class="bf">Best fit</th>' : ''}<th>Assigned</th><th>Role</th></tr></thead><tbody>${body}</tbody></table></div>` : sq ? `<div class="empty"><h3>No staff match "${esc(UI.stQ)}"</h3></div>` : `<div class="empty"><h3>No ${esc(ROLES[UI.staffTab].toLowerCase())}s yet</h3><button class="btn primary" data-act="stAdd">+ Add staff member</button></div>`);
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
  const box = $('#sfBox'); if (!box) return; const F = UI.sf; const pnl = $('#sfPanel');
  if (pnl) { const was = pnl.hidden; pnl.hidden = !F; if (was && F && !F.done) pnl.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  if (!F) { box.innerHTML = ''; return; }
  if (F.done) { box.innerHTML = `<div class="log"><button class="x log-x" data-act="sfCancel" aria-label="Dismiss">×</button>${F.done}</div>`; return; }
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
    <div class="kpis sf-k"><div class="kpi"><span>Responses</span><b>${R.subs}</b></div><div class="kpi"><span>People</span><b>${R.people.length}</b></div><div class="kpi"><span>Duplicates merged</span><b>${merged}</b></div><div class="kpi"><span>Already on staff list</span><b>${upd8}</b></div></div>${recs.some(r => r.keptRole) ? `<p class="note"><b>${nn(recs.filter(r => r.keptRole).length, 'person keeps', 'people keep')} their current role</b> (AC, coordinator or other) because this file doesn't give them a different one in a Type column.</p>` : ''}
    ${F.role === 'column' ? `<p class="note"><b>By type:</b> ${['counselor', 'ac', 'coordinator'].map(r => { const n = recs.filter(x => x.role === r).length, w = ROLES[r].toLowerCase(); return `${n} ${esc(n === 1 ? w : w + 's')}`; }).join(', ')}${R.people.filter(p => !p.role).length ? ` · <span class="chip warn">${R.people.filter(p => !p.role).length} with no type, imported as counselors</span>` : ''}</p>` : ''}
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
    const s = {}; recs.forEach(r => { const x = Object.assign({}, r); delete x.isUpdate; delete x.keptRole; s[x.id] = x; });
    S.staff = Object.assign({}, S.staff, s); const ex = S.staffEx; S.staffEx = true;
    await upd('staff/all', { s, cols: { headers: F.rows[0].map(h => String(h == null ? '' : h)), map: Object.fromEntries(Object.entries(F.map).map(([k, v]) => [String(k), v])) } }, ex);
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
/* official stakes and their wards (from the participant upload), plus places already used on staff records */
function stAreas() {
  const units = {}; const add = (st, un) => { if (!st) return; (units[st] = units[st] || new Set()); if (un) units[st].add(un); };
  sfKnownUnits().forEach(([st, un]) => add(st, un)); S.staffList.forEach(x => add(x.stake, x.unit));
  const out = { stakes: Object.keys(units).sort((a, b) => a.localeCompare(b)), units: {} };
  for (const k in units) out.units[k] = [...units[k]].sort((a, b) => a.localeCompare(b)); return out;
}
function stUnitOpts(stake, sel) {
  if (stake === '__other') return opt('__other', '+ Other ward or branch…', true);
  const list = stake ? stAreas().units[stake] || [] : [];
  return opt('', stake ? 'Choose…' : 'Choose the stake first', !sel) + list.map(x => opt(x, x, x === sel)).join('') + (stake ? opt('__other', '+ Other ward or branch…', sel === '__other') : '');
}
function stAgeText(bday, age) {
  const a = bday ? ageOn(bday, S.config.sessionStart || '') : age;
  if (a == null || isNaN(a)) return bday ? '' : 'Age is worked out from the birthdate';
  return `${bday ? 'Age' : 'Age from the sign-up form'}: <b>${a}</b>${S.config.sessionStart ? ' at the session' : ''}${a < 19 ? ' · under 19, check the date' : ''}`;
}
function stAreaSync(changed) {
  const ss = $('#stStakeSel'), us = $('#stUnitSel'), sn = $('#stStakeNew'), un = $('#stUnitNew'); if (!ss || !us) return;
  const otherStake = ss.value === '__other';
  if (changed === 'stake') { us.innerHTML = stUnitOpts(ss.value, otherStake ? '__other' : ''); if (un) un.value = ''; }
  sn.hidden = !otherStake; un.hidden = !(otherStake || us.value === '__other');
  const nt = $('#stOtherNote'); if (nt) nt.hidden = sn.hidden && un.hidden;
  if (changed === 'stake' && otherStake) sn.focus(); else if (changed === 'unit' && !un.hidden) un.focus();
}
/* shown only when someone who may not add staff presses Add or Import while adding is closed */
function staffClosedNotice() {
  const L = S.config.staffLock || {};
  openModal(`<div class="modal-head"><h2>Adding staff is closed</h2><button class="x" data-act="close" aria-label="Close">×</button></div>
    <p>${esc(L.by || 'The Session Directing Couple')} closed it${L.at ? ' on ' + esc(fmtWhen(L.at)) : ''}. Only the registration admin, the Session Directing Couple, the Area Seventy and the Head of Logistics can add staff, import the staff form or make someone a counselor.</p>
    <p class="note">You can still edit and delete existing records. To add someone, ask the Session Directing Couple or the registration admin.</p>
    <div class="btnrow" style="justify-content:flex-end"><button class="btn primary" data-act="close">OK</button></div>`);
}
function openStaffForm(id) {
  const s = id ? S.staffMap[id] : null;
  const A = stAreas(), stk = s ? s.stake || '' : '', unt = s ? s.unit || '' : '';
  const stOther = !!stk && !A.stakes.includes(stk), unOther = !!unt && !(A.units[stk] || []).includes(unt);
  const age = s ? staffAge(s, S.config) : null;
  openModal(`<div class="modal-head"><h2>${s ? 'Edit ' + esc(s.name) : 'Add a staff member'}</h2><button class="x" data-act="close" aria-label="Close">×</button></div>
  <form id="stForm" class="form" data-id="${s ? esc(s.id) : ''}">
    <label class="span2">Full name<input id="stName" required value="${esc(s ? s.name : '')}" autocomplete="off"></label>
    <label>Role<select id="stRole">${STAFF_ROLES.map(r => opt(r, ROLES[r], r === (s ? s.role : UI.staffTab))).join('')}</select></label>
    <label>Gender<select id="stGender" required>${opt('', 'Choose…', !(s && s.gender))}${opt('F', 'Female', s && s.gender === 'F')}${opt('M', 'Male', s && s.gender === 'M')}</select></label>
    <label>Birthdate${s ? '' : ' *'}<input id="stBday" type="date" max="${isoUTC(new Date(Date.now() - 15 * 365.25 * 864e5))}" value="${esc(s ? s.bday || '' : '')}"><small class="muted st-age" id="stAgeOut">${stAgeText(s ? s.bday : '', s && !s.bday ? s.ageCsv : null)}</small></label>
    <details class="span2 st-noage" ${s && !s.bday && s.ageCsv != null ? 'open' : ''}><summary>Don't know the birthdate? Enter the age instead</summary><label>Age<input id="stAge" type="number" min="16" max="90" inputmode="numeric" value="${esc(s && !s.bday && age != null ? age : '')}"></label></details>
    <label>Phone${s ? '' : ' *'}<input id="stPhone" inputmode="tel" ${s ? '' : 'required'} placeholder="07… or 01…" value="${esc(s ? s.phone || '' : '')}"></label>
    <label class="span2">Google (Gmail) email${s ? '' : ' *'} <small class="muted" style="font-weight:600">· links their sign-in account to this record</small><input id="stEmail" type="email" inputmode="email" autocomplete="off" placeholder="name@gmail.com" ${s ? '' : 'required'} value="${esc(s ? s.email || '' : '')}"></label>
    <label>Stake / district${s ? '' : ' *'}<select id="stStakeSel">${opt('', 'Choose…', !stk)}${A.stakes.map(x => opt(x, x, x === stk)).join('')}${opt('__other', '+ Other stake or district…', stOther)}</select>
      <input id="stStakeNew" placeholder="Type the stake or district" autocomplete="off" value="${esc(stOther ? stk : '')}" ${stOther ? '' : 'hidden'}></label>
    <label>Ward / branch${s ? '' : ' *'}<select id="stUnitSel">${stUnitOpts(stOther ? '__other' : stk, unOther ? '__other' : unt)}</select>
      <input id="stUnitNew" placeholder="Type the ward or branch" autocomplete="off" value="${esc(unOther ? unt : '')}" ${unOther || stOther ? '' : 'hidden'}></label>
    <p class="note span2 st-other-note" id="stOtherNote" ${stOther || unOther ? '' : 'hidden'} style="margin:-4px 0 0">Places outside the official list are saved with this person only. They don't add youth areas or change the session's stakes and wards.</p>
    <label>T-shirt size<select id="stSize">${opt('', 'Not given', !(s && s.tshirt))}${SIZES.map(z => opt(z, SIZE_LABEL[z], s && s.tshirt === z)).join('')}</select></label>
    ${s ? '' : '<p class="note span2" style="margin:0">* Needed for every new staff member.</p>'}<div class="span2"><button class="btn primary" type="submit" style="width:100%">${s ? 'Save changes' : 'Add staff member'}</button></div>
  </form>`);
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
    <div id="hcBody" style="display:flex;flex-direction:column;gap:14px"></div>
    ${can.admin() ? `<details class="panel danger-zone hc-reset" id="hcReset"><summary><h2 style="display:inline">Reset headcounts</h2> <span class="chip bad">Can't be undone</span></summary>
      <p class="note">Removes saved headcount reports so counselors can report again from scratch. Check-ins, groups and participants are not touched. Use this after a practice run.</p>
      <div class="dz-list"><div class="dz"><div><b id="hcResetNightT">Reset this night</b><small class="muted" id="hcResetNightN"></small></div><button class="btn danger" data-act="hcReset" data-v="night">Reset this night</button></div>
      <div class="dz"><div><b>Reset every night</b><small class="muted" id="hcResetAllN"></small></div><button class="btn danger" data-act="hcReset" data-v="all">Reset all nights</button></div></div></details>` : ''}`;
  },
  update() {
    const day = hcDay(), tonight = nightOf(), r = role();
    if ($('#hcReset')) { const dn = Object.values(S.hc || {}).filter(x => x && x.date === day).length, an = Object.keys(S.hc || {}).length; $('#hcResetNightT').textContent = 'Reset ' + nightLabel(day, true); $('#hcResetNightN').textContent = `${nn(dn, 'group report')} saved for this night`; $('#hcResetAllN').textContent = `${nn(an, 'group report')} saved across all nights`; }
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
/* Headcounts: each phone listens only to the reports it needs, so a tap on one phone is not sent to all 140.
   Counselors: their own group. ACs: their company. Admins and coordinators: tonight (admins: every night, for resets).
   Others with headcount access: tonight. Re-subscribes when the night, the role or someone's group changes. */
function hcSubscribe() {
  if (!S.db || !role() || !can.headcount()) return;
  const r = role(), day = hcDay();
  let field = 'date', vals = [day];
  if (r === 'counselor') { field = 'groupId'; vals = myGroups().map(g => g.id).slice(0, 30); }
  else if (r === 'ac') { field = 'companyId'; vals = myCompanies().map(c => c.id).slice(0, 30); }
  else if (can.admin()) { field = ''; vals = []; }
  const key = S.sid + '|' + r + '|' + field + '|' + vals.join(',');
  if (S.hcKey === key) return; S.hcKey = key;
  if (S.hcSub) { try { S.hcSub(); } catch (e) { } S.hcSub = null; }
  if (field && !vals.length) { S.hc = {}; S.hcLoaded = true; return; }
  const col = S.db.collection('headcount'), q = !field ? col : vals.length === 1 ? col.where(field, '==', vals[0]) : col.where(field, 'in', vals);
  S.hcSub = q.onSnapshot(sn => { const m = {}; sn.docs.forEach(d => m[d.id] = d.data()); for (const id in HC_PENDING) m[id] = Object.assign({}, m[id] || {}, HC_PENDING[id]); S.hc = m; S.hcLoaded = true; recompute(); }, e => console.error(e));
}
/* present/missing taps are saved together a moment after the last tap, instead of one save per tap */
const HC_PENDING = {}; let hcTimer = null;
function hcFlush() { clearTimeout(hcTimer); hcTimer = null; const ids = Object.keys(HC_PENDING); ids.forEach(id => { const next = HC_PENDING[id]; delete HC_PENDING[id]; setDoc('headcount/' + id, next).catch(fail); }); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && hcTimer) hcFlush(); });
window.addEventListener('pagehide', () => { if (hcTimer) hcFlush(); });
async function resetHeadcounts(which) {
  if (!can.admin()) return;
  const day = hcDay(), ids = Object.keys(S.hc || {}).filter(id => which === 'all' || (S.hc[id] && S.hc[id].date === day));
  if (!ids.length) { toast('There are no saved headcounts to reset.'); return; }
  const what = which === 'all' ? 'every night' : nightLabel(day, true);
  if (!await confirmTyped(`Reset headcounts for ${what}?`, `${nn(ids.length, 'group report')} will be deleted, including missing-youth marks and notes. Counselors can then report again. Check-ins and groups stay as they are.`, 'RESET', 'Reset headcounts')) return;
  let done = 0; for (const id of ids) { try { await serial('headcount/' + id, () => S.db.doc('headcount/' + id).delete()); done++; } catch (e) { console.error(e); } }
  const h = Object.assign({}, S.hc); ids.forEach(id => delete h[id]); S.hc = h;
  audit('headcount', `Reset headcounts for ${what}: ${nn(done, 'group report')} deleted`);
  toast(`Headcounts reset for ${what}`); render();
}
async function hcWrite(gid, patch, submit) {
  const day = hcDay(), id = day + '_' + gid, g = S.org.groups[gid]; if (!g) return;
  const base = { date: day, groupId: gid, groupNum: g.num, companyId: g.companyId || null, counselorId: g.counselorId || null, by: S.uid, byName: S.meName || S.email || '', byRole: role(), byStaff: myStaffId() || null, updatedAt: Date.now() };
  const cur = S.hc[id] || {};
  const next = Object.assign({}, cur, base, patch, { marks: Object.assign({}, cur.marks || {}, patch.marks || {}), reasons: Object.assign({}, cur.reasons || {}, patch.reasons || {}) });
  if (submit) Object.assign(next, { submitted: true, at: Date.now(), expected: hcGroup(g, day).people.map(p => p.id) });
  S.hc = Object.assign({}, S.hc, { [id]: next }); render();
  HC_PENDING[id] = next;
  if (submit) { hcFlush(); return; }
  clearTimeout(hcTimer); hcTimer = setTimeout(hcFlush, 2500);
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
    return `<section class="pagehead"><div><p class="th">Sessions · registration admin, Area Seventy, Head of Logistics & Session Directing Couple</p><h1>Sessions</h1><p class="note">Start a new session from its own data, or move participants by stake, district, ward or branch into another session.</p></div>${allowedPages().some(p => p[0] === 'planner') ? '<div class="btnrow"><button class="btn primary" data-act="nav" data-v="planner">Plan sessions</button></div>' : ''}</section>
    <section class="panel"><div class="panel-head"><h2>Sessions</h2></div><div id="sessList" class="sess-list"></div></section>
    <section class="panel" id="newSessPanel"><div class="panel-head"><h2>Start a new session from its own data</h2></div>
      <p class="note" style="margin-top:-4px">An empty session with its own participants, staff, groups and settings. Nothing is copied from ${esc(sessName(S.sid))}. After creating it, open it and upload its participant file on Data & areas and its staff on the Staff page.</p>
      <div class="form ns-form"><label>Session name<input id="nsName" placeholder="e.g. FSY Kenya 3rd 2026" autocomplete="off"></label>
        <label>First day of the session<input id="nsStart" type="date"></label>
        <div class="ns-go"><button class="btn primary" data-act="nsGo">Create the session</button></div></div></section>
    <section class="panel" id="splitPanel"></section>`;
  },
  update() {
    if (!UI.sessCounts) { UI.sessCounts = {}; loadSessionCounts(); }
    $('#sessList').innerHTML = Object.keys(S.sessions).filter(id => S.mySessions.includes(id)).map(id => { const cur = id === S.sid; const n = cur ? S.P.filter(isExpected).length : UI.sessCounts[id], left = cur ? S.P.filter(p => !p.inc && p.src !== 'walkin').length : (UI.sessLeft || {})[id], wk = cur ? S.P.filter(p => p.src === 'walkin').length : (UI.sessWalk || {})[id]; const x = S.sessions[id];
      return `<div class="sess ${cur ? 'cur' : ''}"><div><b>${esc(sessName(id))}</b><small class="muted">${n == null ? 'Counting…' : n + ' participants'}${wk ? ` <span class="muted">+ ${nn(wk, 'walk-in')}</span>` : ''}${left ? ` <span class="muted">(+${left} cancelled or left out)</span>` : ''}${x.from ? ' · split from ' + esc(sessName(x.from)) : ''}${x.at ? ' · ' + esc(fmtTime(x.at)) : ''}</small></div><div class="sess-act">${cur ? '<span class="chip good">Open now</span>' : `<button class="btn small" data-act="switchSession" data-v="${esc(id)}">Open</button>`}${canDelSession(id) ? `<button class="btn small danger" data-act="sessDel" data-v="${esc(id)}">Delete</button>` : ''}</div></div>`; }).join('') + (Object.keys(S.sessions).length > 1 ? '<p class="note" style="margin:8px 0 0">The first session and the one that is open can\'t be deleted. To delete this one, open another first.</p>' : '');
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
/* Deleting a session: the registration admin, Area Seventy and Head of Logistics, or the person who created it.
   Never the first session ("main", whose data sits at the top level) and never the one that is open. */
function canDelSession(id) { const x = S.sessions[id] || {}; return id !== 'main' && id !== S.sid && (TOP_ROLES.includes(realRole()) || (realRole() === 'sdc' && x.creator && x.creator === S.email)) && !S.viewAs; }
async function purgeSession(id) {
  /* each part is deleted on its own: one refusal no longer stops the rest, and the session always leaves the list */
  let failed = 0;
  /* off the list first, so it disappears straight away; the data is removed behind it */
  const left = Object.assign({}, S.sessions); delete left[id]; S.sessions = left; S.mySessions = S.mySessions.filter(x => x !== id); render();
  await FB.fs.doc('meta/sessions').update({ ['s.' + id]: firebase.firestore.FieldValue.delete() });
  for (const c of ['roster', 'state', 'staff', 'org', 'headcount', 'medical', 'share', 'intake', 'reports', 'config']) {
    try { const sn = await FB.fs.collection(rawPath(id, c)).get(); for (const d of sn.docs) await FB.fs.doc(rawPath(id, c + '/' + d.id)).delete().catch(() => { failed++; }); } catch (e) { failed++; }
  }
  if (failed) console.warn(`Session ${id}: ${failed} parts could not be deleted (publish the latest firestore.rules)`);
  if (can.accounts()) for (const e in S.invites) { const v = S.invites[e]; if (v && Array.isArray(v.sessions) && v.sessions.includes(id)) await FB.fs.doc('invites/' + e).set({ sessions: v.sessions.filter(x => x !== id) }, { merge: true }).catch(() => { }); }
}
async function deleteSession(id) {
  const name = sessName(id);
  const ok = await confirmTyped(`Delete ${name}?`, `Every participant, check-in, staff record, group, company, headcount, health concern and setting in <b>${esc(name)}</b> is deleted for good. Other sessions are not touched. Export what you need first (open the session, then Data & areas, Export everything).`, 'DELETE', 'Delete session');
  if (!ok) return;
  toast('Deleting the session…');
  try {
    await purgeSession(id);
    audit('session', `Deleted the session ${name}`); UI.sessCounts = null; render(); toast(`${name} deleted`);
  } catch (e) { fail(e); }
}
/* page: plan sessions (registration admin, Area Seventy, Head of Logistics)
   Every session side by side. Try moving stakes or units between sessions and watch the numbers; nothing changes
   until Apply, which moves those youth (and, if chosen, their staff) for real. */
const PLAN = { data: null, loading: false, moves: {}, staffMove: true, open: new Set(), sel: new Set(), virt: {}, to: '' };
function planYouth(id, b, r, st, cfg) {
  const status = normStatus(r.status), uk = (r.stake || '') + '|' + (r.unit || '');
  let inc = !((status && (cfg.excludedStatuses || []).includes(status)) || (cfg.excludedStakes || []).includes(r.stake) || (cfg.excludedUnits || []).includes(uk) || (cfg.excludeNonMembers && r.member === false && r.src !== 'walkin'));
  if (st.ov === 'inc') inc = true; if (st.ov === 'exc') inc = false;
  const age = r.bday ? ageOn(r.bday, cfg.sessionStart || '') : (r.ageCsv != null ? r.ageCsv : null);
  return { id, b, st: r.stake || NO_STAKE, un: r.unit || NO_UNIT, gender: r.gender || '', band: bandOfAge(age), inc, walk: r.src === 'walkin', in: st.s === 'in' };
}
async function planLoad() {
  PLAN.loading = true; render();
  try {
    const ids = uniq(['main'].concat(Object.keys(S.sessions || {})));
    const out = {};
    for (const id of ids) {
      const cd = await FB.fs.doc(rawPath(id, 'config/session')).get();
      if (!cd.exists && id !== 'main') continue;
      const cfg = Object.assign({}, DEFAULT_CONFIG, cd.exists ? cd.data() : {});
      const [ro, sts, sf] = await Promise.all([FB.fs.collection(rawPath(id, 'roster')).get(), FB.fs.collection(rawPath(id, 'state')).get(), FB.fs.doc(rawPath(id, 'staff/all')).get()]);
      const state = {}; sts.docs.forEach(d => Object.assign(state, (d.data() || {}).p || {}));
      const youth = []; ro.docs.forEach(d => { const m = (d.data() || {}).p || {}; for (const pid in m) { const r = m[pid]; if (!r) continue; const st = state[pid] || {}; if (st.del) continue; youth.push(planYouth(pid, d.id, r, st, cfg)); } });
      const staff = Object.values(((sf.exists && sf.data()) || {}).s || {}).filter(x => x && !x.test && !x.fromAccount).map(x => ({ id: x.id, role: x.role, gender: x.gender || '', st: x.stake || NO_STAKE, un: x.unit || NO_UNIT }));
      out[id] = { id, name: cfg.sessionName || sessName(id), cfg, youth, staff };
    }
    for (const v in PLAN.virt) out[v] = PLAN.virt[v];
    const ud = await FB.fs.doc('meta/planUndo').get(); PLAN.undo = ud.exists && (ud.data().moves || []).length ? ud.data() : null;
    PLAN.data = out;
  } catch (e) { fail(e); }
  PLAN.loading = false; render();
}
function planDest(src, st, un) { return PLAN.moves[src + '\u0001' + st + '\u0001' + un] || src; }
function planTotals() {
  const D = PLAN.data, T = {};
  for (const id in D) T[id] = { y: [], staff: [], now: { y: D[id].youth.filter(x => x.inc).length, c: D[id].staff.filter(x => x.role === 'counselor').length } };
  for (const id in D) {
    D[id].youth.forEach(x => { const d = planDest(id, x.st, x.un); if (T[d]) T[d].y.push(x); });
    D[id].staff.forEach(x => { const d = PLAN.staffMove ? planDest(id, x.st, x.un) : id; if (T[d]) T[d].staff.push(x); });
  }
  for (const id in T) {
    const t = T[id], cfg = D[id].cfg, y = t.y.filter(x => x.inc), c = t.staff.filter(x => x.role === 'counselor');
    t.n = y.length; t.walk = y.filter(x => x.walk).length; t.inn = y.filter(x => x.in).length;
    t.F = y.filter(x => x.gender === 'F').length; t.M = y.filter(x => x.gender === 'M').length; t.Y = y.filter(x => x.band === 'Y').length; t.O = y.filter(x => x.band === 'O').length;
    t.gap = {}; for (const g of ['F', 'M']) { const size = gsize(cfg, g), yy = y.filter(x => x.gender === g); const need = ['Y', 'O'].reduce((a, b) => a + Math.ceil(yy.filter(x => x.band === b).length / size), 0) + Math.ceil(yy.filter(x => !x.band).length / size); const have = c.filter(x => x.gender === g).length; t.gap[g] = { need, have, short: Math.max(0, need - have), size }; }
    t.c = c.length; t.ac = t.staff.filter(x => x.role === 'ac').length; t.coord = t.staff.filter(x => x.role === 'coordinator').length;
  }
  return T;
}
function planChanges() {
  const D = PLAN.data, out = [];
  for (const k in PLAN.moves) { const [src, st, un] = k.split('\u0001'), dest = PLAN.moves[k]; if (!D[src] || !D[dest] || dest === src) continue;
    const youth = D[src].youth.filter(x => x.st === st && x.un === un), staff = PLAN.staffMove ? D[src].staff.filter(x => x.st === st && x.un === un) : [];
    if (youth.length || staff.length) out.push({ src, dest, st, un, youth, staff }); }
  return out;
}
/* move youth (by roster bucket) and staff from one session to another; returns each youth's group in the old session.
   gBack gives the groups to put them back into (used by Undo). */
async function planMoveIds(src, dest, byB, staffIds, gBack) {
  const del = firebase.firestore.FieldValue.delete, prevG = {};
  for (const b in byB) {
    const [ro, st, md] = await Promise.all(['roster', 'state', 'medical'].map(c => FB.fs.doc(rawPath(src, c + '/' + b)).get()));
    const R = (ro.exists && ro.data().p) || {}, ST = (st.exists && st.data().p) || {}, MD = (md.exists && md.data().p) || {};
    const r = {}, t = {}, m = {}, gone = {};
    byB[b].forEach(id => { if (!R[id]) return; r[id] = R[id]; if (ST[id] && ST[id].g) prevG[id] = ST[id].g;
      const back = gBack && gBack[id]; if (ST[id] || back) t[id] = Object.assign({}, ST[id] || {}, { g: back || null }); if (MD[id]) m[id] = MD[id]; gone['p.' + id] = del(); });
    if (!Object.keys(r).length) continue;
    await FB.fs.doc(rawPath(dest, 'roster/' + b)).set({ p: r }, { merge: true });
    if (Object.keys(t).length) await FB.fs.doc(rawPath(dest, 'state/' + b)).set({ p: t }, { merge: true });
    if (Object.keys(m).length) await FB.fs.doc(rawPath(dest, 'medical/' + b)).set({ p: m }, { merge: true });
    await FB.fs.doc(rawPath(src, 'roster/' + b)).update(gone);
    if (st.exists && Object.keys(r).some(id => ST[id])) await FB.fs.doc(rawPath(src, 'state/' + b)).update(gone).catch(() => { });
    if (md.exists && Object.keys(r).some(id => MD[id])) await FB.fs.doc(rawPath(src, 'medical/' + b)).update(gone).catch(() => { });
  }
  if (staffIds && staffIds.length) {
    const sd = await FB.fs.doc(rawPath(src, 'staff/all')).get(); const all = (sd.exists && sd.data().s) || {};
    const recs = {}, gone = {}; staffIds.forEach(id => { if (all[id]) { recs[id] = all[id]; gone['s.' + id] = del(); } });
    if (Object.keys(recs).length) { await FB.fs.doc(rawPath(dest, 'staff/all')).set({ s: recs }, { merge: true }); await FB.fs.doc(rawPath(src, 'staff/all')).update(gone); }
  }
  return prevG;
}
/* Undo the last applied plan: everyone goes back to the session they came from, into their old group where it still exists */
async function planUndoLast() {
  const d = await FB.fs.doc('meta/planUndo').get(); const U = d.exists ? d.data() : null; if (!U || !U.moves || !U.moves.length) { toast('There is no plan to undo'); return; }
  const ny = U.moves.reduce((a, m) => a + Object.values(m.byB || {}).reduce((x, l) => x + l.length, 0), 0), ns = U.moves.reduce((a, m) => a + (m.staff || []).length, 0);
  const made = (U.created || []).filter(id => S.sessions[id]).map(id => sessName(id));
  if (!await confirmTyped('Undo the last plan?', `The plan applied ${esc(fmtWhen(U.at))}${U.by ? ' by ' + esc(U.by) : ''} is reversed: ${nn(ny, 'youth')}${ns ? ` and ${nn(ns, 'staff member')}` : ''} go back to the session they came from, into their old group where it still exists. Check-ins and medical notes go with them.${made.length ? ` ${esc(made.join(', '))}, made by the plan, is deleted if nothing else is in it.` : ''} Anything changed since in those sessions stays as it is.`, 'UNDO', 'Undo plan')) return;
  toast('Undoing…');
  try {
    for (const m of U.moves.slice().reverse()) await planMoveIds(m.dest, m.src, m.byB || {}, m.staff || [], m.g || {});
    for (const id in (U.cfg || {})) await FB.fs.doc(rawPath(id, 'config/session')).set(U.cfg[id], { merge: true });
    for (const id of (U.created || [])) {
      const ro = await FB.fs.collection(rawPath(id, 'roster')).get(); const left = ro.docs.some(x => Object.keys((x.data() || {}).p || {}).length);
      const sf = await FB.fs.doc(rawPath(id, 'staff/all')).get(); const staffLeft = sf.exists && Object.keys((sf.data() || {}).s || {}).length;
      if (!left && !staffLeft && id !== S.sid) await purgeSession(id);
    }
    await FB.fs.doc('meta/planUndo').delete();
    audit('session', `Undid the plan applied ${fmtWhen(U.at)}: ${nn(ny, 'youth')}${ns ? ` and ${nn(ns, 'staff member')}` : ''} moved back`);
    PLAN.moves = {}; PLAN.data = null; toast('Plan undone. Press Rebalance in every session to fill any gaps.'); planLoad();
  } catch (e) { fail(e); }
}
async function planApply() {
  const ch = planChanges(); if (!ch.length) return;
  const ny = ch.reduce((a, c) => a + c.youth.length, 0), ns = ch.reduce((a, c) => a + c.staff.length, 0), nin = ch.reduce((a, c) => a + c.youth.filter(x => x.in).length, 0);
  if (!await confirmTyped(`Apply this plan?`, `${nn(ny, 'youth')}${ns ? ` and ${nn(ns, 'staff member')}` : ''} from ${nn(ch.length, 'ward or branch', 'wards and branches')} move to their new session${nin ? `, including ${nin} already checked in (their check-ins move with them)` : ''}. They leave their groups. Press Rebalance in every session afterwards.`, 'APPLY', 'Apply plan')) return;
  toast('Moving…'); const del = firebase.firestore.FieldValue.delete;
  try {
    /* sessions that only exist in the plan are created first */
    const real = {};
    for (const v of uniq(ch.map(c => c.dest)).filter(d => PLAN.virt[d])) {
      const id = 's' + rid(''), name = PLAN.virt[v].name, entry = { [id]: { name, at: Date.now(), by: S.meName || '', creator: S.email || '' } };
      await FB.fs.doc('meta/sessions').set({ s: entry }, { merge: true }); Object.assign(S.sessions, entry);
      await FB.fs.doc(rawPath(id, 'config/session')).set(Object.assign({}, DEFAULT_CONFIG, { sessionName: name }));
      if (!S.mySessions.includes(id)) S.mySessions.push(id);
      PLAN.data[id] = Object.assign({}, PLAN.data[v], { id }); real[v] = id; audit('session', `Created a new session from the plan: ${name}`);
    }
    ch.forEach(c => { if (real[c.dest]) c.dest = real[c.dest]; });
    PLAN.virt = {};
    const undo = { at: Date.now(), by: S.meName || S.email || '', moves: [], cfg: {}, created: Object.values(real) };
    const pairs = {}; ch.forEach(c => { const k = c.src + '>' + c.dest; (pairs[k] = pairs[k] || { src: c.src, dest: c.dest, y: [], s: [], areas: [] }); pairs[k].y.push(...c.youth); pairs[k].s.push(...c.staff); pairs[k].areas.push([c.st, c.un]); });
    for (const k in pairs) {
      const { src, dest, y, s: sf, areas } = pairs[k];
      const byB = {}; y.forEach(x => (byB[x.b] = byB[x.b] || []).push(x.id));
      const prevG = await planMoveIds(src, dest, byB, sf.map(x => x.id), null);
      undo.moves.push({ src, dest, byB, staff: sf.map(x => x.id), g: prevG, areas });
      /* the moved areas must not be left out in the session they join */
      const cd = await FB.fs.doc(rawPath(dest, 'config/session')).get(); const cfg = (cd.exists && cd.data()) || {};
      const ks = new Set(areas.map(([st, un]) => st + '|' + un)), sts = new Set(areas.map(a => a[0]));
      const exU = (cfg.excludedUnits || []).filter(u => !ks.has(u)), exS = (cfg.excludedStakes || []).filter(x => !sts.has(x));
      if (exU.length !== (cfg.excludedUnits || []).length || exS.length !== (cfg.excludedStakes || []).length) { if (!undo.cfg[dest]) undo.cfg[dest] = { excludedUnits: cfg.excludedUnits || [], excludedStakes: cfg.excludedStakes || [] }; await FB.fs.doc(rawPath(dest, 'config/session')).set({ excludedUnits: exU, excludedStakes: exS }, { merge: true }); }
      audit('session', `Plan applied: moved ${nn(y.length, 'youth')}${sf.length ? ` and ${nn(sf.length, 'staff member')}` : ''} from ${PLAN.data[src].name} to ${PLAN.data[dest].name} (${areas.map(a => a[1]).join(', ')})`);
    }
    await FB.fs.doc('meta/planUndo').set(undo);
    PLAN.moves = {}; toast('Plan applied. Press Rebalance in every session.'); await planLoad();
  } catch (e) { fail(e); }
}
PAGE_IMPL.planner = {
  frame() {
    return `<section class="pagehead"><div><p class="th"><a href="#sessions" class="th-link">Sessions</a> · registration admin, Area Seventy & Head of Logistics</p><h1>Plan sessions</h1><p class="note">Every session side by side. Move stakes or units between sessions to see the numbers. Nothing changes until you press Apply.</p></div><div class="btnrow"><button class="btn" data-act="plUndoLast" id="plUndoBtn" hidden>Undo last plan</button><button class="btn" data-act="plReload">Refresh data</button><button class="btn" data-act="plReset">Clear plan</button><button class="btn primary" data-act="plApply" id="plApplyBtn" disabled>Apply plan</button></div></section>
    <div id="plBody"></div>`;
  },
  update() {
    const box = $('#plBody'); if (!box) return;
    if (!PLAN.data && !PLAN.loading) { planLoad(); }
    if (!PLAN.data) { box.innerHTML = '<section class="panel"><p class="note">Loading every session…</p></section>'; return; }
    const D = PLAN.data, ids = Object.keys(D), T = planTotals(), ch = planChanges();
    const ub = $('#plUndoBtn'); if (ub) { ub.hidden = !PLAN.undo; if (PLAN.undo) ub.title = 'Applied ' + fmtWhen(PLAN.undo.at) + (PLAN.undo.by ? ' by ' + PLAN.undo.by : ''); }
    const ab = $('#plApplyBtn'); if (ab) { ab.disabled = !ch.length; ab.textContent = ch.length ? `Apply plan (${nn(ch.length, 'change')})` : 'Apply plan'; }
    const dlt = (a, b) => a === b ? '' : `<small class="pl-d ${a > b ? 'up' : 'down'}">${a > b ? '+' : ''}${a - b}</small>`;
    const card = id => { const t = T[id], g = t.gap;
      return `<div class="pl-card"><h3>${esc(D[id].name)}${id === S.sid ? ' <span class="chip good">Open now</span>' : ''}${PLAN.virt[id] ? ' <span class="chip info">Planned</span>' : ''}</h3>
        <div class="pl-big"><b>${t.n}</b> youth ${dlt(t.n, t.now.y)}</div>
        <ul class="pl-stats"><li>${t.F} young women · ${t.M} young men</li><li>${t.Y} aged 14–15 · ${t.O} aged 16–18</li>${t.inn ? `<li>${t.inn} already checked in</li>` : ''}
          <li><b>${t.c}</b> counselors ${dlt(t.c, t.now.c)} · ${t.ac} ACs · ${t.coord} coordinators</li>
          <li class="${g.F.short ? 'warn' : ''}">Young women: ${g.F.need} groups of ${g.F.size}, ${g.F.have} counselors${g.F.short ? ` · <b>${g.F.short} short</b>` : ''}</li>
          <li class="${g.M.short ? 'warn' : ''}">Young men: ${g.M.need} groups of ${g.M.size}, ${g.M.have} counselors${g.M.short ? ` · <b>${g.M.short} short</b>` : ''}</li></ul></div>`; };
    /* every unit that has participants, wherever it is now, listed under the session it will be in after the plan */
    const sel = PLAN.sel, key = (src, st, un) => src + '\u0001' + st + '\u0001' + un, U = [];
    for (const src of ids) {
      const A = {}; D[src].youth.forEach(x => { const u = ((A[x.st] = A[x.st] || {})[x.un] = A[x.st][x.un] || { y: 0, inn: 0, c: 0, s: 0 }); if (x.inc) u.y++; if (x.in) u.inn++; });
      D[src].staff.forEach(x => { const u = A[x.st] && A[x.st][x.un]; if (!u) return; u.s++; if (x.role === 'counselor') u.c++; });
      for (const st in A) for (const un in A[st]) U.push(Object.assign({ src, st, un, k: key(src, st, un), dest: planDest(src, st, un) }, A[st][un]));
    }
    const group = d => {
      const mine = U.filter(u => u.dest === d), byS = {}; mine.forEach(u => (byS[u.st] = byS[u.st] || []).push(u));
      let h = '';
      for (const st of Object.keys(byS).sort((a, b) => a.localeCompare(b))) {
        const us = byS[st].sort((a, b) => a.un.localeCompare(b.un)), gk = d + '\u0001' + st, open = PLAN.open.has(gk);
        const all = us.every(u => sel.has(u.k)), some = us.some(u => sel.has(u.k)), moved = us.filter(u => u.src !== d), froms = uniq(moved.map(u => D[u.src].name));
        const y = us.reduce((a, u) => a + u.y, 0), c = us.reduce((a, u) => a + u.c, 0);
        h += `<div class="pl-row st ${moved.length ? 'moved' : ''} ${some ? 'sel' : ''}"><input type="checkbox" data-act="plSelSt" data-v="${esc(gk)}" ${all ? 'checked' : ''} ${!all && some ? 'data-mixed="1"' : ''} aria-label="Select ${esc(st)}">
          <button class="pl-name" data-act="plOpen" data-v="${esc(gk)}"><span class="caret">${open ? '▾' : '▸'}</span><b>${esc(st)}</b><small class="muted">${nn(us.length, 'unit')} · ${y} youth · ${c} counselors</small></button>
          ${moved.length ? `<span class="pl-to">${moved.length === us.length ? 'Moved here' : `${moved.length} of ${us.length} units moved here`} from ${esc(froms.join(', '))}<button class="x" data-act="plUndoSt" data-v="${esc(gk)}" aria-label="Move back" title="Move back">×</button></span>` : ''}</div>`;
        if (open) for (const u of us) h += `<label class="pl-row un ${u.src !== d ? 'moved' : ''} ${sel.has(u.k) ? 'sel' : ''}"><input type="checkbox" data-act="plSel" data-v="${esc(u.k)}" ${sel.has(u.k) ? 'checked' : ''}>
            <span class="pl-name"><span>${esc(u.un)}</span><small class="muted">${u.y} youth${u.inn ? ` (${u.inn} checked in)` : ''} · ${u.c} counselors</small></span>${u.src !== d ? `<span class="pl-to">from ${esc(D[u.src].name)}<button class="x" data-act="plUndo" data-v="${esc(u.k)}" aria-label="Move back" title="Move back">×</button></span>` : ''}</label>`;
      }
      return h || '<p class="note" style="padding:10px 14px;margin:0">Nothing here yet. Tick stakes or units in another session and move them here.</p>';
    };
    const nSel = sel.size, selY = U.filter(u => sel.has(u.k)).reduce((a, u) => a + u.y, 0);
    if (!PLAN.to || !D[PLAN.to]) PLAN.to = ids.find(id => !U.some(u => sel.has(u.k) && u.dest === id)) || ids[0];
    const step = (n, on, done, body) => `<div class="pl-step ${on ? 'on' : ''} ${done ? 'done' : ''}"><span class="pl-num">${done ? '✓' : n}</span><div class="pl-step-b">${body}</div></div>`;
    const bar = `<div class="pl-bar">
      ${step(1, !nSel, nSel > 0, nSel ? `<b>${nn(nSel, 'unit')} ticked</b> <small class="muted">${selY} youth</small> <button class="linkbtn" data-act="plSelClear">Untick all</button>` : '<b>Tick</b> the stakes or units to move')}
      ${step(2, nSel > 0, false, `<label class="inline"><b>Move to</b> <select id="plTo" data-act="plTo">${ids.map(id => opt(id, D[id].name + (PLAN.virt[id] ? ' (new)' : ''), id === PLAN.to)).join('')}</select></label> <button class="btn small primary" data-act="plMoveSel" ${nSel ? '' : 'disabled'}>Move ${nSel ? nn(nSel, 'unit') : ''}</button> <button class="linkbtn" data-act="plNewSess">+ New session</button>`)}
      ${step(3, !nSel && ch.length > 0, false, ch.length ? `<button class="btn small apply" data-act="plApply">Apply ${nn(ch.length, 'change')}</button> <button class="linkbtn" data-act="plReset">Clear plan</button>` : '<span class="muted">Apply when the numbers look right</span>')}
    </div>`;
    box.innerHTML = `<div class="pl-cards">${ids.map(card).join('')}</div>
      <section class="panel"><div class="panel-head"><h2>Move stakes and units</h2><label class="inline"><input type="checkbox" data-act="plStaff" ${PLAN.staffMove ? 'checked' : ''}> Staff move with their unit</label></div>
        ${bar}
        <div class="pl-warn"><b>Only press Apply if you want to make the changes official.</b> Apply really moves youth${PLAN.staffMove ? ' and staff' : ''} between sessions. To just see how the numbers would look, use <b>Move</b>, then <b>Clear plan</b> when you are done.</div>
        <p class="note" style="margin:0 0 8px">Moved units appear under their new session in amber. Press × to move one back.</p>
        ${ids.map(d => { const t = T[d]; return `<details class="pl-src ${PLAN.virt[d] ? 'virt' : ''}" open><summary><b>${esc(D[d].name)}</b>${PLAN.virt[d] ? ' <span class="chip info">New</span>' : ''} <span class="muted">· ${t.n} youth after the plan</span></summary><div class="pl-tree">${group(d)}</div></details>`; }).join('')}
        ${ch.length ? (() => { const g = {}; ch.forEach(c => { const k = c.src + '>' + c.dest; const x = g[k] = g[k] || { src: c.src, dest: c.dest, st: new Set(), un: 0, y: 0, s: 0 }; x.st.add(c.st); x.un++; x.y += c.youth.filter(y => y.inc).length; x.s += c.staff.length; });
          return `<div class="pl-sum"><ul>${Object.values(g).map(x => `<li><b>${x.y} youth</b>${x.s ? ` and ${nn(x.s, 'staff member')}` : ''} from ${esc(D[x.src].name)} to <b>${esc(D[x.dest].name)}</b> <span class="muted">· ${nn(x.un, 'unit')} in ${nn(x.st.size, 'stake or district', 'stakes and districts')}</span></li>`).join('')}</ul><button class="btn primary" data-act="plApply">Apply ${nn(ch.length, 'change')}</button></div>`; })() : ''}</section>`;
    document.querySelectorAll('#plBody [data-mixed]').forEach(el => el.indeterminate = true);
  }
};
async function loadSessionCounts() {
  UI.sessLeft = UI.sessLeft || {};
  for (const id of S.mySessions) { if (id === S.sid) continue; try {
    // count the way the open session does: cancelled statuses and left-out areas are not participants
    const cd = await FB.fs.doc(rawPath(id, 'config/session')).get(); const cfg = Object.assign({}, DEFAULT_CONFIG, cd.exists ? cd.data() : {});
    const exS = new Set(cfg.excludedStatuses || []), exSt = new Set(cfg.excludedStakes || []), exU = new Set(cfg.excludedUnits || []);
    const sn = await FB.fs.collection(rawPath(id, 'roster')).get(); let n = 0, out = 0, wk = 0;
    sn.docs.forEach(d => { const m = (d.data() || {}).p || {}; for (const k in m) { const r = m[k]; if (!r) continue; const st = normStatus(r.status); if (r.src === 'walkin') wk++; else if ((st && exS.has(st)) || (cfg.excludeNonMembers && r.member === false) || exSt.has(r.stake) || exU.has((r.stake || '') + '|' + (r.unit || ''))) out++; else n++; } });
    UI.sessCounts[id] = n; UI.sessLeft[id] = out; (UI.sessWalk = UI.sessWalk || {})[id] = wk;
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

/* Possible duplicates: the same first name plus one more name, backed up by the same birthday or age, contact or ward.
   Covers participants (walk-ins too) and staff. People are only compared within their own kind. */
const DUP_LIMIT = 30;
let dupMemo = { k: null, v: [] };
function dupPeople() {
  const P = S.P.map(p => ({ kind: 'p', id: p.id, rec: p, name: p.name || `${p.first || ''} ${p.last || ''}`, first: clean(p.first || p.name || '').split(/\s+/)[0], bday: p.bday || '', age: p.age,
    phones: [p.phone, p.c1p, p.c2p].map(x => sfPhone(x || '')).filter(okPhone), email: String(p.email || '').toLowerCase(), unit: (p.unit || '').toLowerCase() }));
  const T = S.staffList.filter(x => !x.test && !x.fromAccount).map(x => ({ kind: 's', id: x.id, rec: x, name: x.name, first: clean(x.name).split(/\s+/)[0], bday: x.bday || '', age: staffAge(x, S.config),
    phones: [sfPhone(x.phone || '')].filter(okPhone), email: String(x.email || '').toLowerCase(), unit: (x.unit || '').toLowerCase() }));
  return [P, T];
}
function tokSame(a, b) { return a === b || (a.length >= 4 && b.length >= 4 && editDist(a, b) <= 1); }
function dupScore(a, b) {
  const ta = nameTokens(a.name), tb = nameTokens(b.name), fa = nameTokens(a.first)[0], fb = nameTokens(b.first)[0];
  if (!fa || !fb || !tb.some(t => tokSame(t, fa)) || !ta.some(t => tokSame(t, fb))) return null; /* each one's first name is in the other's name */
  const shared = ta.filter(t => tb.some(u => tokSame(t, u))).length; if (shared < 2) return null;
  const why = []; let pts = 0;
  if (ta.join(' ') === tb.join(' ')) { pts += 1; why.push('Same name'); } else if (ta.length === tb.length && shared === ta.length) { pts += 1; why.push('Similar name'); }
  if (a.bday && b.bday) { if (a.bday === b.bday) { pts += 3; why.push('Same birthday'); } else if (a.age != null && a.age === b.age) { pts += 1; why.push('Same age'); } else pts -= 2; }
  else if (a.age != null && a.age === b.age) { pts += 1; why.push('Same age'); }
  if (a.phones.some(x => b.phones.includes(x))) { pts += 2; why.push('Same phone'); }
  if (a.email && a.email === b.email) { pts += 2; why.push('Same email'); }
  if (a.unit && a.unit === b.unit) { pts += 1; why.push('Same ward'); }
  return pts >= 2 ? { pts, why, high: pts >= 4 } : null;
}
function findDuplicates() {
  const ign = new Set(S.config.dupIgnore || []), key = S.P.length + ':' + S.staffList.length + ':' + ign.size + ':' + (S.P[0] && S.P[0].id) + ':' + fnv(JSON.stringify(S.P.map(p => p.name + p.bday + p.unit + p.phone).join('|') + S.staffList.map(x => x.name + x.phone + x.bday + x.unit).join('|')));
  if (dupMemo.k === key) return dupMemo.v;
  const out = [];
  for (const list of dupPeople()) {
    /* every name word is a bucket, so "Abel Kiprop" and "Kiprop Abel" meet; first names alone feed the spelling pass below */
    const byTok = {}, byFirst = {}; list.forEach((x, i) => { nameTokens(x.name).forEach(t => (byTok[t] = byTok[t] || []).push(i)); nameTokens(x.first).slice(0, 1).forEach(t => (byFirst[t] = byFirst[t] || []).push(i)); });
    const seen = new Set();
    for (const t in byTok) { const ids = byTok[t]; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = list[ids[i]], b = list[ids[j]], k = [a.id, b.id].sort().join('|'); if (seen.has(k) || ign.has(k)) continue; seen.add(k);
      const r = dupScore(a, b); if (r) out.push(Object.assign({ a, b, key: k }, r)); } }
    /* first names spelt slightly differently land in different buckets: compare those buckets too */
    const toks = Object.keys(byFirst).filter(t => t.length >= 4);
    for (let i = 0; i < toks.length; i++) for (let j = i + 1; j < toks.length; j++) { if (Math.abs(toks[i].length - toks[j].length) > 1 || editDist(toks[i], toks[j]) > 1) continue;
      for (const x of byFirst[toks[i]]) for (const y of byFirst[toks[j]]) { const a = list[x], b = list[y], k = [a.id, b.id].sort().join('|'); if (seen.has(k) || ign.has(k)) continue; seen.add(k); const r = dupScore(a, b); if (r) out.push(Object.assign({ a, b, key: k }, r)); } }
  }
  out.sort((x, y) => y.pts - x.pts || x.a.name.localeCompare(y.a.name));
  dupMemo = { k: key, v: out }; return out;
}
/* when a record came in: the portal's registration date, the time a staff member was added, or when a walk-in was recorded */
function dupWhen(x) {
  const r = x.rec; if (x.kind === 's') return r.addedAt || 0;
  const t = r.regDate ? Date.parse(r.regDate) || Date.parse(parseDate(r.regDate)) : 0; return t || (r.src === 'walkin' ? r.imp || 0 : 0);
}
function dupDiffs(a, b) {
  const L = [['tshirt', 'T-shirt'], ['phone', 'phone'], ['email', 'email'], ['status', 'status'], ['unit', 'ward'], ['bday', 'birthday']];
  return L.filter(([k]) => String(a.rec[k] || '') !== String(b.rec[k] || '')).map(([k, l]) => { const f = v => !v ? 'blank' : k === 'status' ? String(v).replace(/_/g, ' ').toLowerCase() : k === 'bday' ? dmyStr(v) : v; return `${l}: ${f(a.rec[k])} → ${f(b.rec[k])}`; });
}
function dupCard(x, tag) {
  const r = x.rec, isP = x.kind === 'p';
  const kind = isP ? (r.src === 'walkin' ? 'Walk-in' : 'Participant') : (ROLES[r.role] || 'Staff');
  const where = isP ? (r.s === 'in' ? 'Checked in' : r.s === 'out' ? 'Checked out' : 'Not arrived') + (r.group ? ` · G${r.group.num}` : '') : '';
  const meta = [kind, isP && r.src !== 'walkin' ? 'ID ' + (r.id.length > 12 ? r.id.slice(0, 8) + '…' : r.id) : '', isP && r.status ? r.status.replace(/_/g, ' ').toLowerCase() : '', r.tshirt ? 'T-shirt ' + r.tshirt : '', x.age != null ? 'age ' + x.age : '', x.bday ? dmyStr(x.bday) : '', [r.unit, r.stake].filter(Boolean).join(', '), r.phone || '', r.email || '', where].filter(Boolean);
  const del = isP ? (can.deleteP() ? `<button class="btn small danger adm" data-act="delP" data-id="${esc(r.id)}">Delete</button>` : '') : (can.staff() ? `<button class="btn small danger adm" data-act="stDel" data-id="${esc(r.id)}">Delete</button>` : '');
  const w = dupWhen(x), when = w ? `${isP && r.src !== 'walkin' ? 'Registered' : 'Added'} ${new Date(w).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'Date not known';
  return `<div class="dup-card"><div class="dup-top">${tag ? `<span class="chip ${tag === 'Newer' ? 'info' : ''}">${tag}</span>` : ''}<small class="dup-when">${esc(when)}</small>${isP && r.src !== 'walkin' ? (r.member === true ? '<span class="chip good">Has MRN</span>' : r.member === false ? '<span class="chip warn">No MRN</span>' : '<span class="chip">MRN not known</span>') : ''}</div><a href="#" data-act="${isP ? 'detail' : 'stEdit'}" data-id="${esc(r.id)}"><b>${esc(x.name)}</b></a><small class="muted">${meta.map(esc).join(' · ')}</small>${del}</div>`;
}
function dmyStr(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; }
function renderNonMembers() {
  const box = $('#dNm'); if (!box) return;
  const known = S.P.some(p => p.member === true || p.member === false), L = S.P.filter(p => p.member === false && p.src !== 'walkin');
  const out = !!S.config.excludeNonMembers, n = $('#nmN');
  if (n) { n.textContent = known ? (L.length || 'None') : 'Not known'; n.className = 'chip ' + (!known ? '' : L.length ? (out ? 'bad' : 'info') : 'good'); }
  if (!known) { box.innerHTML = '<p class="note">The last upload had no Member column. Upload a file from the updated portal script.</p>'; return; }
  if (!L.length) { box.innerHTML = '<p class="note">Every youth in the upload has an MRN.</p>'; return; }
  const by = {}; L.forEach(p => { const a = areaOf(p); ((by[a.st] = by[a.st] || {})[a.un] = by[a.st][a.un] || []).push(p); });
  const row = p => { const own = p.ov === 'inc' || p.ov === 'exc';
    return `<tr><td><a href="#" data-act="detail" data-id="${esc(p.id)}">${esc(p.name)}</a></td><td class="n">${p.age ?? ''}</td><td>${esc((p.status || '').replace(/_/g, ' ').toLowerCase())}</td><td>${p.s === 'in' ? '<span class="chip good">Checked in</span>' : ''}</td>
      <td><span class="chip ${p.inc ? 'good' : 'bad'}">${p.inc ? 'Counted' : 'Left out'}</span>${own ? ' <small class="muted">by hand</small>' : ''}</td>
      <td class="adm">${p.inc ? `<button class="btn small" data-act="ovr" data-id="${esc(p.id)}" data-v="exc">Leave out</button>` : `<button class="btn small" data-act="ovr" data-id="${esc(p.id)}" data-v="inc">Include</button>`}${own ? ` <button class="linkbtn" data-act="ovr" data-id="${esc(p.id)}" data-v="">Undo</button>` : ''}</td></tr>`; };
  const open = UI.nmOpen || (UI.nmOpen = new Set()), cnt = l => { const n = l.filter(p => p.inc).length; return `${nn(l.length, 'youth', 'youth')}${n && n < l.length ? ` · ${n} counted` : ''}`; };
  const tbl = l => `<div class="tablewrap nm-tbl"><table><thead><tr><th>Name</th><th class="n">Age</th><th>Status</th><th></th><th>In this session</th><th class="adm"></th></tr></thead><tbody>${l.map(row).join('')}</tbody></table></div>`;
  let h = '';
  for (const st of Object.keys(by).sort((a, b) => a.localeCompare(b))) {
    const units = by[st], all = Object.values(units).flat(), so = open.has(st), nu = Object.keys(units).length;
    h += `<button class="nm-row st" data-act="nmToggle" data-v="${esc(st)}" aria-expanded="${so}"><span class="caret">${so ? '▾' : '▸'}</span><b>${esc(st)}</b><small class="muted">${nn(nu, 'ward or branch', 'wards and branches')}</small><span class="nm-n">${cnt(all)}</span></button>`;
    if (!so) continue;
    for (const un of Object.keys(units).sort((a, b) => a.localeCompare(b))) {
      const l = units[un].sort((a, b) => a.name.localeCompare(b.name)), k = st + '|' + un, uo = open.has(k), bp = l.find(p => p.bishopN || p.bishopE);
      h += `<button class="nm-row un" data-act="nmToggle" data-v="${esc(k)}" aria-expanded="${uo}"><span class="caret">${uo ? '▾' : '▸'}</span><b>${esc(un)}</b>${bp ? `<small class="muted">${esc(bp.bishopN || '')}${bp.bishopE ? ' · ' + esc(bp.bishopE) : ''}</small>` : ''}<span class="nm-n">${cnt(l)}</span></button>`;
      if (uo) h += tbl(l);
    }
  }
  box.innerHTML = `<div class="fold-tools"><button class="btn small" data-act="nmCsv">Export CSV for bishops</button></div><p class="note" style="margin:0 0 8px">${out ? 'Left out of the expected list and groups (unticked under Registration statuses).' : 'Counted as registered (ticked under Registration statuses).'} Tap a stake, then a unit. Include or leave out one person on their row.</p>
    <div class="nm-list">${h}</div>`;
}
/* Which record of a pair to keep: the one checked in, then an approved one, then one linked to an account (staff), then the older one */
function dupKeepFirst(d) {
  const sc = x => { const r = x.rec; return x.kind === 'p' ? [r.s === 'in' || r.s === 'out' ? 0 : 1, r.status && r.status !== 'APPROVED' ? 1 : 0, dupWhen(x) || 9e15] : [0, dupLinked(r.id) ? 0 : 1, dupWhen(x) || 9e15]; };
  const a = sc(d.a), b = sc(d.b); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? [d.a, d.b] : [d.b, d.a];
  return [d.a, d.b];
}
function dupLinked(id) { return Object.values(S.invites || {}).some(v => v && v.staffId === id); }
/* the extra copies to delete, one per pair; a person with three copies loses two */
function dupPlan(onlyLikely) {
  const gone = new Map(), kept = new Set();
  for (const d of findDuplicates()) {
    if (onlyLikely && !d.high) continue;
    if (d.a.kind === 'p' ? !can.deleteP() : !can.staff()) continue;
    if (gone.has(d.a.id) || gone.has(d.b.id)) continue;
    const [keep, drop] = dupKeepFirst(d);
    if (drop.kind === 's' && drop.rec.fromAccount) continue;
    if (kept.has(drop.id)) continue;
    gone.set(drop.id, drop); kept.add(keep.id);
  }
  return [...gone.values()];
}
async function deleteDuplicates(onlyLikely) {
  const plan = dupPlan(onlyLikely); if (!plan.length) { toast('Nothing to delete'); return; }
  const P = plan.filter(x => x.kind === 'p'), T = plan.filter(x => x.kind === 's');
  const ok = await confirmTyped(`Delete ${nn(plan.length, 'extra record')}?`, `${P.length ? nn(P.length, 'participant record') : ''}${P.length && T.length ? ' and ' : ''}${T.length ? nn(T.length, 'staff record') : ''} ${plan.length === 1 ? 'is' : 'are'} deleted, one from each ${onlyLikely ? '<b>Likely</b> ' : ''}pair. In each pair the app keeps the record that is checked in, then the approved one, then the older one.${onlyLikely ? '' : ' Pairs marked <b>Possible</b> are included: mark any that are two different people as <b>Not a duplicate</b> first.'} Press Rebalance afterwards.`, 'DELETE', 'Delete all');
  if (!ok) return;
  toast('Deleting…');
  try {
    if (P.length) {
      const byB = {}; P.forEach(x => (byB[bucketOf(x.id)] = byB[bucketOf(x.id)] || []).push(x.id));
      for (const b in byB) { const m = Object.assign({}, S.roster[b]); byB[b].forEach(id => delete m[id]); S.roster = Object.assign({}, S.roster, { [b]: m }); await setDoc('roster/' + b, { p: m }); }
      const st = {}; P.forEach(x => st[x.id] = { del: true, g: null }); await setStates(st);
    }
    if (T.length) { const ids = new Set(T.map(x => x.id)); unlinkDeleted(ids); const s2 = {}; for (const k in S.staff) if (!ids.has(k)) s2[k] = S.staff[k]; S.staff = s2; recompute(true); await setDoc('staff/all', { s: s2 }); }
    audit('settings', `Deleted ${plan.length} duplicate records (${onlyLikely ? 'likely pairs' : 'all pairs'}): ${plan.slice(0, 30).map(x => x.name).join(', ')}${plan.length > 30 ? '…' : ''}`);
    recompute(true); toast(`${nn(plan.length, 'duplicate')} deleted. Press Rebalance on Companies & groups.`);
  } catch (e) { fail(e); }
}
function renderDups() {
  const box = $('#dDup'); if (!box) return;
  const D = findDuplicates(), n = $('#dupN'); if (n) { n.textContent = D.length || 'None'; n.className = 'chip ' + (D.some(d => d.high) ? 'bad' : D.length ? 'warn' : 'good'); }
  if (!D.length) { box.innerHTML = '<p class="note">None found.</p>'; return; }
  const show = UI.dupAll ? D : D.slice(0, DUP_LIMIT);
  const pp = D.filter(d => d.a.kind === 'p'), nm = pp.filter(d => d.a.rec.member === false || d.b.rec.member === false).length, known = S.P.some(p => p.member != null);
  const nA = dupPlan(false).length;
  const bulk = nA ? `<div class="fold-tools dup-bulk"><button class="btn small danger" data-act="dupDelAll" data-v="all">Delete all duplicates (${nA})</button></div>` : '';
  box.innerHTML = `${bulk}${known && pp.length ? `<p class="note" style="margin:0 0 8px"><b>${nm} of ${nn(pp.length, 'participant pair')}</b> involve a youth with no MRN.</p>` : ''}<div class="dup-list">${show.map(d => `<div class="dup ${d.high ? 'high' : ''}"><div class="dup-why"><span class="chip ${d.high ? 'bad' : 'warn'}">${d.high ? 'Likely' : 'Possible'}</span>${d.why.map(w => `<span class="chip">${esc(w)}</span>`).join('')}<button class="linkbtn adm" data-act="dupIgnore" data-v="${esc(d.key)}">Not a duplicate</button></div>${(() => { const [o, n] = dupWhen(d.a) <= dupWhen(d.b) ? [d.a, d.b] : [d.b, d.a], same = dupWhen(o) === dupWhen(n) || !dupWhen(o) || !dupWhen(n), df = dupDiffs(o, n); return `<div class="dup-pair">${dupCard(o, same ? '' : 'Older')}${dupCard(n, same ? '' : 'Newer')}</div>${df.length ? `<p class="note dup-diff"><b>${same ? 'Differs' : 'Changed in the newer one'}:</b> ${df.map(esc).join(' · ')}</p>` : ''}`; })()}</div>`).join('')}</div>
    ${D.length > DUP_LIMIT ? `<button class="btn small" data-act="dupAll">${UI.dupAll ? 'Show fewer' : `Show all ${D.length}`}</button>` : ''}`;
}

/* page: data */
PAGE_IMPL.data = {
  frame() {
    return `<section class="pagehead"><div><h1>Data & areas</h1><p class="note" style="margin:4px 0 0">Upload the FSY portal export, choose which stakes and units belong to this session, and clean up problem records.</p></div><div class="btnrow">${can.admin() ? '<button class="btn primary adm" data-act="impPick">Upload participants or staff</button>' : ''}<button class="btn" data-act="expAll">Export everything (Excel)</button><button class="btn" data-act="expPart">Participants (CSV)</button><button class="btn" data-act="expStaff">Staff (CSV)</button>${infoBtn('data', 'About uploading and exporting')}</div></section>
    ${infoCard('data', 'Uploading and exporting', `<h4>Upload</h4><ul><li>Excel (.xlsx, .xls) or .csv. Column headers are read from the first row and matched to fields; you can adjust the matches before saving.</li><li>Rows are matched by <b>Registration ID</b>, so a newer export updates people without losing check-ins or groups.</li><li>The <b>Type</b> column decides who is a participant, counselor or assistant coordinator.</li></ul><h4>Export</h4><ul><li><b>Excel</b> has three tabs: <b>Everyone</b> (youth, walk-ins and staff in the same columns, with T-shirt, company, group and check-in), <b>Participants</b> and <b>Staff</b>.</li><li>The <b>CSV</b> files keep exactly the columns you uploaded, so they can be edited and uploaded again. Company and Group are always the last two columns.</li></ul>`)}
    <input type="file" id="impFile" class="vh" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"><div class="panel adm" id="impPanel" hidden><div class="panel-head"><h2>Upload participants or staff</h2><label class="btn small" for="impFile">Choose another file</label></div><div id="impBox"></div></div>
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
    ${foldSec('nmPanel', 'No MRN', 'nmN', '', '<div id="dNm"></div>', 'Youth registered without a membership record number (the portal\'s hasMrn), usually added by leaders as non-members. Whether they count is set under Registration statuses.')}
    ${foldSec('dupPanel', 'Possible duplicates', 'dupN', '', '<div id="dDup"></div>', 'Same first name and another name, plus the same birthday, age, contact or ward. Check each pair, then delete the extra record or mark it as not a duplicate.')}
    ${can.deleteP() ? `<div id="dzData">${resetPanel()}</div>` : ''}
    <div class="panel"><div class="panel-head"><h2>Stakes, wards and branches in this session</h2><span class="note">Untick an area to leave its youth out of the expected list and the groups.</span></div><div id="dAreas" class="arealist"></div></div>`;
  },
  update() {
    if ($('#fitRow')) $('#fitRow').innerHTML = fitHint();
    renderDups(); renderNonMembers();
    const P = S.P, ex = new Set(S.config.excludedStatuses || []);
    const statuses = uniq(P.map(p => p.status).filter(Boolean)).sort();
    $('#dStat').innerHTML = statuses.length ? statuses.map(s => `<label class="inline" style="padding:3px 0"><input type="checkbox" data-act="stat" data-v="${esc(s)}" ${ex.has(s) ? '' : 'checked'}> ${esc(s.replace(/_/g, ' ').toLowerCase())} <span class="muted num">${P.filter(p => p.status === s).length}</span></label>`).join('') + (P.some(p => p.member === false) ? `<label class="inline" style="padding:3px 0;margin-top:4px;border-top:1px solid var(--line)"><input type="checkbox" data-act="nmStat" ${S.config.excludeNonMembers ? '' : 'checked'}> no MRN <span class="muted num">${P.filter(p => p.member === false && p.src !== 'walkin').length}</span> <button class="linkbtn" data-act="nmShow">See list</button></label>` : '') + '<p class="note">Ticked statuses count as registered. Unticked ones show up as exceptions if they check in.</p>' : '<p class="note">Statuses appear after the first upload.</p>';
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
/* After an upload: how many of the uploaded youth count, and why the others don't */
function impBreakdown(ids) {
  if (!ids.length) return '';
  const byId = {}; S.P.forEach(p => byId[p.id] = p);
  const del = ids.filter(id => ((S.state[bucketOf(id)] || {})[id] || {}).del), present = ids.map(id => byId[id]).filter(Boolean);
  if (present.length + del.length < ids.length) return '<p class="note" style="margin:6px 0 0">Counting…</p>';
  const counted = present.filter(p => p.inc), out = present.filter(p => !p.inc);
  const why = { status: 0, area: 0, nonmember: 0, hand: 0 };
  out.forEach(p => { if (p.ov === 'exc') why.hand++; else if (p.flags.includes('status')) why.status++; else if (p.flags.includes('area')) why.area++; else if (p.flags.includes('nonmember')) why.nonmember++; });
  const li = [];
  if (why.status) li.push(`<li><b>${why.status}</b> have a status that is unticked under Registration statuses (for example cancelled)</li>`);
  if (why.area) li.push(`<li><b>${why.area}</b> are in stakes or units that are unticked in the list of stakes, wards and branches below</li>`);
  if (why.nonmember) li.push(`<li><b>${why.nonmember}</b> have no MRN, and "no MRN" is unticked under Registration statuses</li>`);
  if (why.hand) li.push(`<li><b>${why.hand}</b> were left out by hand on their record</li>`);
  if (del.length) li.push(`<li><b>${del.length}</b> were deleted in the app before (for example as duplicates), so they stay hidden. <button class="linkbtn" data-act="impRestore">Bring them back</button></li>`);
  return `<p style="margin:6px 0 0"><b>${counted.length}</b> of ${ids.length} count as registered in this session.</p>${li.length ? `<ul class="imp-why">${li.join('')}</ul>` : ''}<p class="note" style="margin:4px 0 0">Next: check Possible duplicates and No MRN, then press Rebalance on Companies & groups.</p>`;
}
function renderImport() {
  const box = $('#impBox'); if (!box) return; const I = UI.imp; const pnl = $('#impPanel');
  if (pnl) { const was = pnl.hidden; pnl.hidden = !I; if (was && I && !I.done) pnl.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  if (!I) { box.innerHTML = ''; return; }
  if (I.done) { box.innerHTML = `<div class="log"><button class="x log-x" data-act="impCancel" aria-label="Dismiss">×</button><b>${esc(I.done)}</b>${impBreakdown(I.ids || [])}</div>`; return; }
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
/* Export in the same layout as the upload: the original columns, in order, then Company and Group. */
const PORTAL_HEADERS = ['First Name', 'Last Name', 'Preferred Name', 'Birthday', 'Gender', 'Phone', 'Email', 'Medical Information', 'T-shirt Size', 'Dietary Information', 'Contact 1 Name', 'Contact 1 Email', 'Contact 1 Phone', 'Contact 2 Name', 'Contact 2 Email', 'Contact 2 Phone', 'Age', 'Date', 'Status', 'Type', 'Stake - District Name', 'Ward - Branch Name', "Bishop's Email", "Bishop's Name", 'Registration ID'];
const FORM_HEADERS = ['Timestamp', 'Enter your name and surname. eg Jane Dore', 'Enter your date birth . eg 11/12/2004', 'Your phone number', 'Your email', 'Ward/branch', 'T-shirt size', 'Gender', 'Food allergies', 'Type'];
const SIZE_WORD = { XS: 'Extra Small', S: 'Small', M: 'Medium', L: 'Large', XL: 'XL', XXL: 'XXL', '3XL': '3XL' };
const dmy = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
function partValue(p, f) {
  switch (f) {
    case 'first': return p.first || ''; case 'last': return p.last || ''; case 'pref': return p.pref || ''; case 'fullname': return p.name || '';
    case 'bday': return p.bday || ''; case 'gender': return p.gender || ''; case 'phone': return p.phone || ''; case 'email': return p.email || '';
    case 'med': return p.med || ''; case 'diet': return p.diet || ''; case 'tshirt': return SIZE_WORD[p.tshirt] || p.tshirt || '';
    case 'c1n': return p.c1n || ''; case 'c1e': return p.c1e || ''; case 'c1p': return p.c1p || ''; case 'c2n': return p.c2n || ''; case 'c2e': return p.c2e || ''; case 'c2p': return p.c2p || '';
    case 'age': return p.ageCsv != null ? p.ageCsv : (p.age != null ? p.age : ''); case 'regDate': return p.regDate || ''; case 'status': return p.status || (p.src === 'walkin' ? 'WALK_IN' : '');
    case 'type': return p.src === 'walkin' ? 'WALK-IN' : 'PARTICIPANT'; case 'stake': return p.stake || ''; case 'unit': return p.unit || '';
    case 'bishopE': return p.bishopE || ''; case 'bishopN': return p.bishopN || ''; case 'member': return p.member === true ? 'Yes' : p.member === false ? 'No' : ''; case 'regId': return /^X[a-z0-9]+$/.test(p.id) || p.src === 'walkin' ? '' : p.id;
  }
  return '';
}
function participantRows() {
  const cols = S.config.partCols, headers = cols && cols.headers && cols.headers.length ? cols.headers : PORTAL_HEADERS;
  const map = cols && cols.map ? cols.map : autoMap(headers);
  const rows = [headers.concat(['Company', 'Group'])];
  S.P.slice().sort((a, b) => (a.stake || '').localeCompare(b.stake || '') || (a.unit || '').localeCompare(b.unit || '') || a.name.localeCompare(b.name)).forEach(p => {
    const r = headers.map((h, i) => { const f = map[i] || map[String(i)]; if (f === 'med' || f === 'diet') return partValue(p, f); if (Array.isArray(p.raw) && i < p.raw.length && p.raw[i] != null) return p.raw[i]; return f ? partValue(p, f) : ''; });
    rows.push(r.concat([p.company ? 'Company ' + p.company.num : '', p.group ? 'G' + p.group.num : '']));
  });
  return rows;
}
function exportParticipants() { const rows = participantRows(); audit('settings', `Exported all ${rows.length - 1} participants`); exportCSV('fsy-participants-' + new Date().toISOString().slice(0, 10) + '.csv', rows); }
function staffPlace(s) {
  const G = Object.values(S.org.groups), C = S.org.companies;
  if (s.role === 'counselor') { const g = G.find(g => g.counselorId === s.id); return g ? [g.companyId && C[g.companyId] ? 'Company ' + C[g.companyId].num : '', 'G' + g.num] : ['', '']; }
  if (s.role === 'ac') { const c = Object.values(C).find(c => c.acId === s.id); return [c ? 'Company ' + c.num : '', '']; }
  if (s.role === 'coordinator') return ['All companies', ''];
  return ['', ''];
}
function staffValue(s, f) {
  switch (f) {
    case 'ts': return s.addedAt ? new Date(s.addedAt).toLocaleString('en-GB').replace(',', '') : '';
    case 'name': return s.name || ''; case 'bday': return dmy(s.bday) || (s.ageCsv != null ? s.ageCsv : '');
    case 'phone': return s.phone || ''; case 'email': return s.email || ''; case 'unit': return s.unitRaw || s.unit || ''; case 'stake': return s.stake || '';
    case 'tshirt': return s.tshirt || ''; case 'gender': return s.gender === 'F' ? 'Female' : s.gender === 'M' ? 'Male' : '';
    case 'diet': return s.diet || ''; case 'med': return s.med || ''; case 'role': return ({ ac: 'AC' })[s.role] || ROLES[s.role] || s.role || '';
  }
  return '';
}
function staffRows() {
  const cols = S.staffCols, headers = cols && cols.headers && cols.headers.length ? cols.headers : FORM_HEADERS;
  const map = cols && cols.map ? cols.map : sfMap(headers);
  const fieldAt = i => map[i] || map[String(i)];
  // the role always comes out up to date, even when the form said something else
  const roleCol = headers.findIndex((h, i) => fieldAt(i) === 'role'); const hs = roleCol >= 0 ? headers : headers.concat(['Type']);
  const rows = [hs.concat(['Company', 'Group'])];
  S.staffList.filter(x => !x.test).slice().sort((a, b) => (ROLES[a.role] || '').localeCompare(ROLES[b.role] || '') || a.name.localeCompare(b.name)).forEach(x => {
    const r = headers.map((h, i) => { const f = fieldAt(i); if (f === 'role' || f === 'name') return staffValue(x, f); if (Array.isArray(x.raw) && i < x.raw.length && x.raw[i] !== '') return x.raw[i]; return f ? staffValue(x, f) : ''; });
    if (roleCol < 0) r.push(staffValue(x, 'role'));
    rows.push(r.concat(staffPlace(x)));
  });
  return rows;
}
function exportStaff() { const rows = staffRows(); audit('staff', `Exported all ${rows.length - 1} staff`); exportCSV('fsy-staff-' + new Date().toISOString().slice(0, 10) + '.csv', rows); }
/** Everyone in one list with the same columns: expected youth, walk-ins and staff. */
function everyoneRows() {
  const est = (S.tee && S.tee.perPerson) || {}, st = staffTee();
  const rows = [['Name', 'Type', 'Gender', 'Age', 'Phone', 'Email', 'Ward/branch', 'Stake/district', 'T-shirt', 'Company', 'Group', 'Checked in']];
  const yth = S.P.filter(p => isExpected(p) || p.src === 'walkin').sort((a, b) => a.name.localeCompare(b.name));
  yth.forEach(p => rows.push([p.name, p.src === 'walkin' ? 'Walk-in' : 'Participant', p.gender === 'F' ? 'Female' : p.gender === 'M' ? 'Male' : '', p.age ?? '', p.phone || p.c1p || '', p.email || '', p.unit || '', p.stake || '', p.tshirt || (est[p.id] ? est[p.id] + ' (est.)' : ''), p.company ? 'Company ' + p.company.num : '', p.group ? 'G' + p.group.num : '', p.s === 'in' ? 'Yes' : p.s === 'out' ? 'Checked out' : 'No']));
  S.staffList.filter(x => !x.test).sort((a, b) => (STAFF_ROLES.indexOf(a.role) - STAFF_ROLES.indexOf(b.role)) || a.name.localeCompare(b.name)).forEach(x => { const pl = staffPlace(x), a = staffAge(x, S.config);
    rows.push([x.name, ROLES[x.role] || x.role, x.gender === 'F' ? 'Female' : x.gender === 'M' ? 'Male' : '', a ?? '', x.phone || '', x.email || '', x.unit || x.unitRaw || '', x.stake || '', x.tshirt || (st.perPerson[x.id] ? st.perPerson[x.id] + ' (est.)' : ''), pl[0], pl[1], '']); });
  (S.config.otherRoles || []).filter(o => o && +o.count > 0).forEach(o => rows.push([`${o.name || 'Other'} (${+o.count} ${+o.count === 1 ? 'person' : 'people'})`, 'Other', '', '', '', '', '', '', '', '', '', '']));
  return rows;
}
/** One Excel file: Everyone, Participants (upload layout) and Staff (form layout). */
async function exportWorkbook() {
  if (typeof XLSX === 'undefined' || !XLSX.utils) { toast('The spreadsheet tool did not load. Check your connection and reload.', true); return; }
  const sheet = (rows, widths) => { const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = rows[0].map((h, i) => ({ wch: widths ? widths[i] || 14 : Math.min(40, Math.max(10, String(h).length + 2, ...rows.slice(1, 200).map(r => String(r[i] == null ? '' : r[i]).length + 1))) })); if (rows.length > 1 && ws['!ref']) ws['!autofilter'] = { ref: ws['!ref'] }; return ws; };
  const wb = XLSX.utils.book_new();
  const ev = everyoneRows(), pr = participantRows(), sr = staffRows();
  XLSX.utils.book_append_sheet(wb, sheet(ev, [28, 22, 8, 5, 14, 28, 22, 26, 12, 11, 7, 11]), 'Everyone');
  XLSX.utils.book_append_sheet(wb, sheet(pr), 'Participants');
  XLSX.utils.book_append_sheet(wb, sheet(sr), 'Staff');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  audit('settings', `Exported everything to Excel: ${ev.length - 1} people, ${pr.length - 1} participant records, ${sr.length - 1} staff`);
  try { await S.dl.save({ filename: 'fsy-everyone-' + new Date().toISOString().slice(0, 10) + '.xlsx', data: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) }); } catch (e) { if (e && e.code !== 'declined') toast('The file was not saved.', true); }
}
async function doImport() {
  const I = UI.imp; const rec = rowsToRecords(I.rows, I.map, I.mode, Date.now());
  I.busy = 'Saving…'; renderImport();
  try {
    const byB = {}, medB = {}; rec.participants.forEach(p => { const id = p.id; const b = bucketOf(id); const r = Object.assign({}, p); delete r.id; (medB[b] = medB[b] || {})[id] = { med: r.med || '', diet: r.diet || '' }; delete r.med; delete r.diet; (byB[b] = byB[b] || {})[id] = r; });
    const bs = Object.keys(byB); let n = 0;
    for (const b of bs) { const mx = S.medicalEx.has(b); S.medicalEx.add(b); await upd('medical/' + b, { p: medB[b] }, mx); const ex = S.rosterEx.has(b); S.rosterEx.add(b); await upd('roster/' + b, { p: byB[b] }, ex); n++; I.busy = `Saving… ${Math.round(n / bs.length * 100)}%`; renderImport(); }
    if (rec.staff.length) { const s = {}; rec.staff.forEach(x => { if (!S.staff[x.id]) { x.addedAt = Date.now(); x.addedBy = S.meName || ''; } else if (S.staff[x.id].addedAt) x.addedAt = S.staff[x.id].addedAt; s[x.id] = x; }); const ex = S.staffEx; S.staffEx = true; await upd('staff/all', { s }, ex); }
    await saveConfig({ partCols: { headers: I.rows[0].map(h => String(h == null ? '' : h)), map: Object.fromEntries(Object.entries(I.map).map(([k, v]) => [String(k), v])) } });
    audit('settings', `Uploaded ${I.name}: ${rec.participants.length} participants and ${rec.staff.length} staff`);
    UI.imp = { done: `Imported ${rec.participants.length} participants and ${rec.staff.length} staff.`, ids: rec.participants.map(p => p.id) };
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
  UI.genLog = { title: 'Rebalanced. Existing groups were kept.', lines: r.log }; audit('groups', `Pressed Rebalance: ${nn(Object.keys(r.changes).length, 'participant')} moved`);
  await saveOrg(r.org, { at: Date.now(), mode: 'rebalance' });
  const ch = {}; for (const id in r.changes) ch[id] = { g: r.changes[id] };
  await setStates(ch).catch(fail); toast('Groups and companies updated');
}
async function runRenumber() {
  const gs = Object.values(S.org.groups); if (!gs.length) { toast('There are no groups to number yet.', true); return; }
  const inN = S.P.filter(p => p.s).length;
  const ok = await confirmBox('Renumber groups by company?', `Groups are numbered in company order: Company 1's groups first (young women, then young men), then Company 2, and so on. Companies are numbered 14–15 first, then 16–18. Nobody changes group or counselor, only the numbers.${inN ? ` <br><br><b>${inN} youth have already checked in.</b> Counselors and printed rosters may already use the old numbers.` : ''}<br><br>Numbers are then <b>locked</b>: Rebalance keeps them, and new groups fill free numbers first.`, 'Renumber and lock', !!inN);
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
  if (S.config.regenLock) { toast('Companies are official, so they cannot be regenerated. Use Rebalance, or ask the registration admin or Session Directing Couple to unlock them.', true); return; }
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
    case 'myDetails': closeModal(); openMyDetails(); break;
    case 'addMe': { closeModal(); openStaffForm(null); setTimeout(() => { const n = $('#stName'), e2 = $('#stEmail'); if (n) n.value = titleCase(S.meName || ''); if (e2) e2.value = S.email || ''; const rl = $('#stRole'); const rr = realRole(); if (rl && STAFF_ROLES.includes(rr)) rl.value = rr; }, 80); break; }
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
    case 'useAll': {
      const on = v === 'on', sz = { groupSizeF: gsize(S.config, 'F'), groupSizeM: gsize(S.config, 'M'), groupSize: gsize(S.config, 'F'), useAll: on };
      if (on && !await confirmBox('Give every counselor a group?', `Counselors without a group each get a new group, made from one or two youth taken from the biggest groups of the same gender and age band. Groups end up smaller than ${sz.groupSizeF === sz.groupSizeM ? sz.groupSizeF : 'the set size'}. This stays on for future Rebalances until you turn it off.`, 'Give them groups')) break;
      await saveSizes(sz); if (on) await runRebalance(); else toast('Turned off. Rebalance now fills groups up to the set size before opening new ones.');
      UI.frameKey = ''; render(); break; }
    case 'renumber': await runRenumber(); break;
    case 'dupIgnore': { const l = (S.config.dupIgnore || []).concat([v]); audit('settings', 'Marked a possible duplicate pair as two different people'); await saveConfig({ dupIgnore: l }); toast('Marked as not a duplicate'); break; }
    case 'nmCsv': { const L = S.P.filter(p => p.member === false && p.src !== 'walkin').sort((a, b) => areaOf(a).st.localeCompare(areaOf(b).st) || areaOf(a).un.localeCompare(areaOf(b).un) || a.name.localeCompare(b.name));
      exportCSV('no-mrn-youth-' + new Date().toISOString().slice(0, 10) + '.csv', [['Stake / district', 'Ward / branch', 'Bishop or branch president', 'Bishop email', 'First name', 'Last name', 'Birthday', 'Age', 'Phone', 'Contact 1 name', 'Contact 1 phone', 'Registration ID', 'Is a member? (bishop to fill in)']].concat(L.map(p => [areaOf(p).st, areaOf(p).un, p.bishopN || '', p.bishopE || '', p.first || '', p.last || '', p.bday || '', p.age ?? '', p.phone || '', p.c1n || '', p.c1p || '', p.id, '']))); audit('settings', `Exported the list of ${L.length} youth with no MRN`); break; }
    case 'nmToggle': { const o = UI.nmOpen || (UI.nmOpen = new Set()); o.has(v) ? o.delete(v) : o.add(v); renderNonMembers(); break; }
    case 'dupDelAll': await deleteDuplicates(v === 'likely'); break;
    case 'teePdf': await printTeeOrder(); break;
    case 'xlEdit': if (can.teeEdit()) openExtraLogistics(); break;
    case 'xlSave': await saveExtraLogistics(); break;
    case 'teeRolePdf': await printTeeByRole(); break;
    case 'teeEdit': if (can.teeEdit()) openTeeEditor(); break;
    case 'teeSug': { const B = teeBlanks(UI.teeL || S.P.filter(p => p.inc || p.s)); document.querySelectorAll('.te-in').forEach(i => { i.value = +(B.sug[i.dataset.k][i.dataset.z] || 0); }); teeLeft(); break; }
    case 'teeSave': { const o = teeRead(); const B = teeBlanks(UI.teeL || S.P.filter(p => p.inc || p.s)); const same = ['y', 's'].every(k => SIZE_ORDER.every(z => (+(o[k][z] || 0)) === (+(B.sug[k][z] || 0)))); await saveTeeSplit(same ? null : o); break; }
    case 'nmShow': openFold('nmPanel'); break;
    case 'dupAll': UI.dupAll = !UI.dupAll; renderDups(); break;
    case 'logClose': UI.genLog = null; render(); break;
    case 'info': { const c = $('#info-' + v); if (!c) break; c.hidden = !c.hidden; document.querySelectorAll(`.ibtn[data-v="${v}"]`).forEach(b => { b.setAttribute('aria-expanded', String(!c.hidden)); b.classList.toggle('on', !c.hidden); }); if (!c.hidden) c.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); break; }
    case 'hcReset': await resetHeadcounts(v); break;
    case 'expAll': await exportWorkbook(); break;
    case 'expPart': exportParticipants(); break;
    case 'expStaff': exportStaff(); break;
    case 'chkGo': { UI.coQ = v; UI.band = ''; if (id) UI.open.add(id); const q = $('#coQ'); if (q) q.value = v; render(); const f = $('#coFind'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
    case 'regen': await runRegen(); break;
    case 'regenLock': { if (!can.lockRegen()) break; if (v === 'on') { if (!await confirmBox('Mark companies as official?', 'Regenerate all and Undo all groups are switched off for everyone. Coordinators and leaders can still press <b>Rebalance</b>, which keeps every group and company and only places newcomers or fills gaps. Only the registration admin or the Session Directing Couple can unlock this.', 'Mark official')) break; await saveConfig({ regenLock: { at: Date.now(), by: S.meName || S.email || '' } }); audit('groups', 'Marked companies as official (Regenerate all locked)'); toast('Companies are official'); }
      else { if (!await confirmBox('Unlock companies?', 'Regenerate all and Undo all groups become available again. Regenerating would put everyone in new groups.', 'Unlock', true)) break; await saveConfig({ regenLock: null }); audit('groups', 'Unlocked companies (Regenerate all allowed again)'); toast('Companies unlocked'); }
      UI.frameKey = ''; render(); break; }
    case 'addCo': { const band = await new Promise(res => { openModal(`<div class="modal-head"><h2>Add a company</h2><button class="x" data-act="close" aria-label="Close">×</button></div><p class="note">An empty company is created. Move groups into it with the Company picker inside each group, or press Rebalance to fill it automatically with a spare AC.</p><div class="btnrow"><button class="btn primary" id="aY">14–15 company</button><button class="btn primary" id="aO">16–18 company</button></div>`); $('#aY').onclick = () => { closeModal(); res('Y'); }; $('#aO').onclick = () => { closeModal(); res('O'); }; }); if (!band) break; const cid = rid('c'); const num = Math.max(0, ...Object.values(S.org.companies).map(c => c.num)) + 1; await patchOrg({ companies: { [cid]: { id: cid, band, acId: null, coordId: null, num } } }); toast('Company ' + num + ' added'); break; }
    case 'delCo': { const c = S.org.companies[id]; if (!await confirmBox(`Remove Company ${c.num}?`, 'Its groups stay together and move to "Groups without a company". Press Rebalance to place them in other companies.', 'Remove company', true)) break; audit('groups', `Removed Company ${c.num}`); const o = { groups: {}, companies: Object.assign({}, S.org.companies) }; for (const g of Object.values(S.org.groups)) o.groups[g.id] = g.companyId === id ? Object.assign({}, g, { companyId: null }) : g; delete o.companies[id]; await saveOrg(o, S.orgGen); toast('Company removed'); break; }
    case 'delGrp': { const g = S.org.groups[id]; if (!await confirmBox(`Remove group G${g.num}?`, 'Its participants become unassigned. Press Rebalance to place them in other groups.', 'Remove group', true)) break; audit('groups', `Removed group G${g.num}`); const o = { groups: Object.assign({}, S.org.groups), companies: S.org.companies }; delete o.groups[id]; await saveOrg(o, S.orgGen); const ch = {}; S.P.filter(p => p.g === id).forEach(p => ch[p.id] = { g: null }); await setStates(ch).catch(fail); toast('Group removed'); break; }
    case 'rosterCsv': { const rows = [['Company', 'Age group', 'AC', 'Group', 'Counselor', 'Participant', 'Gender', 'Age', 'Ward/branch', 'Stake', 'T-shirt', 'Status']]; S.P.filter(p => p.group).sort((a, b) => (a.company ? a.company.num : 999) - (b.company ? b.company.num : 999) || a.group.num - b.group.num || a.name.localeCompare(b.name)).forEach(p => rows.push([p.company ? p.company.num : '', BANDS[p.group.band], p.company ? sName(p.company.acId) : '', 'G' + p.group.num, p.counselor ? p.counselor.name : '', p.name, p.gender, p.age, p.unit, p.stake, p.tshirt, p.s || 'not arrived'])); exportCSV('fsy-rosters.csv', rows); break; }
    case 'tallyCsv': { const rows = [['Stake', 'Ward/branch', 'Expected', 'Checked in', 'Checked out']]; const m = {}; S.P.forEach(p => { const k = p.stake + '|' + p.unit; const x = m[k] = m[k] || [p.stake, p.unit, 0, 0, 0]; if (isExpected(p)) x[2]++; if (p.s === 'in') x[3]++; if (p.s === 'out') x[4]++; }); Object.values(m).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])).forEach(r => rows.push(r)); exportCSV('fsy-tally.csv', rows); break; }
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
    case 'plReload': PLAN.data = null; planLoad(); break;
    case 'plReset': PLAN.moves = {}; PLAN.sel = new Set(); for (const v in PLAN.virt) delete PLAN.data[v]; PLAN.virt = {}; PLAN.to = ''; render(); break;
    case 'plApply': await planApply(); break;
    case 'plUndoLast': await planUndoLast(); break;
    case 'plMoveSel': { const to = PLAN.to; if (!to) break; const n = PLAN.sel.size; PLAN.sel.forEach(k => { const [src, st] = k.split('\u0001'); if (to === src) delete PLAN.moves[k]; else PLAN.moves[k] = to; PLAN.open.add(to + '\u0001' + st); }); PLAN.sel = new Set(); render(); toast(`${nn(n, 'unit')} moved to ${PLAN.data[to].name} in the plan. Apply when ready.`); break; }
    case 'plUndoSt': { const [d, st] = v.split('\u0001'); for (const k of Object.keys(PLAN.moves)) { const p = k.split('\u0001'); if (p[1] === st && PLAN.moves[k] === d) delete PLAN.moves[k]; } render(); break; }
    case 'plSelClear': PLAN.sel = new Set(); render(); break;
    case 'plUndo': { const parts = v.split('\u0001'); if (parts.length === 3) delete PLAN.moves[v]; else for (const k in PLAN.moves) if (k.startsWith(v + '\u0001')) delete PLAN.moves[k]; render(); break; }
    case 'plNewSess': { const name = await askText('New session in the plan', 'Name for the planned session (it is only created if you apply the plan)'); if (!name) break; const id = 'v' + rid('');
      PLAN.virt[id] = { id, name, cfg: Object.assign({}, DEFAULT_CONFIG, { sessionName: name }), youth: [], staff: [] }; PLAN.data[id] = PLAN.virt[id]; PLAN.to = id; render(); break; }
    case 'plOpen': PLAN.open.has(v) ? PLAN.open.delete(v) : PLAN.open.add(v); render(); break;
    case 'sessDel': if (canDelSession(v)) await deleteSession(v); break;
    case 'nsGo': { if (!can.split()) break; const name = clean(($('#nsName') || {}).value || ''), start = ($('#nsStart') || {}).value || '';
      if (!name) { toast('Give the new session a name', true); break; }
      if (Object.values(S.sessions).some(x => x && clean(x.name).toLowerCase() === name.toLowerCase())) { toast('A session with that name already exists', true); break; }
      if (!await confirmBox(`Create ${esc(name)}?`, 'An empty session is created. You can open it straight away and upload its participants and staff. Registration admins, the Area Seventy and the Head of Logistics can open every session; give other people access on the Accounts page.', 'Create session')) break;
      const target = 's' + rid(''); toast('Creating the session…');
      try {
        const entry = { [target]: { name, at: Date.now(), by: S.meName || '', creator: S.email || '' } };
        await FB.fs.doc('meta/sessions').set({ s: entry }, { merge: true }); Object.assign(S.sessions, entry);
        if (realRole() === 'sdc') { const k = emailKey(S.email || ''), mine = invSessions(S.invites[k] || {}); if (!mine.includes(target)) await FB.fs.doc('invites/' + k).set({ sessions: mine.concat(target) }, { merge: true }); }
        await FB.fs.doc(rawPath(target, 'config/session')).set(Object.assign({}, DEFAULT_CONFIG, { sessionName: name, sessionStart: start }));
        if (!S.mySessions.includes(target)) S.mySessions.push(target);
        audit('session', `Created a new empty session: ${name}`); UI.sessCounts = null; if ($('#nsName')) $('#nsName').value = ''; if ($('#nsStart')) $('#nsStart').value = ''; render();
        toast(`${name} created`, false, { label: 'Open it', fn: () => { try { localStorage.setItem('fsy.session.' + S.uid, target); } catch (e) { } location.hash = 'data'; location.reload(); } });
      } catch (e) { fail(e); }
      break; }
    case 'spGo': { if (!can.split()) break; const sp = UI.split; const list = S.P.filter(p => sp.sel.has(areaOf(p).st + '|' + areaOf(p).un)); if (!list.length) break;
      const isNew = sp.dest === 'new', name = isNew ? clean(sp.name) : sessName(sp.dest); if (isNew && !name) { toast('Give the new session a name', true); break; }
      const units = uniq(list.map(p => areaOf(p).un)).length;
      if (!await confirmTyped(`Move ${list.length} participants to ${name}?`, `${list.length} youth from ${units} ward${units === 1 ? '' : 's'} and branch${units === 1 ? '' : 'es'} leave ${esc(sessName(S.sid))}, with their check-ins and medical notes. They leave their groups here. ${sp.team === 'same' ? 'The Session Directing Couple will be able to open both sessions.' : 'Set up the staff team and accounts in the new session.' + (realRole() === 'sdc' && isNew ? ' <b>You will not keep access to the new session</b>: a registration admin, the Area Seventy or the Head of Logistics sets up its team.' : '')}`, 'MOVE', 'Move participants')) break;
      const target = isNew ? 's' + rid('') : sp.dest; toast('Moving participants…');
      try { await moveParticipants(list, target, { isNew, name, team: sp.team }); UI.split = { dest: 'new', name: '', team: 'same', sel: new Set() }; UI.sessCounts = null; render(); toast(`${list.length} participants moved to ${name}`, false, { label: 'Open', fn: () => { try { localStorage.setItem('fsy.session.' + S.uid, target); } catch (e) { } location.hash = ''; location.reload(); } }); }
      catch (e) { fail(e); }
      break; }
    case 'resetOrg': { if (!can.reset()) break; if (S.config.regenLock) { toast('Companies are official. Unlock them first.', true); break; } if (!await confirmTyped('Undo all groups and companies?', `All ${Object.keys(S.org.groups).length} groups and ${Object.keys(S.org.companies).length} companies are removed, and every participant goes back to having no group. Check-ins stay. You can generate new companies afterwards.`, 'UNDO', 'Undo all groups and companies')) break; audit('groups', 'Undid all groups and companies'); await resetOrg(); toast('Groups and companies removed'); break; }
    case 'resetPart': { if (!can.deleteP()) break; const n = S.P.length; if (!n) break;
      if (!await confirmTyped(`Delete all ${n} participants?`, `Every youth and walk-in in <b>${esc(sessName(S.sid))}</b> is deleted, with their check-ins, medical notes and headcounts. Other sessions are not touched. Staff, groups and companies stay, so after uploading the participant file again, press Rebalance to fill the groups.${PLAN.undo ? ' <br><br>If the last applied plan caused the problem, <b>Undo last plan</b> on Plan sessions may fix it without deleting anyone.' : ''}`, 'DELETE', 'Delete all participants')) break;
      toast('Deleting participants…'); let failed = 0;
      for (const c of ['roster', 'state', 'medical', 'intake', 'share', 'headcount']) {
        try { const sn = await FB.fs.collection(rawPath(S.sid, c)).get(); for (const d of sn.docs) await FB.fs.doc(rawPath(S.sid, c + '/' + d.id)).delete().catch(() => { failed++; }); } catch (e) { failed++; }
      }
      S.roster = {}; S.state = {}; S.medical = {}; S.rosterEx = new Set(); S.stateEx = new Set(); S.medicalEx = new Set(); S.hc = {}; recompute(true);
      audit('settings', `Deleted all ${n} participants in ${sessName(S.sid)}`);
      toast(failed ? `Participants deleted, but ${failed} parts were refused. Check that the latest firestore.rules are published.` : `All ${n} participants deleted. Upload the participant file on Data & areas.`, !!failed); break; }
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
    case 'stAdd': if (!can.addStaff()) { staffClosedNotice(); break; } openStaffForm(null); break;
    case 'stFold': UI.stFold = !UI.stFold; try { localStorage.setItem('fsy.stFold', UI.stFold ? '1' : '0'); } catch (e) { } if (PAGE_IMPL.staff && $('#stList')) PAGE_IMPL.staff.update(); else render(); break;
    case 'stView': UI.staffView = v; render(); break;
    case 'repNew': closeModal(); openReportForm(id); break;
    case 'repResolve': { const note = await askText('Mark as resolved', 'What was done? (optional)'); if (note === null) break; await updateReport(id, v, { status: 'resolved', resNote: note, resAt: Date.now(), resBy: S.uid, resByName: S.meName || S.email }); toast('Marked resolved'); break; }
    case 'repNote': { const note = await askText('Add a follow-up', 'Follow-up note'); if (!note) break; await updateReport(id, v, { resNote: note, resAt: Date.now(), resBy: S.uid, resByName: S.meName || S.email }); toast('Saved'); break; }
    case 'repReopen': await updateReport(id, v, { status: 'open' }); toast('Reopened'); break;
    case 'coQClear': UI.coQ = ''; { const i = $('#coQ'); if (i) i.value = ''; } render(); break;
    case 'wlRep': UI.wlRep = v; render(); break;
    case 'orAdd': { const l = (S.config.otherRoles || []).concat([{ name: '', count: 1 }]); await saveConfig({ otherRoles: l }); setTimeout(() => { const x = document.querySelectorAll('.or-name'); if (x.length) x[x.length - 1].focus(); }, 50); break; }
    case 'orInc': case 'orDec': { const l = (S.config.otherRoles || []).map(o => Object.assign({}, o)); const o = l[+v]; if (!o) break; o.count = Math.max(0, (+o.count || 0) + (act === 'orInc' ? 1 : -1)); audit('settings', `Set ${o.name || 'other role'} to ${o.count}`); await saveConfig({ otherRoles: l }); break; }
    case 'orDel': { const l = (S.config.otherRoles || []).slice(); const o = l[+v]; if (!o) break; if (!await confirmBox(`Remove ${o.name || 'this role'}?`, `${nn(+o.count || 0, 'person', 'people')} will no longer be counted.`, 'Remove')) break; l.splice(+v, 1); audit('settings', `Removed the other role ${o.name || ''}`); await saveConfig({ otherRoles: l }); break; }
    case 'audK': UI.audK = v; render(); break;
    case 'audMore': UI.audLimit = (UI.audLimit || 500) + 1000; render(); break;
    case 'audCsv': { const rows = [['When', 'Who', 'Email', 'Role', 'Kind', 'What']]; audFiltered().forEach(r => rows.push([new Date(r.at).toLocaleString(), r.name || '', r.email || '', ROLES[r.role] || r.role || '', AUDIT_KINDS[r.kind] || r.kind, r.text])); exportCSV('fsy-audit-log.csv', rows); break; }
    case 'spareToggle': UI.spareOpen = !UI.spareOpen; render(); break;
    case 'fitSizes': { const f = fitSizes(); const F = f.F.fit || f.F.now, M = f.M.fit || f.M.now; if (!await confirmBox('Change group sizes?', `Young women: <b>${F}</b> per group (now ${f.F.now}). Young men: <b>${M}</b> per group (now ${f.M.now}). Press <b>Rebalance</b> afterwards: every counselor who is free gets a group, made from one or two youth from each of the biggest groups of the same gender and age band.`, 'Change sizes')) break; await saveSizes({ groupSizeF: F, groupSizeM: M, groupSize: F, useAll: true }); UI.frameKey = ''; render(); toast('Group sizes changed. Press Rebalance to apply them.'); break; }
    case 'lgGo': { if (v === 'blank') { UI.foldSet = Object.assign(UI.foldSet || {}, { 'sec-tee': true }); if (location.hash === '#tee-blank') openFold('sec-tee'); else location.hash = 'tee-blank'; break; } openFold({ med: 'sec-med', diet: 'sec-diet', tee: 'sec-tee', steee: 'sec-steee' }[v]); break; }
    case 'accToggle': { const o = UI.accOpen || (UI.accOpen = new Set()); o.has(v) ? o.delete(v) : o.add(v); render(); break; }
    case 'accAllOpen': { UI.accOpen = new Set(v ? Object.keys(ROLES) : []); render(); break; }
    case 'accF': UI.accF = v; render(); break;
    case 'wlGo': { const map = { open: ['wl-rep', () => UI.wlRep = 'open'], urgent: ['wl-rep', () => UI.wlRep = 'urgent'], med: ['wl-youth', () => { UI.wlY = 'med'; UI.wlMore = false; }], diet: ['wl-youth', () => { UI.wlY = 'diet'; UI.wlMore = false; }], staff: ['wl-staff', () => { }] }[v]; if (!map) break; map[1](); UI.foldSet = Object.assign(UI.foldSet || {}, { [map[0]]: true }); render(); const d = document.getElementById(map[0]); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } break; }
    case 'wlY': UI.wlY = v; UI.wlMore = false; render(); break;
    case 'wlMore': UI.wlMore = true; render(); break;
    case 'wlCsv': { const rows = [['Who', 'Name', 'Role or group', 'Unit', 'Stake', 'Medical', 'Dietary', 'Checked in']]; registered().filter(p => p.medIssue || p.dietIssue).forEach(p => rows.push(['Youth', p.name, p.group ? 'G' + p.group.num : '', p.unit, p.stake, p.medIssue || '', p.dietIssue || '', p.s === 'in' ? 'yes' : ''])); S.staffList.filter(x => !x.test && (x.med || x.diet)).forEach(x => rows.push(['Staff', x.name, ROLES[x.role] || x.role, x.unit || '', x.stake || '', x.med || '', x.diet || '', ''])); rows.push([]); rows.push(['Concern', 'Participant', 'Kind', 'Urgent', 'Status', 'Reported', 'By', 'Details', 'Follow-up']); allReports().forEach(r => rows.push(['', r.pname || '', repKind(r.kind), r.urgent ? 'yes' : '', r.status, fmtWhen(r.at), r.byName || '', r.text, r.resNote || ''])); exportCSV('fsy-wellness.csv', rows); break; }
    case 'stPdf': printStaffList(UI.staffTab, v || ''); break;
    case 'stSpare': { const st = S.staffMap[id]; if (!st || !can.staff()) break; const on = !st.spare;
      if (on && !await confirmBox(`Mark ${esc(st.name)} as spare?`, `They stay on the staff list but are kept in reserve. Rebalance and Regenerate leave them out${st.role === 'counselor' ? ': no group is given to them, and if they lead a group now, the next Rebalance gives it to another counselor' : ': no company is given to them, and if they oversee one now, the next Rebalance gives it to another AC'}.`, 'Mark spare')) break;
      await saveStaffRec(Object.assign({}, S.staff[id] || st, { spare: on || null })); audit('staff', `${on ? 'Marked' : 'Unmarked'} ${st.name} as spare`, id); toast(on ? `${st.name} is spare. Press Rebalance to apply.` : `${st.name} is available again. Press Rebalance to give them a group.`); break; }
    case 'stLock': { if (!can.lockStaff()) break; const L = S.config.staffLock;
      if (!L && !await confirmBox('Close addition of staff?', 'Coordinators and everyone else can no longer add staff, import the staff form or make someone a counselor. The registration admin, the Session Directing Couple, the Area Seventy and the Head of Logistics still can. Editing and deleting existing records still works.', 'Close addition', true)) break;
      const v = L ? null : { at: Date.now(), by: S.meName || S.email || '' }; audit('staff', v ? 'Closed the addition of staff' : 'Opened the addition of staff'); await saveConfig({ staffLock: v }); toast(v ? 'Addition of staff closed' : 'Addition of staff opened'); break; }
    case 'sfGo': if (!can.addStaff()) { staffClosedNotice(); break; } await sfImport(); break;
    case 'sfCancel': { UI.sf = null; const f = $('#sfFile'); if (f) f.value = ''; renderSf(); break; }
    case 'sfPick': { if (!can.addStaff()) { staffClosedNotice(); break; } const f = $('#sfFile'); if (f) { f.value = ''; f.click(); } break; }
    case 'sfNewCancel': UI.sf.adding = null; renderSf(); break;
    case 'sfNewSave': { const st = clean(($('#sfNewStake') || {}).value), un = sfName(($('#sfNewUnit') || {}).value || ''); if (!st || !un) { toast('Type both the stake or district and the ward or branch', true); break; } UI.sf.choices[v] = st + '|' + un; UI.sf.adding = null; sfRun(); renderSf(); break; }
    case 'stEdit': if (can.staff()) openStaffForm(id); break;
    case 'stCsv': { const rows = [['Name', 'Role', 'Gender', 'Age', 'Ward/branch', 'Stake', 'Phone', 'Email', 'T-shirt', 'Food needs']]; S.staffList.slice().sort((a, b) => (a.stake || '').localeCompare(b.stake || '') || (a.unit || '').localeCompare(b.unit || '') || a.name.localeCompare(b.name)).forEach(s => rows.push([s.name, ROLES[s.role], s.gender, staffAge(s, S.config) ?? '', s.unit || '', s.stake || '', s.phone || '', s.email || '', s.tshirt || '', s.diet || ''])); exportCSV('fsy-staff.csv', rows); break; }
    case 'exCsv': { const L = PAGE_IMPL.exceptions.lists(); const rows = [['Type', 'Name', 'Age', 'Gender', 'Ward/branch', 'Stake', 'Status', 'Group']]; [['Walk-in', L.walk], ['Not on approved list', L.off], ['Checked in, no group', L.nog]].forEach(([t, list]) => list.forEach(p => rows.push([t, p.name, p.age ?? '', p.gender, p.unit, p.stake, p.s || 'not arrived', p.group ? 'G' + p.group.num : '']))); exportCSV('fsy-walkins-exceptions.csv', rows); break; }
    case 'stDel': { const st = S.staffMap[id]; if (st && st.fromAccount) { toast('This person comes from Accounts. Delete or change their account there.', true); break; } if (!await confirmBox(`Delete ${st.name}?`, 'If they lead a group or company, it loses its leader. Press Rebalance afterwards to fill the gap.', 'Delete', true)) break; audit('staff', `Deleted staff member ${st.name}`, id); const s = Object.assign({}, S.staff); delete s[id]; S.staff = s; recompute(true); await setDoc('staff/all', { s }).catch(fail); toast('Deleted'); break; }
    case 'impGo': await doImport(); break;
    case 'impPick': { const f = $('#impFile'); if (f) { f.value = ''; f.click(); } break; }
    case 'impRestore': { const ids = ((UI.imp || {}).ids || []).filter(id => ((S.state[bucketOf(id)] || {})[id] || {}).del); if (!ids.length) break;
      if (!await confirmBox(`Bring back ${nn(ids.length, 'participant')}?`, 'These records were deleted in the app before, for example as duplicates, and the upload contains them again. They come back as normal participants, without a group.', 'Bring them back')) break;
      const st = {}; ids.forEach(id => st[id] = { del: null }); await setStates(st); audit('settings', `Brought back ${ids.length} deleted participants from the upload`); toast(`${nn(ids.length, 'participant')} brought back`); renderImport(); break; }
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
  if (act === 'plSel') { t.checked ? PLAN.sel.add(v) : PLAN.sel.delete(v); render(); return; }
  if (act === 'plSelSt') { const [d, st] = v.split('\u0001'); for (const src in PLAN.data) uniq(PLAN.data[src].youth.filter(x => x.st === st).map(x => x.un)).forEach(un => { if (planDest(src, st, un) !== d) return; const k = src + '\u0001' + st + '\u0001' + un; t.checked ? PLAN.sel.add(k) : PLAN.sel.delete(k); }); render(); return; }
  if (t.id === 'plTo') { PLAN.to = t.value; return; }
  if (act === 'plMove') { const src = v.split('\u0001')[0]; if (t.value === src) delete PLAN.moves[v]; else PLAN.moves[v] = t.value; render(); return; }
  if (act === 'plMoveSt') { if (!t.value) return; const [src, st] = v.split('\u0001'); const D = PLAN.data[src]; const units = uniq(D.youth.filter(x => x.st === st).map(x => x.un).concat(D.staff.filter(x => x.st === st).map(x => x.un))); units.forEach(un => { const k = src + '\u0001' + st + '\u0001' + un; if (t.value === src) delete PLAN.moves[k]; else PLAN.moves[k] = t.value; }); render(); return; }
  if (act === 'plStaff') { PLAN.staffMove = t.checked; render(); return; }
  if (t.id === 'stStakeSel') { stAreaSync('stake'); return; }
  if (t.id === 'stUnitSel') { stAreaSync('unit'); return; }
  if (t.id === 'stBday') { const o = $('#stAgeOut'); if (o) o.innerHTML = stAgeText(t.value, null); return; }
  if (t.dataset && t.dataset.act === 'spUnit') { t.checked ? UI.split.sel.add(t.dataset.v) : UI.split.sel.delete(t.dataset.v); render(); return; }
  if (t.dataset && t.dataset.act === 'spStake') { const st = t.dataset.v; S.P.filter(p => areaOf(p).st === st).forEach(p => { const k = st + '|' + areaOf(p).un; t.checked ? UI.split.sel.add(k) : UI.split.sel.delete(k); }); render(); return; }
  if (t.id === 'viewAs') { S.viewAs = t.value || null; S.viewAsStaff = null; UI.coMineSet = false; UI.band = ''; UI.filterSet = false; UI.filter = 'all'; if (S.viewAs && ['counselor', 'ac', 'coordinator'].includes(S.viewAs)) { const s = S.staffList.find(x => x.role === S.viewAs && (S.viewAs !== 'counselor' || Object.values(S.org.groups).some(g => g.counselorId === x.id)) && (S.viewAs !== 'ac' || Object.values(S.org.companies).some(c => c.acId === x.id))); S.viewAsStaff = s ? s.id : null; if (s) toast('Previewing as ' + s.name); } UI.frameKey = ''; closeModal(); render(); return; }
  if (t.id === 'ciStake') { UI.stake = t.value; UI.unit = ''; UI.limit = 40; t.blur(); render(); return; }
  if (t.id === 'ciUnit') { UI.unit = t.value; UI.limit = 40; t.blur(); render(); return; }
  if (t.id === 'impFile') { if (t.files[0]) readFile(t.files[0]).catch(err => { console.error(err); toast('Could not read that file. Save it as .xlsx or .csv and try again.', true); }); return; }
  if (t.id === 'impMode') { UI.imp.mode = t.value; renderImport(); return; }
  if (t.id === 'sfFile') { const f = t.files[0]; if (f) sfRead(f).catch(err => { console.error(err); toast('Could not read that file. Save it as .xlsx or .csv and try again.', true); }).finally(() => { t.value = ''; }); return; }
  if (t.classList && (t.classList.contains('or-name') || t.classList.contains('or-count'))) { const l = (S.config.otherRoles || []).map(o => Object.assign({}, o)); const o = l[+t.dataset.i]; if (!o) return; if (t.classList.contains('or-name')) o.name = clean(t.value).slice(0, 60); else o.count = Math.max(0, Math.min(500, parseInt(t.value, 10) || 0)); audit('settings', `Set other role ${o.name || '(unnamed)'} to ${o.count || 0}`); t.blur(); await saveConfig({ otherRoles: l }); return; }
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
    case 'nmStat': { const on = !t.checked; audit('settings', on ? 'Stopped counting youth with no MRN as registered' : 'Counted youth with no MRN as registered'); await saveConfig({ excludeNonMembers: on }); toast(on ? 'Youth with no MRN are left out. Press Rebalance on Companies & groups.' : 'Youth with no MRN count as registered. Press Rebalance to give them groups.'); break; }
    case 'stat': { audit('settings', `${t.checked ? 'Counted' : 'Stopped counting'} the status ${v.replace(/_/g, ' ').toLowerCase()} as registered`); const ex = new Set(S.config.excludedStatuses || []); t.checked ? ex.delete(v) : ex.add(v); await saveConfig({ excludedStatuses: [...ex] }); break; }
    case 'areaS': { audit('settings', `${t.checked ? 'Included' : 'Excluded'} the area ${v}`); const ex = new Set(S.config.excludedStakes || []); t.checked ? ex.delete(v) : ex.add(v); await saveConfig({ excludedStakes: [...ex] }); break; }
    case 'areaU': { audit('settings', `${t.checked ? 'Included' : 'Excluded'} the unit ${v.replace('|', ' · ')}`); const ex = new Set(S.config.excludedUnits || []); t.checked ? ex.delete(v) : ex.add(v); await saveConfig({ excludedUnits: [...ex] }); break; }
    case 'impMap': { const i = +v; if (t.value) { for (const k in UI.imp.map) if (UI.imp.map[k] === t.value) delete UI.imp.map[k]; UI.imp.map[i] = t.value; } else delete UI.imp.map[i]; renderImport(); break; }
    case 'stRole': { t.blur(); if (t.value === 'counselor' && !can.addStaff() && (S.staffMap[id] || {}).role !== 'counselor') { render(); staffClosedNotice(); break; } await saveStaffRec(Object.assign({}, S.staffMap[id], { role: t.value })); toast('Role changed'); break; }
    case 'reqRole': { if (!t.value) break; const rq = S.requests[id] || {}; if (!rq.email) { toast('This request has no email.', true); break; } audit('accounts', `Gave ${rq.name || rq.email} (${rq.email}) access as ${ROLES[t.value] || t.value}`); try { await setDoc('invites/' + emailKey(rq.email), { name: rq.name || rq.email, role: t.value, staffId: null, sessions: [S.sid], at: Date.now() }); } catch (e) { fail(e); break; } await serial('requests/' + id, () => S.db.doc('requests/' + id).delete()).catch(() => { }); const sent = await notifyGranted(rq.email, rq.name, t.value); toast(sent ? `Access given. ${rq.name || rq.email} gets an email.` : 'Access given'); break; }
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
  if (f.id === 'meForm') { await saveMyDetails(); return; }
  if (f.id === 'stForm') {
    if (!can.addStaff()) { const sid0 = f.dataset.id, old0 = sid0 ? S.staffMap[sid0] : null; if (!sid0 || (val('stRole') === 'counselor' && old0 && old0.role !== 'counselor')) { staffClosedNotice(); return; } }
    const name = titleCase(val('stName')), gender = val('stGender'); if (!name || !gender) { toast('Name and gender are needed', true); return; }
    const bday = val('stBday') || '', age = bday ? ageOn(bday, S.config.sessionStart || '') : parseInt(val('stAge'), 10), sid = f.dataset.id; const old = sid ? S.staffMap[sid] || {} : {};
    if (bday && (age < 15 || age > 90)) { toast('That birthdate does not look right', true); return; }
    const stakeV = val('stStakeSel') === '__other' ? titleCase(val('stStakeNew')) : val('stStakeSel'), unitV = val('stUnitSel') === '__other' || val('stStakeSel') === '__other' ? titleCase(val('stUnitNew')) : val('stUnitSel');
    const email = sfEmail(val('stEmail')); if (email && !okEmail(email)) { toast('That email does not look right', true); return; }
    const V = { role: val('stRole'), phone: val('stPhone'), size: val('stSize'), stake: stakeV, unit: unitV }; /* read before any confirm box replaces the form */
    if (!sid) { const miss = [['Google email', email], ['phone', clean(val('stPhone'))], ['birthdate', bday || (isNaN(age) ? '' : 'x')], ['stake or district', clean(stakeV)], ['ward or branch', clean(unitV)]].filter(x => !x[1]).map(x => x[0]); if (miss.length) { toast('Please add the ' + miss.join(', '), true); return; }
      if (!okPhone(sfPhone(val('stPhone')))) { toast('That phone number does not look right. Use 07… or 01…', true); return; }
      if (!/@(gmail|googlemail)\.com$/.test(email) && f.dataset.okEmail !== email) { f.dataset.okEmail = email; toast(`${email} is not a Gmail address. It only links if it is the Google account they sign in with. Press Add again to keep it.`, true); return; } }
    const dupE = email && S.staffList.find(x => x.id !== sid && (x.email || '').toLowerCase() === email); if (dupE) { toast(`${dupE.name} already has that email`, true); return; }
    const rec = Object.assign({ addedAt: Date.now(), addedBy: S.meName || S.email || '' }, old, { id: sid || rid('S'), name, gender, ageCsv: bday ? null : (isNaN(age) ? null : age), bday, role: V.role, phone: sfPhone(V.phone) || clean(V.phone), email, tshirt: V.size, stake: clean(V.stake), unit: clean(V.unit) });
    await saveStaffRec(rec); linkTried = {}; UI.staffTab = rec.role; closeModal(); toast(sid ? 'Saved' : name + ' added');
  }
  if (f.id === 'invForm') {
    const name = titleCase(val('invName')), email = clean(val('invEmail')).toLowerCase(), r = val('invRole'), sid = val('invStaff') || null;
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !r) { toast('Enter a name, a valid email and a role', true); return; }
    const h = emailKey(email); if (S.invites[h]) { toast('There is already an account for ' + email, true); return; }
    const chosen = [...document.querySelectorAll('.invSessChk:checked')].map(x => x.value); const sessions = chosen.length ? chosen : [S.sid];
    try { await setDoc('invites/' + h, { name, role: r, gender: val('invGender') || '', staffId: sid, sessions, at: Date.now() }); audit('accounts', `Created an account for ${name} (${email}) as ${ROLES[r] || r}`, h); f.reset(); const sent = await notifyGranted(email, name, r); toast(`Account created for ${name}${sent ? '. They get an email.' : ''}`); } catch (err) { fail(err); }
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
document.addEventListener('input', e => { if (e.target.classList && e.target.classList.contains('te-in')) { teeLeft(); return; } if (e.target.classList && e.target.classList.contains('xl-in')) { xlTotal(); return; } if (e.target.id === 'spName') { UI.split.name = e.target.value; const b = $('[data-act=spGo]'); if (b) b.disabled = !(e.target.value.trim() && S.P.some(p => UI.split.sel.has(areaOf(p).st + '|' + areaOf(p).un))); } });
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

/* liquid glass press: the light follows the finger or mouse on banner buttons */
document.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('.pagehead .btn, .hero .btn'); if (!b) return;
  const r = b.getBoundingClientRect(); b.style.setProperty('--lx', (e.clientX - r.left) + 'px'); b.style.setProperty('--ly', (e.clientY - r.top) + 'px');
  b.classList.remove('lq'); void b.offsetWidth; b.classList.add('lq');
  clearTimeout(b._lq); b._lq = setTimeout(() => b.classList.remove('lq'), 650);
}, { passive: true });