// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
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
// Movido a authMiddleware.js (mismo comportamiento, ninguna llamada acá abajo
// cambia) para que registerIpanelRoutes.js pueda usar los mismos
// requireAuth/attachRole/requireRole en vez de quedar sin auth - ver el
// comentario en ese archivo.
const { requireAuth, attachRole, requireRole, configureRolePool } = require('./authMiddleware');
// attachRole reusa este pool en vez de abrir uno propio - ver el comentario
// en authMiddleware.js sobre por qué (esta Supabase ya la comparten las 6
// apps del ecosistema, sumar pools de a poco pega contra su límite de
// conexiones). Esto corre bien antes de que cualquier request real llegue,
// las rutas de ipanel recién se registran dentro del app.listen() de más
// abajo.
configureRolePool(supabasePool);

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

// ---------------------
// Pre_Produccion (sistema anterior)
// ---------------------
// El SQL Server del sistema anterior se dio de baja (2026-09). Su tabla
// WebApp.dbo.Pre_Produccion ya está copiada en preproduccion_sql, así que se
// lee de ahí con el mismo formato y orden que antes (TOP 1000 por ID DESC).

async function getPreProduccionRows(nv) {
  if (!supabasePool) throw new Error('SUPABASE_DB_URL no está configurado');

  let sqlText = 'SELECT nv, data FROM preproduccion_sql';
  const params = [];

  if (nv) {
    const nvParsed = parseInt(nv, 10);
    if (Number.isNaN(nvParsed)) return [];
    params.push(nvParsed);
    sqlText += ' WHERE nv = $1';
  }

  sqlText += ' ORDER BY id DESC LIMIT 1000';

  const { rows } = await supabasePool.query(sqlText, params);
  const allRows = (rows || []).map((r) => {
    const obj = r?.data && typeof r.data === 'object' ? r.data : {};
    return { ...obj, NV: r.nv };
  });

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
// UTILIDADES
// =====================

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
// ~15MB de bytes crudos de adjuntos (igual al límite combinado del cliente,
// ver ticketAttachment.js) codificado en base64 (~x1.34). El cliente ya
// valida esto antes de enviar, pero acá no hay que confiar ciegamente en
// eso: es la segunda línea de defensa server-side.
const MAX_TICKET_ADJUNTOS_DATA_URL_CHARS = 21 * 1024 * 1024;
// El cliente SIEMPRE genera data_url con FileReader.readAsDataURL(), así que
// nunca debería ser otra cosa. Sin este chequeo, alguien podía mandar
// data_url = "https://atacante.com/pixel.gif" (o un data: URI con un mime no
// permitido, ej. text/html) y que se renderizara solo (<img src>) o se
// abriera (openTicketAttachment) al primer admin que mirara el ticket —
// tracking pixel o, peor, un blob text/html ejecutando JS en el origen del
// panel admin (robo de token vía localStorage). Se valida el mime REAL
// embebido en el data: URI, no el campo `type` (que también lo controla
// quien manda el ticket y no tiene por qué coincidir).
const ALLOWED_ADJUNTO_DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp|gif)|application\/pdf|video\/(?:mp4|quicktime|webm));base64,/i;

function normalizeTicketAdjuntos(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_TICKET_ADJUNTOS).map((a) => ({
    name: String(a?.name || 'adjunto').slice(0, 200),
    type: String(a?.type || 'application/octet-stream').slice(0, 100),
    size: Number(a?.size || 0) || 0,
    data_url: String(a?.data_url || ''),
    uploaded_at: a?.uploaded_at || new Date().toISOString(),
  })).filter((a) => ALLOWED_ADJUNTO_DATA_URL_RE.test(a.data_url));
}

function ticketAdjuntosExceedTotal(adjuntos) {
  return adjuntos.reduce((sum, a) => sum + a.data_url.length, 0) > MAX_TICKET_ADJUNTOS_DATA_URL_CHARS;
}

// Título libre del ticket (obligatorio al crear; el input del widget ya lo
// corta con maxLength, acá se recorta por si alguien llama a la API directo).
const MAX_TICKET_TITULO = 120;

