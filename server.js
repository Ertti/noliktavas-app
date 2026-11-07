require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'noliktava',
});
 
if (!process.env.SESSION_SECRET) {
  console.error('Trūkst SESSION_SECRET failā .env');
  process.exit(1);
}
 
app.use(express.json({ limit: '10kb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,                                   // JS nevar nolasīt sīkdatni
      sameSite: 'strict',                               // aizsardzība pret CSRF
      secure: process.env.NODE_ENV === 'production',    // HTTPS produkcijā
      maxAge: 1000 * 60 * 60 * 8,                       // 8 stundas
    },
  })
);

app.use(express.static('public'));

// Fiktīvs hash, lai laiks būtu vienāds arī tad, ja lietotājs neeksistē
const DUMMY_HASH = bcrypt.hashSync('fiktiva-parole', 10);
 
function kluda(res, status, zinojums) {
  return res.status(status).json({ kluda: zinojums });
}
 
// ---------- Starpprogrammatūra (middleware) ----------

// Kontu un lomu katrā pieprasījumā pārbauda datubāzē, lai dzēsts vai pārslēgts lietotājs
// uzreiz zaudē tiesības (nevis darbojas ar veco lomu līdz sesijas beigām)
async function requireLogin(req, res, next) {
  try {
    const sesija = req.session.lietotajs;
    if (!sesija) {
      return kluda(res, 401, 'Jums jāpieslēdzas sistēmai');
    }

    const r = await pool.query(
      `SELECT l.id, l.lietotajvards, l.vards_uzvards, l.loma_id, r.nosaukums AS loma
       FROM lietotaji l
       JOIN lomas r ON r.id = l.loma_id
       WHERE l.id = $1`,
      [sesija.id]
    );
    if (r.rowCount === 0) {
      return req.session.destroy(() => kluda(res, 401, 'Konts vairs neeksistē'));
    }

    req.session.lietotajs = r.rows[0];
    next();
  } catch (err) {
    console.error(err);
    kluda(res, 500, 'Servera kļūda, mēģiniet vēlreiz');
  }
}
 
function requireRole(...atlautasLomas) {
  return (req, res, next) =>
    requireLogin(req, res, () => {
      if (!atlautasLomas.includes(req.session.lietotajs.loma)) {
        return kluda(res, 403, 'Jums nav tiesību veikt šo darbību');
      }
      next();
    });
}
 
// ---------- Pieslēgšanās ----------
 
app.post('/api/login', async (req, res) => {
  try {
    const { lietotajvards, parole } = req.body || {};
 
    if (typeof lietotajvards !== 'string' || typeof parole !== 'string') {
      return kluda(res, 400, 'Ievadiet lietotājvārdu un paroli');
    }
    if (!lietotajvards.trim() || !parole) {
      return kluda(res, 400, 'Lietotājvārds un parole nedrīkst būt tukši');
    }
 
    const result = await pool.query(
      `SELECT l.id, l.lietotajvards, l.parole, l.vards_uzvards, r.nosaukums AS loma
       FROM lietotaji l
       JOIN lomas r ON r.id = l.loma_id
       WHERE l.lietotajvards = $1`,
      [lietotajvards.trim()]
    );
 
    const lietotajs = result.rows[0];
    const derigs = await bcrypt.compare(parole, lietotajs ? lietotajs.parole : DUMMY_HASH);
 
    // Viena un tā pati ziņa gan nepareizam vārdam, gan parolei (neatklāj, kas ir nepareizs)
    if (!lietotajs || !derigs) {
      return kluda(res, 401, 'Nepareizs lietotājvārds vai parole');
    }
 
    // Jauns sesijas ID pēc pieslēgšanās (aizsardzība pret session fixation)
    req.session.regenerate((err) => {
      if (err) return kluda(res, 500, 'Servera kļūda, mēģiniet vēlreiz');
      req.session.lietotajs = {
        id: lietotajs.id,
        lietotajvards: lietotajs.lietotajvards,
        vards_uzvards: lietotajs.vards_uzvards,
        loma: lietotajs.loma,
      };
      res.json({ zinojums: 'Pieslēgšanās veiksmīga', lietotajs: req.session.lietotajs });
    });
  } catch (err) {
    console.error('Login kļūda:', err);
    kluda(res, 500, 'Servera kļūda, mēģiniet vēlreiz');
  }
});
 
app.post('/api/logout', requireLogin, (req, res) => {
  req.session.destroy((err) => {
    if (err) return kluda(res, 500, 'Neizdevās atslēgties');
    res.clearCookie('connect.sid');
    res.json({ zinojums: 'Atslēgšanās veiksmīga' });
  });
});
 
// Kas pašlaik ir pieslēdzies (frontendam, lai zinātu, ko rādīt)
app.get('/api/me', requireLogin, (req, res) => {
  res.json({ lietotajs: req.session.lietotajs });
});
 
// ---------- Lietotāju pārvaldība (tikai administrators) ----------
 
