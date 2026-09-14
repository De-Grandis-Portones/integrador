const SOURCE_APP = 'presupuestador';
const PRODUCTION_SOURCE_SECTION = 'nota_venta';
const PRODUCTION_ASSIGNMENTS_TABLE = 'public.presupuestador_production_property_assignments';
const IPANEL_SOURCE_SECTION = 'nota_venta_inv';
const IPANEL_ASSIGNMENTS_TABLE = 'public.presupuestador_ipanel_property_assignments';

const BASE_PRODUCTION_SOURCE_PROPERTIES = [
  { source_key: 'nv', label: 'NV', group: 'Referencias', description: 'Número de nota de venta final.' },
  { source_key: 'referencia_nv', label: 'Referencia NV', group: 'Referencias', description: 'Texto completo de la NV, por ejemplo NV5056.' },
  { source_key: 'referencia_np', label: 'Referencia NP', group: 'Referencias', description: 'Texto completo de la NP origen, si existe.' },
  { source_key: 'quote_number', label: 'Número interno presupuesto', group: 'Referencias', description: 'Número interno del presupuestador.' },
  { source_key: 'fecha_presupuesto', label: 'Fecha presupuesto', group: 'Fechas', description: 'Fecha de creación del presupuesto original.' },
  { source_key: 'fecha_confirmacion', label: 'Fecha confirmación', group: 'Fechas', description: 'Fecha en la que se confirmó el presupuesto.' },
  { source_key: 'fecha_aprobacion_comercial', label: 'Fecha aprobación comercial', group: 'Fechas', description: 'Fecha de aprobación comercial.' },
  { source_key: 'fecha_aprobacion_tecnica', label: 'Fecha aprobación técnica', group: 'Fechas', description: 'Fecha de aprobación técnica inicial.' },
  { source_key: 'fecha_np', label: 'Fecha NP', group: 'Fechas', description: 'Fecha de generación/sync de la NP en Odoo, si existe.' },
  { source_key: 'fecha_medicion', label: 'Fecha medición', group: 'Fechas', description: 'Fecha de medición del portón, si existe.' },
  { source_key: 'fecha_revision_tecnica_final', label: 'Fecha revisión técnica final', group: 'Fechas', description: 'Fecha de revisión técnica final de la medición.' },
  { source_key: 'fecha_solicitud_salida_acopio', label: 'Fecha solicitud salida de acopio', group: 'Fechas', description: 'Fecha en la que se pidió pasar un portón de acopio a producción.' },
  { source_key: 'fecha_nv', label: 'Fecha NV', group: 'Fechas', description: 'Fecha de generación/sync de la NV final en Odoo.' },
  { source_key: 'catalog_kind', label: 'Tipo de catálogo', group: 'General', description: 'porton / ipanel / otros.' },
  { source_key: 'fulfillment_mode', label: 'Modo', group: 'General', description: 'acopio / produccion.' },
  { source_key: 'payment_method', label: 'Forma de pago', group: 'General', description: 'Forma de pago del presupuesto.' },
  { source_key: 'cliente_nombre', label: 'Cliente nombre', group: 'Cliente', description: 'Nombre del cliente final.' },
  { source_key: 'cliente_apellido', label: 'Cliente apellido', group: 'Cliente', description: 'Apellido del cliente final.' },
  { source_key: 'cliente_nombre_completo', label: 'Cliente nombre completo', group: 'Cliente', description: 'Nombre y apellido del cliente final.' },
  { source_key: 'cliente_telefono', label: 'Cliente teléfono', group: 'Cliente', description: 'Teléfono del cliente final.' },
  { source_key: 'cliente_email', label: 'Cliente email', group: 'Cliente', description: 'Email del cliente final.' },
  { source_key: 'cliente_direccion', label: 'Cliente dirección', group: 'Cliente', description: 'Dirección del cliente final.' },
  { source_key: 'cliente_localidad', label: 'Cliente localidad', group: 'Cliente', description: 'Ciudad / localidad del cliente final.' },
  { source_key: 'cliente_maps_url', label: 'Cliente Maps', group: 'Cliente', description: 'URL de Google Maps del cliente.' },
  { source_key: 'vendido_por_rol', label: 'Vendido por rol', group: 'Venta', description: 'Rol del usuario que vendió el portón.' },
  { source_key: 'vendido_por_nombre', label: 'Vendido por nombre', group: 'Venta', description: 'Nombre del usuario que vendió el portón.' },
  { source_key: 'vendido_por_username', label: 'Vendido por usuario', group: 'Venta', description: 'Username del usuario que vendió el portón.' },
  { source_key: 'vendedor_nombre', label: 'Vendedor nombre', group: 'Venta', description: 'Nombre del vendedor, si la venta la hizo un vendedor.' },
  { source_key: 'distribuidor_nombre', label: 'Distribuidor nombre', group: 'Venta', description: 'Nombre del distribuidor, si la venta la hizo un distribuidor.' },
  { source_key: 'porton_type', label: 'Sistema (label visible)', group: 'Portón', description: 'Tipo/sistema visible, en mayúsculas como el desplegable del cotizador.' },
  { source_key: 'porton_type_key', label: 'Sistema (key interna)', group: 'Portón', description: 'Key interna, por ejemplo acero_simil_aluminio_clasico.' },
  { source_key: 'alto_final_mm', label: 'Alto final (mm)', group: 'Portón', description: 'Alto final en milímetros.' },
  { source_key: 'ancho_final_mm', label: 'Ancho final (mm)', group: 'Portón', description: 'Ancho final en milímetros.' },
  { source_key: 'cantidad_parantes', label: 'Cantidad parantes', group: 'Portón', description: 'Cantidad de parantes.' },
  { source_key: 'orientacion_parantes', label: 'Orientación parantes', group: 'Portón', description: 'Orientación de parantes.' },
  { source_key: 'distribucion_parantes', label: 'Distribución parantes', group: 'Portón', description: 'Distribución de parantes.' },
  { source_key: 'observaciones_parantes', label: 'Observaciones parantes', group: 'Portón', description: 'Observaciones de parantes.' },
  { source_key: 'tolerance_percent', label: 'Tolerancia %', group: 'Métricas', description: 'Tolerancia porcentual final aplicada.' },
  { source_key: 'tolerance_amount', label: 'Tolerancia importe', group: 'Métricas', description: 'Tolerancia monetaria aplicada.' },
  { source_key: 'difference_amount', label: 'Diferencia final', group: 'Métricas', description: 'Diferencia final calculada.' },
  { source_key: 'absorbed_by_company', label: 'Absorbido por empresa', group: 'Métricas', description: 'true / false.' },
  { source_key: 'final_amount_to_charge', label: 'Importe final a cobrar', group: 'Métricas', description: 'Monto final de la NV.' },
];

