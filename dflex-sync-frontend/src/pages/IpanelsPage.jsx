// src/pages/IpanelsPage.jsx
import { useEffect, useMemo, useState } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const SIMPLE_OPTIONS = ['', 'MADERA', 'ALUMINIO', 'PINTURA', 'OTRO'];
const IPANEL_SOURCE_SECTION = 'nota_venta_inv';

const DEFAULT_IPANEL_TARGET_PROPERTIES = [
  'Nombre', 'RazSoc', 'nombre', 'direccion', 'localidad',
  'descripcion', 'observaciones', 'fecha_plan_entrega', 'DescripcionSimple',
];

const IPANEL_SOURCE_PROPERTIES = [
  { source_key: 'nv', label: 'NV', group: 'Referencias', description: 'Número de nota de venta.' },
  { source_key: 'referencia_nv', label: 'Referencia NV', group: 'Referencias', description: 'Texto completo, ej: INV4248.' },
  { source_key: 'quote_number', label: 'Número interno presupuesto', group: 'Referencias', description: 'Número interno del presupuestador.' },
  { source_key: 'fecha_nv', label: 'Fecha NV', group: 'Fechas', description: 'Fecha de la NV.' },
  { source_key: 'fecha_confirmacion', label: 'Fecha confirmación', group: 'Fechas', description: 'Fecha en la que se confirmó el presupuesto.' },
  { source_key: 'catalog_kind', label: 'Tipo de catálogo', group: 'General', description: 'porton / ipanel / otros.' },
  { source_key: 'payment_method', label: 'Forma de pago', group: 'General', description: 'Forma de pago del presupuesto.' },
  { source_key: 'cliente_nombre', label: 'Cliente nombre', group: 'Cliente', description: 'Nombre del cliente final.' },
  { source_key: 'cliente_apellido', label: 'Cliente apellido', group: 'Cliente', description: 'Apellido del cliente final.' },
  { source_key: 'cliente_nombre_completo', label: 'Cliente nombre completo', group: 'Cliente', description: 'Nombre y apellido del cliente final.' },
  { source_key: 'cliente_telefono', label: 'Cliente teléfono', group: 'Cliente', description: 'Teléfono del cliente final.' },
  { source_key: 'cliente_email', label: 'Cliente email', group: 'Cliente', description: 'Email del cliente final.' },
  { source_key: 'cliente_direccion', label: 'Cliente dirección', group: 'Cliente', description: 'Dirección del cliente final.' },
  { source_key: 'cliente_localidad', label: 'Cliente localidad', group: 'Cliente', description: 'Ciudad / localidad del cliente final.' },
  { source_key: 'vendido_por_nombre', label: 'Vendido por nombre', group: 'Venta', description: 'Nombre del usuario que realizó la venta.' },
  { source_key: 'vendedor_nombre', label: 'Vendedor nombre', group: 'Venta', description: 'Nombre del vendedor.' },
  { source_key: 'distribuidor_nombre', label: 'Distribuidor nombre', group: 'Venta', description: 'Nombre del distribuidor.' },
  { source_key: 'final_amount_to_charge', label: 'Importe final', group: 'Métricas', description: 'Monto final de la NV.' },
];