// Lomu saraksts (izvēlnei lietotāja izveides formā)
app.get('/api/lomas', requireRole('administrators'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nosaukums FROM lomas ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    kluda(res, 500, 'Servera kļūda, mēģiniet vēlreiz');
  }
});
 
// Jauna lietotāja izveide - TIKAI administrators
app.post('/api/lietotaji', requireRole('administrators'), async (req, res) => {
  try {
    const { lietotajvards, parole, vards_uzvards, loma_id } = req.body || {};
 
    // Validācija
    if (typeof lietotajvards !== 'string' || !/^[\p{L}0-9_.-]{3,50}$/u.test(lietotajvards.trim())) {
      return kluda(res, 400, 'Lietotājvārds: 3-50 simboli (burti, arī garumzīmes, cipari, _ . -)');
    }
    if (typeof parole !== 'string' || parole.length < 8 || parole.length > 72) {
      return kluda(res, 400, 'Parolei jābūt 8-72 simbolus garai');
    }
    if (typeof vards_uzvards !== 'string' || !vards_uzvards.trim() || vards_uzvards.length > 100) {
      return kluda(res, 400, 'Norādiet vārdu un uzvārdu (līdz 100 simboliem)');
    }
    const lomaId = Number(loma_id);
    if (!Number.isInteger(lomaId) || lomaId <= 0) {
      return kluda(res, 400, 'Izvēlieties lomu');
    }
 
    const role = await pool.query('SELECT id FROM lomas WHERE id = $1', [lomaId]);
    if (role.rowCount === 0) {
      return kluda(res, 400, 'Izvēlētā loma neeksistē');
    }
 
    const hash = await bcrypt.hash(parole, 10);
 
    const result = await pool.query(
      `INSERT INTO lietotaji (lietotajvards, parole, vards_uzvards, loma_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, lietotajvards, vards_uzvards, loma_id`,
      [lietotajvards.trim(), hash, vards_uzvards.trim(), lomaId]
    );
 
    res.status(201).json({ zinojums: 'Lietotājs izveidots', lietotajs: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return kluda(res, 409, 'Šāds lietotājvārds jau eksistē');
    }
    console.error('Lietotāja izveides kļūda:', err);
    kluda(res, 500, 'Servera kļūda, mēģiniet vēlreiz');
  }
});

// ====================================================
// LIETOTĀJU REDIĢĒŠANA/DZĒŠANA, NOLIKTAVAS DATI, PASŪTĪJUMI UN PĀRSKATI
// ====================================================

const STAVOKLI = ['labs', 'bojats', 'karantina'];
const MAKS_INT = 2147483647;

// Pasūtījuma izpildes process: no kura statusa uz kuru drīkst pāriet
const STATUSU_PLUSMA = {
  jauns: ['komplektesana', 'atcelts'],
  komplektesana: ['nosutits', 'atcelts'],
  nosutits: ['piegadats'],
  piegadats: [],
  atcelts: [],
};
const STATUSU_NOSAUKUMI = {
  jauns: 'Jauns',
  komplektesana: 'Komplektēšanā',
  nosutits: 'Nosūtīts',
  piegadats: 'Piegādāts',
  atcelts: 'Atcelts',
};

// ---------- Pārskati ----------
const PARSKATI = {
  atlikumi: {
    nosaukums: 'Preču atlikumi',
    lomas: ['administrators', 'noliktavas_darbinieks'],
    sql: 'SELECT artikuls, nosaukums, atlikums FROM v_atlikumi ORDER BY artikuls',
    kolonnas: [
      { key: 'artikuls', label: 'Artikuls' },
      { key: 'nosaukums', label: 'Nosaukums' },
      { key: 'atlikums', label: 'Atlikums (labs)' },
    ],
  },
  izvietojums: {
    nosaukums: 'Preču izvietojums un stāvoklis',
    lomas: ['administrators', 'noliktavas_darbinieks', 'plauktu_kartotajs'],
    sql: `SELECT artikuls, nosaukums, vieta, daudzums, stavoklis,
                 to_char(atjaunots, 'YYYY-MM-DD HH24:MI') AS atjaunots
          FROM v_izvietojuma_parskats ORDER BY vieta, artikuls`,
    kolonnas: [
      { key: 'artikuls', label: 'Artikuls' },
      { key: 'nosaukums', label: 'Nosaukums' },
      { key: 'vieta', label: 'Vieta' },
      { key: 'daudzums', label: 'Daudzums' },
      { key: 'stavoklis', label: 'Stāvoklis' },
      { key: 'atjaunots', label: 'Atjaunots' },
    ],
  },
  pasutijumi: {
    nosaukums: 'Pasūtījumu kopsavilkums',
    lomas: ['administrators', 'noliktavas_darbinieks'],
    sql: `SELECT id, klients, statuss,
                 to_char(izveidots, 'YYYY-MM-DD HH24:MI') AS izveidots, preces_kopa
          FROM v_pasutijumu_kopsavilkums ORDER BY id DESC`,
    kolonnas: [
      { key: 'id', label: 'Nr.' },
      { key: 'klients', label: 'Klients' },
      { key: 'statuss', label: 'Statuss' },
      { key: 'izveidots', label: 'Izveidots' },
      { key: 'preces_kopa', label: 'Preču skaits' },
    ],
  },
  vesture: {
    nosaukums: 'Izvietojuma izmaiņu vēsture (pēdējās 500)',
    lomas: ['administrators', 'noliktavas_darbinieks', 'plauktu_kartotajs'],
    sql: `SELECT to_char(h.laiks, 'YYYY-MM-DD HH24:MI') AS laiks, p.artikuls, p.nosaukums AS prece,
                 h.darbiba, vn.kods AS no_vietas, vu.kods AS uz_vietu, h.daudzums,
                 l.lietotajvards AS lietotajs
          FROM izvietojuma_vesture h
          JOIN preces p ON p.id = h.prece_id
          LEFT JOIN vietas vn ON vn.id = h.no_vietas
          LEFT JOIN vietas vu ON vu.id = h.uz_vietu
          LEFT JOIN lietotaji l ON l.id = h.lietotajs_id
          ORDER BY h.laiks DESC, h.id DESC
          LIMIT 500`,
    kolonnas: [
      { key: 'laiks', label: 'Laiks' },
      { key: 'artikuls', label: 'Artikuls' },
      { key: 'prece', label: 'Prece' },
      { key: 'darbiba', label: 'Darbība' },
      { key: 'no_vietas', label: 'No vietas' },
      { key: 'uz_vietu', label: 'Uz vietu' },
      { key: 'daudzums', label: 'Daudzums' },
      { key: 'lietotajs', label: 'Lietotājs' },
    ],
  },
};

// CSV lauks ar pēdiņām; teksta laukiem, kas sākas ar = + - @, pievieno ' (aizsardzība pret Excel formulām)
function csvLauks(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

const admin = requireRole('administrators');
const adminVaiDarbinieks = requireRole('administrators', 'noliktavas_darbinieks');
const visi = requireRole('administrators', 'noliktavas_darbinieks', 'plauktu_kartotajs');
const darbinieks = requireRole('noliktavas_darbinieks');

// ---------- Palīgfunkcijas ----------

function teksts(v, maks) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= maks;
}

// Atgriež skaitli vai null, ja vērtība nav derīga
function skaitlis(v, { min = 0, maks = Infinity, vesels = false } = {}) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > maks) return null;
  if (vesels && !Number.isInteger(n)) return null;
  return n;
}

