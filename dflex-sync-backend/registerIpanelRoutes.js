// registerIpanelRoutes.js
// Precarga para registrar endpoints de ipanel sin modificar server.js.
// Se activa con: node -r ./registerIpanelRoutes.js server.js

require('dotenv').config();

const Module = require('module');
const sql = require('mssql');
const { Pool } = require('pg');
const { requireAuth, attachRole, requireRole } = require('./authMiddleware');

function toStr(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toIntOrNull(value) {
  const raw = toStr(value);
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateOnlyOrNull(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }

  const raw = toStr(value);
  if (!raw) return null;

  const direct = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeSimpleValue(value) {
  const raw = toStr(value).toUpperCase();
  if (!raw) return null;
  if (raw.includes('MADERA')) return 'MADERA';
  if (raw.includes('ALUMINIO')) return 'ALUMINIO';
  if (raw.includes('PINTURA')) return 'PINTURA';
  if (raw.includes('OTRO')) return 'OTRO';
  return raw;
}

function autoDescripcionSimple(descripcion) {
  const d = toStr(descripcion).toUpperCase();
  if (!d) return null;
  if (d.includes('MADERA')) return 'MADERA';
  if (d.includes('ALUMINIO')) return 'ALUMINIO';
  return null;
}


const DEFAULT_BLOCKED_IPANEL_RANGE = { from: 100000, to: 100736 };
const DEFAULT_ALLOWED_IPANEL_PARTIDAS = new Set([
  100083, 100084, 100300, 100398, 100512, 100513, 100514, 100523,
  100359, 100369, 100650, 100658, 100677, 100678, 100679, 100682,
  100710, 100713, 100715, 100716, 100717, 100718, 100721, 100736,
]);

function buildDefaultBlockedIpanelPartidas() {
  const blocked = new Set();
  for (let n = DEFAULT_BLOCKED_IPANEL_RANGE.from; n <= DEFAULT_BLOCKED_IPANEL_RANGE.to; n += 1) {
    if (!DEFAULT_ALLOWED_IPANEL_PARTIDAS.has(n)) blocked.add(n);
  }
  return blocked;
}

const DEFAULT_BLOCKED_IPANEL_PARTIDAS = buildDefaultBlockedIpanelPartidas();

function parseBlockedPartidasEnv() {
  const raw = toStr(process.env.IPANEL_BLOCKED_PARTIDAS);
  if (!raw) return [];
  return raw
    .split(/[\s,;|]+/)
    .map((v) => toIntOrNull(v))
    .filter((v) => Number.isInteger(v));
}

function isBlockedIpanelPartida(partida, blockedSet) {
  const n = toIntOrNull(partida);
  return Number.isInteger(n) && blockedSet && blockedSet.has(n);
}

function buildSqlConfig() {
  const sqlServerRaw = process.env.SQL_SERVER || 'localhost';
  let sqlHost = sqlServerRaw;
  let sqlPort = 1433;

  if (sqlServerRaw.includes(',')) {
    const [hostPart, portPart] = sqlServerRaw.split(',');
    sqlHost = hostPart;
    const parsedPort = parseInt(portPart, 10);
    if (!Number.isNaN(parsedPort)) sqlPort = parsedPort;
  }

  return {
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
}

let ipanelSqlPoolPromise = null;
function getIpanelSqlPool() {
  if (!ipanelSqlPoolPromise) {
    ipanelSqlPoolPromise = new sql.ConnectionPool(buildSqlConfig()).connect();
  }
  return ipanelSqlPoolPromise;
}

let ipanelPgPool = null;
function getIpanelPgPool() {
  if (!ipanelPgPool) {
    const dbUrl = process.env.SUPABASE_DB_URL || null;
    if (!dbUrl) throw new Error('SUPABASE_DB_URL no esta configurado');
    ipanelPgPool = new Pool({ connectionString: dbUrl });
    ipanelPgPool.on('error', (err) => {
      console.error('[ipanel] Error en pool de Supabase:', err);
    });
  }
  return ipanelPgPool;
}

let ensuredDescripcionSimpleSchema = false;
async function ensureDescripcionSimpleSchema(pgPool = getIpanelPgPool()) {
  if (ensuredDescripcionSimpleSchema) return;

  await pgPool.query(`
    create table if not exists public.ipanel_descripcion_simple_mappings (
      descripcion text primary key,
      descripcion_simple text null,
      created_at timestamp with time zone not null default now(),
      updated_at timestamp with time zone not null default now()
    );
  `);

  await pgPool.query(`
    alter table public.preproduccion_valores_ipanels
      add column if not exists descripcion_simple text;
  `);

  await pgPool.query(`
    alter table public.preproduccion_valores_ipanels
      add column if not exists source text;
  `);

  await pgPool.query(`
    alter table public.ipanel
      add column if not exists descripcion_simple text;
  `);

  await pgPool.query(`
    create index if not exists ipanel_descripcion_simple_mappings_value_idx
      on public.ipanel_descripcion_simple_mappings using btree (descripcion_simple);
  `);

  await pgPool.query(`
    create index if not exists preproduccion_valores_ipanels_descripcion_simple_idx
      on public.preproduccion_valores_ipanels using btree (descripcion_simple);
  `);

  await pgPool.query(`
    create index if not exists ipanel_descripcion_simple_idx
      on public.ipanel using btree (descripcion_simple);
  `);

  await pgPool.query(`
    create table if not exists public.ipanel_sync_blocklist (
      partida integer primary key,
      motivo text null,
      created_at timestamp with time zone not null default now()
    );
  `);

  ensuredDescripcionSimpleSchema = true;
}

function buildObservaciones(row) {
  const parts = [];

  const cliente = toStr(row.cliente);
  const nombre = toStr(row.nombre);
  const direccion = toStr(row.direccion);
  const localidad = toStr(row.localidad);
  const provincia = toStr(row.provincia);
  const cp = toStr(row.cp);
  const cuit = toStr(row.cuit);
  const observ = toStr(row.observ);
  const obs = toStr(row.obs);
  const oc = toStr(row.oc);
  const idpedido = toStr(row.idpedido);
  const vendedor = toStr(row.vendedor);
  const operador = toStr(row.operador);
  const productoDescripcion = getProductoDescripcion(row);

  if (cliente || nombre) parts.push(`Cliente: ${[cliente, nombre].filter(Boolean).join(' - ')}`);
  if (direccion || localidad || provincia || cp) {
    const ubicacion = [direccion, localidad, provincia, cp ? `CP ${cp}` : ''].filter(Boolean).join(' | ');
    parts.push(`Direccion: ${ubicacion}`);
  }
  if (cuit) parts.push(`CUIT: ${cuit}`);
  if (vendedor) parts.push(`Vendedor: ${vendedor}`);
  if (operador) parts.push(`Operador: ${operador}`);
  if (productoDescripcion) parts.push(`Producto: ${productoDescripcion}`);
  if (observ) parts.push(`Observ: ${observ}`);
  if (obs) parts.push(`Obs: ${obs}`);
  if (oc) parts.push(`OC: ${oc}`);
  if (idpedido) parts.push(`ID pedido: ${idpedido}`);

  return parts.join('\n') || null;
}

function getProductoDescripcion(row) {
  return toStr(row.producto_descripcion || row.producto_descripciones || row.descripcion_producto || row.descripcion) || null;
}

function getMappingKey(descripcion) {
  return toStr(descripcion);
}

function resolveDescripcionSimple(descripcion, mappingMap) {
  const key = getMappingKey(descripcion);
  if (!key) return null;

  const mapped = mappingMap && mappingMap.get(key);
  const mappedNorm = normalizeSimpleValue(mapped);
  if (mappedNorm) return mappedNorm;

  return autoDescripcionSimple(key);
}

async function getDescripcionSimpleMappingMap(pgPool = getIpanelPgPool()) {
  await ensureDescripcionSimpleSchema(pgPool);
  const { rows } = await pgPool.query(`
    select descripcion, descripcion_simple
    from public.ipanel_descripcion_simple_mappings
    order by descripcion asc;
  `);

  const map = new Map();
  for (const r of rows || []) {
    const k = getMappingKey(r.descripcion);
    if (k) map.set(k, normalizeSimpleValue(r.descripcion_simple));
  }
  return map;
}


async function getBlockedIpanelPartidas(pgPool = getIpanelPgPool()) {
  await ensureDescripcionSimpleSchema(pgPool);

  const blocked = new Set(DEFAULT_BLOCKED_IPANEL_PARTIDAS);
  for (const n of parseBlockedPartidasEnv()) blocked.add(n);

  try {
    const { rows } = await pgPool.query(`select partida from public.ipanel_sync_blocklist;`);
    for (const r of rows || []) {
      const n = toIntOrNull(r.partida);
      if (Number.isInteger(n)) blocked.add(n);
    }
  } catch (err) {
    console.warn('[ipanel] No se pudo leer ipanel_sync_blocklist; uso lista hardcodeada/env:', err?.message || err);
  }

  return blocked;
}

async function deleteBlockedIpanelPreproduccionRows(pgPool, blockedSet) {
  const arr = Array.from(blockedSet || []).filter((n) => Number.isInteger(n));
  if (!arr.length) return 0;

  const { rowCount } = await pgPool.query(
    `delete from public.preproduccion_valores_ipanels where partida = any($1::int[])`,
    [arr]
  );
  return rowCount || 0;
}

function mapSqlRowToPreproduccionValoresIpanel(row, mappingMap = new Map()) {
  const partida = toIntOrNull(row.numero);
  if (!partida) return null;

  const fechaNv = toDateOnlyOrNull(row.fecha);
  const fechaPlanEntrega = toDateOnlyOrNull(row.fechaent);
  const productoDescripcion = getProductoDescripcion(row);
  const descripcionSimple = resolveDescripcionSimple(productoDescripcion, mappingMap);
  const productoCodigos = toStr(row.producto_codigos) || null;
  const observaciones = buildObservaciones(row);

  return {
    partida,
    nv: partida,
    fecha_nv: fechaNv,
    fecha_plan_entrega: fechaPlanEntrega,
    descripcion: productoDescripcion,
    descripcion_simple: descripcionSimple,
    data: {
      ...row,
      source: 'SQL',
      origen: 'Paneles.dbo.NTASVTAS',
      partida,
      nv: partida,
      fecha_nv: fechaNv,
      fecha_plan_entrega: fechaPlanEntrega,
      producto_codigos: productoCodigos,
      descripcion: productoDescripcion,
      producto_descripcion: productoDescripcion,
      producto_descripciones: productoDescripcion,
      descripcion_producto: productoDescripcion,
      DescripcionSimple: descripcionSimple,
      descripcion_simple: descripcionSimple,
      observaciones,
    },
  };
}

function decorateSqlIpanelRow(row, mappingMap = new Map()) {
  const mapped = mapSqlRowToPreproduccionValoresIpanel(row, mappingMap) || {};
  const productoDescripcion = getProductoDescripcion(row);
  const descripcionSimple = mapped.descripcion_simple ?? resolveDescripcionSimple(productoDescripcion, mappingMap);

  return {
    ...row,
    source: 'SQL',
    partida: mapped.partida ?? toIntOrNull(row.numero),
    nv: mapped.nv ?? toIntOrNull(row.numero),
    fecha_nv: mapped.fecha_nv ?? toDateOnlyOrNull(row.fecha),
    fecha_plan_entrega: mapped.fecha_plan_entrega ?? toDateOnlyOrNull(row.fechaent),
    producto_codigos: toStr(row.producto_codigos) || null,
    descripcion: productoDescripcion,
    producto_descripcion: productoDescripcion,
    producto_descripciones: productoDescripcion,
    descripcion_producto: productoDescripcion,
    DescripcionSimple: descripcionSimple,
    descripcion_simple: descripcionSimple,
    observaciones: mapped.observaciones ?? buildObservaciones(row),
  };
}

async function fetchSqlIpanelRows({ partida, nv, limit } = {}) {
  const pool = await getIpanelSqlPool();
  const request = pool.request();

  const limitValue = Math.max(1, Math.min(toIntOrNull(limit) || 10000, 10000));
  request.input('limit', sql.Int, limitValue);

  const filterValue = toStr(partida || nv);
  let where = '';
  if (filterValue) {
    request.input('numeroStr', sql.VarChar, filterValue);
    where = `
      WHERE LTRIM(RTRIM(CAST(h.numero AS varchar(50)))) = @numeroStr
    `;
  }

  const result = await request.query(`
    SELECT TOP (@limit)
      h.fecha,
      h.tipo,
      h.sucursal,
      h.numero,
      h.deposito,
      h.cliente,
      h.nombre,
      h.direccion,
      h.localidad,
      h.cp,
      h.provincia,
      h.fpago,
      h.vendedor,
      h.operador,
      h.zona,
      h.iva,
      h.cuit,
      h.ibrutos,
      h.observ,
      h.retrep,
      h.fechaent,
      h.dirent,
      h.obs,
      h.oc,
      h.idpedido,
      h.condicion,
      h.factura,
      h.remito,
      STUFF((
        SELECT DISTINCT ', ' + LTRIM(RTRIM(CAST(l.producto AS varchar(100))))
        FROM Paneles.dbo.INTASVTAS AS l
        WHERE LTRIM(RTRIM(CAST(l.numero AS varchar(50)))) = LTRIM(RTRIM(CAST(h.numero AS varchar(50))))
          AND (h.tipo IS NULL OR l.tipo = h.tipo)
          AND (h.sucursal IS NULL OR l.sucursal = h.sucursal)
          AND (h.deposito IS NULL OR l.deposito = h.deposito)
          AND l.producto IS NOT NULL
        FOR XML PATH(''), TYPE
      ).value('.', 'nvarchar(max)'), 1, 2, '') AS producto_codigos,
      STUFF((
        SELECT DISTINCT ' | ' + LTRIM(RTRIM(COALESCE(p.descripcion, '')))
        FROM Paneles.dbo.INTASVTAS AS l
        LEFT JOIN Paneles.dbo.PRODUCTOS AS p
          ON LTRIM(RTRIM(CAST(p.codigo AS varchar(100)))) = LTRIM(RTRIM(CAST(l.producto AS varchar(100))))
        WHERE LTRIM(RTRIM(CAST(l.numero AS varchar(50)))) = LTRIM(RTRIM(CAST(h.numero AS varchar(50))))
          AND (h.tipo IS NULL OR l.tipo = h.tipo)
          AND (h.sucursal IS NULL OR l.sucursal = h.sucursal)
          AND (h.deposito IS NULL OR l.deposito = h.deposito)
          AND NULLIF(LTRIM(RTRIM(COALESCE(p.descripcion, ''))), '') IS NOT NULL
        FOR XML PATH(''), TYPE
      ).value('.', 'nvarchar(max)'), 1, 3, '') AS producto_descripcion
    FROM Paneles.dbo.NTASVTAS AS h
    ${where}
    ORDER BY h.fecha DESC, h.numero DESC
  `);

  return result.recordset || [];
}

async function getDescripcionSimpleCatalog({ limit } = {}) {
  const pgPool = getIpanelPgPool();
  const mappingMap = await getDescripcionSimpleMappingMap(pgPool);
  const sqlRows = await fetchSqlIpanelRows({ limit: limit || 10000 });
  const counts = new Map();

  for (const row of sqlRows) {
    const desc = getProductoDescripcion(row);
    if (!desc) continue;
    counts.set(desc, (counts.get(desc) || 0) + 1);
  }

  const rows = Array.from(counts.entries())
    .map(([descripcion, count]) => ({
      descripcion,
      count,
      descripcion_simple: resolveDescripcionSimple(descripcion, mappingMap),
      descripcion_simple_manual: mappingMap.get(descripcion) || null,
    }))
    .sort((a, b) => String(a.descripcion).localeCompare(String(b.descripcion), 'es'));

  return rows;
}

async function upsertDescripcionSimpleMapping({ descripcion, descripcion_simple }) {
  const pgPool = getIpanelPgPool();
  await ensureDescripcionSimpleSchema(pgPool);
  const desc = getMappingKey(descripcion);
  if (!desc) throw new Error('descripcion es requerida');

  const simple = normalizeSimpleValue(descripcion_simple);

  if (!simple) {
    await pgPool.query(`delete from public.ipanel_descripcion_simple_mappings where descripcion = $1`, [desc]);
  } else {
    await pgPool.query(
      `
        insert into public.ipanel_descripcion_simple_mappings (descripcion, descripcion_simple, updated_at)
        values ($1, $2, now())
        on conflict (descripcion)
        do update set descripcion_simple = excluded.descripcion_simple, updated_at = now();
      `,
      [desc, simple]
    );
  }

  // Recalcula filas ya sincronizadas con esa descripcion.
  await pgPool.query(
    `
      update public.preproduccion_valores_ipanels
      set descripcion_simple = $2,
          data = jsonb_set(
            jsonb_set(coalesce(data, '{}'::jsonb), '{DescripcionSimple}', to_jsonb($2::text), true),
            '{descripcion_simple}', to_jsonb($2::text), true
          ),
          updated_at = now()
      where coalesce(descripcion, data->>'descripcion', data->>'producto_descripcion', data->>'producto_descripciones', data->>'descripcion_producto') = $1;
    `,
    [desc, simple]
  );

  await pgPool.query(
    `
      update public.ipanel i
      set descripcion_simple = $2,
          updated_at = now()
      from public.preproduccion_valores_ipanels p
      where p.partida = i.partida
        and coalesce(p.descripcion, p.data->>'descripcion', p.data->>'producto_descripcion', p.data->>'producto_descripciones', p.data->>'descripcion_producto') = $1;
    `,
    [desc, simple]
  );

  return { descripcion: desc, descripcion_simple: simple };
}

async function upsertPreproduccionValoresIpanelRow(pgPool, mapped) {
  await ensureDescripcionSimpleSchema(pgPool);

  const existing = await pgPool.query(
    `
      SELECT id, data
      FROM public.preproduccion_valores_ipanels
      WHERE partida = $1
      ORDER BY id ASC
      LIMIT 1
    `,
    [mapped.partida]
  );

  if (existing.rows.length) {
    const existingData = existing.rows[0]?.data && typeof existing.rows[0].data === 'object' ? existing.rows[0].data : {};
    const mergedData = {
      ...existingData,
      ...(mapped.data || {}),
    };

    // No pisar fechas/datos imputados por logística desde Planificación.
    for (const key of ['fecha_prod', 'inicio_prod_imput', 'fecha_plan_entrega', 'fecha_salida_imput', 'produccion_enviada', 'produccion_enviada_at', 'ipanel_id']) {
      if (existingData[key] !== undefined && existingData[key] !== null && String(existingData[key]).trim() !== '') {
        mergedData[key] = existingData[key];
      }
    }

    await pgPool.query(
      `
        UPDATE public.preproduccion_valores_ipanels
        SET
          nv = $2,
          source = coalesce(source, 'SQL'),
          fecha_nv = $3,
          fecha_plan_entrega = coalesce(fecha_plan_entrega, $4),
          descripcion = $5,
          descripcion_simple = $6,
          data = $7::jsonb,
          updated_at = now()
        WHERE id = $1
      `,
      [
        existing.rows[0].id,
        mapped.nv,
        mapped.fecha_nv,
        mapped.fecha_plan_entrega,
        mapped.descripcion || mapped.data?.descripcion || mapped.data?.producto_descripcion || null,
        mapped.descripcion_simple || mapped.data?.DescripcionSimple || null,
        JSON.stringify(mergedData),
      ]
    );
    return 'updated';
  }

  await pgPool.query(
    `
      INSERT INTO public.preproduccion_valores_ipanels (
        partida,
        nv,
        source,
        fecha_nv,
        fecha_plan_entrega,
        descripcion,
        descripcion_simple,
        data
      ) VALUES ($1, $2, 'SQL', $3, $4, $5, $6, $7::jsonb)
    `,
    [
      mapped.partida,
      mapped.nv,
      mapped.fecha_nv,
      mapped.fecha_plan_entrega,
      mapped.descripcion || mapped.data?.descripcion || mapped.data?.producto_descripcion || null,
      mapped.descripcion_simple || mapped.data?.DescripcionSimple || null,
      JSON.stringify(mapped.data || {}),
    ]
  );
  return 'inserted';
}

async function syncIpanels({ partida, nv, limit } = {}) {
  const pgPool = getIpanelPgPool();
  await ensureDescripcionSimpleSchema(pgPool);
  const mappingMap = await getDescripcionSimpleMappingMap(pgPool);
  const blockedSet = await getBlockedIpanelPartidas(pgPool);
  const deletedBlocked = await deleteBlockedIpanelPreproduccionRows(pgPool, blockedSet);
  const sqlRows = await fetchSqlIpanelRows({ partida, nv, limit });

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let skippedBlocked = 0;
  const errors = [];

  for (const row of sqlRows) {
    try {
      const mapped = mapSqlRowToPreproduccionValoresIpanel(row, mappingMap);
      if (!mapped) {
        skipped += 1;
        continue;
      }

      if (isBlockedIpanelPartida(mapped.partida, blockedSet)) {
        skipped += 1;
        skippedBlocked += 1;
        continue;
      }

      const result = await upsertPreproduccionValoresIpanelRow(pgPool, mapped);
      if (result === 'inserted') inserted += 1;
      else if (result === 'updated') updated += 1;
    } catch (err) {
      errors.push({ numero: row?.numero ?? null, error: err?.message || String(err) });
    }
  }

  return {
    ok: errors.length === 0,
    source: 'SQL',
    imported: inserted + updated,
    inserted,
    updated,
    skipped,
    skippedBlocked,
    deletedBlocked,
    totalSqlRows: sqlRows.length,
    errors,
  };
}

async function getLastIpanelSync() {
  const pgPool = getIpanelPgPool();
  await ensureDescripcionSimpleSchema(pgPool);
  const { rows } = await pgPool.query('SELECT MAX(updated_at) AS last_sync_at FROM public.preproduccion_valores_ipanels');
  return rows?.[0]?.last_sync_at || null;
}

function registerIpanelRoutes(app) {
  if (!app || app.__ipanelRoutesRegistered) return;
  app.__ipanelRoutesRegistered = true;

  app.get('/api/ipanel', requireAuth, attachRole, async (req, res) => {
    try {
      const pgPool = getIpanelPgPool();
      const mappingMap = await getDescripcionSimpleMappingMap(pgPool);
      const blockedSet = await getBlockedIpanelPartidas(pgPool);
      const rawRows = await fetchSqlIpanelRows({
        partida: req.query.partida,
        nv: req.query.nv,
        limit: req.query.limit,
      });
      const rows = rawRows.map((r) => {
        const decorated = decorateSqlIpanelRow(r, mappingMap);
        return {
          ...decorated,
          bloqueado_preproduccion: isBlockedIpanelPartida(decorated.partida ?? decorated.numero, blockedSet),
        };
      });
      return res.json({ source: 'SQL', rows });
    } catch (err) {
      console.error('[ipanel] Error leyendo desde SQL:', err);
      return res.status(500).json({ error: 'Error leyendo ipanels desde SQL', details: err?.message || String(err) });
    }
  });

  app.get('/api/ipanel/sql', requireAuth, attachRole, async (req, res) => {
    try {
      const pgPool = getIpanelPgPool();
      const mappingMap = await getDescripcionSimpleMappingMap(pgPool);
      const blockedSet = await getBlockedIpanelPartidas(pgPool);
      const rawRows = await fetchSqlIpanelRows({
        partida: req.query.partida,
        nv: req.query.nv,
        limit: req.query.limit,
      });
      const rows = rawRows.map((r) => {
        const decorated = decorateSqlIpanelRow(r, mappingMap);
        return {
          ...decorated,
          bloqueado_preproduccion: isBlockedIpanelPartida(decorated.partida ?? decorated.numero, blockedSet),
        };
      });
      return res.json({ source: 'SQL', rows });
    } catch (err) {
      console.error('[ipanel] Error leyendo desde SQL:', err);
      return res.status(500).json({ error: 'Error leyendo ipanels desde SQL', details: err?.message || String(err) });
    }
  });

  app.get('/api/ipanel/descripcion-simple/catalog', requireAuth, attachRole, async (req, res) => {
    try {
      const rows = await getDescripcionSimpleCatalog({ limit: req.query.limit });
      return res.json({ rows });
    } catch (err) {
      console.error('[ipanel] Error leyendo catalogo DescripcionSimple:', err);
      return res.status(500).json({ error: 'Error leyendo catalogo DescripcionSimple', details: err?.message || String(err) });
    }
  });

  app.get('/api/ipanel/descripcion-simple/mappings', requireAuth, attachRole, async (_req, res) => {
    try {
      const pgPool = getIpanelPgPool();
      await ensureDescripcionSimpleSchema(pgPool);
      const { rows } = await pgPool.query(`
        select descripcion, descripcion_simple, created_at, updated_at
        from public.ipanel_descripcion_simple_mappings
        order by descripcion asc;
      `);
      return res.json({ rows });
    } catch (err) {
      console.error('[ipanel] Error leyendo mappings DescripcionSimple:', err);
      return res.status(500).json({ error: 'Error leyendo mappings DescripcionSimple', details: err?.message || String(err) });
    }
  });

  app.put('/api/ipanel/descripcion-simple/mapping', requireAuth, attachRole, requireRole(['admin']), async (req, res) => {
    try {
      const result = await upsertDescripcionSimpleMapping(req.body || {});
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[ipanel] Error guardando mapping DescripcionSimple:', err);
      return res.status(400).json({ error: 'Error guardando mapping DescripcionSimple', details: err?.message || String(err) });
    }
  });

  app.post('/api/ipanel/descripcion-simple/mapping', requireAuth, attachRole, requireRole(['admin']), async (req, res) => {
    try {
      const result = await upsertDescripcionSimpleMapping(req.body || {});
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[ipanel] Error guardando mapping DescripcionSimple:', err);
      return res.status(400).json({ error: 'Error guardando mapping DescripcionSimple', details: err?.message || String(err) });
    }
  });

  app.get('/api/ipanel/blocklist', requireAuth, attachRole, async (_req, res) => {
    try {
      const pgPool = getIpanelPgPool();
      const blockedSet = await getBlockedIpanelPartidas(pgPool);
      return res.json({ rows: Array.from(blockedSet).sort((a, b) => a - b).map((partida) => ({ partida })) });
    } catch (err) {
      console.error('[ipanel] Error leyendo blocklist:', err);
      return res.status(500).json({ error: 'Error leyendo blocklist ipanel', details: err?.message || String(err) });
    }
  });

  app.post('/api/ipanel/blocklist/cleanup', requireAuth, attachRole, requireRole(['admin']), async (_req, res) => {
    try {
      const pgPool = getIpanelPgPool();
      const blockedSet = await getBlockedIpanelPartidas(pgPool);
      const deletedBlocked = await deleteBlockedIpanelPreproduccionRows(pgPool, blockedSet);
      return res.json({ ok: true, deletedBlocked });
    } catch (err) {
      console.error('[ipanel] Error limpiando blocklist:', err);
      return res.status(500).json({ error: 'Error limpiando blocklist ipanel', details: err?.message || String(err) });
    }
  });

  app.get('/api/ipanel/last-sync', requireAuth, attachRole, async (_req, res) => {
    try {
      const lastSyncAt = await getLastIpanelSync();
      return res.json({ lastSyncAt });
    } catch (err) {
      console.error('[ipanel] Error leyendo ultima sync:', err);
      return res.status(500).json({ error: 'Error leyendo ultima sync ipanel', details: err?.message || String(err) });
    }
  });

  app.post('/api/sync/ipanel', requireAuth, attachRole, requireRole(['admin']), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await syncIpanels({
        partida: body.partida || req.query.partida,
        nv: body.nv || req.query.nv,
        limit: body.limit || req.query.limit,
      });
      return res.status(result.ok ? 200 : 207).json(result);
    } catch (err) {
      console.error('[ipanel] Error sincronizando:', err);
      return res.status(500).json({ error: 'Error sincronizando ipanels', details: err?.message || String(err) });
    }
  });

  app.get('/api/ipanel/presupuestador', requireAuth, attachRole, async (req, res) => {
    try {
      const pgPool = getIpanelPgPool();
      const { rows } = await pgPool.query(`
        SELECT id, partida, nv, fecha_nv, fecha_plan_entrega, descripcion, descripcion_simple, data, updated_at
        FROM public.preproduccion_valores_ipanels
        WHERE source = 'Presupuestador'
        ORDER BY nv DESC, id DESC
        LIMIT 1000
      `);

      const mapped = (rows || []).map((r) => {
        const d = r.data && typeof r.data === 'object' ? r.data : {};
        return {
          ...d,
          _id: r.id,
          partida: r.partida,
          nv: r.nv,
          fecha_nv: r.fecha_nv,
          fecha_plan_entrega: r.fecha_plan_entrega,
          descripcion: r.descripcion || d.descripcion || d.producto_descripcion || null,
          descripcion_simple: r.descripcion_simple,
          updated_at: r.updated_at,
          source: 'Presupuestador',
        };
      });

      return res.json({ rows: mapped });
    } catch (err) {
      console.error('[ipanel] Error leyendo filas de Presupuestador:', err);
      return res.status(500).json({ error: 'Error leyendo ipanels del Presupuestador', details: err?.message || String(err) });
    }
  });

  console.log('[ipanel] Rutas registradas: SQL + productos + DescripcionSimple + blocklist + sync + presupuestador');
}

function patchExpress() {
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);

    if (request !== 'express' || !exported || exported.__ipanelPatched) {
      return exported;
    }

    function wrappedExpress(...args) {
      const app = exported(...args);

      if (app && !app.__ipanelListenPatched) {
        app.__ipanelListenPatched = true;
        const originalListen = app.listen.bind(app);

        app.listen = function patchedListen(...listenArgs) {
          registerIpanelRoutes(app);
          return originalListen(...listenArgs);
        };
      }

      return app;
    }

    Object.assign(wrappedExpress, exported);
    Object.setPrototypeOf(wrappedExpress, Object.getPrototypeOf(exported));
    wrappedExpress.__ipanelPatched = true;

    return wrappedExpress;
  };
}

patchExpress();
