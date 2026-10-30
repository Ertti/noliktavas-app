CREATE TABLE lomas (
    id SERIAL PRIMARY KEY,
    nosaukums VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE lietotaji (
    id SERIAL PRIMARY KEY,
    lietotajvards VARCHAR(50) NOT NULL UNIQUE CHECK (length(lietotajvards) >= 3),
    parole VARCHAR(255) NOT NULL,
    vards_uzvards VARCHAR(100) NOT NULL,
    loma_id INT NOT NULL REFERENCES lomas(id)
);

CREATE TABLE preces (
    id SERIAL PRIMARY KEY,
    artikuls VARCHAR(50) NOT NULL UNIQUE,
    nosaukums VARCHAR(150) NOT NULL,
    apraksts TEXT,
    cena NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cena >= 0)
);

CREATE TABLE vietas (
    id SERIAL PRIMARY KEY,
    kods VARCHAR(30) NOT NULL UNIQUE
);

CREATE TABLE izvietojums (
    id SERIAL PRIMARY KEY,
    prece_id INT NOT NULL REFERENCES preces(id) ON DELETE CASCADE,
    vieta_id INT NOT NULL REFERENCES vietas(id),
    daudzums INT NOT NULL CHECK (daudzums >= 0),
    stavoklis VARCHAR(20) NOT NULL DEFAULT 'labs'
    CHECK (stavoklis IN ('labs', 'bojats', 'karantina')),
    atjaunoja INT REFERENCES lietotaji(id),
    atjaunots TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (prece_id, vieta_id, stavoklis)
);

CREATE TABLE pasutijumi (
    id SERIAL PRIMARY KEY,
    klients VARCHAR(150) NOT NULL,
    statuss VARCHAR(20) NOT NULL DEFAULT 'jauns'
    CHECK (statuss IN ('jauns', 'komplektesana', 'nosutits', 'piegadats', 'atcelts')),
    izveidoja INT REFERENCES lietotaji(id),
    izveidots TIMESTAMP NOT NULL DEFAULT NOW()
);
 
CREATE TABLE pasutijuma_preces (
    id SERIAL PRIMARY KEY,
    pasutijums_id INT NOT NULL REFERENCES pasutijumi(id) ON DELETE CASCADE,
    prece_id INT NOT NULL REFERENCES preces(id),
    daudzums INT NOT NULL CHECK (daudzums > 0)
);

CREATE TABLE izvietojuma_vesture (
    id SERIAL PRIMARY KEY,
    prece_id INT NOT NULL REFERENCES preces(id) ON DELETE CASCADE,
    no_vietas INT REFERENCES vietas(id),
    uz_vietu INT REFERENCES vietas(id),
    darbiba VARCHAR(20) NOT NULL
    CHECK (darbiba IN ('pievienots', 'parvietots', 'daudzums_mainits', 'nonemts')),
    daudzums INT NOT NULL CHECK (daudzums >= 0),
    lietotajs_id INT REFERENCES lietotaji(id),
    laiks TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE VIEW v_atlikumi AS
SELECT p.artikuls, p.nosaukums,
COALESCE(SUM(i.daudzums) FILTER (WHERE i.stavoklis = 'labs'), 0) AS atlikums
FROM preces p
LEFT JOIN izvietojums i ON i.prece_id = p.id
GROUP BY p.id;

CREATE VIEW v_izvietojuma_parskats AS
SELECT p.artikuls, p.nosaukums, v.kods AS vieta, i.daudzums, i.stavoklis, i.atjaunots
FROM izvietojums i
JOIN preces p ON p.id = i.prece_id
JOIN vietas v ON v.id = i.vieta_id;

CREATE VIEW v_pasutijumu_kopsavilkums AS
SELECT o.id, o.klients, o.statuss, o.izveidots, 
COALESCE(SUM(pp.daudzums), 0) AS preces_kopa
FROM pasutijumi o
LEFT JOIN pasutijuma_preces pp ON pp.pasutijums_id = o.id
GROUP BY o.id;
 
-- 4. Sākuma dati
INSERT INTO lomas (nosaukums) VALUES
    ('administrators'), ('noliktavas_darbinieks'), ('plauktu_kartotajs');

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO lietotaji (lietotajvards, parole, vards_uzvards, loma_id)
VALUES ('Edza', '$2b$10$jrys9P1mxliyJZwaFuLP2eOJb1grE5KWYgVFaBE7kjV3GviZVxVZm', 'E T', '1')

SELECT l.lietotajvards, r.nosaukums AS loma
FROM lietotaji l JOIN lomas r ON r.id = l.loma_id;