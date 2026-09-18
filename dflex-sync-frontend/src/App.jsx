// src/App.jsx
import { useEffect, useMemo, useRef, useState } from 'react';
import TablePage from './pages/TablePage';
import FormulasPage from './pages/FormulasPage';
import ImportPage from './pages/ImportPage';
import PortonesPage from './pages/PortonesPage';
import IpanelsPage from './pages/IpanelsPage';
import TicketWidget from './components/TicketWidget';
import ViewPdf from './pages/ViewPdf';
import PdfLinkView from './pages/PdfLinkView';
import LoginPage from './pages/LoginPage.jsx';

import { useAuth } from './auth/AuthProvider.jsx';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

// ===== localStorage keys =====
const LS_CURRENT_PAGE = 'dflex.currentPage';
const LS_VISIBLE_COLUMNS = 'dflex.visibleColumns.v1';

// ===== helpers =====
function toStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function getPdfTipoFromLocation() {
  const { pathname, search } = window.location;

  let tipoFromPath = '';
  const m = pathname.match(/^\/pdfs\/([^/]+)\/?$/i);
  if (m && m[1]) tipoFromPath = toStr(m[1]).toLowerCase();

  const qs = new URLSearchParams(search);
  const tipoFromQuery = toStr(qs.get('pdf')).toLowerCase();

  return tipoFromPath || tipoFromQuery;
}

// Detecta si el usuario vino por link "directo" para generar/mostrar PDF
function isPdfLinkMode() {
  const { pathname, search } = window.location;
  const qs = new URLSearchParams(search);

  const tipo = getPdfTipoFromLocation();

  const hasTipoByQuery = (qs.get('pdf') || '').trim().length > 0;
  const hasTipoByPath = /^\/pdfs\/[^/]+\/?$/i.test(pathname);
  const hasNv = (qs.get('nv') || '').trim().length > 0;
  const hasFecha =
    (qs.get('inicio_prod_imput') || '').trim().length > 0 ||
    (qs.get('fecha') || '').trim().length > 0 ||
    (qs.get('fecha_envio_produccion') || '').trim().length > 0;

  // Para arm-primario requerimos NV
  if (tipo === 'arm-primario') {
    return (hasTipoByQuery || hasTipoByPath) && hasNv;
  }

  // Para el resto: requiere fecha
  return (hasTipoByQuery || hasTipoByPath) && hasFecha;
}

// ==== helpers de backend (ahora con token) ====
async function fetchPreProduccion(nv, accessToken) {
  const params = new URLSearchParams();
  if (nv) params.set('nv', nv);

  const qs = params.toString() ? `?${params.toString()}` : '';
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};

  const syncRes = await fetch(`${API_BASE_URL}/api/pre-produccion${qs}`, { headers });
  if (!syncRes.ok) {
    throw new Error(`Error HTTP ${syncRes.status}`);
  }
  const syncData = await syncRes.json();

  try {
    const valsRes = await fetch(`${API_BASE_URL}/api/pre-produccion-valores${qs}`, { headers });
    if (!valsRes.ok) throw new Error(`Error HTTP ${valsRes.status}`);
    const valsData = await valsRes.json();
    if (Array.isArray(valsData.rows)) return valsData;
  } catch (e) {
    console.warn('No se pudo leer pre-produccion-valores, uso SQL crudo:', e?.message || e);
  }

  return syncData;
}

async function fetchFormulasFromBackend(accessToken) {
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const res = await fetch(`${API_BASE_URL}/api/formulas`, { headers });
  if (!res.ok) throw new Error(`Error HTTP ${res.status}`);
  return res.json();
}