const MEASUREMENT_SOURCE_CATALOG = [
  {
    section_key: 'datos_generales',
    section_label: 'Datos generales',
    fields: [
      { path: 'fecha', label: 'Fecha' },
      { path: 'distribuidor', label: 'Distribuidor' },
      { path: 'nro_porton', label: 'N° de portón / Nota de venta' },
      { path: 'en_acopio', label: 'Portón en acopio' },
    ],
  },
  {
    section_key: 'parantes_laterales',
    section_label: 'Parantes / Laterales',
    fields: [
      { path: 'parantes.cant', label: 'Parantes (cantidad)' },
      { path: 'lado_puerta', label: 'Lado de la puerta' },
      { path: 'lado_motor', label: 'Lado de motor o soporte' },
      { path: 'toma_corriente', label: 'Toma corriente' },
    ],
  },
  {
    section_key: 'esquema_medidas',
    section_label: 'Esquema (medidas)',
    fields: [
      { path: 'esquema.alto', label: 'Altos (array x3)' },
      { path: 'esquema.ancho', label: 'Anchos (array x3)' },
      { path: 'alto_final_mm', label: 'Alto final (mm)' },
      { path: 'ancho_final_mm', label: 'Ancho final (mm)' },
    ],
  },
  {
    section_key: 'instalacion_sistema',
    section_label: 'Instalación / Sistema',
    fields: [
      { path: 'colocacion', label: 'Tipo de colocación' },
      { path: 'accionamiento', label: 'Tipo de accionamiento' },
      { path: 'levadizo', label: 'Sistema levadizo' },
      { path: 'estructura_metalica', label: 'Estructura metálica para puerta' },
      { path: 'rebaje_lateral_mm', label: 'Rebaje lateral (mm)' },
      { path: 'rebaje_inferior_mm', label: 'Rebaje inferior (mm)' },
      { path: 'anclaje', label: 'Anclaje de fijación' },
      { path: 'color_sistema', label: 'Color de sistema' },
    ],
  },
  {
    section_key: 'revestimiento',
    section_label: 'Revestimiento',
    fields: [
      { path: 'tipo_revestimiento', label: 'Tipo de revestimiento' },
      { path: 'varillado_medida', label: 'Medida varillado' },
      { path: 'orientacion_revestimiento', label: 'Orientación del revestimiento' },
      { path: 'revestimiento', label: 'Revestimiento' },
      { path: 'color_revestimiento', label: 'Color de revestimiento' },
      { path: 'color_revestimiento_otro', label: 'Color de revestimiento (otro)' },
      { path: 'lucera', label: 'Lucera con vidrios' },
      { path: 'lucera_cantidad', label: 'Cantidad lucera' },
      { path: 'peso_revestimiento', label: 'Peso del revestimiento' },
    ],
  },
  {
    section_key: 'servicios_contacto',
    section_label: 'Servicios / Contacto',
    fields: [
      { path: 'traslado', label: 'Servicio de traslado' },
      { path: 'relevamiento', label: 'Servicio de relevamiento de medidas' },
      { path: 'contacto_obra_nombre', label: 'Nombre contacto en obra' },
      { path: 'contacto_obra_tel', label: 'Teléfono contacto en obra' },
    ],
  },
  {
    section_key: 'observaciones',
    section_label: 'Observaciones',
    fields: [
      { path: 'observaciones', label: 'Observaciones' },
    ],
  },
];

