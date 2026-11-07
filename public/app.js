const $ = (id) => document.getElementById(id);

const nosaukumi = {
  administrators: 'Administrators',
  noliktavas_darbinieks: 'Noliktavas darbinieks',
  plauktu_kartotajs: 'Plauktu kārtotājs',
};
 
async function api(url, metode = 'GET', dati) {
  const opcijas = { method: metode, headers: {} };
  if (dati) {
    opcijas.headers['Content-Type'] = 'application/json';
    opcijas.body = JSON.stringify(dati);
  }
  let atbilde;
  try {
    atbilde = await fetch(url, opcijas);
  } catch {
    throw new Error('Nav savienojuma ar serveri');
  }
  const json = await atbilde.json().catch(() => ({}));
  if (!atbilde.ok) {
    const err = new Error(json.kluda || 'Radās kļūda');
    err.status = atbilde.status;
    throw err;
  }
  return json;
}
 
function paradit(elements, teksts, klase) {
  elements.textContent = teksts;
  elements.className = klase || '';
}

const panels = document.querySelectorAll('.panel');
 
function showSection(id) {
  panels.forEach((p) => p.classList.toggle('hide', p.id !== id));
}

document.addEventListener('click', (e) => {
  const poga = e.target.closest('[data-section]');
  if (!poga) return;
  showSection(poga.dataset.section);
  $('menu').hidePopover?.();
});
 
function paraditLietotaju(lietotajs) {
  document.querySelectorAll('.name').forEach((el) => {
    el.textContent = lietotajs.vards_uzvards;
  });
  $('role').textContent = nosaukumi[lietotajs.loma] || lietotajs.loma;

  document.querySelectorAll('[data-roles]').forEach((el) => {
    if (el.dataset.roles.split(',').includes(lietotajs.loma)) {
      el.classList.remove('hide');
    }
  });
 
  if (lietotajs.loma === 'administrators') {
    ieladetLomas();
  }
}

$('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/logout', 'POST');
  } catch {}
  window.location.href = 'signin/signin.html';
});

async function ieladetLomas() {
  try {
    const lomas = await api('/api/lomas');
    const izvelne = $('jLoma');
    izvelne.innerHTML = '';
    lomas.forEach((l) => {
      const option = document.createElement('option');
      option.value = l.id;
      option.textContent = nosaukumi[l.nosaukums] || l.nosaukums;
      izvelne.appendChild(option);
    });
  } catch (err) {
    paradit($('adminMessage'), err.message, 'kluda');
  }
}
 
$('newUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  paradit($('adminMessage'), '');
 
  const dati = {
    lietotajvards: $('jLietotajvards').value.trim(),
    vards_uzvards: $('jVards').value.trim(),
    parole: $('jParole').value,
    loma_id: $('jLoma').value,
  };
 
  if (!/^[\p{L}0-9_.-]{3,50}$/u.test(dati.lietotajvards)) {
    return paradit($('adminMessage'), 'Lietotājvārds: 3-50 simboli (burti, cipari, _ . -)', 'kluda');
  }
  if (!dati.vards_uzvards) {
    return paradit($('adminMessage'), 'Norādiet vārdu un uzvārdu', 'kluda');
  }
  if (dati.parole.length < 8) {
    return paradit($('adminMessage'), 'Parolei jābūt vismaz 8 simbolus garai', 'kluda');
  }
 
  try {
    const atbilde = await api('/api/lietotaji', 'POST', dati);
    paradit($('adminMessage'), atbilde.zinojums + ': ' + atbilde.lietotajs.lietotajvards, 'veiksme');
    $('newUserForm').reset();
  } catch (err) {
    paradit($('adminMessage'), err.message, 'kluda');
  }
});

(async function sakums() {
  try {
    const atbilde = await api('/api/me');
    paraditLietotaju(atbilde.lietotajs);
  } catch {
    window.location.href = 'signin/signin.html';
  }
})();

// ---------- Sections ----------

const lomuNosaukums = (n) => (typeof nosaukumi !== 'undefined' && nosaukumi[n]) || n;
 
let manaLoma = null; // tiek iestatīta lapas beigās no /api/me
 