// La columna tickets.titulo la crea la migración tickets_titulo de
// planificación, pero esta app puede publicarse antes: si todavía no existe,
// se agrega acá (solo si falta, una vez por proceso). Sin esto, crear o
// listar tickets fallaría hasta que se publique planificación.
let tituloColumnPromise = null;
function asegurarColumnaTitulo() {
  if (!tituloColumnPromise) {
    tituloColumnPromise = supabasePool
      .query(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'tickets' and column_name = 'titulo';`
      )
      .then(({ rowCount }) => {
        if (!rowCount) return supabasePool.query('alter table public.tickets add column if not exists titulo text;');
      })
      .catch((err) => {
        tituloColumnPromise = null;
        throw err;
      });
  }
  return tituloColumnPromise;
}

// admin_users es la tabla de admins de planificación: en producción vive en
// la misma base que tickets, pero no necesariamente en una base local de prueba.
let adminUsersPromise = null;
function hayAdminUsers() {
  if (!adminUsersPromise) {
    adminUsersPromise = supabasePool
      .query(`select to_regclass('public.admin_users') is not null as ok;`)
      .then(({ rows }) => !!rows[0]?.ok)
      .catch((err) => {
        adminUsersPromise = null;
        throw err;
      });
  }
  return adminUsersPromise;
}

app.post('/api/tickets', requireAuth, async (req, res) => {
  if (!supabasePool) return res.status(500).json({ error: 'SUPABASE_DB_URL no está configurado' });
  try {
    const titulo = String(req.body?.titulo || '').trim().slice(0, MAX_TICKET_TITULO);
    const categoria = String(req.body?.categoria || '').trim();
    const mensaje = String(req.body?.mensaje || '').trim();
    const rutaOrigen = req.body?.rutaOrigen ? String(req.body.rutaOrigen) : null;
    const adjuntos = normalizeTicketAdjuntos(req.body?.adjuntos);
    // El widget nuevo ya no deja enviar sin título: este mensaje solo lo ve
    // quien tiene abierta la versión vieja de la pantalla (sin el campo).
    if (!titulo) return res.status(400).json({ error: 'Falta el título. Si no ves el campo "Título", recargá la página.' });
    if (!categoria) return res.status(400).json({ error: 'Falta la categoría' });
    if (!mensaje) return res.status(400).json({ error: 'Falta el mensaje' });
    if (ticketAdjuntosExceedTotal(adjuntos)) {
      return res.status(400).json({ error: 'Los adjuntos superan el tamaño total permitido.' });
    }

    await asegurarColumnaTitulo();
    const { rows } = await supabasePool.query(
      `
      insert into public.tickets (categoria, mensaje, ruta_origen, creado_por_id, creado_por_username, app_origen, adjuntos, titulo)
      values ($1, $2, $3, $4, $5, 'integrador', $6::jsonb, $7)
      returning *;
      `,
      [categoria, mensaje, rutaOrigen, req.user.id, req.user.email, JSON.stringify(adjuntos), titulo]
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
    // Sin `adjuntos`: esa columna puede pesar varios MB por fila (adjuntos en
    // base64) y esta lista es solo para pintar categoría/estado/fecha - se
    // recorta a propósito. El detalle (GET /api/tickets/mine/:id) sí trae
    // todo con `select *`.
    await asegurarColumnaTitulo();
    const { rows } = await supabasePool.query(
      `select id, titulo, categoria, mensaje, estado, creado_por_id, creado_por_username,
              ruta_origen, app_origen, created_at, updated_at
       from public.tickets where creado_por_id = $1 order by created_at desc;`,
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
    // Las respuestas de soporte las escribe un admin de planificación
    // (autor_id = admin_users.id): se muestra su nombre real en vez del
    // usuario de login, y si no tiene nombre cargado queda el usuario.
    const autorNombre = (await hayAdminUsers())
      ? `coalesce(case when m.es_admin then
           (select nullif(trim(au.name), '') from public.admin_users au where au.id::text = m.autor_id::text)
         end, m.autor_username) as autor_nombre`
      : 'm.autor_username as autor_nombre';
    const mensajes = await supabasePool.query(
      `select m.*, ${autorNombre} from public.ticket_mensajes m where m.ticket_id = $1 order by m.created_at asc;`,
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

// DELETE /api/tickets/mine/:id — anular (= borrar) un ticket propio,
// autoservicio, no hace falta que intervenga soporte. Solo si todavía no
// está "closed" (ya resuelto por soporte, eso queda como historial).
// `ticket_mensajes` tiene ON DELETE CASCADE, así que las respuestas del
// ticket se borran solas con esto.
app.delete('/api/tickets/mine/:id', requireAuth, async (req, res) => {
  if (!supabasePool) return res.status(500).json({ error: 'SUPABASE_DB_URL no está configurado' });
  try {
    const { rows } = await supabasePool.query(
      `delete from public.tickets where id = $1 and creado_por_id = $2 and estado != 'closed' returning id;`,
      [Number(req.params.id), req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ticket no encontrado o ya no se puede anular' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error en DELETE /api/tickets/mine/:id:', err);
    return res.status(500).json({ error: 'Error anulando el ticket', details: err.message || String(err) });
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
// Sistema anterior dado de baja
// ---------------------
// "Enviar a Odoo" (NTASVTAS/INTASVTAS) y el listado de portones pendientes de
// enviar leían del SQL Server del sistema anterior, que se dio de baja
// (2026-09). Los portones nuevos se generan desde el Presupuestador.
function sistemaAnteriorDadoDeBaja(_req, res) {
  return res.status(410).json({
    error: 'El sistema anterior (SQL Server) se dio de baja: esta función ya no está disponible.',
  });
}

app.post('/api/sync/order-from-sql', requireAuth, attachRole, sistemaAnteriorDadoDeBaja);
app.post('/api/sync/order-from-nv', requireAuth, attachRole, sistemaAnteriorDadoDeBaja);
app.get('/api/debug/ntasvtas-by-nv', requireAuth, attachRole, sistemaAnteriorDadoDeBaja);
app.get('/api/portones', requireAuth, attachRole, sistemaAnteriorDadoDeBaja);

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