function getByPath(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value).trim().replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function toNumericArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toNumber(item))
    .filter((n) => n !== null);
}

function applyResolver(value, resolver) {
  const mode = String(resolver || 'identity').trim().toLowerCase();

  if (mode === 'identity') return value;
  if (mode === 'first_non_empty') {
    if (!Array.isArray(value)) return value;
    for (const item of value) {
      if (item !== null && item !== undefined && String(item).trim() !== '') return item;
    }
    return null;
  }
  if (mode === 'join_csv') {
    if (!Array.isArray(value)) return value;
    return value.filter((item) => item !== null && item !== undefined && String(item).trim() !== '').join(', ');
  }

  const numeric = toNumericArray(value);
  if (!numeric.length) return null;

  if (mode === 'min') return Math.min(...numeric);
  if (mode === 'max') return Math.max(...numeric);
  if (mode === 'sum') return numeric.reduce((acc, item) => acc + item, 0);

  return value;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function slugifySimple(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function buildSectionSourceKey(sectionName) {
  const slug = slugifySimple(sectionName);
  return slug ? `section__${slug}` : '';
}

function labelFromSectionSourceKey(sourceKey) {
  const raw = String(sourceKey || '').replace(/^section__/, '').replace(/_/g, ' ').trim();
  return raw ? raw.replace(/\w/g, (m) => m.toUpperCase()) : sourceKey;
}

function isIpanelAssignmentPayload(payload) {
  return normalizeText(payload?.source_section) === IPANEL_SOURCE_SECTION;
}

function isProductionAssignmentPayload(payload) {
  const section = normalizeText(payload?.source_section);
  return section === PRODUCTION_SOURCE_SECTION || !!normalizeText(payload?.source_key);
}

function mapIpanelAssignmentRow(row, meta = {}) {
  const sourceKey = normalizeText(row?.source_key || meta?.source_key || meta?.path);
  return {
    id: sourceKey ? `inv:${sourceKey}` : null,
    source_key: sourceKey,
    target_property: normalizeText(row?.target_property),
    source_app: SOURCE_APP,
    source_section: IPANEL_SOURCE_SECTION,
    source_path: sourceKey,
    source_label: meta?.label || row?.source_label || sourceKey,
    source_group: meta?.group || row?.source_group || 'IPanels',
    source_description: meta?.description || row?.source_description || '',
    resolver: 'identity',
    is_active: row?.is_active !== false,
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null,
  };
}

function mapProductionAssignmentRow(row, meta = {}) {
  const sourceKey = normalizeText(row?.source_key || meta?.source_key || meta?.path);
  return {
    id: sourceKey ? `nv:${sourceKey}` : null,
    source_key: sourceKey,
    target_property: normalizeText(row?.target_property),
    source_app: SOURCE_APP,
    source_section: PRODUCTION_SOURCE_SECTION,
    source_path: sourceKey,
    source_label: meta?.label || row?.source_label || sourceKey,
    source_group: meta?.group || row?.source_group || (sourceKey.startsWith('section__') ? 'Secciones del presupuesto' : 'Nota de venta'),
    source_description: meta?.description || row?.source_description || '',
    resolver: 'identity',
    is_active: row?.is_active !== false,
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null,
  };
}

let measurementMappingsLastSyncAt = null;

function getMeasurementMappingsLastSyncAt() {
  return measurementMappingsLastSyncAt;
}

async function ensureMeasurementMappingsTable(pool) {
  if (!pool) throw new Error('SUPABASE_DB_URL no está configurado');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS preproduccion_property_mappings (
      id bigserial PRIMARY KEY,
      target_property text NOT NULL UNIQUE,
      source_app text NOT NULL DEFAULT 'presupuestador',
      source_section text,
      source_path text,
      resolver text NOT NULL DEFAULT 'identity',
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${PRODUCTION_ASSIGNMENTS_TABLE} (
      source_key text PRIMARY KEY,
      target_property text NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${IPANEL_ASSIGNMENTS_TABLE} (
      source_key text PRIMARY KEY,
      target_property text NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  measurementMappingsLastSyncAt = new Date().toISOString();
}

async function listLegacyMeasurementPropertyMappings(pool) {
  const { rows } = await pool.query(`
    SELECT
      id,
      target_property,
      source_app,
      source_section,
      source_path,
      resolver,
      is_active,
      created_at,
      updated_at
    FROM preproduccion_property_mappings
    ORDER BY target_property
  `);

  return rows || [];
}

async function listProductionSectionSourceProperties(pool) {
  if (!pool) return [];

  const byKey = new Map();

  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT name
      FROM public.presupuestador_sections
      WHERE COALESCE(name, '') <> ''
      ORDER BY name ASC
    `);

    for (const row of rows || []) {
      const sectionName = normalizeText(row?.name);
      const sourceKey = buildSectionSourceKey(sectionName);
      if (!sectionName || !sourceKey) continue;
      byKey.set(sourceKey, {
        path: sourceKey,
        source_key: sourceKey,
        label: sectionName,
        group: 'Secciones del presupuesto',
        description: `Item elegido en la sección ${sectionName}. Si la sección no participa en la NV, la propiedad asignada queda null.`,
      });
    }
  } catch (err) {
    console.warn('No se pudieron leer secciones desde public.presupuestador_sections:', err?.message || err);
  }

  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT key AS source_key
      FROM public.preproduccion_valores pv
      CROSS JOIN LATERAL jsonb_object_keys(COALESCE(pv.data, '{}'::jsonb)) AS j(key)
      WHERE key LIKE 'section__%'
      ORDER BY key ASC
      LIMIT 1000
    `);

    for (const row of rows || []) {
      const sourceKey = normalizeText(row?.source_key);
      if (!sourceKey || byKey.has(sourceKey)) continue;
      byKey.set(sourceKey, {
        path: sourceKey,
        source_key: sourceKey,
        label: labelFromSectionSourceKey(sourceKey),
        group: 'Secciones del presupuesto',
        description: 'Item elegido en esta sección del presupuesto. Si la sección no participa en la NV, la propiedad asignada queda null.',
      });
    }
  } catch (err) {
    console.warn('No se pudieron detectar secciones desde preproduccion_valores:', err?.message || err);
  }

  return Array.from(byKey.values()).sort((a, b) => String(a.label).localeCompare(String(b.label), 'es'));
}

async function listProductionSourceCatalog(pool) {
  const sectionFields = await listProductionSectionSourceProperties(pool);
  const baseFields = BASE_PRODUCTION_SOURCE_PROPERTIES.map((item) => ({
    path: item.source_key,
    source_key: item.source_key,
    label: item.label,
    group: item.group || 'Campos generales',
    description: item.description || '',
  }));

  return {
    section_key: PRODUCTION_SOURCE_SECTION,
    section_label: 'Nota de venta / Presupuesto',
    fields: [...sectionFields, ...baseFields],
  };
}

async function listProductionPropertyAssignmentsRaw(pool) {
  const { rows } = await pool.query(`
    SELECT source_key, target_property, is_active, created_at, updated_at
    FROM ${PRODUCTION_ASSIGNMENTS_TABLE}
    ORDER BY source_key ASC
  `);
  return rows || [];
}

async function listIpanelPropertyAssignmentsRaw(pool) {
  const { rows } = await pool.query(`
    SELECT source_key, target_property, is_active, created_at, updated_at
    FROM ${IPANEL_ASSIGNMENTS_TABLE}
    ORDER BY source_key ASC
  `);
  return rows || [];
}

async function listProductionPropertyAssignments(pool) {
  const rows = await listProductionPropertyAssignmentsRaw(pool);
  return rows.map((row) => mapProductionAssignmentRow(row));
}

async function listMeasurementPropertyMappings(pool) {
  await ensureMeasurementMappingsTable(pool);

  const [legacyRows, productionRowsRaw, productionCatalog, ipanelRowsRaw] = await Promise.all([
    listLegacyMeasurementPropertyMappings(pool),
    listProductionPropertyAssignmentsRaw(pool),
    listProductionSourceCatalog(pool),
    listIpanelPropertyAssignmentsRaw(pool),
  ]);

  const productionByKey = new Map();
  for (const field of productionCatalog?.fields || []) {
    const sourceKey = normalizeText(field?.source_key || field?.path);
    if (!sourceKey) continue;
    productionByKey.set(sourceKey, mapProductionAssignmentRow({ source_key: sourceKey, target_property: '', is_active: true }, field));
  }
  for (const row of productionRowsRaw || []) {
    const sourceKey = normalizeText(row?.source_key);
    const meta = productionByKey.get(sourceKey) || {};
    productionByKey.set(sourceKey, mapProductionAssignmentRow(row, meta));
  }

  // IPanel assignments keyed by source_key
  const ipanelByKey = new Map();
  for (const row of ipanelRowsRaw || []) {
    const sourceKey = normalizeText(row?.source_key);
    if (!sourceKey) continue;
    ipanelByKey.set(sourceKey, mapIpanelAssignmentRow(row));
  }

  const visibleLegacyRows = (legacyRows || []).filter((row) => row?.source_section !== PRODUCTION_SOURCE_SECTION);
  return [
    ...visibleLegacyRows,
    ...Array.from(productionByKey.values()),
    ...Array.from(ipanelByKey.values()),
  ];
}

async function upsertProductionPropertyAssignment(pool, payload) {
  await ensureMeasurementMappingsTable(pool);

  const sourceKey = normalizeText(payload?.source_key || payload?.source_path);
  if (!sourceKey) throw new Error('Falta source_key/source_path para asignación desde Nota de venta');

  const targetProperty = normalizeText(payload?.target_property) || null;
  const isActive = payload?.is_active !== false;

  const { rows } = await pool.query(
    `
      INSERT INTO ${PRODUCTION_ASSIGNMENTS_TABLE} (
        source_key,
        target_property,
        is_active
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (source_key)
      DO UPDATE SET
        target_property = EXCLUDED.target_property,
        is_active = EXCLUDED.is_active,
        updated_at = now()
      RETURNING source_key, target_property, is_active, created_at, updated_at
    `,
    [sourceKey, targetProperty, isActive]
  );

  return mapProductionAssignmentRow(rows?.[0] || {});
}

async function upsertIpanelPropertyAssignment(pool, payload) {
  await ensureMeasurementMappingsTable(pool);

  const sourceKey = normalizeText(payload?.source_key || payload?.source_path);
  if (!sourceKey) throw new Error('Falta source_key/source_path para asignación INV');

  const targetProperty = normalizeText(payload?.target_property) || null;
  const isActive = payload?.is_active !== false;

  const { rows } = await pool.query(
    `INSERT INTO ${IPANEL_ASSIGNMENTS_TABLE} (source_key, target_property, is_active)
     VALUES ($1, $2, $3)
     ON CONFLICT (source_key)
     DO UPDATE SET target_property = EXCLUDED.target_property, is_active = EXCLUDED.is_active, updated_at = now()
     RETURNING source_key, target_property, is_active, created_at, updated_at`,
    [sourceKey, targetProperty, isActive]
  );

  return mapIpanelAssignmentRow(rows?.[0] || {});
}

async function upsertMeasurementPropertyMapping(pool, payload) {
  await ensureMeasurementMappingsTable(pool);

  if (isIpanelAssignmentPayload(payload)) {
    return upsertIpanelPropertyAssignment(pool, payload);
  }

  if (isProductionAssignmentPayload(payload)) {
    return upsertProductionPropertyAssignment(pool, payload);
  }

  const targetProperty = normalizeText(payload?.target_property);
  if (!targetProperty) throw new Error('Falta target_property');

  const sourceSection = payload?.source_section ? normalizeText(payload.source_section) : null;
  const sourcePath = payload?.source_path ? normalizeText(payload.source_path) : null;
  const resolver = normalizeText(payload?.resolver || 'identity') || 'identity';
  const sourceApp = normalizeText(payload?.source_app || SOURCE_APP) || SOURCE_APP;
  const isActive = payload?.is_active !== false;

  const { rows } = await pool.query(
    `
      INSERT INTO preproduccion_property_mappings (
        target_property,
        source_app,
        source_section,
        source_path,
        resolver,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (target_property)
      DO UPDATE SET
        source_app = EXCLUDED.source_app,
        source_section = EXCLUDED.source_section,
        source_path = EXCLUDED.source_path,
        resolver = EXCLUDED.resolver,
        is_active = EXCLUDED.is_active,
        updated_at = now()
      RETURNING
        id,
        target_property,
        source_app,
        source_section,
        source_path,
        resolver,
        is_active,
        created_at,
        updated_at
    `,
    [targetProperty, sourceApp, sourceSection, sourcePath, resolver, isActive]
  );

  return rows?.[0] || null;
}

async function reapplyProductionPropertyAssignments(pool, { nv } = {}) {
  await ensureMeasurementMappingsTable(pool);

  const assignmentRows = await listProductionPropertyAssignmentsRaw(pool);
  const assignments = (assignmentRows || [])
    .filter((row) => row?.is_active !== false)
    .map((row) => ({
      source_key: normalizeText(row?.source_key),
      target_property: normalizeText(row?.target_property),
    }))
    .filter((row) => row.source_key && row.target_property);

  if (!assignments.length) {
    return { updated: 0, assignments_applied: 0 };
  }

  const params = [];
  const objectParts = [];
  let idx = 1;
  for (const { source_key, target_property } of assignments) {
    params.push(target_property, source_key);
    objectParts.push(`$${idx}::text, NULLIF(data->>$${idx + 1}, '')`);
    idx += 2;
  }

  const where = [];
  if (nv) {
    const nvParsed = parseInt(nv, 10);
    if (!Number.isNaN(nvParsed)) {
      params.push(nvParsed);
      where.push(`nv = $${idx}`);
      idx += 1;
    }
  }

  // jsonb_strip_nulls: si el origen (ej. porton_type) no existe para esta fila,
  // NULLIF da null y la clave se elimina del objeto antes del merge, en vez de
  // pisar con null un valor que ya estaba bien puesto (ej. Sistema calculado
  // por otra via, como filas viejas que nunca pasaron por el Presupuestador).
  const sql = `
    UPDATE preproduccion_valores
    SET data = data || jsonb_strip_nulls(jsonb_build_object(${objectParts.join(', ')})),
        updated_at = now()
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    RETURNING nv
  `;

  const { rows } = await pool.query(sql, params);

  return { updated: rows.length, assignments_applied: assignments.length };
}

function listMeasurementSourceCatalog() {
  return MEASUREMENT_SOURCE_CATALOG;
}

function computeMeasurementMappedValues(measurementForm, mappings) {
  const out = {};
  const safeForm = measurementForm && typeof measurementForm === 'object' ? measurementForm : null;
  if (!safeForm) return out;

  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    if (!mapping?.is_active) continue;
    if (mapping?.source_section === PRODUCTION_SOURCE_SECTION) continue;
    if (mapping?.source_section === IPANEL_SOURCE_SECTION) continue;

    const targetProperty = normalizeText(mapping?.target_property);
    const sourcePath = normalizeText(mapping?.source_path);
    if (!targetProperty || !sourcePath) continue;

    const raw = getByPath(safeForm, sourcePath);
    const resolved = applyResolver(raw, mapping?.resolver);

    if (resolved === undefined || resolved === null || resolved === '') continue;
    out[targetProperty] = resolved;
  }

  return out;
}

module.exports = {
  SOURCE_APP,
  MEASUREMENT_SOURCE_CATALOG,
  BASE_PRODUCTION_SOURCE_PROPERTIES,
  PRODUCTION_SOURCE_SECTION,
  PRODUCTION_ASSIGNMENTS_TABLE,
  IPANEL_SOURCE_SECTION,
  IPANEL_ASSIGNMENTS_TABLE,
  ensureMeasurementMappingsTable,
  getMeasurementMappingsLastSyncAt,
  listMeasurementSourceCatalog,
  listMeasurementPropertyMappings,
  upsertMeasurementPropertyMapping,
  reapplyProductionPropertyAssignments,
  computeMeasurementMappedValues,
  applyResolver,
  getByPath,
  buildSectionSourceKey,
};
