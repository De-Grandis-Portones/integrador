// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sql = require('mssql');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const {
  ensureMeasurementMappingsTable,
  getMeasurementMappingsLastSyncAt,
  listMeasurementSourceCatalog,
  listMeasurementPropertyMappings,
  upsertMeasurementPropertyMapping,
  reapplyProductionPropertyAssignments,
} = require('./measurementMappings');

// =====================
// CONFIGURACIÓN
// =====================

const PORT = process.env.PORT || 4000;

// --- SQL Server ---
const sqlServerRaw = process.env.SQL_SERVER || 'localhost';
let sqlHost = sqlServerRaw;
let sqlPort = 1433;

if (sqlServerRaw.includes(',')) {
  const [hostPart, portPart] = sqlServerRaw.split(',');
  sqlHost = hostPart;
  const parsedPort = parseInt(portPart, 10);
  if (!Number.isNaN(parsedPort)) {
    sqlPort = parsedPort;
  }
}

const sqlConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: sqlHost,
  port: sqlPort,
  database: process.env.SQL_DATABASE,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

// --- Odoo ---
const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USERNAME = process.env.ODOO_USERNAME;
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;
const ODOO_COMPANY_ID = process.env.ODOO_COMPANY_ID ? parseInt(process.env.ODOO_COMPANY_ID, 10) : null;

// --- Supabase (Postgres) ---
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || null;
let supabasePool = null;

if (SUPABASE_DB_URL) {
  supabasePool = new Pool({ connectionString: SUPABASE_DB_URL });
  console.log('Pool de Supabase inicializado.');
} else {
  console.warn('ATENCIÓN: SUPABASE_DB_URL no está configurado. API de fórmulas / valores no funcionará.');
}

if (supabasePool) {
  // Sincroniza la estructura de tablas dos veces por día (08:30 y 17:30, hora Argentina).
  // No corre al arrancar ni al abrir la página: solo en estos horarios.
  cron.schedule('30 8,17 * * *', () => {
    ensureMeasurementMappingsTable(supabasePool).catch((err) => {
      console.error('No se pudo sincronizar preproduccion_property_mappings (cron):', err?.message || err);
    });
  }, { timezone: 'America/Argentina/Buenos_Aires' });
}

if (supabasePool) {
  supabasePool.on('error', (err) => {
    console.error('Error en pool de Supabase:', err);
  });
}

// --- Supabase Admin (Auth verify) ---
const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

if (!supabaseAdmin) {
  console.warn('ATENCIÓN: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no configurados. Auth/roles no funcionarán.');
}

// Sistema de Tickets compartido entre apps: todas (planificación,
// integrador, y las que se sumen después) escriben en las mismas tablas
// public.tickets / public.ticket_mensajes — no cada app tiene la suya.
// Esas tablas viven en la MISMA base que ya usa el resto de esta app
// (SUPABASE_DB_URL), así que no hace falta un pool ni una env var aparte:
// se reusa `supabasePool`. Ver Backend/server/index.js (MIGRATIONS, tablas
// 'tickets'/'ticket_mensajes') en el repo de planificación.

// =====================
// HELPERS
// =====================

function normalizeYYYYMMDD(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  if (!s) return '';

  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return '';
}