// Katras sadaļas ielādes funkcija; to izsauc, kad sadaļu atver
const ielades = {};
 
document.addEventListener('click', (e) => {
  const pogaEl = e.target.closest('[data-section]');
  if (pogaEl && ielades[pogaEl.dataset.section]) ielades[pogaEl.dataset.section]();
});
 
// ---------- Kopīgi palīgi ----------
 
function izveidotPogu(teksts, klase, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = teksts;
  b.className = klase;
  b.addEventListener('click', onClick);
  return b;
}
 
// Tabula ar pēc izvēles pievienotu "Darbības" kolonnu. Viss teksts ar textContent (drošs pret XSS)
function tabula(kolonnas, rindas, darbibas) {
  const wrap = document.createElement('div');
  wrap.className = 'tableWrap';
  const t = document.createElement('table');
 
  const galvasRinda = t.createTHead().insertRow();
  kolonnas.forEach((k) => {
    const th = document.createElement('th');
    th.textContent = k.label;
    galvasRinda.append(th);
  });
  if (darbibas) {
    const th = document.createElement('th');
    th.textContent = 'Darbības';
    galvasRinda.append(th);
  }
 
  const tbody = t.createTBody();
  if (rindas.length === 0) {
    const td = tbody.insertRow().insertCell();
    td.colSpan = kolonnas.length + (darbibas ? 1 : 0);
    td.textContent = 'Nav datu';
  }
  rindas.forEach((r) => {
    const tr = tbody.insertRow();
    kolonnas.forEach((k) => {
      const v = r[k.key];
      tr.insertCell().textContent = k.format ? k.format(v, r) : (v ?? '');
    });
    if (darbibas) tr.insertCell().append(...darbibas(r));
  });
 
  wrap.append(t);
  return wrap;
}
 
// ---------- Vispārīgs saraksts + forma (pievienot / rediģēt / dzēst) ----------
// cfg: { url, columns, fields, canCreate, canEdit, canDelete, deleteQuestion }
// field: { key, label, type ('text' | 'number' | 'password' | 'textarea' | 'select'),
//          required, maxlength, min, step, autocomplete, createOnly, options (async -> [{value,label}]) }
 