async function syncIpanelsOnEntry(accessToken) {
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    };

    const res = await fetch(`${API_BASE_URL}/api/sync/ipanel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: 10000 }),
    });

    if (!res.ok && res.status !== 207) {
      const txt = await res.text();
      console.warn('[ipanel] No se pudo sincronizar al entrar:', res.status, txt);
    }
  } catch (e) {
    console.warn('[ipanel] No se pudo sincronizar al entrar:', e?.message || e);
  }
}

async function saveFormulaToBackend(columnName, expression, accessToken) {
  const res = await fetch(`${API_BASE_URL}/api/formulas`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ column_name: columnName, expression }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

export default function App() {
  // App solo decide si es modo link público o app normal.
  // Este hook siempre se ejecuta igual.
  const linkMode = useMemo(() => isPdfLinkMode(), []);
  return linkMode ? <PdfLinkView /> : <AuthGate />;
}

function AuthGate() {
  // AuthGate SOLO maneja auth.
  // NOTA: ahora también lee postLoginDelay para mantener Login visible durante el delay.
  const { session, loading: authLoading, signOut, role, postLoginDelay } = useAuth();

  if (authLoading) {
    return (
      <div className="page">
        <div className="info">Cargando sesión…</div>
      </div>
    );
  }

  // Si Supabase ya dio sesión pero todavía estamos dentro del "postLoginDelay",
  // mantenemos el LoginPage en modo "success" (inputs verdes) y bloqueado.
  if (session && postLoginDelay) {
    return <LoginPage forceSuccess locked />;
  }

  if (!session) {
    return <LoginPage />;
  }

  return <MainApp session={session} signOut={signOut} role={role} />;
}

function MainApp({ session, signOut, role }) {
  const accessToken = session?.access_token || null;

  // authHeader (para componentes que lo usan directamente)
  const authHeader = useMemo(() => {
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  }, [accessToken]);

  // permissions calculadas desde role
  const canSyncOdoo = useMemo(() => {
    const r = String(role || 'viewer').trim().toLowerCase();
    return r === 'admin';
  }, [role]);

  const canSyncIpanel = useMemo(() => {
    const r = String(role || 'viewer').trim().toLowerCase();
    return r === 'admin';
  }, [role]);

  const permissions = useMemo(() => {
    const r = String(role || 'viewer').trim().toLowerCase();
    return {
      canEditFormulas: r === 'admin' || r === 'formula_editor',
      canEditData: r === 'admin' || r === 'data_editor',
    };
  }, [role]);

  // ===== current page (persistido) =====
  const [currentPage, setCurrentPage] = useState(() => {
    const saved = localStorage.getItem(LS_CURRENT_PAGE);
    return saved || 'tabla';
  });

  // ===== data =====
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // ===== formulas =====
  const [formulas, setFormulas] = useState({});
  const [formulaBackendError, setFormulaBackendError] = useState('');

  // ===== visible columns (persistido) =====
  const [visibleColumns, setVisibleColumns] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_VISIBLE_COLUMNS);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  });

  const nvInputRef = useRef(null);
  const formulaInputRefs = useRef({});

  useEffect(() => {
    localStorage.setItem(LS_CURRENT_PAGE, currentPage);
  }, [currentPage]);

  useEffect(() => {
    if (!visibleColumns) return;
    try {
      localStorage.setItem(LS_VISIBLE_COLUMNS, JSON.stringify(visibleColumns));
    } catch (e) {
      console.warn('No se pudo guardar visibleColumns en localStorage:', e);
    }
  }, [visibleColumns]);

  // al montar (ya hay sesión garantizada)
  useEffect(() => {
    loadData();
    loadFormulas();
    // Sincroniza ipanels desde SQL Server hacia Supabase cada vez que se entra al integrador.
    // La pantalla Ipanels igualmente muestra la data directa desde SQL.
    syncIpanelsOnEntry(accessToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  async function loadData(nv) {
    try {
      setLoading(true);
      setError('');
      const data = await fetchPreProduccion(nv, accessToken);
      setRows(data.rows || []);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Error cargando datos');
    } finally {
      setLoading(false);
    }
  }

  async function loadFormulas() {
    try {
      setFormulaBackendError('');
      const data = await fetchFormulasFromBackend(accessToken);
      const map = {};
      (data.formulas || []).forEach((f) => {
        map[f.column_name] = f.expression || '';
      });
      setFormulas(map);
    } catch (err) {
      console.error(err);
      setFormulaBackendError(err.message || 'Error cargando fórmulas guardadas');
    }
  }

  function handleSearch(e) {
    e.preventDefault();
    const nv = nvInputRef.current ? nvInputRef.current.value.trim() : '';
    loadData(nv || undefined);
  }

  const hasData = rows && rows.length > 0;

  const allColumns = useMemo(() => {
    const set = new Set();

    if (hasData) {
      Object.keys(rows[0] || {}).forEach((k) => set.add(k));
      (rows || []).forEach((r) => Object.keys(r || {}).forEach((k) => set.add(k)));
    }

    Object.keys(formulas || {}).forEach((k) => set.add(k));
    ['lado_mas_alto', 'calc_espada'].forEach((k) => set.add(k));

    // Columnas "solo app" (persisten en preproduccion_valores.data)
    ['Descripcion', 'Observaciones'].forEach((k) => set.add(k));

    return Array.from(set);
  }, [hasData, rows, formulas]);

  const columnsToShow = useMemo(() => {
    if (!visibleColumns || !Array.isArray(visibleColumns) || !visibleColumns.length) {
      return allColumns;
    }

    const allowed = new Set(allColumns);
    const filtered = visibleColumns.filter((c) => allowed.has(c));
    return filtered.length ? filtered : allColumns;
  }, [allColumns, visibleColumns]);

  const { compiledFormulas, formulaErrors } = useMemo(() => {
    const compiled = {};
    const errors = {};

    for (const [col, expr] of Object.entries(formulas)) {
      const trimmed = (expr || '').trim();
      if (!trimmed) continue;

      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(
          'row',
          `
            try {
              with (row) {
                return (${trimmed});
              }
            } catch (e) {
              return undefined;
            }
          `
        );
        compiled[col] = fn;
      } catch (e) {
        console.error(`Error compilando fórmula para ${col}:`, e);
        errors[col] = 'Error de sintaxis';
      }
    }

    return { compiledFormulas: compiled, formulaErrors: errors };
  }, [formulas]);

  function getDisplayValue(row, targetCol) {
    const cache = {};
    const visiting = new Set();

    function evalCol(col) {
      if (Object.prototype.hasOwnProperty.call(cache, col)) return cache[col];

      if (visiting.has(col)) {
        return row[col];
      }
      visiting.add(col);

      const raw = row[col];
      const fn = compiledFormulas[col];

      if (!fn) {
        cache[col] = raw;
        visiting.delete(col);
        return raw;
      }

      const proxyRow = new Proxy(row, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && (Object.prototype.hasOwnProperty.call(target, prop) || compiledFormulas[prop])) {
            return evalCol(prop);
          }
          return Reflect.get(target, prop, receiver);
        },
        has(target, prop) {
          if (typeof prop === 'string' && (Object.prototype.hasOwnProperty.call(target, prop) || compiledFormulas[prop])) {
            return true;
          }
          return Reflect.has(target, prop);
        },
      });

      let result;
      try {
        result = fn(proxyRow);
      } catch (e) {
        console.error(`Error evaluando fórmula para ${col}:`, e);
        result = raw;
      }

      visiting.delete(col);
      cache[col] = result;
      return result;
    }

    const result = evalCol(targetCol);

    if (result === undefined || result === null || Number.isNaN(result)) {
      const raw = row[targetCol];
      if (raw === undefined || raw === null) return '';
      return String(raw);
    }

    return String(result);
  }

  function handleFormulaKeyDown(e, col) {
    if (e.key !== 'Enter') return;
    e.preventDefault();

    const inputEl = formulaInputRefs.current[col];
    const draft = inputEl ? inputEl.value.trim() : '';
    const prev = (formulas[col] || '').trim();

    if (!draft && !prev) return;

    if (draft === prev) {
      window.alert('La fórmula nueva es igual a la actual.');
      return;
    }

    const msg = prev
      ? `La columna "${col}" ya tiene esta fórmula:\n\n${prev}\n\n¿Querés reemplazarla por?\n\n${draft || '(sin fórmula, usar valor original)'}`
      : `¿Querés aplicar esta fórmula a la columna "${col}"?\n\n${draft || '(sin fórmula, usar valor original)'}`;

    const ok = window.confirm(msg);
    if (!ok) {
      if (inputEl) inputEl.value = prev;
      return;
    }

    setFormulas((current) => ({ ...current, [col]: draft }));

    saveFormulaToBackend(col, draft, accessToken).catch((err) => {
      console.error('Error guardando fórmula en backend:', err);
      window.alert('Error guardando la fórmula:\n' + (err.message || String(err)));
    });
  }

  function handleChangeVisibleColumns(nextCols) {
    if (!Array.isArray(nextCols)) return;
    setVisibleColumns(nextCols);
  }

  function handleResetVisibleColumns() {
    setVisibleColumns(null);
    try {
      localStorage.removeItem(LS_VISIBLE_COLUMNS);
    } catch (e) {
      console.warn('No se pudo borrar visibleColumns de localStorage:', e);
    }
  }

  async function saveTableChanges(changesByRow) {
    const updates = [];

    Object.entries(changesByRow).forEach(([rowKey, cols]) => {
      if (!cols || !Object.keys(cols).length) return;

      let nvValue = null;

      if (rowKey.startsWith('ID:')) {
        const idPart = rowKey.slice(3);
        const row = rows.find((r) => String(r.ID) === idPart);
        if (row && row.NV !== null && row.NV !== undefined) nvValue = row.NV;
      } else {
        const parsed = parseInt(rowKey, 10);
        if (!Number.isNaN(parsed)) nvValue = parsed;
      }

      if (nvValue === null || nvValue === undefined) return;

      updates.push({ nv: nvValue, changes: cols });
    });

    if (!updates.length) return;

    const res = await fetch(`${API_BASE_URL}/api/pre-produccion-valores/bulk-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ updates }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <nav className="nav">
            <button
              type="button"
              className={currentPage === 'tabla' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setCurrentPage('tabla')}
            >
              Tabla Pre-Producción
            </button>

            <button
              type="button"
              className={currentPage === 'formulas' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setCurrentPage('formulas')}
            >
              Fórmulas
            </button>

            <button
              type="button"
              className={currentPage === 'pdf' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setCurrentPage('pdf')}
            >
              PDFs (por fecha / NV)
            </button>

            <button
              type="button"
              className={currentPage === 'import' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setCurrentPage('import')}
            >
              Importar Excel
            </button>

            <button
              type="button"
              className={currentPage === 'portones' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setCurrentPage('portones')}
            >
              Portones (Enviar a Odoo)
            </button>

            <button
              type="button"
              className={currentPage === 'ipanels' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setCurrentPage('ipanels')}
            >
              Ipanels
            </button>

          </nav>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TicketWidget authHeader={authHeader} />
            <button type="button" className="btn-secondary" onClick={() => signOut()}>
              Cerrar sesión
            </button>
          </div>
        </div>

        {currentPage === 'tabla' && (
          <form className="search-form" onSubmit={handleSearch}>
            <label>
              NV:&nbsp;
              <input type="text" ref={nvInputRef} placeholder="Ej: 1019" />
            </label>
            <button type="submit" disabled={loading}>
              {loading ? 'Buscando...' : 'Buscar'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (nvInputRef.current) nvInputRef.current.value = '';
                loadData();
              }}
              disabled={loading}
            >
              Limpiar
            </button>

            <button
              type="button"
              onClick={handleResetVisibleColumns}
              disabled={loading}
              title="Vuelve a mostrar todas las columnas"
            >
              Ver todas las columnas
            </button>
          </form>
        )}

        {formulaBackendError && <div className="error">⚠ {formulaBackendError}</div>}
      </header>

      {error && <div className="error">⚠ {error}</div>}

      {currentPage === 'tabla' && (
        <TablePage
          rows={rows}
          columns={columnsToShow}
          hasData={hasData}
          loading={loading}
          formulas={formulas}
          formulaErrors={formulaErrors}
          formulaInputRefs={formulaInputRefs}
          handleFormulaKeyDown={handleFormulaKeyDown}
          getDisplayValue={getDisplayValue}
          onSaveChanges={saveTableChanges}
          permissions={permissions}
          authHeader={authHeader}
        />
      )}

      {currentPage === 'formulas' && (
        <FormulasPage
          hasData={hasData}
          columns={allColumns}
          formulas={formulas}
          permissions={permissions}
          authHeader={authHeader}
        />
      )}

      {currentPage === 'import' && <ImportPage rows={rows} columns={allColumns} authHeader={authHeader} />}

      {currentPage === 'pdf' && <ViewPdf />}

      {currentPage === 'portones' && (
        <PortonesPage authHeader={authHeader} canSyncOdoo={canSyncOdoo} />
      )}

      {currentPage === 'ipanels' && (
        <IpanelsPage authHeader={authHeader} canSyncIpanel={canSyncIpanel} />
      )}

    </div>
  );
}