// Rango diario UTC: [YYYY-MM-DDT00:00Z, +1 día)
function dayRangeUtc(yyyy_mm_dd) {
  const f = normalizeYYYYMMDD(yyyy_mm_dd);
  if (!f) return null;

  const start = new Date(`${f}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { startISO: start.toISOString(), endISO: end.toISOString(), day: f };
}

// =====================
// AUTH / ROLES
// =====================

async function requireAuth(req, res, next) {
  try {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'Supabase admin no configurado' });
    }

    const hdr = req.headers.authorization || '';
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Falta token Bearer' });

    const token = m[1];
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    req.user = data.user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'No autorizado', details: e.message || String(e) });
  }
}

async function attachRole(req, _res, next) {
  try {
    req.role = 'viewer';
    if (!supabasePool || !req.user?.id) return next();

    const r = await supabasePool.query('SELECT role FROM app_users WHERE user_id = $1 LIMIT 1', [req.user.id]);
    req.role = r?.rows?.[0]?.role || 'viewer';
    next();
  } catch {
    req.role = 'viewer';
    next();
  }
}

function requireRole(allowedRoles) {
  const allowed = new Set(allowedRoles || []);
  return (req, res, next) => {
    const role = req.role || 'viewer';
    if (!allowed.has(role)) {
      return res.status(403).json({ error: 'No tenés permisos', role });
    }
    next();
  };
}

// =====================
// NV TERMINADOS (texto)
// =====================

let nvTerminadosCache = null;

function loadNvTerminados() {
  if (nvTerminadosCache !== null) {
    return nvTerminadosCache;
  }

  try {
    const filePath = path.join(__dirname, 'nv_terminados.txt');
    const content = fs.readFileSync(filePath, 'utf8');
    const set = new Set();
    content.split(/\r?\n/).forEach((line) => {
      const v = line.trim();
      if (v) set.add(v);
    });
    nvTerminadosCache = set;
    console.log(`NV terminados cargados: ${set.size}`);
  } catch (err) {
    console.warn('No se pudo leer nv_terminados.txt. Se asume que no hay NV terminados.', err.message);
    nvTerminadosCache = new Set();
  }

  return nvTerminadosCache;
}

// =====================
// CONEXIÓN SQL SERVER
// =====================

let poolPromise = null;

async function getSqlPool() {
  if (!poolPromise) {
    console.log('Conectando a SQL Server...', sqlHost + ':' + sqlPort);
    poolPromise = sql.connect(sqlConfig);
  }
  return poolPromise;
}

// ---------------------
// NTASVTAS / INTASVTAS
// ---------------------

async function getNtavHeader(idpedido) {
  const pool = await getSqlPool();
  const result = await pool
    .request()
    .input('idpedido', sql.VarChar, idpedido)
    .query(`
      SELECT
        fecha,
        tipo,
        sucursal,
        numero,
        deposito,
        cliente,
        nombre,
        direccion,
        localidad,
        cp,
        provincia,
        fpago,
        vendedor,
        operador,
        zona,
        iva,
        cuit,
        ibrutos,
        observ,
        retrep,
        fechaent,
        dirent,
        obs AS obs2,
        oc,
        idpedido,
        condicion,
        factura,
        remito
      FROM Portones.dbo.NTASVTAS
      WHERE idpedido = @idpedido
    `);

  if (!result.recordset.length) {
    return null;
  }
  return result.recordset[0];
}

async function getNtavLinesFromHeader(header) {
  const pool = await getSqlPool();

  // En instalaciones viejas, el campo `numero` a veces es VARCHAR.
  // Para hacerlo robusto, comparamos como string (trim) en lugar de forzar INT.
  const tipo = header?.tipo ?? null;
  const sucursalInt = header?.sucursal !== undefined && header?.sucursal !== null ? parseInt(header.sucursal, 10) : null;
  const depositoInt = header?.deposito !== undefined && header?.deposito !== null ? parseInt(header.deposito, 10) : null;
  const numeroStr = header?.numero !== undefined && header?.numero !== null ? String(header.numero).trim() : '';

  const result = await pool
    .request()
    .input('tipo', sql.VarChar, tipo)
    .input('sucursal', sql.Int, Number.isFinite(sucursalInt) ? sucursalInt : null)
    .input('numeroStr', sql.VarChar, numeroStr)
    .input('deposito', sql.Int, Number.isFinite(depositoInt) ? depositoInt : null)
    .query(`
      SELECT
        l.producto,
        p.descripcion,
        l.cantidad,
        l.precio,
        l.bonific,
        l.preneto,
        l.prelista
      FROM Portones.dbo.INTASVTAS AS l
      LEFT JOIN Portones.dbo.PRODUCTOS AS p
        ON p.codigo = l.producto
      WHERE
        l.tipo = @tipo
        AND l.sucursal = @sucursal
        AND LTRIM(RTRIM(CAST(l.numero AS varchar(50)))) = @numeroStr
        AND l.deposito = @deposito
    `);

  return result.recordset;
}

// ---------------------
// Pre_Produccion (SQL)
// ---------------------

async function getPreProduccionRows(nv) {
  const pool = await getSqlPool();

  let query = `
    SELECT TOP (1000) *
    FROM WebApp.dbo.Pre_Produccion
  `;

  const request = pool.request();

  if (nv) {
    query += ' WHERE NV = @nv';
    request.input('nv', sql.Int, parseInt(nv, 10));
  }

  query += ' ORDER BY ID DESC';

  const result = await request.query(query);
  const allRows = result.recordset || [];

  const nvTerminados = loadNvTerminados();
  const filtered = allRows.filter((row) => {
    const nvVal = row.NV !== null && row.NV !== undefined ? String(row.NV).trim() : '';
    if (nvTerminados.has(nvVal)) {
      row.Estado = 'TERMINADO';
      return false;
    }
    return true;
  });

  return filtered;
}

// =====================
// FORMULAS EN SUPABASE
// =====================

async function getAllColumnFormulas() {
  if (!supabasePool) throw new Error('SUPABASE_DB_URL no está configurado');
  const { rows } = await supabasePool.query(
    'SELECT column_name, expression FROM preproduccion_formulas ORDER BY column_name'
  );
  return rows;
}

async function upsertColumnFormula(columnName, expression) {
  if (!supabasePool) throw new Error('SUPABASE_DB_URL no está configurado');
  const { rows } = await supabasePool.query(
    `
      INSERT INTO preproduccion_formulas (column_name, expression)
      VALUES ($1, $2)
      ON CONFLICT (column_name)
      DO UPDATE SET expression = EXCLUDED.expression, updated_at = now()
      RETURNING column_name, expression
    `,
    [columnName, expression]
  );
  return rows[0];
}

async function getCompiledFormulasFromDb() {
  const formulas = await getAllColumnFormulas();
  const compiled = {};

  for (const f of formulas) {
    const col = f.column_name;
    const expr = (f.expression || '').trim();
    if (!expr) continue;

    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(
        'row',
        `
          try {
            with (row) {
              return (${expr});
            }
          } catch (e) {
            return undefined;
          }
        `
      );
      compiled[col] = fn;
    } catch (err) {
      console.error(`No se pudo compilar la fórmula para columna ${col}:`, err.message);
    }
  }

  return compiled;
}

// =====================
// PREPRODUCCION_* EN SUPABASE
// =====================

async function upsertPreproduccionSqlRow(rawRow) {
  if (!supabasePool) return;

  const nvVal = rawRow.NV != null ? parseInt(rawRow.NV, 10) : null;
  if (!nvVal || Number.isNaN(nvVal)) return;

  const idVal = rawRow.ID ?? rawRow.Id ?? rawRow.id; // por si cambia el case
  if (idVal == null) {
    console.warn('Fila sin ID en SQL Server para NV', nvVal);
    return;
  }

  await supabasePool.query(
    `
      INSERT INTO preproduccion_sql (id, nv, data)
      VALUES ($1, $2, $3)
      ON CONFLICT (nv)
      DO UPDATE
        SET data = EXCLUDED.data,
            updated_at = now()
    `,
    [idVal, nvVal, rawRow]
  );
}

function computeFormulaValuesWithDeps(row, compiled) {
  const cache = {};
  const visiting = new Set();

  function evalCol(col) {
    if (Object.prototype.hasOwnProperty.call(cache, col)) return cache[col];

    if (visiting.has(col)) {
      return row[col];
    }
    visiting.add(col);

    const fn = compiled[col];
    if (!fn) {
      cache[col] = row[col];
      visiting.delete(col);
      return cache[col];
    }

    const proxyRow = new Proxy(row, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') {
          if (Object.prototype.hasOwnProperty.call(compiled, prop)) {
            return evalCol(prop);
          }
          if (Object.prototype.hasOwnProperty.call(target, prop)) {
            return target[prop];
          }
        }
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        if (typeof prop === 'string') {
          if (Object.prototype.hasOwnProperty.call(compiled, prop)) return true;
          if (Object.prototype.hasOwnProperty.call(target, prop)) return true;
        }
        return Reflect.has(target, prop);
      },
    });

    let result;
    try {
      result = fn(proxyRow);
    } catch {
      result = undefined;
    }

    visiting.delete(col);
    cache[col] = result;
    return result;
  }

  const out = {};
  for (const col of Object.keys(compiled)) {
    const v = evalCol(col);
    if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))) {
      out[col] = v;
    }
  }
  return out;
}

async function upsertPreproduccionValoresFillDerived(rawRow, compiled) {
  if (!supabasePool) return;

  const nvVal = rawRow.NV !== null && rawRow.NV !== undefined ? parseInt(rawRow.NV, 10) : null;
  if (!nvVal || Number.isNaN(nvVal)) return;

  const idVal = rawRow.ID ?? rawRow.Id ?? rawRow.id;
  if (idVal == null) {
    console.warn('Fila sin ID para preproduccion_valores, NV', nvVal);
    return;
  }

  let baseRow = null;
  try {
    const r = await supabasePool.query('SELECT data FROM preproduccion_sql WHERE nv = $1 LIMIT 1', [nvVal]);
    baseRow = r?.rows?.[0]?.data || null;
  } catch (e) {
    console.warn('No se pudo leer preproduccion_sql para NV', nvVal, e?.message || e);
    baseRow = null;
  }

  if (!baseRow) baseRow = { ...rawRow };

  let existing = {};
  try {
    const r = await supabasePool.query('SELECT data FROM preproduccion_valores WHERE nv = $1 AND nv_tipo = $2 LIMIT 1', [nvVal, 'NV']);
    existing = r?.rows?.[0]?.data || {};
  } catch {
    existing = {};
  }

  const formulaCols = new Set(Object.keys(compiled || {}));
  formulaCols.add('lado_mas_alto');
  formulaCols.add('calc_espada');

  const manualOverrides = {};
  for (const [k, v] of Object.entries(existing || {})) {
    if (formulaCols.has(k)) continue;
    const baseV = baseRow?.[k];
    if (v !== baseV) {
      manualOverrides[k] = v;
    }
  }

  const effectiveRow = { ...baseRow, ...manualOverrides };
  const computed = compiled ? computeFormulaValuesWithDeps(effectiveRow, compiled) : {};

  if (rawRow && rawRow.lado_mas_alto !== undefined && rawRow.lado_mas_alto !== null) {
    computed.lado_mas_alto = rawRow.lado_mas_alto;
  }
  if (rawRow && rawRow.calc_espada !== undefined && rawRow.calc_espada !== null) {
    computed.calc_espada = rawRow.calc_espada;
  }

  const payload = { ...baseRow, ...manualOverrides, ...computed };

  await supabasePool.query(
    `
      INSERT INTO preproduccion_valores (nv, nv_tipo, data)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (nv, nv_tipo)
      DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = now()
    `,
    [nvVal, 'NV', JSON.stringify(payload)]
  );
}

// =====================
// LECTURA "DEFINITIVA"
// =====================

async function getPreProduccionSqlRowsFromSupabase({ nv, partida, fecha_envio_produccion } = {}) {
  if (!supabasePool) throw new Error('SUPABASE_DB_URL no está configurado');

  let sqlText = 'SELECT nv, data FROM preproduccion_sql';
  const where = [];
  const params = [];

  if (nv) {
    const nvParsed = parseInt(nv, 10);
    if (!Number.isNaN(nvParsed)) {
      params.push(nvParsed);
      where.push(`nv = $${params.length}`);
    }
  }

  if (partida) {
    params.push(String(partida).trim());
    where.push(`COALESCE(data->>'PARTIDA', data->>'Partida', data->>'partida') = $${params.length}`);
  }

  if (fecha_envio_produccion) {
    const rng = dayRangeUtc(fecha_envio_produccion);
    if (rng) {
      params.push(rng.startISO);
      const p1 = params.length;
      params.push(rng.endISO);
      const p2 = params.length;

      where.push(
        `(NULLIF(data->>'fecha_envio_produccion','')::timestamptz >= $${p1} AND NULLIF(data->>'fecha_envio_produccion','')::timestamptz < $${p2})`
      );
    }
  }

  if (where.length) {
    sqlText += ' WHERE ' + where.join(' AND ');
  }

  sqlText += ' ORDER BY nv';

  const { rows } = await supabasePool.query(sqlText, params);

  return (rows || []).map((r) => {
    const obj = r?.data && typeof r.data === 'object' ? r.data : {};
    return { ...obj, NV: r.nv };
  });
}

async function getPreProduccionValoresRows({ nv, partida, fecha_envio_produccion } = {}) {
  if (!supabasePool) throw new Error('SUPABASE_DB_URL no está configurado');

  // ======================================================
  // Importante (caso fecha_envio_produccion):
  // - La fecha de producción vive en "preproduccion_valores" (campos imputados).
  // - Muchas veces NO está en "preproduccion_sql".
  // Si filtramos baseRows por fecha, nos quedamos sin el "base" y el merge
  // devuelve filas incompletas.
  // Solución: si hay filtro por fecha, primero buscamos los NV en valores y luego
  // traemos baseRows por esos NV (sin exigir que el base tenga la fecha).
  // ======================================================

  let sqlText = 'SELECT nv, nv_tipo, data FROM preproduccion_valores';
  const where = ["nv_tipo != 'INV'"];
  const params = [];

  if (nv) {
    const nvParsed = parseInt(nv, 10);
    if (!Number.isNaN(nvParsed)) {
      params.push(nvParsed);
      where.push(`nv = $${params.length}`);
    }
  }

  if (partida) {
    params.push(String(partida).trim());
    where.push(`COALESCE(data->>'PARTIDA', data->>'Partida', data->>'partida') = $${params.length}`);
  }

  if (fecha_envio_produccion) {
    const rng = dayRangeUtc(fecha_envio_produccion);
    if (rng) {
      params.push(rng.startISO);
      const p1 = params.length;
      params.push(rng.endISO);
      const p2 = params.length;

      where.push(
        `(NULLIF(data->>'fecha_envio_produccion','')::timestamptz >= $${p1} AND NULLIF(data->>'fecha_envio_produccion','')::timestamptz < $${p2})`
      );
    }
  }

  if (where.length) {
    sqlText += ' WHERE ' + where.join(' AND ');
  }
  sqlText += ' ORDER BY nv';

  const { rows: overlayRaw } = await supabasePool.query(sqlText, params);
  const overlayRows = (overlayRaw || []).map((r) => {
    const obj = r?.data && typeof r.data === 'object' ? r.data : {};
    return { ...obj, NV: r.nv, NV_TIPO: r.nv_tipo || 'NV' };
  });

  // --- baseRows ---
  let baseRows = [];
  if (fecha_envio_produccion) {
    // Si vino nv puntual, usamos la lectura normal
    if (nv) {
      baseRows = await getPreProduccionSqlRowsFromSupabase({ nv, partida });
    } else {
      const nvList = overlayRows
        .map((r) => parseInt(r?.NV, 10))
        .filter((n) => Number.isFinite(n));

      if (nvList.length) {
        // Traemos base por lista de NV, con filtro de partida si aplica
        let baseSql = 'SELECT nv, data FROM preproduccion_sql WHERE nv = ANY($1::int[])';
        const baseParams = [nvList];

        if (partida) {
          baseParams.push(String(partida).trim());
          baseSql += ` AND COALESCE(data->>'PARTIDA', data->>'Partida', data->>'partida') = $${baseParams.length}`;
        }

        baseSql += ' ORDER BY nv';

        const { rows: baseRaw } = await supabasePool.query(baseSql, baseParams);
        baseRows = (baseRaw || []).map((r) => {
          const obj = r?.data && typeof r.data === 'object' ? r.data : {};
          return { ...obj, NV: r.nv };
        });
      } else {
        baseRows = [];
      }
    }
  } else {
    // Sin fecha: lectura normal (nv/partida)
    baseRows = await getPreProduccionSqlRowsFromSupabase({ nv, partida });
  }

  // Overlay tipo='NV' se fusiona con el base del SQL Server para el mismo NV.
  // Overlay de otros tipos (ONV, INV, PLNV, PNV) son filas independientes sin base.
  const overlayByNv = new Map(); // solo tipo='NV', clave: String(nv)
  const overlayNonNv = [];      // tipo != 'NV'

  for (const r of overlayRows) {
    const nvKey = r?.NV !== undefined && r?.NV !== null ? String(r.NV) : undefined;
    if (!nvKey) continue;
    if ((r.NV_TIPO || 'NV') === 'NV') {
      overlayByNv.set(nvKey, r);
    } else {
      overlayNonNv.push(r);
    }
  }

  // Fusionar base con overlay tipo='NV'
  const merged = baseRows.map((base) => {
    const key = base?.NV !== undefined && base?.NV !== null ? String(base.NV) : undefined;
    const over = key ? overlayByNv.get(key) : null;
    return over ? { ...base, ...over } : { ...base, NV_TIPO: 'NV' };
  });

  // Agregar overlay tipo='NV' que no tienen fila base en SQL Server
  for (const over of overlayRows) {
    const nvKey = over?.NV !== undefined && over?.NV !== null ? String(over.NV) : undefined;
    if (!nvKey || (over.NV_TIPO || 'NV') !== 'NV') continue;
    const hasBase = baseRows.some((b) => b?.NV !== undefined && b?.NV !== null && String(b.NV) === nvKey);
    if (!hasBase) merged.push(over);
  }

  // Agregar filas de otros tipos (ONV, INV, PLNV, PNV) — siempre separadas
  merged.push(...overlayNonNv);

  merged.sort((a, b) => {
    const na = parseInt(a?.NV, 10);
    const nb = parseInt(b?.NV, 10);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
      // mismo número: NV primero, luego el resto alfabético
      const ta = a?.NV_TIPO || 'NV';
      const tb = b?.NV_TIPO || 'NV';
      if (ta === 'NV' && tb !== 'NV') return -1;
      if (ta !== 'NV' && tb === 'NV') return 1;
      return ta.localeCompare(tb);
    }
    return String(a?.NV || '').localeCompare(String(b?.NV || ''));
  });

  return merged;
}

async function getDistinctPropertyValues(property) {
  if (!supabasePool) throw new Error('SUPABASE_DB_URL no está configurado');

  const propertyName = String(property || '').trim();
  if (!propertyName) throw new Error('Falta property');

  const { rows } = await supabasePool.query(
    `
      SELECT value, COUNT(*)::int AS count
      FROM (
        SELECT BTRIM(e.value) AS value
        FROM preproduccion_valores p
        CROSS JOIN LATERAL jsonb_each_text(COALESCE(p.data, '{}'::jsonb)) AS e(key, value)
        WHERE LOWER(BTRIM(e.key)) = LOWER(BTRIM($1))
          AND NULLIF(BTRIM(e.value), '') IS NOT NULL
      ) AS distinct_values
      GROUP BY value
      ORDER BY count DESC, value ASC
    `,
    [propertyName]
  );

  return (rows || []).map((row) => ({
    value: row.value,
    count: Number(row.count) || 0,
  }));
}

// =====================
// CLIENTE ODOO (JSON-RPC)
// =====================

let cachedUid = null;

async function odooJsonRpc(params) {
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params,
    id: Date.now(),
  };

  const response = await axios.post(`${ODOO_URL}/jsonrpc`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (response.data.error) {
    console.error('Error JSON-RPC Odoo:', response.data.error);
    throw new Error(JSON.stringify(response.data.error));
  }

  return response.data.result;
}

async function getOdooUid() {
  if (cachedUid !== null) return cachedUid;

  const result = await odooJsonRpc({
    service: 'common',
    method: 'authenticate',
    args: [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}],
  });

  if (!result) throw new Error('No se pudo autenticar en Odoo (uid nulo)');

  cachedUid = result;
  console.log('Autenticado en Odoo, uid =', cachedUid);
  return cachedUid;
}

async function odooExecuteKw(model, method, args = [], kwargs = {}) {
  const uid = await getOdooUid();

  const baseContext = {
    ...(kwargs.context || {}),
  };

  if (ODOO_COMPANY_ID) {
    baseContext.company_id = ODOO_COMPANY_ID;
    baseContext.allowed_company_ids = [ODOO_COMPANY_ID];
  }

  const finalKwargs = {
    ...kwargs,
    context: baseContext,
  };

  const result = await odooJsonRpc({
    service: 'object',
    method: 'execute_kw',
    args: [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, finalKwargs],
  });

  return result;
}

// =====================
// CAMPOS CUSTOM EN ODOO
// =====================

const ODOO_SALE_ORDER_NV_FIELD = 'x_porton_nv'; // Integer: NV del sistema viejo

async function ensureSaleOrderNvField() {
  // Verifica / crea el campo x_porton_nv en sale.order para guardar el NV (sistema viejo)
  const existing = await odooExecuteKw(
    'ir.model.fields',
    'search_read',
    [[['model', '=', 'sale.order'], ['name', '=', ODOO_SALE_ORDER_NV_FIELD]]],
    { fields: ['id', 'name', 'ttype'], limit: 1 }
  );

  if (existing && existing.length) return existing[0].id;

  const modelIds = await odooExecuteKw('ir.model', 'search', [[['model', '=', 'sale.order']]], { limit: 1 });
  if (!modelIds || !modelIds.length) {
    throw new Error('No se encontró ir.model para sale.order (no se puede crear campo NV)');
  }

  const fieldVals = {
    name: ODOO_SALE_ORDER_NV_FIELD,
    field_description: 'NV (Portón)',
    model_id: modelIds[0],
    ttype: 'integer',
    state: 'manual',
    required: false,
    readonly: false,
    store: true,
    help: 'Número NV del sistema anterior (portones).',
  };

  const fieldId = await odooExecuteKw('ir.model.fields', 'create', [fieldVals]);
  console.log('Creado campo custom en Odoo:', ODOO_SALE_ORDER_NV_FIELD, 'id=', fieldId);
  return fieldId;
}

async function getAlreadySentNvSet(nvList) {
  // Devuelve Set<string> de NVs (como string) que ya existen en sale.order.x_porton_nv
  if (!Array.isArray(nvList) || !nvList.length) return new Set();

  // Asegura que el campo exista para poder buscar
  await ensureSaleOrderNvField();

  const ints = nvList
    .map((v) => parseInt(String(v).trim(), 10))
    .filter((n) => Number.isFinite(n));

  const sent = new Set();

  const CHUNK = 250;
  for (let i = 0; i < ints.length; i += CHUNK) {
    const chunk = ints.slice(i, i + CHUNK);

    const rows = await odooExecuteKw(
      'sale.order',
      'search_read',
      [[['x_porton_nv', 'in', chunk]]],
      { fields: ['x_porton_nv'], limit: 5000 }
    );

    for (const r of rows || []) {
      const val = r?.x_porton_nv;
      if (val === null || val === undefined) continue;
      sent.add(String(val).trim());
    }
  }

  return sent;
}

function extractRowFechaNV(row) {
  // Fecha de NV (columna confirmada: Fecha_NV). Acepta variantes de casing.
  const raw =
    (row && (row.Fecha_NV ?? row.FECHA_NV ?? row.fecha_nv ?? row.FechaNV ?? row.FECHANV ?? row.fechanv)) ?? null;

  if (raw === null || raw === undefined) return null;

  const s = String(raw).trim();
  if (!s) return null;

  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return null;

  return d;
}

// =====================
// UTILIDADES
// =====================

function formatDateForOdoo(value) {
  if (!value) return null;

  const d = value instanceof Date ? value : new Date(value);

  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function ladoMayorDelCano(perfil) {
  if (!perfil) return null;

  const s = String(perfil).trim();
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return null;

  const a = parseFloat(m[1].replace(',', '.'));
  const b = parseFloat(m[2].replace(',', '.'));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  return Math.max(a, b);
}

function calcularLargoEspada({ DATOS_Brazos } = {}) {
  if (DATOS_Brazos === null || DATOS_Brazos === undefined) return null;

  if (typeof DATOS_Brazos === 'number' && Number.isFinite(DATOS_Brazos)) return DATOS_Brazos;

  if (typeof DATOS_Brazos === 'string') {
    const s = DATOS_Brazos.trim();

    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        const obj = JSON.parse(s);
        const candidates = [
          obj?.espada,
          obj?.ESPADA,
          obj?.largo_espada,
          obj?.LARGO_ESPADA,
          obj?.calc_espada,
          obj?.CALC_ESPADA,
        ].filter((v) => v !== undefined && v !== null);

        for (const v of candidates) {
          const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
          if (typeof n === 'number' && Number.isFinite(n)) return n;
        }
      } catch {
        // sigue abajo
      }
    }

    const m =
      s.match(/espada\s*[:=]\s*(\d+(?:[.,]\d+)?)/i) ||
      s.match(/largo\s*espada\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i);
    if (m) {
      const n = parseFloat(m[1].replace(',', '.'));
      if (Number.isFinite(n)) return n;
    }

    return null;
  }

  if (typeof DATOS_Brazos === 'object') {
    const candidates = [
      DATOS_Brazos?.espada,
      DATOS_Brazos?.ESPADA,
      DATOS_Brazos?.largo_espada,
      DATOS_Brazos?.LARGO_ESPADA,
      DATOS_Brazos?.calc_espada,
      DATOS_Brazos?.CALC_ESPADA,
    ].filter((v) => v !== undefined && v !== null);

    for (const v of candidates) {
      const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    }
  }

  return null;
}

async function getOrCreatePartnerFromHeader(header) {
  const cuit = header.cuit ? String(header.cuit).trim() : null;
  const clienteCode = header.cliente != null ? String(header.cliente).trim() : null;

  const nombre = header.nombre && String(header.nombre).trim() ? String(header.nombre).trim() : 'Cliente sin nombre';

  let domain;

  if (cuit && clienteCode) {
    domain = ['|', ['vat', '=', cuit], ['ref', '=', clienteCode]];
  } else if (cuit) {
    domain = [['vat', '=', cuit]];
  } else if (clienteCode) {
    domain = [['ref', '=', clienteCode]];
  } else {
    domain = [['name', '=', nombre]];
  }

  const foundIds = await odooExecuteKw('res.partner', 'search', [domain], { limit: 1 });

  if (foundIds.length) {
    console.log(`Usando partner existente ${foundIds[0]} para cliente ${nombre}`);
    return foundIds[0];
  }

  const vals = {
    name: nombre,
    customer_rank: 1,
  };

  if (clienteCode) vals.ref = clienteCode;
  if (cuit) vals.vat = cuit;
  if (header.direccion) vals.street = String(header.direccion).trim();
  if (header.localidad) vals.city = String(header.localidad).trim();
  if (header.cp) vals.zip = String(header.cp).trim();
  if (ODOO_COMPANY_ID) vals.company_id = ODOO_COMPANY_ID;

  const newPartnerId = await odooExecuteKw('res.partner', 'create', [vals]);
  console.log(`Creado nuevo partner ${newPartnerId} para cliente ${nombre}`);
  return newPartnerId;
}

async function calculateAndAddProperties(row) {
  try {
    const perfil = row.PARANTES_Descripcion;
    row.lado_mas_alto = ladoMayorDelCano(perfil);

    row.calc_espada = calcularLargoEspada({
      perfil,
      Largo_Parantes: row.Largo_Parantes,
      DATOS_Brazos: row.DATOS_Brazos,
    });

    return row;
  } catch (e) {
    console.warn(`No se pudieron calcular propiedades (NV=${row?.NV}):`, e.message || e);
    return row;
  }
}

async function syncPreproduccionToSupabaseFromSqlRows(sqlRows) {
  if (!supabasePool || !sqlRows || !sqlRows.length) return;

  const compiled = await getCompiledFormulasFromDb();

  for (const row of sqlRows) {
    const updatedRow = await calculateAndAddProperties(row);
    await upsertPreproduccionSqlRow(updatedRow);
    await upsertPreproduccionValoresFillDerived(updatedRow, compiled);
  }
}

// =====================
// SYNC ASYNC (OPCIÓN A)
// =====================

let syncRunning = false;
const syncQueueByNv = new Map(); // nv(string) -> row

function enqueuePreproduccionSync(rows) {
  if (!supabasePool || !Array.isArray(rows) || !rows.length) return;

  for (const r of rows) {
    const nvKey = r?.NV !== null && r?.NV !== undefined ? String(r.NV).trim() : '';
    if (!nvKey) continue;
    syncQueueByNv.set(nvKey, r);
  }

  schedulePreproduccionSyncWorker();
}

function schedulePreproduccionSyncWorker() {
  if (syncRunning) return;

  syncRunning = true;

  setImmediate(async () => {
    try {
      while (syncQueueByNv.size > 0) {
        const batch = Array.from(syncQueueByNv.values());
        syncQueueByNv.clear();

        try {
          await syncPreproduccionToSupabaseFromSqlRows(batch);
        } catch (e) {
          console.error('Error sincronizando Pre_Produccion con Supabase (async batch):', e?.message || e);
        }
      }
    } finally {
      syncRunning = false;

      if (syncQueueByNv.size > 0) {
        schedulePreproduccionSyncWorker();
      }
    }
  });
}

// =====================
// EXPRESS APP
// =====================

const app = express();
app.use(cors());
// 25mb: deja lugar a los adjuntos de un ticket (hasta 5, ~15MB cada uno en
// base64) ademas del resto del payload. Ver /api/tickets y
// src/utils/ticketAttachment.js en el front para el limite del lado cliente.
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// =====================
// ME (privado)
// =====================
app.get('/api/me', requireAuth, attachRole, (req, res) => {
  return res.json({
    user: { id: req.user.id, email: req.user.email },
    role: req.role || 'viewer',
  });
});

// =====================
// TICKETS (tablas compartidas con planificación, misma base — ver
// comentario junto a supabasePool más arriba. Cualquier usuario logueado
// puede crear un ticket y ver/responder los propios; se gestionan todos
// desde /admin/tickets en planificación, no hay pantalla de gestión acá.)
// =====================

const MAX_TICKET_ADJUNTOS = 5;
function normalizeTicketAdjuntos(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_TICKET_ADJUNTOS).map((a) => ({
    name: String(a?.name || 'adjunto').slice(0, 200),
    type: String(a?.type || 'application/octet-stream').slice(0, 100),
    size: Number(a?.size || 0) || 0,
    data_url: String(a?.data_url || ''),
    uploaded_at: a?.uploaded_at || new Date().toISOString(),
  })).filter((a) => a.data_url);
}

app.post('/api/tickets', requireAuth, async (req, res) => {
  if (!supabasePool) return res.status(500).json({ error: 'SUPABASE_DB_URL no está configurado' });
  try {
    const categoria = String(req.body?.categoria || '').trim();
    const mensaje = String(req.body?.mensaje || '').trim();
    const rutaOrigen = req.body?.rutaOrigen ? String(req.body.rutaOrigen) : null;
    const adjuntos = normalizeTicketAdjuntos(req.body?.adjuntos);
    if (!categoria) return res.status(400).json({ error: 'Falta la categoría' });
    if (!mensaje) return res.status(400).json({ error: 'Falta el mensaje' });

    const { rows } = await supabasePool.query(
      `
      insert into public.tickets (categoria, mensaje, ruta_origen, creado_por_id, creado_por_username, app_origen, adjuntos)
      values ($1, $2, $3, $4, $5, 'integrador', $6::jsonb)
      returning *;
      `,
      [categoria, mensaje, rutaOrigen, req.user.id, req.user.email, JSON.stringify(adjuntos)]
    );
    return res.json({ ok: true, ticket: rows[0] });
  } catch (err) {
    console.error('Error en POST /api/tickets:', err);
    return res.status(500).json({ error: 'Error creando el ticket', details: err.message || String(err) });
  }
});

app.get('/api/tickets/mine', requireAuth, async (req, res) => {
  if (!supabasePool) return res.status(500).json({ error: 'SUPABASE_DB_URL no está configurado' });
  try {
    const { rows } = await supabasePool.query(
      `select * from public.tickets where creado_por_id = $1 order by created_at desc;`,
      [req.user.id]
    );
    return res.json({ ok: true, tickets: rows });
  } catch (err) {
    console.error('Error en GET /api/tickets/mine:', err);
    return res.status(500).json({ error: 'Error listando tus tickets', details: err.message || String(err) });
  }
});

app.get('/api/tickets/mine/:id', requireAuth, async (req, res) => {
  if (!supabasePool) return res.status(500).json({ error: 'SUPABASE_DB_URL no está configurado' });
  try {
    const { rows } = await supabasePool.query(
      `select * from public.tickets where id = $1 and creado_por_id = $2;`,
      [Number(req.params.id), req.user.id]
    );
    const ticket = rows[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
    const mensajes = await supabasePool.query(
      `select * from public.ticket_mensajes where ticket_id = $1 order by created_at asc;`,
      [ticket.id]
    );
    return res.json({ ok: true, ticket: { ...ticket, mensajes: mensajes.rows } });
  } catch (err) {
    console.error('Error en GET /api/tickets/mine/:id:', err);
    return res.status(500).json({ error: 'Error obteniendo el ticket', details: err.message || String(err) });
  }
});

app.post('/api/tickets/mine/:id/messages', requireAuth, async (req, res) => {
  if (!supabasePool) return res.status(500).json({ error: 'SUPABASE_DB_URL no está configurado' });
  try {
    const mensaje = String(req.body?.mensaje || '').trim();
    if (!mensaje) return res.status(400).json({ error: 'Falta el mensaje' });

    const own = await supabasePool.query(
      `select id from public.tickets where id = $1 and creado_por_id = $2;`,
      [Number(req.params.id), req.user.id]
    );
    if (!own.rows[0]) return res.status(404).json({ error: 'Ticket no encontrado' });

    const { rows } = await supabasePool.query(
      `
      insert into public.ticket_mensajes (ticket_id, autor_id, autor_username, es_admin, mensaje)
      values ($1, $2, $3, false, $4)
      returning *;
      `,
      [own.rows[0].id, req.user.id, req.user.email, mensaje]
    );
    await supabasePool.query(`update public.tickets set updated_at = now() where id = $1;`, [own.rows[0].id]);
    return res.json({ ok: true, mensaje: rows[0] });
  } catch (err) {
    console.error('Error en POST /api/tickets/mine/:id/messages:', err);
    return res.status(500).json({ error: 'Error agregando el mensaje', details: err.message || String(err) });
  }
});

// =====================
// PUBLIC (solo para modo PDF link)
// =====================

app.get('/api/public/formulas', async (_req, res) => {
  try {
    const formulas = await getAllColumnFormulas();
    return res.json({ formulas });
  } catch (err) {
    console.error('Error en /api/public/formulas (GET):', err);
    return res.status(500).json({
      error: 'Error obteniendo fórmulas',
      details: err.message || String(err),
    });
  }
});

// Lectura pública de "valores definitivos" (para generar PDF por link)
// AHORA soporta: nv, partida, fecha, fecha_envio_produccion
app.get('/api/public/pre-produccion-valores', async (req, res) => {
  const { nv, partida, fecha, fecha_envio_produccion } = req.query;
  const f = fecha_envio_produccion || fecha;

  try {
    const rows = await getPreProduccionValoresRows({ nv, partida, fecha_envio_produccion: f });
    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('Error en /api/public/pre-produccion-valores:', err);
    return res.status(500).json({
      error: 'Error interno obteniendo Pre_Produccion (valores)',
      details: err.message || String(err),
    });
  }
});

// ---------------------
// API Sincronización Odoo (privada)
// ---------------------

// ---------------------
// Sync a Odoo desde SQL (reutilizable)
// ---------------------
async function syncOrderFromHeader({ header, partner_id, nv, idpedido_hint }) {
  if (!header) {
    const err = new Error('Falta parámetro: header es requerido');
    err.status = 400;
    throw err;
  }

  let partnerIdFinal = partner_id;
  if (!partnerIdFinal) {
    partnerIdFinal = await getOrCreatePartnerFromHeader(header);
  }

  const lines = await getNtavLinesFromHeader(header);
  if (!lines.length) {
    const err = new Error(
      `No se encontraron líneas en INTASVTAS para la nota (tipo=${header.tipo}, sucursal=${header.sucursal}, numero=${header.numero}, deposito=${header.deposito})`
    );
    err.status = 404;
    throw err;
  }

  const clientOrderRefParts = [header.tipo || '', header.sucursal || '', header.numero || ''].filter((p) => p !== '');
  const clientOrderRef = clientOrderRefParts.join('-');

  const idpedido = header.idpedido || idpedido_hint || null;
  const originBase = idpedido ? `NTASVTAS ${idpedido}` : `NTASVTAS ${clientOrderRefParts.join('-')}`;

  const orderVals = {
    partner_id: partnerIdFinal,
    origin: originBase,
  };

  // Guardar NV en campo propio para trazabilidad con el sistema viejo
  if (nv !== undefined && nv !== null && String(nv).trim() !== '') {
    await ensureSaleOrderNvField();
    const nvInt = parseInt(String(nv).trim(), 10);
    if (Number.isFinite(nvInt)) {
      orderVals[ODOO_SALE_ORDER_NV_FIELD] = nvInt;
      orderVals.origin = `NV ${nvInt} - ${originBase}`;
    }
  }

  if (ODOO_COMPANY_ID) orderVals.company_id = ODOO_COMPANY_ID;

  const odooDate = formatDateForOdoo(header.fecha);
  if (odooDate) orderVals.date_order = odooDate;
  if (clientOrderRef) orderVals.client_order_ref = clientOrderRef;

  const orderId = await odooExecuteKw('sale.order', 'create', [orderVals]);
  console.log('Creado sale.order ID', orderId);

  let createdLines = 0;
  const missingProducts = [];

  for (const line of lines) {
    const rawCode = line.producto || '';
    const rawDesc = line.descripcion || '';

    const productoCodigo = String(rawCode).trim();
    const descripcion = String(rawDesc).trim();

    let productId = null;

    // 1) Intento por default_code (si coincide)
    if (productoCodigo) {
      const idsByCode = await odooExecuteKw('product.product', 'search', [[['default_code', '=', productoCodigo]]], {
        limit: 1,
      });
      if (idsByCode.length) productId = idsByCode[0];
    }

    // 2) Por nombre: vos confirmaste que PRODUCTOS.descripcion es exactamente igual a la descripción en Odoo.
    // Usamos '=' (exacto) y si no, fallback a ilike.
    if (!productId && descripcion) {
      const idsExact = await odooExecuteKw('product.product', 'search', [[['name', '=', descripcion]]], { limit: 1 });
      if (idsExact.length) productId = idsExact[0];
    }
    if (!productId && descripcion) {
      const idsByName = await odooExecuteKw('product.product', 'search', [[['name', 'ilike', descripcion]]], { limit: 1 });
      if (idsByName.length) productId = idsByName[0];
    }

    if (!productId) {
      missingProducts.push({ producto: productoCodigo, descripcion });
      continue;
    }

    function toNumber(v) {
      if (v === null || v === undefined) return 0;
      if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
      const s = String(v).trim().replace(/\./g, '').replace(',', '.'); // soporta "1.234,56"
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    }

    const priceUnit = toNumber(line.prelista);   // <-- SIEMPRE INTASVTAS.precio
    const discount = toNumber(line.bonific);
    const qty = toNumber(line.cantidad);

    const lineVals = {
      order_id: orderId,
      product_id: productId,
      name: descripcion || productoCodigo,
      product_uom_qty: qty,
      price_unit: priceUnit,
      discount,
    };

    await odooExecuteKw('sale.order.line', 'create', [lineVals]);
    createdLines += 1;
  }

  const orders = await odooExecuteKw('sale.order', 'read', [[orderId], ['amount_total']]);
  const amountTotal = orders[0]?.amount_total || 0;

  // Vincular con modelo x_dflex.porton si existe (no bloquea si no está)
  const numeroRaw = header.numero;
  if (numeroRaw != null) {
    const numeroStr = String(numeroRaw).trim();
    const numeroInt = parseInt(numeroStr, 10);
    const numeroDomainValue = Number.isFinite(numeroInt) ? numeroInt : numeroStr;

    const portonDomain = [['x_nota_de_venta', '=', numeroDomainValue]];
    const portonIds = await odooExecuteKw('x_dflex.porton', 'search', [portonDomain], { limit: 1 });

    if (portonIds.length) {
      await odooExecuteKw('x_dflex.porton', 'write', [
        portonIds,
        {
          x_studio_sale_order_id: orderId,
          x_base_value: amountTotal,
        },
      ]);
      console.log(`Portón ${portonIds[0]} vinculado al pedido ${orderId}`);
    } else {
      console.log(`No se encontró x_dflex.porton con x_nota_de_venta = ${numeroDomainValue} (no se vincula)`);
    }
  }

  return {
    success: true,
    order_id: orderId,
    amount_total: amountTotal,
    created_lines: createdLines,
    missing_products: missingProducts,
    header,
  };
}

async function syncOrderFromSql({ idpedido, partner_id, nv }) {
  if (!idpedido) {
    const err = new Error('Falta parámetro: idpedido es requerido');
    err.status = 400;
    throw err;
  }

  const header = await getNtavHeader(idpedido);
  if (!header) {
    const err = new Error(`No se encontró NTASVTAS.idpedido = ${idpedido}`);
    err.status = 404;
    throw err;
  }

  return syncOrderFromHeader({ header, partner_id, nv, idpedido_hint: idpedido });
}

// Busca NTASVTAS por NV (numero) y opcionalmente tipo/sucursal/deposito
async function getNtavHeaderByNv({ nv, tipo, sucursal, deposito }) {
  const pool = await getSqlPool();

  const nvStr = String(nv ?? '').trim();
  const nvInt = parseInt(nvStr, 10);

  console.log('[getNtavHeaderByNv] input:', { nv, nvStr, nvInt, tipo, sucursal, deposito });

  const request = pool.request();
  request.input('nvInt', sql.Int, Number.isFinite(nvInt) ? nvInt : null);
  request.input('nvStr', sql.VarChar, nvStr);

  // numero en NTASVTAS puede ser INT o VARCHAR (según instalaciones históricas).
  // Evitamos TRY_CONVERT (no existe en versiones antiguas de SQL Server).
  // Estrategia segura:
  // 1) Comparamos como string (CAST a varchar) contra @nvStr (cubre int/varchar sin errores).
  // 2) Si nvInt es válido, también comparamos por valor numérico para soportar ceros a la izquierda.
  const numeroExpr = "LTRIM(RTRIM(CAST(numero AS varchar(50))))";

  const hasNvInt = Number.isFinite(nvInt);
  let where = `(${numeroExpr} = @nvStr`;
  if (hasNvInt) {
    where += ` OR (${numeroExpr} <> '' AND ${numeroExpr} NOT LIKE '%[^0-9]%' AND CAST(${numeroExpr} AS int) = @nvInt)`;
  }
  where += `)`;

  if (tipo) {
    where += ' AND tipo = @tipo';
    request.input('tipo', sql.VarChar, String(tipo));
  }
  if (sucursal !== undefined && sucursal !== null && sucursal !== '') {
    where += ' AND sucursal = @sucursal';
    request.input('sucursal', sql.Int, parseInt(sucursal, 10));
  }
  if (deposito !== undefined && deposito !== null && deposito !== '') {
    where += ' AND deposito = @deposito';
    request.input('deposito', sql.Int, parseInt(deposito, 10));
  }

  console.log('[getNtavHeaderByNv] WHERE:', where);

  // Log del SQL (compacto) para debug
  const sqlText = `
    SELECT TOP (5)
      fecha,
      tipo,
      sucursal,
      numero,
      deposito,
      cliente,
      nombre,
      direccion,
      localidad,
      cp,
      provincia,
      fpago,
      vendedor,
      operador,
      zona,
      iva,
      cuit,
      ibrutos,
      observ,
      retrep,
      fechaent,
      dirent,
      obs AS obs2,
      oc,
      idpedido,
      condicion,
      factura,
      remito
    FROM Portones.dbo.NTASVTAS
    WHERE ${where}
    ORDER BY fecha DESC, idpedido DESC
  `;

  console.log('[getNtavHeaderByNv] SQL:', sqlText.replace(/\s+/g, ' ').trim());

  const result = await request.query(sqlText);

  const rows = result.recordset || [];
  console.log('[getNtavHeaderByNv] rows.length:', rows.length);
  console.log('[getNtavHeaderByNv] top rows preview:', rows.slice(0, 3).map(r => ({
    fecha: r.fecha,
    tipo: r.tipo,
    sucursal: r.sucursal,
    numero: r.numero,
    deposito: r.deposito,
    idpedido: r.idpedido,
  })));

  if (!rows.length) return null;

  // Si no se pasan suficientes filtros y hay potencial ambigüedad, usamos el más reciente.
  return rows[0];
}

// Listado liviano de portones desde Pre_Produccion (solo NV/Nombre/RazSoc)
function mapPortonListRow(row) {
  const nv = row?.NV ?? row?.nv ?? null;
  const nombre = row?.Nombre ?? row?.nombre ?? '';
  const razsoc = row?.RazSoc ?? row?.razsoc ?? row?.RAZSOC ?? '';
  const id = row?.ID ?? row?.id ?? null;

  return { ID: id, NV: nv, Nombre: nombre, RazSoc: razsoc };
}
app.post('/api/sync/order-from-sql', requireAuth, attachRole, requireRole(['admin']), async (req, res) => {
  const { idpedido, partner_id, nv } = req.body;

  try {
    const data = await syncOrderFromSql({ idpedido, partner_id, nv });
    return res.json(data);
  } catch (err) {
    const status = err?.status || 500;
    const msg = err?.message || String(err);

    if (status >= 500) {
      console.error('Error en /api/sync/order-from-sql:', err);
      return res.status(status).json({ error: 'Error interno sincronizando con Odoo', details: msg });
    }

    return res.status(status).json({ error: msg });
  }
});

// Variante: sincronizar por NV (numero). Útil para botón "Enviar a Odoo" desde listado.
app.post('/api/sync/order-from-nv', requireAuth, attachRole, requireRole(['admin']), async (req, res) => {
  const { nv, tipo, sucursal, deposito, partner_id } = req.body || {};

  if (!nv) {
    return res.status(400).json({ error: 'Falta parámetro: nv es requerido' });
  }

  try {
    console.log('[POST /api/sync/order-from-nv] body:', { nv, tipo, sucursal, deposito, partner_id });

    const header = await getNtavHeaderByNv({ nv, tipo, sucursal, deposito });
    console.log('[POST /api/sync/order-from-nv] header:', header);
    if (!header) {
      return res.status(404).json({ error: `No se encontró NTASVTAS para NV=${nv}` });
    }

    // Idempotencia: si ya existe una cotización con este NV, devolvemos esa referencia
    const nvInt = parseInt(String(nv).trim(), 10);
    if (Number.isFinite(nvInt)) {
      await ensureSaleOrderNvField();
      const existing = await odooExecuteKw(
        'sale.order',
        'search_read',
        [[['x_porton_nv', '=', nvInt]]],
        { fields: ['id', 'name', 'amount_total'], limit: 1, order: 'id desc' }
      );

      if (existing && existing.length) {
        return res.json({
          already_sent: true,
          order_id: existing[0].id,
          name: existing[0].name,
          amount_total: existing[0].amount_total,
        });
      }
    }

    // No dependemos de idpedido: generamos la cotización con la clave natural
    // (tipo, sucursal, numero, deposito) y trazabilidad por NV.
    const data = await syncOrderFromHeader({ header, partner_id, nv, idpedido_hint: header?.idpedido || null });
    return res.json(data);
  } catch (err) {
    const status = err?.status || 500;
    const msg = err?.message || String(err);

    if (status >= 500) {
      console.error('Error en /api/sync/order-from-nv:', err);
      return res.status(status).json({ error: 'Error interno sincronizando con Odoo', details: msg });
    }

    return res.status(status).json({ error: msg });
  }
});

// ---------------------
// DEBUG (admin): probar búsqueda NTASVTAS por NV sin generar cotización
// GET /api/debug/ntasvtas-by-nv?nv=3948
// ---------------------
app.get('/api/debug/ntasvtas-by-nv', requireAuth, attachRole, requireRole(['admin']), async (req, res) => {
  const { nv, tipo, sucursal, deposito } = req.query || {};
  if (!nv) return res.status(400).json({ error: 'Falta parámetro: nv' });

  try {
    const header = await getNtavHeaderByNv({ nv, tipo, sucursal, deposito });
    if (!header) return res.status(404).json({ error: `No se encontró NTASVTAS para NV=${nv}` });
    return res.json({ ok: true, header });
  } catch (err) {
    console.error('Error en /api/debug/ntasvtas-by-nv:', err);
    return res.status(500).json({ error: 'Error interno en debug NTASVTAS', details: err.message || String(err) });
  }
});

// ---------------------
// API Portones (privada) - listado reducido: NV/Nombre/RazSoc
// ---------------------
app.get('/api/portones', requireAuth, attachRole, async (req, res) => {
  const { nv } = req.query;

  try {
    let rows = await getPreProduccionRows(nv);

    // 1) Filtro por fecha (>= 2026-01-01). Si la tabla no tiene fecha detectable, no rompe.
    const MIN_DATE_STR = '2026-01-01';
    const minDate = new Date(`${MIN_DATE_STR}T00:00:00.000Z`);

    const hasAnyDate = (rows || []).some((r) => !!extractRowFechaNV(r));
    if (hasAnyDate) {
      rows = (rows || []).filter((r) => {
        const d = extractRowFechaNV(r);
        if (!d) return false; // si hay fecha en general, pero esta fila no tiene, la excluimos
        return d.getTime() >= minDate.getTime();
      });
    }

    // 2) Solo pendientes de enviar a Odoo: excluye los NV que ya tengan cotización registrada por x_porton_nv
    const nvList = (rows || [])
      .map((r) => (r?.NV !== null && r?.NV !== undefined ? String(r.NV).trim() : ''))
      .filter((v) => v !== '');

    let sentSet = new Set();
    let pendingFilterOk = true;

    try {
      sentSet = await getAlreadySentNvSet(nvList);
    } catch (odooErr) {
      pendingFilterOk = false;
      console.error('No se pudo filtrar pendientes contra Odoo:', odooErr?.message || odooErr);
    }

    const pending = pendingFilterOk
      ? (rows || []).filter((r) => {
          const nvVal = r?.NV !== null && r?.NV !== undefined ? String(r.NV).trim() : '';
          if (!nvVal) return false;
          return !sentSet.has(nvVal);
        })
      : (rows || []);

    const mapped = pending.map(mapPortonListRow);

    return res.json({
      count: mapped.length,
      rows: mapped,
      meta: { pending_only: pendingFilterOk, min_date: MIN_DATE_STR, skipped_date_filter: !hasAnyDate },
    });
  } catch (err) {
    console.error('Error en /api/portones:', err);
    return res.status(500).json({
      error: 'Error interno obteniendo portones',
      details: err.message || String(err),
    });
  }
});

// ---------------------
// API Pre_Produccion (privada)
// ---------------------
app.get('/api/pre-produccion', requireAuth, attachRole, async (req, res) => {
  const { nv } = req.query;

  try {
    const rows = await getPreProduccionRows(nv);

    try {
      if (rows.length && supabasePool) {
        enqueuePreproduccionSync(rows);
      }
    } catch (syncErr) {
      console.error('Error encolando sync Pre_Produccion (async):', syncErr?.message || syncErr);
    }

    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('Error en /api/pre-produccion:', err);
    return res.status(500).json({
      error: 'Error interno obteniendo Pre_Produccion',
      details: err.message || String(err),
    });
  }
});

// AHORA soporta: nv, partida, fecha, fecha_envio_produccion
app.get('/api/pre-produccion-valores', requireAuth, attachRole, async (req, res) => {
  const { nv, partida, fecha, fecha_envio_produccion } = req.query;
  const f = fecha_envio_produccion || fecha;

  try {
    const rows = await getPreProduccionValoresRows({ nv, partida, fecha_envio_produccion: f });
    return res.json({ count: rows.length, rows });
  } catch (err) {
    console.error('Error en /api/pre-produccion-valores:', err);
    return res.status(500).json({
      error: 'Error interno obteniendo Pre_Produccion (valores)',
      details: err.message || String(err),
    });
  }
});

app.get('/api/property-value-options', requireAuth, attachRole, async (req, res) => {
  const property = String(req.query?.property || '').trim();
  if (!property) {
    return res.status(400).json({ error: 'Falta property' });
  }

  try {
    const values = await getDistinctPropertyValues(property);
    return res.json({
      property,
      count: values.length,
      values,
    });
  } catch (err) {
    console.error('Error en /api/property-value-options:', err);
    return res.status(500).json({
      error: 'Error obteniendo valores de propiedad',
      details: err.message || String(err),
    });
  }
});

// ---------------------
// API Fórmulas (privada)
// ---------------------
app.get('/api/formulas', requireAuth, attachRole, async (_req, res) => {
  try {
    const formulas = await getAllColumnFormulas();
    return res.json({ formulas });
  } catch (err) {
    console.error('Error en /api/formulas (GET):', err);
    return res.status(500).json({
      error: 'Error obteniendo fórmulas',
      details: err.message || String(err),
    });
  }
});

app.post('/api/formulas', requireAuth, attachRole, requireRole(['admin', 'formula_editor']), async (req, res) => {
  const { column_name, expression } = req.body || {};
  if (!column_name) return res.status(400).json({ error: 'Falta column_name' });

  try {
    const row = await upsertColumnFormula(column_name, expression || '');
    return res.json({ formula: row });
  } catch (err) {
    console.error('Error en /api/formulas (POST):', err);
    return res.status(500).json({
      error: 'Error guardando fórmula',
      details: err.message || String(err),
    });
  }
});

// ---------------------
// API Mappings de medición (privada)
// ---------------------
app.get('/api/measurement-source-catalog', requireAuth, attachRole, async (_req, res) => {
  try {
    return res.json({ sections: listMeasurementSourceCatalog() });
  } catch (err) {
    console.error('Error en /api/measurement-source-catalog:', err);
    return res.status(500).json({
      error: 'Error obteniendo catálogo de medición',
      details: err.message || String(err),
    });
  }
});

app.get('/api/property-mappings/last-sync', requireAuth, attachRole, async (_req, res) => {
  return res.json({ lastSyncAt: getMeasurementMappingsLastSyncAt() });
});

app.get('/api/property-mappings', requireAuth, attachRole, async (_req, res) => {
  try {
    const mappings = await listMeasurementPropertyMappings(supabasePool);
    return res.json({ mappings });
  } catch (err) {
    console.error('Error en /api/property-mappings (GET):', err);
    return res.status(500).json({
      error: 'Error obteniendo mappings',
      details: err.message || String(err),
    });
  }
});

app.post(
  '/api/property-mappings',
  requireAuth,
  attachRole,
  requireRole(['admin', 'formula_editor']),
  async (req, res) => {
    try {
      const mapping = await upsertMeasurementPropertyMapping(supabasePool, req.body || {});
      return res.json({ mapping });
    } catch (err) {
      console.error('Error en /api/property-mappings (POST):', err);
      return res.status(500).json({
        error: 'Error guardando mapping',
        details: err.message || String(err),
      });
    }
  }
);

// Reaplica las asignaciones activas de Nota de venta (presupuestador_production_property_assignments)
// sobre los NV que ya estaban guardados en preproduccion_valores. Sin "nv" en el body, aplica a todos.
app.post(
  '/api/property-mappings/resync-production',
  requireAuth,
  attachRole,
  requireRole(['admin', 'formula_editor']),
  async (req, res) => {
    try {
      const nv = req.body?.nv ? parseInt(req.body.nv, 10) : null;
      const result = await reapplyProductionPropertyAssignments(supabasePool, nv ? { nv } : {});
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('Error en /api/property-mappings/resync-production:', err);
      return res.status(500).json({
        error: 'Error resincronizando valores desde Nota de venta',
        details: err.message || String(err),
      });
    }
  }
);

// ---------------------
// Bulk Update (privado)
// ---------------------
app.post(
  '/api/pre-produccion-valores/bulk-update',
  requireAuth,
  attachRole,
  requireRole(['admin', 'data_editor']),
  async (req, res) => {
    if (!supabasePool) {
      return res.status(500).json({ error: 'SUPABASE_DB_URL no está configurado' });
    }

    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (!updates.length) {
      return res.status(400).json({ error: 'Falta updates[] en el body' });
    }

    function sanitizeChanges(changes) {
      const out = {};
      if (!changes || typeof changes !== 'object') return out;

      for (const [k, v] of Object.entries(changes)) {
        if (!k || typeof k !== 'string') continue;
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        if (k.length > 200) continue;
        out[k] = v;
      }
      return out;
    }

    const client = await supabasePool.connect();

    try {
      await client.query('BEGIN');

      let applied = 0;
      let skipped = 0;

      for (const u of updates) {
        const nvParsed = parseInt(u?.nv, 10);
        if (!Number.isFinite(nvParsed)) {
          skipped += 1;
          continue;
        }

        const changes = sanitizeChanges(u?.changes);
        if (!Object.keys(changes).length) {
          skipped += 1;
          continue;
        }

        const idVal = u?.id ?? u?.ID ?? null;

        let effectiveId = idVal;
        if (effectiveId == null) {
          const r = await client.query('SELECT id FROM preproduccion_sql WHERE nv = $1 LIMIT 1', [nvParsed]);
          effectiveId = r?.rows?.[0]?.id ?? null;
        }

        if (effectiveId == null) {
          skipped += 1;
          console.warn('bulk-update: no se encontró id para NV', nvParsed, '(se saltea)');
          continue;
        }

        await client.query(
          `
            INSERT INTO preproduccion_valores (nv, nv_tipo, data)
            VALUES ($1, $2, $3::jsonb)
            ON CONFLICT (nv, nv_tipo)
            DO UPDATE SET
              data = COALESCE(preproduccion_valores.data, '{}'::jsonb) || EXCLUDED.data,
              updated_at = now()
          `,
          [nvParsed, 'NV', JSON.stringify(changes)]
        );

        applied += 1;
      }

      await client.query('COMMIT');

      return res.json({ success: true, applied, skipped });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }

      console.error('Error en /api/pre-produccion-valores/bulk-update:', err);
      return res.status(500).json({
        error: 'Error interno guardando cambios',
        details: err.message || String(err),
      });
    } finally {
      client.release();
    }
  }
);

// =====================
// ARRANCAR SERVIDOR
// =====================
app.listen(PORT, () => {
  console.log(`Dflex sync backend escuchando en puerto ${PORT}`);
});