function izveidotCrud(sadalasId, cfg) {
  const sadala = $(sadalasId);
  const konteiners = sadala && sadala.querySelector('.crud');
  if (!konteiners) return;
 
  const zina = document.createElement('div');
  const forma = document.createElement('form');
  const tabulasVieta = document.createElement('div');
  forma.className = 'crudForm';
 
  let rindas = [];
  let labojamais = null;
  const lauki = {};
 
  cfg.fields.forEach((f) => {
    const label = document.createElement('label');
    label.textContent = f.label;
 
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
    } else if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 3;
    } else {
      input = document.createElement('input');
      input.type = f.type || 'text';
      if (f.step) input.step = f.step;
      if (f.min !== undefined) input.min = f.min;
    }
    input.id = `${sadalasId}_${f.key}`;
    label.htmlFor = input.id;
    if (f.maxlength) input.maxLength = f.maxlength;
    if (f.autocomplete) input.autocomplete = f.autocomplete;
    input.required = f.required === true;
 
    lauki[f.key] = input;
    forma.append(label, input);
  });
 
  const saglabatPoga = document.createElement('button');
  saglabatPoga.type = 'submit';
  const atceltPoga = izveidotPogu('Atcelt', 'rowBtn', atceltLabot);
  forma.append(saglabatPoga, atceltPoga);
  konteiners.append(zina, forma, tabulasVieta);
 
  function atceltLabot() {
    labojamais = null;
    forma.reset();
    cfg.fields.forEach((f) => { lauki[f.key].disabled = false; });
    saglabatPoga.textContent = 'Pievienot';
    atceltPoga.classList.add('hide');
    forma.classList.toggle('hide', cfg.canCreate === false);
  }
 
  function sakumtLabot(r) {
    labojamais = r;
    paradit(zina, '');
    cfg.fields.forEach((f) => {
      const el = lauki[f.key];
      el.value = r[f.key] ?? '';
      el.disabled = Boolean(f.createOnly);
    });
    saglabatPoga.textContent = 'Saglabāt';
    atceltPoga.classList.remove('hide');
    forma.classList.remove('hide');
    forma.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
 
  function nolasitDatus() {
    const dati = {};
    cfg.fields.forEach((f) => {
      if (f.createOnly && labojamais) return;
      const v = lauki[f.key].value;
      if (f.type === 'password') {
        if (v !== '') dati[f.key] = v; // tukša parole = nemainīt
      } else {
        dati[f.key] = v.trim();
      }
    });
    return dati;
  }
 
  async function ieladetOpcijas() {
    for (const f of cfg.fields) {
      if (f.type !== 'select') continue;
      const opcijas = f.options ? await f.options() : [];
      const sel = lauki[f.key];
      const iepriekseja = sel.value;
      sel.innerHTML = '';
      const tuksa = document.createElement('option');
      tuksa.value = '';
      tuksa.textContent = '- izvēlieties -';
      sel.append(tuksa);
      opcijas.forEach((o) => {
        const op = document.createElement('option');
        op.value = o.value;
        op.textContent = o.label;
        sel.append(op);
      });
      sel.value = iepriekseja;
    }
  }
 
  function zimetTabulu() {
    tabulasVieta.replaceChildren(
      tabula(cfg.columns, rindas, (r) => {
        const pogas = [];
        if (cfg.canEdit !== false) pogas.push(izveidotPogu('Rediģēt', 'rowBtn', () => sakumtLabot(r)));
        const drikstDzest = typeof cfg.canDelete === 'function' ? cfg.canDelete() : cfg.canDelete !== false;
        if (drikstDzest) pogas.push(izveidotPogu('Dzēst', 'rowBtn dangerBtn', () => dzest(r)));
        return pogas;
      })
    );
  }
 
  async function ieladet() {
    try {
      await ieladetOpcijas();
      rindas = await api(cfg.url);
      zimetTabulu();
    } catch (err) {
      paradit(zina, err.message, 'kluda');
    }
  }
 
  async function dzest(r) {
    const jautajums = cfg.deleteQuestion ? cfg.deleteQuestion(r) : 'Vai tiešām dzēst šo ierakstu?';
    if (!confirm(jautajums)) return;
    try {
      const atbilde = await api(`${cfg.url}/${r.id}`, 'DELETE');
      paradit(zina, atbilde.zinojums || 'Dzēsts', 'veiksme');
      if (labojamais && labojamais.id === r.id) atceltLabot();
      await ieladet();
    } catch (err) {
      paradit(zina, err.message, 'kluda');
    }
  }
 
  forma.addEventListener('submit', async (e) => {
    e.preventDefault();
    paradit(zina, '');
    try {
      const url = labojamais ? `${cfg.url}/${labojamais.id}` : cfg.url;
      const atbilde = await api(url, labojamais ? 'PUT' : 'POST', nolasitDatus());
      paradit(zina, atbilde.zinojums || 'Saglabāts', 'veiksme');
      atceltLabot();
      await ieladet();
    } catch (err) {
      paradit(zina, err.message, 'kluda');
    }
  });
 
  atceltLabot();
  ielades[sadalasId] = ieladet;
}
 
// ---------- Sadaļu konfigurācija ----------
 
const ielasitLomas = async () =>
  (await api('/api/lomas')).map((l) => ({ value: l.id, label: lomuNosaukums(l.nosaukums) }));
 
// Lietotāju saraksts: rediģēt (arī loma un parole) un dzēst. Jaunus veido sadaļa "Pievienot lietotāju".
izveidotCrud('users', {
  url: '/api/lietotaji',
  canCreate: false,
  columns: [
    { key: 'lietotajvards', label: 'Lietotājvārds' },
    { key: 'vards_uzvards', label: 'Vārds un uzvārds' },
    { key: 'loma', label: 'Loma', format: lomuNosaukums },
  ],
  fields: [
    { key: 'lietotajvards', label: 'Lietotājvārds', required: true, maxlength: 50 },
    { key: 'vards_uzvards', label: 'Vārds un uzvārds', required: true, maxlength: 100 },
    { key: 'loma_id', label: 'Loma', type: 'select', required: true, options: ielasitLomas },
    { key: 'parole', label: 'Jauna parole (atstāt tukšu, lai nemainītu)', type: 'password', autocomplete: 'new-password', maxlength: 72 },
  ],
  deleteQuestion: (r) => `Vai dzēst lietotāju "${r.lietotajvards}"?`,
});
 