function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function formatDate(v) {
  const raw = toStr(v);
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 10);
  return d.toLocaleDateString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatDateTime(v) {
  const raw = toStr(v);
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function getProductoDescripcion(row) {
  return toStr(row?.producto_descripcion ?? row?.producto_descripciones ?? row?.descripcion_producto ?? row?.descripcion);
}

function getDescripcionSimple(row) {
  return toStr(row?.DescripcionSimple ?? row?.descripcion_simple);
}

function joinObs(row) {
  const parts = [];
  const observ = toStr(row?.observ);
  const obs = toStr(row?.obs);
  const oc = toStr(row?.oc);
  const idpedido = toStr(row?.idpedido);
  const producto = getProductoDescripcion(row);
  if (producto) parts.push(`Producto: ${producto}`);
  if (observ) parts.push(`Observ: ${observ}`);
  if (obs) parts.push(`Obs: ${obs}`);
  if (oc) parts.push(`OC: ${oc}`);
  if (idpedido) parts.push(`ID pedido: ${idpedido}`);
  return parts.join('\n');
}

function SimpleBadge({ value }) {
  const v = toStr(value);
  if (!v) return <span style={{ opacity: 0.45, fontSize: 11 }}>—</span>;
  return (
    <span style={{ padding: '2px 8px', borderRadius: 999, background: '#e0f2fe', color: '#075985', fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }}>
      {v}
    </span>
  );
}

function SourceBadge() {
  return (
    <span style={{ padding: '2px 8px', borderRadius: 999, background: '#f0fdf4', color: '#15803d', fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap' }}>
      Presupuestador
    </span>
  );
}

export default function IpanelsPage({ authHeader, canSyncIpanel }) {
  const headers = useMemo(() => authHeader || {}, [authHeader]);

  // SQL tab state
  const [activeTab, setActiveTab] = useState('sql');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [syncResult, setSyncResult] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [schemaSyncAt, setSchemaSyncAt] = useState(null);
  const [filter, setFilter] = useState('');
  const [showSimplePanel, setShowSimplePanel] = useState(false);
  const [catalogRows, setCatalogRows] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [simpleDrafts, setSimpleDrafts] = useState({});
  const [savingMappingKey, setSavingMappingKey] = useState('');

  // Presupuestador tab state
  const [presRows, setPresRows] = useState([]);
  const [presLoading, setPresLoading] = useState(false);
  const [presError, setPresError] = useState('');
  const [presFilter, setPresFilter] = useState('');

  // Assignment panel state
  const [showAssignPanel, setShowAssignPanel] = useState(false);
  const [assignmentDrafts, setAssignmentDrafts] = useState({});
  const [savedAssignments, setSavedAssignments] = useState({});
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignError, setAssignError] = useState('');
  const [savingKey, setSavingKey] = useState('');
  const [assignFilter, setAssignFilter] = useState('');

  function buildParams(extra = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(extra.limit || 1000));
    const f = toStr(extra.filter ?? filter);
    if (f) { params.set('partida', f); params.set('nv', f); }
    return params;
  }

  // Última corrida del cron de estructura de tablas (08:30 / 17:30)
  async function loadSchemaLastSync() {
    try {
      const res = await fetch(`${API_BASE_URL}/api/property-mappings/last-sync`, { headers });
      if (!res.ok) return;
      const data = await res.json();
      setSchemaSyncAt(data?.lastSyncAt || null);
    } catch (e) { console.warn('No se pudo leer ultima sync de estructura:', e?.message); }
  }

  // SQL tab loaders
  async function loadLastSync() {
    try {
      const res = await fetch(`${API_BASE_URL}/api/ipanel/last-sync`, { headers });
      if (!res.ok) return;
      const data = await res.json();
      setLastSyncAt(data?.lastSyncAt || null);
    } catch (e) { console.warn('No se pudo leer ultima sync:', e?.message); }
  }

  async function loadIpanelsFromSql(nextFilter = filter) {
    try {
      setLoading(true); setError('');
      const qs = buildParams({ filter: nextFilter }).toString();
      const res = await fetch(`${API_BASE_URL}/api/ipanel?${qs}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      setRows(Array.isArray(data.rows) ? data.rows : []);
      await loadLastSync();
    } catch (e) { console.error(e); setError(e.message || 'Error cargando ipanels desde SQL'); }
    finally { setLoading(false); }
  }

  async function loadDescripcionCatalog() {
    try {
      setCatalogLoading(true); setCatalogError('');
      const res = await fetch(`${API_BASE_URL}/api/ipanel/descripcion-simple/catalog?limit=10000`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const arr = Array.isArray(data.rows) ? data.rows : [];
      setCatalogRows(arr);
      const drafts = {};
      for (const r of arr) drafts[r.descripcion] = toStr(r.descripcion_simple);
      setSimpleDrafts(drafts);
    } catch (e) { console.error(e); setCatalogError(e.message || 'Error cargando catálogo DescripcionSimple'); }
    finally { setCatalogLoading(false); }
  }

  async function saveDescripcionSimple(descripcion) {
    const desc = toStr(descripcion);
    if (!desc) return;
    try {
      setSavingMappingKey(desc); setCatalogError('');
      const value = toStr(simpleDrafts[desc]);
      const res = await fetch(`${API_BASE_URL}/api/ipanel/descripcion-simple/mapping`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ descripcion: desc, descripcion_simple: value || null }),
      });
      const text = await res.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
      if (!res.ok) throw new Error(payload?.details || payload?.error || text || `HTTP ${res.status}`);
      await loadDescripcionCatalog();
      await loadIpanelsFromSql(filter.trim());
    } catch (e) { console.error(e); setCatalogError(e.message || 'Error guardando DescripcionSimple'); }
    finally { setSavingMappingKey(''); }
  }

  async function syncIpanels({ ask = true, nextFilter = filter } = {}) {
    const f = toStr(nextFilter);
    if (ask && !canSyncIpanel) { window.alert('No tenes permisos para sincronizar ipanels (solo admin).'); return null; }
    if (ask) {
      const msg = f ? `Sincronizar ipanel ${f} desde SQL Server?` : 'Sincronizar ipanels desde SQL Server hacia Supabase?';
      if (!window.confirm(msg)) return null;
    }
    try {
      setSyncing(true); setError(''); setSyncResult(null);
      const body = { limit: 10000 };
      if (f) { body.partida = f; body.nv = f; }
      const res = await fetch(`${API_BASE_URL}/api/sync/ipanel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
      });
      const payloadText = await res.text();
      let payload = null;
      try { payload = payloadText ? JSON.parse(payloadText) : null; } catch { payload = { raw: payloadText }; }
      if (!res.ok && res.status !== 207) throw new Error(payload?.error || payload?.details || payloadText || `HTTP ${res.status}`);
      setSyncResult(payload || {});
      await loadLastSync();
      return payload || {};
    } catch (e) { console.error(e); setError(e.message || 'Error sincronizando ipanels'); return null; }
    finally { setSyncing(false); }
  }

  // Presupuestador tab loaders
  async function loadPresupuestadorRows() {
    try {
      setPresLoading(true); setPresError('');
      const res = await fetch(`${API_BASE_URL}/api/ipanel/presupuestador`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      setPresRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (e) { console.error(e); setPresError(e.message || 'Error cargando INV del Presupuestador'); }
    finally { setPresLoading(false); }
  }

  async function loadAssignments() {
    try {
      setAssignLoading(true); setAssignError('');
      const res = await fetch(`${API_BASE_URL}/api/property-mappings`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const all = Array.isArray(data.mappings) ? data.mappings : [];
      const inv = all.filter((m) => m?.source_section === IPANEL_SOURCE_SECTION);
      const saved = {};
      for (const m of inv) {
        const k = toStr(m.source_key || m.source_path);
        if (k) saved[k] = { target_property: toStr(m.target_property), is_active: m.is_active !== false };
      }
      setSavedAssignments(saved);
      setAssignmentDrafts((prev) => {
        const merged = { ...prev };
        for (const [k, v] of Object.entries(saved)) {
          if (!merged[k]) merged[k] = { ...v };
        }
        return merged;
      });
    } catch (e) { console.error(e); setAssignError(e.message || 'Error cargando asignaciones INV'); }
    finally { setAssignLoading(false); }
  }

  function setDraft(sourceKey, patch) {
    setAssignmentDrafts((prev) => ({
      ...prev,
      [sourceKey]: { target_property: '', is_active: true, ...(prev[sourceKey] || {}), ...patch },
    }));
  }

  async function saveAssignment(sourceKey) {
    if (!canSyncIpanel) { window.alert('No tenes permisos para editar asignaciones.'); return; }
    const draft = assignmentDrafts[sourceKey] || { target_property: '', is_active: true };
    const sourceMeta = IPANEL_SOURCE_PROPERTIES.find((p) => p.source_key === sourceKey) || {};
    const ok = window.confirm(
      `Guardar asignación INV?\n\nPropiedad presupuestador: ${sourceKey}\nPropiedad ipanel: ${draft.target_property || '(sin asignar)'}\nActivo: ${draft.is_active !== false ? 'Sí' : 'No'}`
    );
    if (!ok) return;
    setSavingKey(sourceKey); setAssignError('');
    try {
      const res = await fetch(`${API_BASE_URL}/api/property-mappings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          source_app: 'presupuestador',
          source_section: IPANEL_SOURCE_SECTION,
          source_path: sourceKey,
          source_key: sourceKey,
          source_label: sourceMeta.label || sourceKey,
          target_property: draft.target_property || '',
          resolver: 'identity',
          is_active: draft.is_active !== false,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      await loadAssignments();
    } catch (e) { console.error(e); setAssignError(e.message || 'Error guardando asignación'); }
    finally { setSavingKey(''); }
  }

  const targetProperties = useMemo(() => {
    const set = new Set(DEFAULT_IPANEL_TARGET_PROPERTIES);
    for (const v of Object.values(savedAssignments)) {
      if (v?.target_property) set.add(v.target_property);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [savedAssignments]);

  const filteredPresRows = useMemo(() => {
    const f = presFilter.trim().toLowerCase();
    if (!f) return presRows;
    return presRows.filter((r) =>
      String(r?.nv ?? '').includes(f) ||
      toStr(r?.Nombre || r?.nombre).toLowerCase().includes(f) ||
      toStr(r?.cliente_nombre_completo).toLowerCase().includes(f) ||
      toStr(r?.descripcion).toLowerCase().includes(f)
    );
  }, [presRows, presFilter]);

  const filteredAssignProps = useMemo(() => {
    const f = assignFilter.trim().toLowerCase();
    if (!f) return IPANEL_SOURCE_PROPERTIES;
    return IPANEL_SOURCE_PROPERTIES.filter((p) =>
      p.label.toLowerCase().includes(f) ||
      p.source_key.toLowerCase().includes(f) ||
      p.group.toLowerCase().includes(f) ||
      (assignmentDrafts[p.source_key]?.target_property || '').toLowerCase().includes(f)
    );
  }, [assignFilter, assignmentDrafts]);

  const assignByGroup = useMemo(() => {
    const map = new Map();
    for (const p of filteredAssignProps) {
      if (!map.has(p.group)) map.set(p.group, []);
      map.get(p.group).push(p);
    }
    return map;
  }, [filteredAssignProps]);

  // Effects
  useEffect(() => { loadIpanelsFromSql(''); }, []);
  useEffect(() => { loadSchemaLastSync(); }, []);
  useEffect(() => { if (showSimplePanel) loadDescripcionCatalog(); }, [showSimplePanel]);
  useEffect(() => {
    if (activeTab === 'presupuestador') { loadPresupuestadorRows(); loadAssignments(); }
  }, [activeTab]);

  async function handleSearch(e) { e.preventDefault(); await loadIpanelsFromSql(filter.trim()); }
  async function handleSync() {
    const result = await syncIpanels({ ask: true, nextFilter: filter });
    if (result) await loadIpanelsFromSql(filter.trim());
  }

  return (
    <div className="content">

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`nav-btn${activeTab === 'sql' ? ' active' : ''}`} onClick={() => setActiveTab('sql')}>
          SQL Server
        </button>
        <button className={`nav-btn${activeTab === 'presupuestador' ? ' active' : ''}`} onClick={() => setActiveTab('presupuestador')}>
          Presupuestador (INV)
        </button>
        {schemaSyncAt
          ? <span className="info" style={{ marginLeft: 'auto' }}>Última sincronización de estructura: {formatDateTime(schemaSyncAt)}</span>
          : <span className="info" style={{ marginLeft: 'auto' }}>Sin sincronización de estructura registrada</span>}
      </div>

      {/* ───────────── TAB SQL SERVER ───────────── */}
      {activeTab === 'sql' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
              <div>
                <div className="hint" style={{ marginBottom: 4 }}>Filtrar por partida / NV</div>
                <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Ej: 100512" style={{ minWidth: 180 }} />
              </div>
              <button type="submit" disabled={loading || syncing}>{loading ? 'Cargando...' : 'Buscar'}</button>
              <button type="button" className="btn-secondary" onClick={() => { setFilter(''); setSyncResult(null); loadIpanelsFromSql(''); }} disabled={loading || syncing}>
                Limpiar
              </button>
            </form>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {lastSyncAt
                ? <span className="info">Última sync: {formatDateTime(lastSyncAt)}</span>
                : <span className="info">Sin sync registrada</span>}
              <button type="button" className="btn-secondary" onClick={() => setShowSimplePanel((v) => !v)} disabled={loading || syncing}>
                {showSimplePanel ? 'Ocultar DescripcionSimple' : 'Configurar DescripcionSimple'}
              </button>
              <button type="button" onClick={handleSync} disabled={!canSyncIpanel || loading || syncing}>
                {syncing ? 'Sincronizando...' : 'Sincronizar ipanels'}
              </button>
            </div>
          </div>

          <p className="info" style={{ marginTop: 8 }}>
            Listado directo desde <strong>Paneles.dbo.NTASVTAS</strong>. Incluye descripción de productos y mapeo a DescripcionSimple.
          </p>
          {!canSyncIpanel && <p className="info">Solo admin puede sincronizar y guardar mapeos.</p>}

          {showSimplePanel && (
            <div className="formulas-panel" style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
                <div>
                  <h2 style={{ margin: 0 }}>Mapeo de descripción a DescripcionSimple</h2>
                  <p className="hint" style={{ margin: '4px 0 0' }}>
                    Definí qué valores de descripción se guardan como MADERA, ALUMINIO, etc. Se aplica en la sincronización.
                  </p>
                </div>
                <button type="button" className="btn-secondary" onClick={loadDescripcionCatalog} disabled={catalogLoading || syncing}>
                  {catalogLoading ? 'Actualizando...' : 'Actualizar lista'}
                </button>
              </div>
              {catalogError && <div className="error">⚠ {catalogError}</div>}
              <div className="table-wrapper" style={{ maxHeight: 380 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Descripción</th>
                      <th style={{ width: 70 }}>Cant.</th>
                      <th style={{ width: 160 }}>DescripcionSimple</th>
                      <th style={{ width: 90 }}>Guardar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(catalogRows || []).map((r) => {
                      const desc = toStr(r.descripcion);
                      const value = Object.prototype.hasOwnProperty.call(simpleDrafts, desc)
                        ? simpleDrafts[desc]
                        : toStr(r.descripcion_simple);
                      return (
                        <tr key={desc}>
                          <td style={{ whiteSpace: 'pre-wrap' }}>{desc}</td>
                          <td>{r.count ?? ''}</td>
                          <td>
                            <select
                              value={value || ''}
                              onChange={(e) => setSimpleDrafts((prev) => ({ ...prev, [desc]: e.target.value }))}
                              disabled={!canSyncIpanel || savingMappingKey === desc}
                            >
                              {SIMPLE_OPTIONS.map((opt) => (
                                <option key={opt || 'blank'} value={opt}>{opt || '(sin asignar)'}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <button className="btn-small" type="button" onClick={() => saveDescripcionSimple(desc)} disabled={!canSyncIpanel || savingMappingKey === desc}>
                              {savingMappingKey === desc ? '...' : 'Guardar'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {!catalogLoading && !catalogRows.length && (
                      <tr><td colSpan={4} style={{ padding: 16, textAlign: 'center', opacity: 0.6 }}>No hay descripciones para mapear.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {syncResult && (
            <div className="info" style={{ marginBottom: 8 }}>
              Sync: SQL {syncResult.totalSqlRows ?? 0} filas — importados {syncResult.imported ?? 0} (nuevos {syncResult.inserted ?? 0}, actualizados {syncResult.updated ?? 0}, omitidos {syncResult.skipped ?? 0}
              {syncResult.skippedBlocked ? `, bloqueados ${syncResult.skippedBlocked}` : ''}
              {syncResult.deletedBlocked ? `, eliminados bloqueados ${syncResult.deletedBlocked}` : ''}
              {Array.isArray(syncResult.errors) && syncResult.errors.length ? `, errores ${syncResult.errors.length}` : ''}).
            </div>
          )}

          {error && <div className="error">⚠ {error}</div>}

          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fecha</th><th>Tipo</th><th>Sucursal</th><th>Número / Partida</th>
                  <th>Depósito</th><th>Producto / descripción</th><th>DescripcionSimple</th>
                  <th>Bloq.</th><th>Cliente</th><th>Nombre</th><th>Dirección</th>
                  <th>Localidad</th><th>Provincia</th><th>Fecha entrega</th><th>F. pago</th>
                  <th>Vendedor</th><th>Operador</th><th>OC</th><th>ID pedido</th>
                  <th>Factura</th><th>Remito</th><th>Observaciones</th>
                </tr>
              </thead>
              <tbody>
                {(rows || []).map((r, idx) => {
                  const key = r?.idpedido ? `ip-${r.idpedido}` : `r-${idx}`;
                  const obs = joinObs(r) || toStr(r?.observaciones);
                  const prod = getProductoDescripcion(r);
                  return (
                    <tr key={key}>
                      <td>{formatDate(r?.fecha)}</td>
                      <td>{toStr(r?.tipo)}</td>
                      <td>{toStr(r?.sucursal)}</td>
                      <td>{toStr(r?.numero ?? r?.partida)}</td>
                      <td>{toStr(r?.deposito)}</td>
                      <td title={prod} style={{ minWidth: 180, maxWidth: 260, maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prod}</td>
                      <td><SimpleBadge value={getDescripcionSimple(r)} /></td>
                      <td>{r?.bloqueado_preproduccion ? <span style={{ color: '#991b1b', fontWeight: 700 }}>Sí</span> : ''}</td>
                      <td>{toStr(r?.cliente)}</td>
                      <td>{toStr(r?.nombre)}</td>
                      <td>{toStr(r?.direccion)}</td>
                      <td>{toStr(r?.localidad)}</td>
                      <td>{toStr(r?.provincia)}</td>
                      <td>{formatDate(r?.fechaent ?? r?.fecha_plan_entrega)}</td>
                      <td>{toStr(r?.fpago)}</td>
                      <td>{toStr(r?.vendedor)}</td>
                      <td>{toStr(r?.operador)}</td>
                      <td>{toStr(r?.oc)}</td>
                      <td>{toStr(r?.idpedido)}</td>
                      <td>{toStr(r?.factura)}</td>
                      <td>{toStr(r?.remito)}</td>
                      <td title={obs} style={{ minWidth: 160, maxWidth: 240, maxHeight: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{obs}</td>
                    </tr>
                  );
                })}
                {!loading && !rows.length && (
                  <tr><td colSpan={22} style={{ padding: 20, textAlign: 'center', opacity: 0.6 }}>No hay ipanels para mostrar desde SQL.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ───────────── TAB PRESUPUESTADOR ───────────── */}
      {activeTab === 'presupuestador' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'end', flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'end' }}>
              <div>
                <div className="hint" style={{ marginBottom: 4 }}>Filtrar</div>
                <input
                  type="text"
                  value={presFilter}
                  onChange={(e) => setPresFilter(e.target.value)}
                  placeholder="NV, nombre, descripción..."
                  style={{ minWidth: 220 }}
                />
              </div>
              <button type="button" className="btn-secondary" onClick={() => setPresFilter('')}>Limpiar</button>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn-secondary" onClick={loadPresupuestadorRows} disabled={presLoading}>
                {presLoading ? 'Actualizando...' : 'Actualizar'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowAssignPanel((v) => !v)}
                style={showAssignPanel ? { background: '#dbeafe', borderColor: '#93c5fd' } : {}}
              >
                {showAssignPanel ? 'Ocultar asignador' : 'Configurar asignaciones'}
              </button>
            </div>
          </div>

          <p className="info">
            INV generados desde el Presupuestador, guardados en <strong>preproduccion_valores_ipanels</strong>.
            Las columnas visibles dependen de las asignaciones configuradas abajo.
          </p>

          {presError && <div className="error">⚠ {presError}</div>}

          <div className="table-wrapper" style={{ marginBottom: 20 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 65 }}>NV</th>
                  <th>Nombre</th>
                  <th>RazSoc / Distribuidor</th>
                  <th>Dirección</th>
                  <th>Localidad</th>
                  <th>Descripción</th>
                  <th style={{ width: 110 }}>DescripcionSimple</th>
                  <th style={{ width: 95 }}>Fecha NV</th>
                  <th style={{ width: 100 }}>Fecha entrega</th>
                  <th style={{ width: 105 }}>Origen</th>
                  <th style={{ width: 125 }}>Actualizado</th>
                </tr>
              </thead>
              <tbody>
                {filteredPresRows.map((r, idx) => {
                  const key = r?._id ?? `pr-${idx}`;
                  const nombre = toStr(r?.Nombre || r?.nombre || r?.cliente_nombre_completo);
                  const razsoc = toStr(r?.RazSoc || r?.distribuidor_nombre || r?.vendedor_nombre);
                  const direccion = toStr(r?.direccion || r?.cliente_direccion);
                  const localidad = toStr(r?.localidad || r?.cliente_localidad);
                  const desc = toStr(r?.descripcion || r?.producto_descripcion);
                  return (
                    <tr key={key}>
                      <td style={{ fontWeight: 700 }}>{toStr(r?.nv ?? r?.partida)}</td>
                      <td>{nombre}</td>
                      <td>{razsoc}</td>
                      <td>{direccion}</td>
                      <td>{localidad}</td>
                      <td title={desc} style={{ maxWidth: 300, whiteSpace: 'pre-wrap' }}>{desc}</td>
                      <td><SimpleBadge value={getDescripcionSimple(r)} /></td>
                      <td>{formatDate(r?.fecha_nv)}</td>
                      <td>{formatDate(r?.fecha_plan_entrega)}</td>
                      <td><SourceBadge /></td>
                      <td style={{ fontSize: 11, color: 'var(--color-text-2, #475569)' }}>{formatDateTime(r?.updated_at)}</td>
                    </tr>
                  );
                })}
                {!presLoading && !filteredPresRows.length && (
                  <tr>
                    <td colSpan={11} style={{ padding: 20, textAlign: 'center', opacity: 0.6 }}>
                      {presRows.length ? 'Sin resultados para el filtro.' : 'No hay INV del Presupuestador todavía.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Assignment panel */}
          {showAssignPanel && (
            <div className="formulas-panel">
              <h2>Asignador de propiedades desde INV (Presupuestador)</h2>
              <p className="hint">
                Definí qué campos del presupuesto se copian a las propiedades de cada fila INV al guardar en Supabase.
                Funciona igual que el asignador de portones pero aplica solo a <strong>preproduccion_valores_ipanels</strong>.
              </p>

              {assignError && <div className="error" style={{ marginBottom: 8 }}>⚠ {assignError}</div>}

              <div className="field-row" style={{ marginBottom: 12 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                  Buscar propiedad origen
                  <input
                    type="text"
                    value={assignFilter}
                    onChange={(e) => setAssignFilter(e.target.value)}
                    placeholder="Nombre, grupo, source_key, propiedad destino..."
                    style={{ minWidth: 340 }}
                  />
                </label>
                {assignLoading && <span className="hint" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>Cargando...</span>}
              </div>

              <div className="table-wrapper" style={{ maxHeight: '55vh' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 105 }}>Grupo</th>
                      <th style={{ minWidth: 200 }}>Propiedad presupuestador</th>
                      <th>Descripción</th>
                      <th style={{ width: 200 }}>Propiedad ipanel destino</th>
                      <th style={{ width: 65 }}>Activo</th>
                      <th style={{ width: 90 }}>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(assignByGroup.entries()).flatMap(([group, props]) => [
                      <tr key={`g-${group}`}>
                        <td
                          colSpan={6}
                          style={{
                            fontWeight: 700, fontSize: 11, letterSpacing: '0.06em',
                            color: '#475569', background: '#f1f5f9',
                            padding: '6px 10px', textTransform: 'uppercase',
                          }}
                        >
                          {group}
                        </td>
                      </tr>,
                      ...props.map((item) => {
                        const draft = assignmentDrafts[item.source_key] || { target_property: '', is_active: true };
                        const saved = savedAssignments[item.source_key];
                        const hasChange = !saved || saved.target_property !== draft.target_property || saved.is_active !== (draft.is_active !== false);
                        return (
                          <tr key={item.source_key}>
                            <td />
                            <td>
                              <div style={{ fontWeight: 600, fontSize: 13 }}>{item.label}</div>
                              <div className="hint">{item.source_key}</div>
                            </td>
                            <td>
                              <div className="hint" style={{ whiteSpace: 'normal' }}>{item.description}</div>
                            </td>
                            <td>
                              <select
                                value={draft.target_property || ''}
                                onChange={(e) => setDraft(item.source_key, { target_property: e.target.value })}
                                disabled={!canSyncIpanel || savingKey === item.source_key}
                                style={{ width: '100%', fontSize: 12 }}
                              >
                                <option value="">Sin asignar</option>
                                {targetProperties.map((t) => (
                                  <option key={t} value={t}>{t}</option>
                                ))}
                              </select>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <input
                                type="checkbox"
                                checked={draft.is_active !== false}
                                onChange={(e) => setDraft(item.source_key, { is_active: e.target.checked })}
                                disabled={!canSyncIpanel || savingKey === item.source_key}
                              />
                            </td>
                            <td>
                              <button
                                className="btn-small"
                                type="button"
                                onClick={() => saveAssignment(item.source_key)}
                                disabled={!canSyncIpanel || savingKey === item.source_key}
                                style={hasChange && draft.target_property ? { background: '#dbeafe', borderColor: '#93c5fd', fontWeight: 600 } : {}}
                              >
                                {savingKey === item.source_key ? '...' : 'Guardar'}
                              </button>
                            </td>
                          </tr>
                        );
                      }),
                    ])}
                    {!filteredAssignProps.length && (
                      <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', opacity: 0.6 }}>Sin resultados.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
