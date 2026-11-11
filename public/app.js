const $ = (id) => document.getElementById(id);

const NOSAUKUMI = {
  administrators: 'Administrators',
  noliktavas_darbinieks: 'Noliktavas darbinieks',
  plauktu_kartotajs: 'Plauktu kārtotājs',
};

const TEKSTI = {
  ...NOSAUKUMI,
  labs: 'Labs', bojats: 'Bojāts', karantina: 'Karantīna',
  jauns: 'Jauns', komplektesana: 'Komplektēšanā', nosutits: 'Nosūtīts', piegadats: 'Piegādāts', atcelts: 'Atcelts',
  pievienots: 'Pievienots', parvietots: 'Pārvietots', daudzums_mainits: 'Daudzums mainīts', nonemts: 'Noņemts',
};

const STATUSU_DARBIBAS = {
  komplektesana: 'Sākt komplektēšanu',
  nosutits: 'Nosūtīt',
  piegadats: 'Atzīmēt kā piegādātu',
  atcelts: 'Atcelt',
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

let manaLoma = null;
const SAKUMA_SADALAS = { administrators: 'adminHome', plauktu_kartotajs: 'sorterHome' };
const panels = document.querySelectorAll('.panel');

$('menuList').append(...[...document.querySelectorAll('nav li')].map((li) => li.cloneNode(true)));

function showSection(id) {
  if (id === 'home') id = SAKUMA_SADALAS[manaLoma];
  panels.forEach((p) => p.classList.toggle('hide', p.id !== id));
  const sadala = $(id);
  if (!sadala) return;
  paradit(sadala.querySelector('[data-msg]'), '');
  sadala.ieladet?.();
}

document.addEventListener('click', (e) => {
  const poga = e.target.closest('[data-section]');
  if (!poga) return;
  showSection(poga.dataset.section);
  $('menu').hidePopover?.();
});

function paraditLietotaju(lietotajs) {
  manaLoma = lietotajs.loma;
  document.querySelectorAll('.name').forEach((el) => {
    el.textContent = lietotajs.vards_uzvards;
  });
  $('role').textContent = NOSAUKUMI[manaLoma] || manaLoma;

  document.querySelectorAll('[data-roles]').forEach((el) => {
    if (el.dataset.roles.split(',').includes(manaLoma)) el.classList.remove('hide');
  });
}

$('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/logout', 'POST');
  } catch {}
  window.location.href = 'signin/signin.html';
});

function poga(teksts, klase, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = teksts;
  b.className = klase;
  b.addEventListener('click', onClick);
  return b;
}

function vertiba(v, th) {
  if (Array.isArray(v)) return v.map((p) => `${p.preces_kods} × ${p.daudzums}`).join(', ');
  if (th.dataset.dec) return Number(v).toFixed(th.dataset.dec);
  if (th.hasAttribute('data-map')) return TEKSTI[v] ?? v ?? '';
  return v ?? '';
}

function zimetTabulu(tabula, rindas, darbibas) {
  const th = [...tabula.tHead.querySelectorAll('th')];
  const tbody = tabula.tBodies[0];
  tbody.replaceChildren();
  if (rindas.length === 0) {
    const td = tbody.insertRow().insertCell();
    td.colSpan = th.length;
    td.textContent = 'Nav datu';
  }
  rindas.forEach((r) => {
    const tr = tbody.insertRow();
    th.forEach((h) => {
      const td = tr.insertCell();
      if (!h.dataset.key) return td.append(...(darbibas ? darbibas(r) : []));
      td.dataset.label = h.textContent;
      td.textContent = vertiba(r[h.dataset.key], h);
    });
  });
}

async function darit(sadala, metode, url, dati, jautajums) {
  if (jautajums && !confirm(jautajums)) return false;
  const zina = sadala.querySelector('[data-msg]');
  try {
    paradit(zina, (await api(url, metode, dati)).zinojums, 'veiksme');
    return true;
  } catch (err) {
    paradit(zina, err.message, 'kluda');
    return false;
  }
}

function aizpilditOpcijas(sel, rindas) {
  const iepriekseja = sel.value;
  sel.replaceChildren(
    new Option('- izvēlieties -', ''),
    ...rindas.map((r) => {
      const t = sel.dataset.label.split(',').map((k) => r[k]).join(' - ');
      return new Option(sel.hasAttribute('data-map') ? (TEKSTI[t] ?? t) : t, r.id);
    })
  );
  sel.value = iepriekseja;
}

const opcijas = async (sel) => aizpilditOpcijas(sel, await api(sel.dataset.url));

