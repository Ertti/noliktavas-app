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
 
function requireLogin(req, res, next) {
  if (!req.session.lietotajs) {
    return kluda(res, 401, 'Jums jāpieslēdzas sistēmai');
  }
  next();
}
 
function requireRole(...atlautasLomas) {
  return (req, res, next) => {
    if (!req.session.lietotajs) {
      return kluda(res, 401, 'Jums jāpieslēdzas sistēmai');
    }
    if (!atlautasLomas.includes(req.session.lietotajs.loma)) {
      return kluda(res, 403, 'Jums nav tiesību veikt šo darbību');
    }
    next();
  };
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
      return kluda(res, 400, 'Lietotājvārds: 3-50 simboli (burti, cipari, _ . -)');
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
 
    const loma = await pool.query('SELECT id FROM lomas WHERE id = $1', [lomaId]);
    if (loma.rowCount === 0) {
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