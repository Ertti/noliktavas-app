const $ = (id) => document.getElementById(id);
 
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
 
function paraditLietotaju(lietotajs) {
  $('vards').textContent = lietotajs.vards_uzvards;
  $('loma').textContent = lietotajs.loma;
 
  if (lietotajs.loma === 'administrators') {
    $('adminSadala').classList.remove('paslept');
    ieladetLomas();
  }
}

$('logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/logout', 'POST');
  } catch {}
  window.location.href = 'signin/signin.html';
});
 
// Administratora funkcijas
async function ieladetLomas() {
  try {
    const lomas = await api('/api/lomas');
    const izvelne = $('jLoma');
    izvelne.innerHTML = '';
    lomas.forEach((l) => {
      const opcija = document.createElement('option');
      opcija.value = l.id;
      opcija.textContent = l.nosaukums;
      izvelne.appendChild(opcija);
    });
  } catch (err) {
    paradit($('adminZinojums'), err.message, 'kluda');
  }
}
 
$('jaunaLietotajaForma').addEventListener('submit', async (e) => {
  e.preventDefault();
  paradit($('adminZinojums'), '');
 
  const dati = {
    lietotajvards: $('jLietotajvards').value.trim(),
    vards_uzvards: $('jVards').value.trim(),
    parole: $('jParole').value,
    loma_id: $('jLoma').value,
  };
 
  if (!/^[\p{L}0-9_.-]{3,50}$/u.test(dati.lietotajvards)) {
    return paradit($('adminZinojums'), 'Lietotājvārds: 3-50 simboli (burti, cipari, _ . -)', 'kluda');
  }
  if (!dati.vards_uzvards) {
    return paradit($('adminZinojums'), 'Norādiet vārdu un uzvārdu', 'kluda');
  }
  if (dati.parole.length < 8) {
    return paradit($('adminZinojums'), 'Parolei jābūt vismaz 8 simbolus garai', 'kluda');
  }
 
  try {
    const atbilde = await api('/api/lietotaji', 'POST', dati);
    paradit($('adminZinojums'), atbilde.zinojums + ': ' + atbilde.lietotajs.lietotajvards, 'veiksme');
    $('jaunaLietotajaForma').reset();
  } catch (err) {
    paradit($('adminZinojums'), err.message, 'kluda');
  }
});
 
// Lapas ielāde: ja nav pieslēgts, uz pieslēgšanās lapu
(async function sakums() {
  try {
    const atbilde = await api('/api/me');
    paraditLietotaju(atbilde.lietotajs);
  } catch {
    window.location.href = 'signin/signin.html';
  }
})();