async function drosi(sadala, fn) {
  try {
    await fn();
  } catch (err) {
    paradit(sadala.querySelector('[data-msg]'), err.message, 'kluda');
  }
}

const ielade = (sadala, fn) => { sadala.ieladet = () => drosi(sadala, fn); };

async function lasitTabulas(sadala) {
  for (const t of sadala.querySelectorAll('table[data-url]')) {
    const dati = await api(t.dataset.url);
    zimetTabulu(t, (t.dataset.path ? dati[t.dataset.path] : dati).slice(0, t.dataset.limit));
  }
}

function crud(sadala) {
  const url = sadala.dataset.url;
  const forma = sadala.querySelector('form');
  const tabula = sadala.querySelector('table:not([data-url])');
  const atcelt = forma.querySelector('.cancel');
  const atlauts = (atr) => !sadala.hasAttribute(atr) || sadala.getAttribute(atr).split(',').includes(manaLoma);
  let labojamais = null;

  function atiestatit() {
    labojamais = null;
    forma.reset();
    [...forma.elements].forEach((el) => { el.disabled = false; });
    atcelt?.classList.add('hide');
    forma.classList.toggle('hide', sadala.hasAttribute('data-edit-only'));
  }

  function labot(r) {
    labojamais = r;
    [...forma.elements].forEach((el) => {
      if (!el.name) return;
      el.value = r[el.name] ?? '';
      el.disabled = el.hasAttribute('data-create-only');
    });
    atcelt.classList.remove('hide');
    forma.classList.remove('hide');
    forma.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const darbibas = (r) => {
    const pogas = [];
    if (atlauts('data-edit')) pogas.push(poga('Rediģēt', 'rowBtn', () => labot(r)));
    if (atlauts('data-delete')) {
      pogas.push(poga('Dzēst', 'rowBtn dangerBtn', async () => {
        const izdevas = await darit(sadala, 'DELETE', `${url}/${r.id}`, null, `Vai dzēst: ${r[sadala.dataset.name] ?? 'ierakstu'}?`);
        if (izdevas && labojamais?.id === r.id) atiestatit();
        await sadala.ieladet();
      }));
    }
    return pogas;
  };

  forma.addEventListener('submit', async (e) => {
    e.preventDefault();
    const dati = Object.fromEntries(new FormData(forma));
    for (const k in dati) {
      if (forma.elements[k].type !== 'password') dati[k] = dati[k].trim();
      else if (dati[k] === '') delete dati[k];
    }
    const labo = labojamais;
    const izdevas = await darit(sadala, labo ? 'PUT' : 'POST', labo ? `${url}/${labo.id}` : url, dati);
    if (izdevas) atiestatit();
    await sadala.ieladet();
  });
  atcelt?.addEventListener('click', atiestatit);

  ielade(sadala, async () => {
    await Promise.all([...sadala.querySelectorAll('select[data-url]')].map(opcijas));
    if (tabula) zimetTabulu(tabula, await api(url), darbibas);
    await lasitTabulas(sadala);
  });
  atiestatit();
}

function pasutijumi(sadala) {
  const forma = sadala.querySelector('form');
  const rindasVieta = sadala.querySelector('.orderLines');
  const sablons = sadala.querySelector('template');
  const tabula = sadala.querySelector('table');
  const iesniegt = forma.querySelector('[type=submit]');
  const atcelt = forma.querySelector('.cancel');
  let preces = [];
  let labojamais = null;

  function pievienotRindu(preceId = '', daudzums = '') {
    const rinda = sablons.content.cloneNode(true);
    const sel = rinda.querySelector('select');
    aizpilditOpcijas(sel, preces);
    sel.value = preceId;
    rinda.querySelector('input').value = daudzums;
    rinda.querySelector('button').addEventListener('click', (e) => e.target.closest('.orderLine').remove());
    rindasVieta.append(rinda);
  }

  function atiestatit() {
    labojamais = null;
    forma.reset();
    rindasVieta.replaceChildren();
    pievienotRindu();
    iesniegt.textContent = 'Izveidot pasūtījumu';
    atcelt.classList.add('hide');
  }

  function labot(r) {
    labojamais = r;
    forma.klients.value = r.klients;
    rindasVieta.replaceChildren();
    r.preces.forEach((p) => pievienotRindu(p.prece_id, p.daudzums));
    iesniegt.textContent = `Saglabāt pasūtījumu Nr. ${r.id}`;
    atcelt.classList.remove('hide');
    forma.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const darbibas = (r) => {
    const pogas = r.nakamie.map((statuss) =>
      poga(STATUSU_DARBIBAS[statuss], statuss === 'atcelts' ? 'rowBtn dangerBtn' : 'rowBtn', async () => {
        await darit(sadala, 'PUT', `/api/pasutijumi/${r.id}/statuss`, { statuss }, statuss === 'atcelts' ? `Vai atcelt pasūtījumu Nr. ${r.id}?` : '');
        await sadala.ieladet();
      })
    );
    if (r.statuss === 'jauns') pogas.push(poga('Rediģēt', 'rowBtn', () => labot(r)));
    if (['jauns', 'atcelts'].includes(r.statuss)) {
      pogas.push(poga('Dzēst', 'rowBtn dangerBtn', async () => {
        const izdevas = await darit(sadala, 'DELETE', `/api/pasutijumi/${r.id}`, null, `Vai dzēst pasūtījumu Nr. ${r.id} (${r.klients})?`);
        if (izdevas && labojamais?.id === r.id) atiestatit();
        await sadala.ieladet();
      }));
    }
    return pogas;
  };

  forma.addEventListener('submit', async (e) => {
    e.preventDefault();
    const dati = {
      klients: forma.klients.value.trim(),
      preces: [...rindasVieta.querySelectorAll('.orderLine')].map((rinda) => ({
        prece_id: rinda.querySelector('select').value,
        daudzums: rinda.querySelector('input').value,
      })),
    };
    if (dati.preces.length === 0) {
      return paradit(sadala.querySelector('[data-msg]'), 'Pievienojiet vismaz vienu preci', 'kluda');
    }
    const labo = labojamais;
    const izdevas = await darit(sadala, labo ? 'PUT' : 'POST', labo ? `/api/pasutijumi/${labo.id}` : '/api/pasutijumi', dati);
    if (izdevas) atiestatit();
    await sadala.ieladet();
  });
  forma.querySelector('.add').addEventListener('click', () => pievienotRindu());
  atcelt.addEventListener('click', atiestatit);

  ielade(sadala, async () => {
    preces = await api('/api/preces');
    rindasVieta.querySelectorAll('select').forEach((sel) => aizpilditOpcijas(sel, preces));
    zimetTabulu(tabula, await api('/api/pasutijumi'), darbibas);
  });
  atiestatit();
}

function parskati(sadala) {
  const pogas = sadala.querySelector('.reportButtons');
  const tabula = sadala.querySelector('table');
  const csv = sadala.querySelector('.csvLink');
  const virsraksts = sadala.querySelector('.reportTitle');

  async function radit(p) {
    const d = await api(`/api/parskati/${p.id}`);
    virsraksts.textContent = d.nosaukums;
    csv.href = `/api/parskati/${p.id}?csv=1`;
    csv.classList.remove('hide');
    tabula.tHead.rows[0].replaceChildren(
      ...d.kolonnas.map((k) => {
        const th = document.createElement('th');
        th.textContent = k.label;
        th.dataset.key = k.key;
        return th;
      })
    );
    zimetTabulu(tabula, d.rindas);
  }

  ielade(sadala, async () => {
    const saraksts = await api('/api/parskati');
    pogas.replaceChildren(...saraksts.map((p) => poga(p.nosaukums, 'rowBtn', () => drosi(sadala, () => radit(p)))));
    if (sadala.hasAttribute('data-first') && saraksts.length > 0) await radit(saraksts[0]);
  });
}

const sorterHome = $('sorterHome');
ielade(sorterHome, async () => {
  const [preces, izv] = await Promise.all([api('/api/preces'), api('/api/izvietojums')]);
  zimetTabulu(sorterHome.querySelector('table'), preces.map((p) => {
    const savas = izv.filter((i) => i.prece_id === p.id);
    const vietas = savas
      .map((i) => `${i.vieta}: ${i.daudzums}` + (i.stavoklis === 'labs' ? '' : ` (${TEKSTI[i.stavoklis]})`))
      .join('; ');
    const atlikums = savas.filter((i) => i.stavoklis === 'labs').reduce((summa, i) => summa + i.daudzums, 0);
    return { ...p, atlikums, izvietojums: vietas || 'nav izvietots' };
  }));
});

['addProduct', 'adminAddUser', 'users', 'moveProducts', 'dataEntry'].forEach((id) => crud($(id)));
pasutijumi($('placeOrder'));
document.querySelectorAll('[data-reports]').forEach(parskati);

(async function sakums() {
  let lietotajs;
  try {
    lietotajs = (await api('/api/me')).lietotajs;
  } catch {
    window.location.href = 'signin/signin.html';
    return;
  }
  paraditLietotaju(lietotajs);
  showSection('home');
})();