function idNoUrl(req, res) {
  const id = skaitlis(req.params.id, { min: 1, maks: MAKS_INT, vesels: true });
  if (id === null) kluda(res, 400, 'Nederīgs ID');
  return id; // null, ja nederīgs (atbilde jau nosūtīta)
}

function dbKluda(res, err, zinojumi = {}) {
  if (err.code === '23505') return kluda(res, 409, zinojumi.dublikats || 'Šāda vērtība jau eksistē');
  if (err.code === '23503') return kluda(res, 409, zinojumi.saistits || 'Ieraksts ir saistīts ar citiem datiem');
  if (err.code === '22003') return kluda(res, 400, 'Vērtība ir pārāk liela');
  console.error(err);
  return kluda(res, 500, 'Servera kļūda, mēģiniet vēlreiz');
}

// Vairākus SQL vaicājumus izpilda kā vienu veselu (vai visi, vai neviens)
async function tranzakcija(darbs) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rezultats = await darbs(client);
    await client.query('COMMIT');
    return rezultats;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ====================================================
// LIETOTĀJI (tikai administrators); izveide ir server.js
// ====================================================

app.get('/api/lietotaji', admin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT l.id, l.lietotajvards, l.vards_uzvards, l.loma_id, r.nosaukums AS loma
       FROM lietotaji l JOIN lomas r ON r.id = l.loma_id
       ORDER BY l.id`
    );
    res.json(r.rows);
  } catch (err) {
    dbKluda(res, err);
  }
});

app.put('/api/lietotaji/:id', admin, async (req, res) => {
  try {
    const id = idNoUrl(req, res);
    if (id === null) return;
    const { lietotajvards, vards_uzvards, loma_id, parole } = req.body || {};

    if (typeof lietotajvards !== 'string' || !/^[\p{L}0-9_.-]{3,50}$/u.test(lietotajvards.trim())) {
      return kluda(res, 400, 'Lietotājvārds: 3-50 simboli (burti, arī garumzīmes, cipari, _ . -)');
    }
    if (!teksts(vards_uzvards, 100)) {
      return kluda(res, 400, 'Norādiet vārdu un uzvārdu (līdz 100 simboliem)');
    }
    const lomaId = skaitlis(loma_id, { min: 1, maks: MAKS_INT, vesels: true });
    if (lomaId === null) return kluda(res, 400, 'Izvēlieties lomu');

    const jaunaParole = parole === undefined || parole === '' ? null : parole;
    if (jaunaParole !== null && (typeof jaunaParole !== 'string' || jaunaParole.length < 8 || jaunaParole.length > 72)) {
      return kluda(res, 400, 'Parolei jābūt 8-72 simbolus garai');
    }

    // Savu lomu mainīt nedrīkst, lai sistēmā vienmēr paliktu vismaz viens administrators
    if (id === req.session.lietotajs.id && lomaId !== req.session.lietotajs.loma_id) {
      return kluda(res, 400, 'Savu lomu mainīt nedrīkst');
    }

    const loma = await pool.query('SELECT id FROM lomas WHERE id = $1', [lomaId]);
    if (loma.rowCount === 0) return kluda(res, 400, 'Izvēlētā loma neeksistē');

    const sets = ['lietotajvards = $1', 'vards_uzvards = $2', 'loma_id = $3'];
    const vals = [lietotajvards.trim(), vards_uzvards.trim(), lomaId];
    if (jaunaParole !== null) {
      vals.push(await bcrypt.hash(jaunaParole, 10));
      sets.push(`parole = $${vals.length}`);
    }
    vals.push(id);

    const r = await pool.query(
      `UPDATE lietotaji SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, lietotajvards, vards_uzvards, loma_id`,
      vals
    );
    if (r.rowCount === 0) return kluda(res, 404, 'Lietotājs nav atrasts');
    res.json({ zinojums: 'Lietotājs atjaunināts', lietotajs: r.rows[0] });
  } catch (err) {
    dbKluda(res, err, { dublikats: 'Šāds lietotājvārds jau eksistē' });
  }
});

app.delete('/api/lietotaji/:id', admin, async (req, res) => {
  try {
    const id = idNoUrl(req, res);
    if (id === null) return;
    if (id === req.session.lietotajs.id) {
      return kluda(res, 400, 'Savu kontu dzēst nedrīkst');
    }
    // Tabulās izvietojums, pasutijumi un izvietojuma_vesture atsauce uz lietotāju nav ON DELETE SET NULL,
    // tāpēc to atbrīvo ar roku (ieraksti paliek, bet bez autora), un tikai tad dzēš lietotāju
    const atrasts = await tranzakcija(async (c) => {
      await c.query('UPDATE izvietojums SET atjaunoja = NULL WHERE atjaunoja = $1', [id]);
      await c.query('UPDATE pasutijumi SET izveidoja = NULL WHERE izveidoja = $1', [id]);
      await c.query('UPDATE izvietojuma_vesture SET lietotajs_id = NULL WHERE lietotajs_id = $1', [id]);
      const r = await c.query('DELETE FROM lietotaji WHERE id = $1', [id]);
      return r.rowCount > 0;
    });
    if (!atrasts) return kluda(res, 404, 'Lietotājs nav atrasts');
    res.json({ zinojums: 'Lietotājs dzēsts' });
  } catch (err) {
    dbKluda(res, err, { saistits: 'Lietotāju nevar dzēst, jo viņš ir saistīts ar citiem datiem' });
  }
});

// ====================================================
// PRECES
// ====================================================

function validetPreci(b) {
  const { artikuls, nosaukums, apraksts, cena } = b || {};
  if (!teksts(artikuls, 50)) return { kluda: 'Norādiet artikulu (līdz 50 simboliem)' };
  if (!teksts(nosaukums, 150)) return { kluda: 'Norādiet nosaukumu (līdz 150 simboliem)' };
  if (apraksts !== undefined && apraksts !== null && (typeof apraksts !== 'string' || apraksts.length > 1000)) {
    return { kluda: 'Apraksts ir pārāk garš (līdz 1000 simboliem)' };
  }
  const c = skaitlis(cena, { min: 0, maks: 99999999 });
  if (c === null) return { kluda: 'Cenai jābūt skaitlim, kas nav negatīvs' };
  return { dati: [artikuls.trim(), nosaukums.trim(), (apraksts || '').trim() || null, c] };
}

app.get('/api/preces', visi, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, artikuls, nosaukums, apraksts, cena FROM preces ORDER BY artikuls');
    res.json(r.rows);
  } catch (err) {
    dbKluda(res, err);
  }
});

app.post('/api/preces', adminVaiDarbinieks, async (req, res) => {
  const v = validetPreci(req.body);
  if (v.kluda) return kluda(res, 400, v.kluda);
  try {
    await pool.query('INSERT INTO preces (artikuls, nosaukums, apraksts, cena) VALUES ($1, $2, $3, $4)', v.dati);
    res.status(201).json({ zinojums: 'Prece pievienota' });
  } catch (err) {
    dbKluda(res, err, { dublikats: 'Prece ar šādu artikulu jau eksistē' });
  }
});

app.put('/api/preces/:id', adminVaiDarbinieks, async (req, res) => {
  const id = idNoUrl(req, res);
  if (id === null) return;
  const v = validetPreci(req.body);
  if (v.kluda) return kluda(res, 400, v.kluda);
  try {
    const r = await pool.query(
      'UPDATE preces SET artikuls = $1, nosaukums = $2, apraksts = $3, cena = $4 WHERE id = $5',
      [...v.dati, id]
    );
    if (r.rowCount === 0) return kluda(res, 404, 'Prece nav atrasta');
    res.json({ zinojums: 'Prece atjaunināta' });
  } catch (err) {
    dbKluda(res, err, { dublikats: 'Prece ar šādu artikulu jau eksistē' });
  }
});

app.delete('/api/preces/:id', admin, async (req, res) => {
  const id = idNoUrl(req, res);
  if (id === null) return;
  try {
    const r = await pool.query('DELETE FROM preces WHERE id = $1', [id]);
    if (r.rowCount === 0) return kluda(res, 404, 'Prece nav atrasta');
    res.json({ zinojums: 'Prece dzēsta' });
  } catch (err) {
    dbKluda(res, err, { saistits: 'Preci nevar dzēst, jo tā ir pasūtījumos' });
  }
});

// ====================================================
// NOLIKTAVAS VIETAS
// ====================================================

app.get('/api/vietas', visi, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, kods FROM vietas ORDER BY kods');
    res.json(r.rows);
  } catch (err) {
    dbKluda(res, err);
  }
});

app.post('/api/vietas', admin, async (req, res) => {
  const { kods } = req.body || {};
  if (!teksts(kods, 30)) return kluda(res, 400, 'Norādiet vietas kodu (līdz 30 simboliem)');
  try {
    await pool.query('INSERT INTO vietas (kods) VALUES ($1)', [kods.trim()]);
    res.status(201).json({ zinojums: 'Vieta pievienota' });
  } catch (err) {
    dbKluda(res, err, { dublikats: 'Šāds vietas kods jau eksistē' });
  }
});

app.put('/api/vietas/:id', admin, async (req, res) => {
  const id = idNoUrl(req, res);
  if (id === null) return;
  const { kods } = req.body || {};
  if (!teksts(kods, 30)) return kluda(res, 400, 'Norādiet vietas kodu (līdz 30 simboliem)');
  try {
    const r = await pool.query('UPDATE vietas SET kods = $1 WHERE id = $2', [kods.trim(), id]);
    if (r.rowCount === 0) return kluda(res, 404, 'Vieta nav atrasta');
    res.json({ zinojums: 'Vieta atjaunināta' });
  } catch (err) {
    dbKluda(res, err, { dublikats: 'Šāds vietas kods jau eksistē' });
  }
});

app.delete('/api/vietas/:id', admin, async (req, res) => {
  const id = idNoUrl(req, res);
  if (id === null) return;
  try {
    // Vietu ar precēm dzēst nedrīkst; vēstures atsauces uz to atbrīvo ar roku (nav ON DELETE SET NULL)
    const rezultats = await tranzakcija(async (c) => {
      const ir = await c.query('SELECT 1 FROM izvietojums WHERE vieta_id = $1 LIMIT 1', [id]);
      if (ir.rowCount > 0) return 'aiznemta';
      await c.query('UPDATE izvietojuma_vesture SET no_vietas = NULL WHERE no_vietas = $1', [id]);
      await c.query('UPDATE izvietojuma_vesture SET uz_vietu = NULL WHERE uz_vietu = $1', [id]);
      const r = await c.query('DELETE FROM vietas WHERE id = $1', [id]);
      return r.rowCount > 0 ? 'ok' : 'nav';
    });
    if (rezultats === 'aiznemta') {
      return kluda(res, 409, 'Vietu nevar dzēst, jo tajā ir preces. Vispirms noņemiet izvietojumu.');
    }
    if (rezultats === 'nav') return kluda(res, 404, 'Vieta nav atrasta');
    res.json({ zinojums: 'Vieta dzēsta' });
  } catch (err) {
    dbKluda(res, err, { saistits: 'Vietu nevar dzēst, jo tajā ir preces. Vispirms noņemiet izvietojumu.' });
  }
});

// ====================================================
// IZVIETOJUMS (katra izmaiņa tiek ierakstīta arī vēsturē)
// ====================================================

function validetIzvietojumu(b, jauns) {
  const { prece_id, vieta_id, daudzums, stavoklis } = b || {};
  const preceId = skaitlis(prece_id, { min: 1, maks: MAKS_INT, vesels: true });
  const vietaId = skaitlis(vieta_id, { min: 1, maks: MAKS_INT, vesels: true });
  const dau = skaitlis(daudzums, { min: 0, maks: 2000000000, vesels: true });
  if (jauns && preceId === null) return { kluda: 'Izvēlieties preci' };
  if (vietaId === null) return { kluda: 'Izvēlieties vietu' };
  if (dau === null) return { kluda: 'Daudzumam jābūt veselam skaitlim, kas nav negatīvs' };
  if (!STAVOKLI.includes(stavoklis)) return { kluda: 'Izvēlieties stāvokli' };
  return { preceId, vietaId, dau, stavoklis };
}

const IZVIETOJUMA_KLUDAS = {
  dublikats: 'Šī prece šajā vietā ar šādu stāvokli jau ir. Rediģējiet esošo ierakstu.',
  saistits: 'Izvēlētā prece vai vieta neeksistē',
};

app.get('/api/izvietojums', visi, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT i.id, i.prece_id, i.vieta_id,
              p.artikuls || ' - ' || p.nosaukums AS prece, v.kods AS vieta,
              i.daudzums, i.stavoklis,
              to_char(i.atjaunots, 'YYYY-MM-DD HH24:MI') AS atjaunots
       FROM izvietojums i
       JOIN preces p ON p.id = i.prece_id
       JOIN vietas v ON v.id = i.vieta_id
       ORDER BY v.kods, p.artikuls`
    );
    res.json(r.rows);
  } catch (err) {
    dbKluda(res, err);
  }
});