izveidotCrud('addProduct', {
  url: '/api/preces',
  columns: [
    { key: 'artikuls', label: 'Artikuls' },
    { key: 'nosaukums', label: 'Nosaukums' },
    { key: 'apraksts', label: 'Apraksts' },
    { key: 'cena', label: 'Cena', format: (v) => Number(v).toFixed(2) },
  ],
  fields: [
    { key: 'artikuls', label: 'Artikuls', required: true, maxlength: 50 },
    { key: 'nosaukums', label: 'Nosaukums', required: true, maxlength: 150 },
    { key: 'apraksts', label: 'Apraksts', type: 'textarea', maxlength: 1000 },
    { key: 'cena', label: 'Cena', type: 'number', min: '0', step: '0.01', required: true },
  ],
  canDelete: () => manaLoma === 'administrators',
  deleteQuestion: (r) => `Vai dzēst preci "${r.nosaukums}"? Tiks dzēsts arī tās izvietojums.`,
});
 
// ---------- Pasūtījumi (noliktavas darbinieks) ----------
// Viena sadaļa: forma jauna pasūtījuma izveidei/rediģēšanai un saraksts ar statusa maiņu.
 
const STATUSU_NOSAUKUMI = {
  jauns: 'Jauns',
  komplektesana: 'Komplektēšanā',
  nosutits: 'Nosūtīts',
  piegadats: 'Piegādāts',
  atcelts: 'Atcelts',
};
// Pogu teksti: kādu statusu poga iestata
const STATUSU_DARBIBAS = {
  komplektesana: 'Sākt komplektēšanu',
  nosutits: 'Nosūtīt',
  piegadats: 'Atzīmēt kā piegādātu',
  atcelts: 'Atcelt',
};
 
