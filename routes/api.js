// routes/api.js - SERVERA puse: lietotāju pārvaldība, noliktavas dati un pārskati (Node + PostgreSQL)
// Pieslēgšana server.js:
//   app.use('/api', require('./routes/api')(pool, requireRole, kluda));

const express = require('express');
const bcrypt = require('bcryptjs');

const STAVOKLI = ['labs', 'bojats', 'karantina'];
const MAKS_INT = 2147483647;

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

module.exports = function (pool, requireRole, kluda) {
  const router = express.Router();

  const admin = requireRole('administrators');
  const adminVaiDarbinieks = requireRole('administrators', 'noliktavas_darbinieks');
  const visi = requireRole('administrators', 'noliktavas_darbinieks', 'plauktu_kartotajs');

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

  router.get('/lietotaji', admin, async (req, res) => {
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

  router.put('/lietotaji/:id', admin, async (req, res) => {
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

  router.delete('/lietotaji/:id', admin, async (req, res) => {
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

  router.get('/preces', visi, async (req, res) => {
    try {
      const r = await pool.query('SELECT id, artikuls, nosaukums, apraksts, cena FROM preces ORDER BY artikuls');
      res.json(r.rows);
    } catch (err) {
      dbKluda(res, err);
    }
  });

  router.post('/preces', adminVaiDarbinieks, async (req, res) => {
    const v = validetPreci(req.body);
    if (v.kluda) return kluda(res, 400, v.kluda);
    try {
      await pool.query('INSERT INTO preces (artikuls, nosaukums, apraksts, cena) VALUES ($1, $2, $3, $4)', v.dati);
      res.status(201).json({ zinojums: 'Prece pievienota' });
    } catch (err) {
      dbKluda(res, err, { dublikats: 'Prece ar šādu artikulu jau eksistē' });
    }
  });

  router.put('/preces/:id', adminVaiDarbinieks, async (req, res) => {
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

  router.delete('/preces/:id', admin, async (req, res) => {
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

  router.get('/vietas', visi, async (req, res) => {
    try {
      const r = await pool.query('SELECT id, kods FROM vietas ORDER BY kods');
      res.json(r.rows);
    } catch (err) {
      dbKluda(res, err);
    }
  });

  router.post('/vietas', admin, async (req, res) => {
    const { kods } = req.body || {};
    if (!teksts(kods, 30)) return kluda(res, 400, 'Norādiet vietas kodu (līdz 30 simboliem)');
    try {
      await pool.query('INSERT INTO vietas (kods) VALUES ($1)', [kods.trim()]);
      res.status(201).json({ zinojums: 'Vieta pievienota' });
    } catch (err) {
      dbKluda(res, err, { dublikats: 'Šāds vietas kods jau eksistē' });
    }
  });

  router.put('/vietas/:id', admin, async (req, res) => {
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

  router.delete('/vietas/:id', admin, async (req, res) => {
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

  router.get('/izvietojums', visi, async (req, res) => {
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

  router.post('/izvietojums', admin, async (req, res) => {
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

  router.put('/izvietojums/:id', admin, async (req, res) => {
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

  router.delete('/izvietojums/:id', admin, async (req, res) => {
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
  // PĀRSKATI (JSON vai CSV ar ?csv=1)
  // ====================================================

  router.get('/parskati', visi, (req, res) => {
    const loma = req.session.lietotajs.loma;
    res.json(
      Object.entries(PARSKATI)
        .filter(([, p]) => p.lomas.includes(loma))
        .map(([id, p]) => ({ id, nosaukums: p.nosaukums }))
    );
  });

  router.get('/parskati/:id', visi, async (req, res) => {
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

  return router;
};