app.post('/api/izvietojums', admin, async (req, res) => {
  const v = validetIzvietojumu(req.body, true);
  if (v.kluda) return kluda(res, 400, v.kluda);
  const lietotajsId = req.session.lietotajs.id;
  try {
    await tranzakcija(async (c) => {
      await c.query(
        `INSERT INTO izvietojums (prece_id, vieta_id, daudzums, stavoklis, atjaunoja)
         VALUES ($1, $2, $3, $4, $5)`,
        [v.preceId, v.vietaId, v.dau, v.stavoklis, lietotajsId]
      );
      await c.query(
        `INSERT INTO izvietojuma_vesture (prece_id, uz_vietu, darbiba, daudzums, lietotajs_id)
         VALUES ($1, $2, 'pievienots', $3, $4)`,
        [v.preceId, v.vietaId, v.dau, lietotajsId]
      );
    });
    res.status(201).json({ zinojums: 'Izvietojums pievienots' });
  } catch (err) {
    dbKluda(res, err, IZVIETOJUMA_KLUDAS);
  }
});

app.put('/api/izvietojums/:id', admin, async (req, res) => {
  const id = idNoUrl(req, res);
  if (id === null) return;
  const v = validetIzvietojumu(req.body, false);
  if (v.kluda) return kluda(res, 400, v.kluda);
  const lietotajsId = req.session.lietotajs.id;
  try {
    const atrasts = await tranzakcija(async (c) => {
      const vecais = await c.query('SELECT prece_id, vieta_id FROM izvietojums WHERE id = $1 FOR UPDATE', [id]);
      if (vecais.rowCount === 0) return false;
      const { prece_id, vieta_id } = vecais.rows[0];
      await c.query(
        `UPDATE izvietojums
         SET vieta_id = $1, daudzums = $2, stavoklis = $3, atjaunoja = $4, atjaunots = NOW()
         WHERE id = $5`,
        [v.vietaId, v.dau, v.stavoklis, lietotajsId, id]
      );
      await c.query(
        `INSERT INTO izvietojuma_vesture (prece_id, no_vietas, uz_vietu, darbiba, daudzums, lietotajs_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [prece_id, vieta_id, v.vietaId, vieta_id !== v.vietaId ? 'parvietots' : 'daudzums_mainits', v.dau, lietotajsId]
      );
      return true;
    });
    if (!atrasts) return kluda(res, 404, 'Ieraksts nav atrasts');
    res.json({ zinojums: 'Izvietojums atjaunināts' });
  } catch (err) {
    dbKluda(res, err, IZVIETOJUMA_KLUDAS);
  }
});

app.delete('/api/izvietojums/:id', admin, async (req, res) => {
  const id = idNoUrl(req, res);
  if (id === null) return;
  const lietotajsId = req.session.lietotajs.id;
  try {
    const atrasts = await tranzakcija(async (c) => {
      const vecais = await c.query(
        'SELECT prece_id, vieta_id, daudzums FROM izvietojums WHERE id = $1 FOR UPDATE', [id]
      );
      if (vecais.rowCount === 0) return false;
      const { prece_id, vieta_id, daudzums } = vecais.rows[0];
      await c.query('DELETE FROM izvietojums WHERE id = $1', [id]);
      await c.query(
        `INSERT INTO izvietojuma_vesture (prece_id, no_vietas, darbiba, daudzums, lietotajs_id)
         VALUES ($1, $2, 'nonemts', $3, $4)`,
        [prece_id, vieta_id, daudzums, lietotajsId]
      );
      return true;
    });
    if (!atrasts) return kluda(res, 404, 'Ieraksts nav atrasts');
    res.json({ zinojums: 'Izvietojums noņemts' });
  } catch (err) {
    dbKluda(res, err);
  }
});

// ====================================================
// PASŪTĪJUMI (noliktavas darbinieks)
// Statusu maina pa soļiem (STATUSU_PLUSMA); rediģēt var tikai jaunu pasūtījumu;
// dzēst var tikai jaunu vai atceltu pasūtījumu.
// ====================================================

function validetPasutijumu(b) {
  const { klients, preces } = b || {};
  if (!teksts(klients, 150)) return { kluda: 'Norādiet klientu (līdz 150 simboliem)' };
  if (!Array.isArray(preces) || preces.length === 0) return { kluda: 'Pievienojiet vismaz vienu preci' };
  if (preces.length > 100) return { kluda: 'Pasūtījumā ir pārāk daudz pozīciju (maksimums 100)' };

  // Vienādas preces apvieno, saskaitot daudzumus
  const kopa = new Map();
  for (const rinda of preces) {
    const preceId = skaitlis(rinda && rinda.prece_id, { min: 1, maks: MAKS_INT, vesels: true });
    const dau = skaitlis(rinda && rinda.daudzums, { min: 1, maks: 1000000, vesels: true });
    if (preceId === null) return { kluda: 'Katrai rindai izvēlieties preci' };
    if (dau === null) return { kluda: 'Daudzumam jābūt veselam skaitlim no 1' };
    kopa.set(preceId, (kopa.get(preceId) || 0) + dau);
  }
  return { klients: klients.trim(), preces: [...kopa.entries()] };
}

async function ierakstitPreces(c, pasutijumaId, preces) {
  await c.query(
    `INSERT INTO pasutijuma_preces (pasutijums_id, prece_id, daudzums)
     SELECT $1::int, t.prece_id, t.daudzums
     FROM unnest($2::int[], $3::int[]) AS t(prece_id, daudzums)`,
    [pasutijumaId, preces.map((p) => p[0]), preces.map((p) => p[1])]
  );
}

app.get('/api/pasutijumi', darbinieks, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.id, o.klients, o.statuss,
              to_char(o.izveidots, 'YYYY-MM-DD HH24:MI') AS izveidots,
              l.lietotajvards AS izveidoja,
              COALESCE(
                json_agg(json_build_object('prece_id', pp.prece_id, 'artikuls', p.artikuls,
                                           'nosaukums', p.nosaukums, 'daudzums', pp.daudzums)
                         ORDER BY p.artikuls) FILTER (WHERE pp.id IS NOT NULL),
                '[]'::json) AS preces
       FROM pasutijumi o
       LEFT JOIN pasutijuma_preces pp ON pp.pasutijums_id = o.id
       LEFT JOIN preces p ON p.id = pp.prece_id
       LEFT JOIN lietotaji l ON l.id = o.izveidoja
       GROUP BY o.id, l.lietotajvards
       ORDER BY o.id DESC`
    );
    res.json(r.rows.map((o) => ({ ...o, nakamie: STATUSU_PLUSMA[o.statuss] || [] })));
  } catch (err) {
    dbKluda(res, err);
  }
});

app.post('/api/pasutijumi', darbinieks, async (req, res) => {
  const v = validetPasutijumu(req.body);
  if (v.kluda) return kluda(res, 400, v.kluda);
  try {
    const id = await tranzakcija(async (c) => {
      const r = await c.query(
        'INSERT INTO pasutijumi (klients, izveidoja) VALUES ($1, $2) RETURNING id',
        [v.klients, req.session.lietotajs.id]
      );
      await ierakstitPreces(c, r.rows[0].id, v.preces);
      return r.rows[0].id;
    });
    res.status(201).json({ zinojums: `Pasūtījums Nr. ${id} izveidots`, id });
  } catch (err) {
    dbKluda(res, err, { saistits: 'Kāda no izvēlētajām precēm neeksistē' });
  }
});

// Rediģēšana: tikai ar statusu "jauns"
app.put('/api/pasutijumi/:id', darbinieks, async (req, res) => {
  const id = idNoUrl(req, res);
  if (id === null) return;
  const v = validetPasutijumu(req.body);
  if (v.kluda) return kluda(res, 400, v.kluda);
  try {
    const rezultats = await tranzakcija(async (c) => {
      const r = await c.query('SELECT statuss FROM pasutijumi WHERE id = $1 FOR UPDATE', [id]);
      if (r.rowCount === 0) return 'nav';
      if (r.rows[0].statuss !== 'jauns') return 'slegts';
      await c.query('UPDATE pasutijumi SET klients = $1 WHERE id = $2', [v.klients, id]);
      await c.query('DELETE FROM pasutijuma_preces WHERE pasutijums_id = $1', [id]);
      await ierakstitPreces(c, id, v.preces);
      return 'ok';
    });
    if (rezultats === 'nav') return kluda(res, 404, 'Pasūtījums nav atrasts');
    if (rezultats === 'slegts') {
      return kluda(res, 409, 'Pasūtījumu var rediģēt tikai ar statusu "Jauns"');
    }
    res.json({ zinojums: `Pasūtījums Nr. ${id} atjaunināts` });
  } catch (err) {
    dbKluda(res, err, { saistits: 'Kāda no izvēlētajām precēm neeksistē' });
  }
});

// Statusa maiņa pa izpildes soļiem
app.put('/api/pasutijumi/:id/statuss', darbinieks, async (req, res) => {
  const id = idNoUrl(req, res);
  if (id === null) return;
  const { statuss } = req.body || {};
  if (typeof statuss !== 'string' || !Object.prototype.hasOwnProperty.call(STATUSU_PLUSMA, statuss)) {
    return kluda(res, 400, 'Nederīgs statuss');
  }
  try {
    const rezultats = await tranzakcija(async (c) => {
      const r = await c.query('SELECT statuss FROM pasutijumi WHERE id = $1 FOR UPDATE', [id]);
      if (r.rowCount === 0) return { kods: 'nav' };
      const pasreizejais = r.rows[0].statuss;
      if (!STATUSU_PLUSMA[pasreizejais].includes(statuss)) return { kods: 'nederigs', pasreizejais };
      await c.query('UPDATE pasutijumi SET statuss = $1 WHERE id = $2', [statuss, id]);
      return { kods: 'ok' };
    });
    if (rezultats.kods === 'nav') return kluda(res, 404, 'Pasūtījums nav atrasts');
    if (rezultats.kods === 'nederigs') {
      return kluda(
        res,
        409,
        `Statusu nevar mainīt no "${STATUSU_NOSAUKUMI[rezultats.pasreizejais]}" uz "${STATUSU_NOSAUKUMI[statuss]}"`
      );
    }
    res.json({ zinojums: `Pasūtījums Nr. ${id}: statuss "${STATUSU_NOSAUKUMI[statuss]}"` });
  } catch (err) {
    dbKluda(res, err);
  }
});

// Dzēšana: tikai jaunu vai atceltu pasūtījumu
app.delete('/api/pasutijumi/:id', darbinieks, async (req, res) => {
  const id = idNoUrl(req, res);
  if (id === null) return;
  try {
    const rezultats = await tranzakcija(async (c) => {
      const r = await c.query('SELECT statuss FROM pasutijumi WHERE id = $1 FOR UPDATE', [id]);
      if (r.rowCount === 0) return 'nav';
      if (!['jauns', 'atcelts'].includes(r.rows[0].statuss)) return 'slegts';
      await c.query('DELETE FROM pasutijumi WHERE id = $1', [id]);
      return 'ok';
    });
    if (rezultats === 'nav') return kluda(res, 404, 'Pasūtījums nav atrasts');
    if (rezultats === 'slegts') {
      return kluda(res, 409, 'Dzēst var tikai jaunu vai atceltu pasūtījumu');
    }
    res.json({ zinojums: `Pasūtījums Nr. ${id} dzēsts` });
  } catch (err) {
    dbKluda(res, err);
  }
});

// ====================================================
// PĀRSKATI (JSON vai CSV ar ?csv=1)
// ====================================================

app.get('/api/parskati', visi, (req, res) => {
  const loma = req.session.lietotajs.loma;
  res.json(
    Object.entries(PARSKATI)
      .filter(([, p]) => p.lomas.includes(loma))
      .map(([id, p]) => ({ id, nosaukums: p.nosaukums }))
  );
});

app.get('/api/parskati/:id', visi, async (req, res) => {
  try {
    const id = req.params.id;
    if (!Object.prototype.hasOwnProperty.call(PARSKATI, id)) {
      return kluda(res, 404, 'Pārskats nav atrasts');
    }
    const p = PARSKATI[id];
    if (!p.lomas.includes(req.session.lietotajs.loma)) {
      return kluda(res, 403, 'Jums nav tiesību veikt šo darbību');
    }

    const r = await pool.query(p.sql);

    if (req.query.csv === '1') {
      // Semikols atdala laukus, jo latviešu Excel to sagaida; BOM nodrošina pareizas garumzīmes
      const rindas = [
        p.kolonnas.map((k) => csvLauks(k.label)).join(';'),
        ...r.rows.map((rinda) => p.kolonnas.map((k) => csvLauks(rinda[k.key])).join(';')),
      ];
      const datums = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${id}-${datums}.csv"`);
      return res.send('\uFEFF' + rindas.join('\r\n'));
    }

    res.json({ nosaukums: p.nosaukums, kolonnas: p.kolonnas, rindas: r.rows });
  } catch (err) {
    dbKluda(res, err);
  }
});

 
// ---------- Neatrasts un kļūdu apstrāde ----------
 
app.use('/api', (req, res) => kluda(res, 404, 'Resurss nav atrasts'));
 
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return kluda(res, 400, 'Nederīgi dati (JSON kļūda)');
  }
  console.error(err);
  kluda(res, 500, 'Servera kļūda, mēģiniet vēlreiz');
});

app.listen(PORT, () => {
  console.log(`Serveris darbojas portā http://localhost:${PORT}`);
});