function izveidotPasutijumus(sadalasId) {
  const sadala = $(sadalasId);
  const konteiners = sadala && sadala.querySelector('.crud');
  if (!konteiners) return;
 
  const zina = document.createElement('div');
  const forma = document.createElement('form');
  const tabulasVieta = document.createElement('div');
  forma.className = 'crudForm';
 
  let preces = [];
  let pasutijumi = [];
  let labojamais = null;
 
  const klientaLabel = document.createElement('label');
  klientaLabel.textContent = 'Klients';
  klientaLabel.htmlFor = `${sadalasId}_klients`;
  const klients = document.createElement('input');
  klients.type = 'text';
  klients.id = `${sadalasId}_klients`;
  klients.maxLength = 150;
  klients.required = true;
 
  const precuLabel = document.createElement('label');
  precuLabel.textContent = 'Preces';
  const rindasVieta = document.createElement('div');
 
  const pievienotPoga = izveidotPogu('+ Pievienot preci', 'rowBtn', () => pievienotRindu());
  const saglabatPoga = document.createElement('button');
  saglabatPoga.type = 'submit';
  const atceltPoga = izveidotPogu('Atcelt', 'rowBtn', atceltLabot);
 
  forma.append(klientaLabel, klients, precuLabel, rindasVieta, pievienotPoga, saglabatPoga, atceltPoga);
  konteiners.append(zina, forma, tabulasVieta);
 
  function aizpilditPreces(sel, izvelets) {
    sel.innerHTML = '';
    const tuksa = document.createElement('option');
    tuksa.value = '';
    tuksa.textContent = '- izvēlieties preci -';
    sel.append(tuksa);
    preces.forEach((p) => {
      const op = document.createElement('option');
      op.value = p.id;
      op.textContent = `${p.artikuls} - ${p.nosaukums}`;
      sel.append(op);
    });
    sel.value = String(izvelets);
  }
 
  function pievienotRindu(preceId = '', daudzums = '') {
    const rinda = document.createElement('div');
    rinda.className = 'orderLine';
 
    const sel = document.createElement('select');
    sel.required = true;
    aizpilditPreces(sel, preceId);
 
    const dau = document.createElement('input');
    dau.type = 'number';
    dau.min = '1';
    dau.step = '1';
    dau.required = true;
    dau.placeholder = 'Daudz.';
    dau.value = daudzums;
 
    const nonemt = izveidotPogu('✕', 'rowBtn dangerBtn', () => rinda.remove());
    nonemt.setAttribute('aria-label', 'Noņemt rindu');
 
    rinda.append(sel, dau, nonemt);
    rindasVieta.append(rinda);
  }
 
  function atceltLabot() {
    labojamais = null;
    klients.value = '';
    rindasVieta.replaceChildren();
    pievienotRindu();
    saglabatPoga.textContent = 'Izveidot pasūtījumu';
    atceltPoga.classList.add('hide');
  }
 
  function sakumtLabot(r) {
    labojamais = r;
    paradit(zina, '');
    klients.value = r.klients;
    rindasVieta.replaceChildren();
    r.preces.forEach((p) => pievienotRindu(p.prece_id, p.daudzums));
    if (r.preces.length === 0) pievienotRindu();
    saglabatPoga.textContent = `Saglabāt pasūtījumu Nr. ${r.id}`;
    atceltPoga.classList.remove('hide');
    forma.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
 
  function nolasitDatus() {
    const rindas = [...rindasVieta.querySelectorAll('.orderLine')].map((r) => ({
      prece_id: r.querySelector('select').value,
      daudzums: r.querySelector('input').value,
    }));
    return { klients: klients.value.trim(), preces: rindas };
  }
 
  const kolonnas = [
    { key: 'id', label: 'Nr.' },
    { key: 'klients', label: 'Klients' },
    { key: 'statuss', label: 'Statuss', format: (v) => STATUSU_NOSAUKUMI[v] || v },
    { key: 'preces', label: 'Preces', format: (v) => v.map((p) => `${p.artikuls} × ${p.daudzums}`).join(', ') },
    { key: 'izveidoja', label: 'Izveidoja' },
    { key: 'izveidots', label: 'Izveidots' },
  ];
 
  function zimetTabulu() {
    tabulasVieta.replaceChildren(
      tabula(kolonnas, pasutijumi, (r) => {
        const pogas = r.nakamie.map((jaunais) =>
          izveidotPogu(
            STATUSU_DARBIBAS[jaunais] || jaunais,
            jaunais === 'atcelts' ? 'rowBtn dangerBtn' : 'rowBtn',
            () => mainitStatusu(r, jaunais)
          )
        );
        if (r.statuss === 'jauns') pogas.push(izveidotPogu('Rediģēt', 'rowBtn', () => sakumtLabot(r)));
        if (r.statuss === 'jauns' || r.statuss === 'atcelts') {
          pogas.push(izveidotPogu('Dzēst', 'rowBtn dangerBtn', () => dzest(r)));
        }
        return pogas;
      })
    );
  }
 
  async function ieladet() {
    try {
      preces = await api('/api/preces');
      rindasVieta.querySelectorAll('select').forEach((sel) => aizpilditPreces(sel, sel.value));
      pasutijumi = await api('/api/pasutijumi');
      zimetTabulu();
    } catch (err) {
      paradit(zina, err.message, 'kluda');
    }
  }
 
  async function mainitStatusu(r, jaunais) {
    if (jaunais === 'atcelts' && !confirm(`Vai atcelt pasūtījumu Nr. ${r.id}?`)) return;
    try {
      const atbilde = await api(`/api/pasutijumi/${r.id}/statuss`, 'PUT', { statuss: jaunais });
      paradit(zina, atbilde.zinojums, 'veiksme');
      if (labojamais && labojamais.id === r.id) atceltLabot();
      await ieladet();
    } catch (err) {
      paradit(zina, err.message, 'kluda');
      await ieladet(); // statuss varēja mainīties, atsvaidzina sarakstu
    }
  }
 
  async function dzest(r) {
    if (!confirm(`Vai dzēst pasūtījumu Nr. ${r.id} (${r.klients})?`)) return;
    try {
      const atbilde = await api(`/api/pasutijumi/${r.id}`, 'DELETE');
      paradit(zina, atbilde.zinojums, 'veiksme');
      if (labojamais && labojamais.id === r.id) atceltLabot();
      await ieladet();
    } catch (err) {
      paradit(zina, err.message, 'kluda');
    }
  }
 
  forma.addEventListener('submit', async (e) => {
    e.preventDefault();
    paradit(zina, '');
    const dati = nolasitDatus();
    if (dati.preces.length === 0) {
      return paradit(zina, 'Pievienojiet vismaz vienu preci', 'kluda');
    }
    try {
      const url = labojamais ? `/api/pasutijumi/${labojamais.id}` : '/api/pasutijumi';
      const atbilde = await api(url, labojamais ? 'PUT' : 'POST', dati);
      paradit(zina, atbilde.zinojums || 'Saglabāts', 'veiksme');
      atceltLabot();
      await ieladet();
    } catch (err) {
      paradit(zina, err.message, 'kluda');
    }
  });
 
  atceltLabot();
  ielades[sadalasId] = ieladet;
}
 
izveidotPasutijumus('placeOrder');
 
// ---------- Pārskati (katrai lomai sava sadaļa) ----------
// Serveris pats atgriež tikai tos pārskatus, kas atļauti pieslēgtajai lomai.
 
function izveidotParskatus(sadalasId, opcijas = {}) {
  const sadala = $(sadalasId);
  if (!sadala) return;
  const pogas = sadala.querySelector('.reportButtons');
  const izvade = sadala.querySelector('.reportOut');
 
  async function raditParskatu(p) {
    try {
      const dati = await api(`/api/parskati/${encodeURIComponent(p.id)}`);
 
      const virsraksts = document.createElement('h3');
      virsraksts.textContent = dati.nosaukums;
 
      const csv = document.createElement('a');
      csv.href = `/api/parskati/${encodeURIComponent(p.id)}?csv=1`;
      csv.textContent = 'Lejupielādēt CSV';
      csv.className = 'csvLink';
 
      izvade.className = 'reportOut';
      izvade.replaceChildren(virsraksts, csv, tabula(dati.kolonnas, dati.rindas));
    } catch (err) {
      paradit(izvade, err.message, 'kluda');
    }
  }
 
  async function ieladet() {
    try {
      const saraksts = await api('/api/parskati');
      pogas.replaceChildren(...saraksts.map((p) => izveidotPogu(p.nosaukums, 'rowBtn', () => raditParskatu(p))));
      if (opcijas.atverPirmo && saraksts.length > 0) await raditParskatu(saraksts[0]);
    } catch (err) {
      paradit(izvade, err.message, 'kluda');
    }
  }
 
  ielades[sadalasId] = ieladet;
}
 
izveidotParskatus('reportsWorker'); // noliktavas darbinieks
izveidotParskatus('reportsSorter'); // plauktu kārtotājs
 
// ---------- Sākums administratoram: noliktavas darbības atskaites ----------
// Administratoram sadaļa "Sākums" rāda atskaites (pirmā atveras uzreiz), citām lomām tā paliek tukša.
 
izveidotParskatus('adminHome', { atverPirmo: true });
 
function paraditAdminSakumu() {
  if (manaLoma !== 'administrators') return;
  showSection('adminHome');
  if (ielades.adminHome) ielades.adminHome();
}
 
// Nospiežot "Sākums": app.js jau paslēpa visas sadaļas, administratoram parāda atskaites
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-section="home"]')) paraditAdminSakumu();
});
 
// Pēc pieslēgšanās (lapas ielādē) administratoram uzreiz parāda Sākumu ar atskaitēm
api('/api/me')
  .then((atbilde) => {
    manaLoma = atbilde.lietotajs.loma;
    paraditAdminSakumu();
  })
  .catch(() => {}); // ja nav pieslēgts, app.js pats novirza uz pieslēgšanās lapu