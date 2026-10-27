const $ = (id) => document.getElementById(id);
 
// Palīgfunkcija pieprasījumiem uz serveri
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
    throw new Error(json.kluda || 'Radās kļūda');
  }
  return json;
}
 
// Ziņojuma parādīšana (textContent, nevis innerHTML - aizsardzība pret XSS)
function paradit(elements, teksts, klase) {
  elements.textContent = teksts;
  elements.className = klase || '';
}
 
// ---------- Skatu pārslēgšana ----------
 
function paraditPieslegtu(lietotajs) {
  $('loginSadala').classList.add('paslept');
  $('galvenaSadala').classList.remove('paslept');
  $('vards').textContent = lietotajs.vards_uzvards;
  $('loma').textContent = 'Loma: ' + lietotajs.loma;
 
  if (lietotajs.loma === 'administrators') {
    $('adminSadala').classList.remove('paslept');
    ieladetLomas();
  } else {
    $('adminSadala').classList.add('paslept');
  }
}
 
function paraditLogin() {
  $('galvenaSadala').classList.add('paslept');
  $('loginSadala').classList.remove('paslept');
  $('loginForma').reset();
}
 
// ---------- Pieslēgšanās ----------
 
$('loginForma').addEventListener('submit', async (e) => {
  e.preventDefault();
  paradit($('loginKluda'), '');
 
  const lietotajvards = $('lietotajvards').value.trim();
  const parole = $('parole').value;
 
  if (!lietotajvards || !parole) {
    return paradit($('loginKluda'), 'Ievadiet lietotājvārdu un paroli', 'kluda');
  }
 
  try {
    const atbilde = await api('/api/login', 'POST', { lietotajvards, parole });
    paraditPieslegtu(atbilde.lietotajs);
  } catch (err) {
    paradit($('loginKluda'), err.message, 'kluda');
  }
});
 
// ---------- Atslēgšanās ----------
 
$('atslegtiesPoga').addEventListener('click', async () => {
  try {
    await api('/api/logout', 'POST');
  } catch (err) {
    // Pat ja kļūda, atgriežamies uz pieslēgšanos
  }
  paraditLogin();
});
 
// ---------- Administratora funkcijas ----------
 
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
 
  // Validācija pārlūkā (serveris to pārbauda vēlreiz)
  if (!/^[A-Za-z0-9_.-]{3,50}$/.test(dati.lietotajvards)) {
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
 
// ---------- Lapas ielāde: vai jau esam pieslēgušies? ----------
 
(async function sakums() {
  try {
    const atbilde = await api('/api/me');
    paraditPieslegtu(atbilde.lietotajs);
  } catch {
    paraditLogin();
  }
})();