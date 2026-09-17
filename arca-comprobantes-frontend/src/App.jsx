import { useEffect, useMemo, useState } from 'react';
import AccountPicker from './components/AccountPicker.jsx';
import Login from './Login.jsx';
import RendicionesView from './RendicionesView.jsx';
import { getStoredAuth, clearStoredAuth } from './auth.js';
import { getStoredTheme, applyTheme } from './theme.js';
import { getJournals, uploadCsv, cargarComprobantes } from './api.js';

const TIPO_COMPROBANTE_LABELS = {
  1: 'Factura A', 2: 'ND A', 3: 'NC A', 4: 'Recibo A',
  6: 'Factura B', 7: 'ND B', 8: 'NC B', 9: 'Recibo B',
  11: 'Factura C', 12: 'ND C', 13: 'NC C', 15: 'Recibo C',
};

function money(n) {
  return (n ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function rowKey(fila) {
  return `${fila.tipoComprobanteCodigo}-${fila.puntoVenta}-${fila.numero}-${fila.cuit}`;
}

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function matcheaBusqueda(fila, textoBusqueda) {
  const q = normalizar(textoBusqueda).trim();
  if (!q) return true;
  const comprobante = `${fila.puntoVenta}-${fila.numero}`;
  const campos = [fila.cuit, fila.denominacionEmisor, fila.fechaEmision, comprobante];
  return campos.some((c) => normalizar(c).includes(q));
}

function ComprobantesApp({ onLogout, theme, onToggleTheme }) {
  const [vista, setVista] = useState('comprobantes'); // 'comprobantes' | 'rendiciones'
  const [journals, setJournals] = useState([]);
  const [filas, setFilas] = useState([]);
  const [aviso, setAviso] = useState(null);
  const [rowState, setRowState] = useState({}); // key -> { selected, journalKey, account }
  const [cargando, setCargando] = useState(false);
  const [subiendo, setSubiendo] = useState(false);
  const [resultados, setResultados] = useState(null);
  const [errorGeneral, setErrorGeneral] = useState(null);
  const [soloPendientes, setSoloPendientes] = useState(true);
  const [busqueda, setBusqueda] = useState('');
  const sinProveedor = useMemo(
    () => (resultados || []).filter((r) => !r.ok && r.code === 'proveedor_no_encontrado'),
    [resultados]
  );

  useEffect(() => {
    getJournals().then(setJournals).catch((e) => setErrorGeneral(e.message));
  }, []);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSubiendo(true);
    setErrorGeneral(null);
    setResultados(null);
    try {
      const data = await uploadCsv(file);
      setFilas(data.filas);
      setAviso(data.avisoEmpresaDistinta);
      setRowState({});
    } catch (err) {
      setErrorGeneral(err.message);
    } finally {
      setSubiendo(false);
      e.target.value = '';
    }
  }

  function updateRow(key, patch) {
    setRowState((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  const seleccionables = useMemo(
    () => filas.filter((f) => !f.loaded && f.reason !== 'error_verificando'),
    [filas]
  );
  const conError = useMemo(() => filas.filter((f) => f.reason === 'error_verificando'), [filas]);
  const seleccionadas = seleccionables.filter((f) => rowState[rowKey(f)]?.selected);
  const filasVisibles = useMemo(() => {
    const base = soloPendientes ? filas.filter((f) => !f.loaded) : filas;
    return base.filter((f) => matcheaBusqueda(f, busqueda));
  }, [filas, soloPendientes, busqueda]);

  const listoParaCargar =
    seleccionadas.length > 0 &&
    seleccionadas.every((f) => {
      const st = rowState[rowKey(f)];
      return st?.journalKey && st?.account?.id;
    });

  async function handleCargar() {
    const mensaje =
      `Vas a cargar ${seleccionadas.length} comprobante(s) en Odoo (facturas de compra${
        seleccionadas.some((f) => f.cierre?.valido) ? ' + pagos conciliados en los que cierran' : ''
      }).\n\n` +
      `Esta acción escribe datos reales en tu contabilidad de Odoo. ¿Confirmás?`;
    if (!window.confirm(mensaje)) return;

    setCargando(true);
    setErrorGeneral(null);
    try {
      const payload = seleccionadas.map((f) => ({
        ...f,
        journalKey: rowState[rowKey(f)].journalKey,
        accountId: rowState[rowKey(f)].account.id,
      }));
      const data = await cargarComprobantes(payload);
      setResultados(data.resultados);
    } catch (err) {
      setErrorGeneral(err.message);
    } finally {
      setCargando(false);
    }
  }

  return (
    <div className="app">
      <div className="app-header">
        <div>
          <h1>Comprobantes ARCA → Odoo</h1>
          <p className="subtitle">Importá el CSV de "Mis Comprobantes Recibidos" de ARCA y cargá en Odoo lo que falte.</p>
        </div>
        <div className="app-header-actions">
          <button type="button" className="theme-toggle" onClick={onToggleTheme}>
            {theme === 'dark' ? '☀ Claro' : '🌙 Oscuro'}
          </button>
          <button className="logout-btn" onClick={onLogout}>Cerrar sesión</button>
        </div>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab-btn ${vista === 'comprobantes' ? 'tab-btn-activo' : ''}`}
          onClick={() => setVista('comprobantes')}
        >
          Comprobantes ARCA
        </button>
        <button
          type="button"
          className={`tab-btn ${vista === 'rendiciones' ? 'tab-btn-activo' : ''}`}
          onClick={() => setVista('rendiciones')}
        >
          Rendiciones Logística
        </button>
      </div>

      {vista === 'rendiciones' ? (
        <RendicionesView />
      ) : (
        <>
      <div className="upload-box">
        <input type="file" accept=".csv" onChange={handleFile} disabled={subiendo} />
        {subiendo && <span>Procesando…</span>}
      </div>

      {errorGeneral && <div className="banner banner-error">{errorGeneral}</div>}
      {aviso && <div className="banner banner-warning">{aviso}</div>}

      {filas.length > 0 && (
        <>
          <div className="resumen-bar">
            <p className="resumen">
              {filas.length} comprobantes en el archivo — {filas.filter((f) => f.loaded).length} ya cargados en Odoo,{' '}
              {seleccionables.length} pendientes.
            </p>
            <div className="resumen-controles">
              <input
                type="text"
                className="busqueda-input"
                placeholder="Buscar por CUIT, razón social, fecha o comprobante..."
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
              />
              <label className="switch">
                <input
                  type="checkbox"
                  checked={soloPendientes}
                  onChange={(e) => setSoloPendientes(e.target.checked)}
                />
                Mostrar solo pendientes
              </label>
            </div>
          </div>
          {conError.length > 0 && (
            <div className="banner banner-error">
              {conError.length} comprobante(s) no se pudieron verificar contra Odoo (falla de red puntual) — no se
              muestran como pendientes ni se pueden seleccionar. Volvé a subir el archivo para reintentarlos.
            </div>
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Proveedor</th>
                  <th>CUIT</th>
                  <th>Comprobante</th>
                  <th>Total</th>
                  <th>Estado</th>
                  <th>Modo de pago</th>
                  <th>Cuenta</th>
                </tr>
              </thead>
              <tbody>
                {filasVisibles.length === 0 && (
                  <tr>
                    <td colSpan={10} className="tabla-vacia">
                      {busqueda.trim()
                        ? 'Ningún comprobante coincide con la búsqueda.'
                        : soloPendientes ? 'No hay comprobantes pendientes 🎉' : 'No hay comprobantes.'}
                    </td>
                  </tr>
                )}
                {filasVisibles.map((f) => {
                  const key = rowKey(f);
                  const st = rowState[key] || {};
                  const yaCargado = f.loaded;
                  const errorVerificando = f.reason === 'error_verificando';
                  const revisar = !f.cierre?.valido;
                  return (
                    <tr key={key} className={yaCargado ? 'row-loaded' : errorVerificando ? 'row-error' : revisar ? 'row-warning' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          disabled={yaCargado || errorVerificando}
                          checked={!!st.selected}
                          onChange={(e) => updateRow(key, { selected: e.target.checked })}
                        />
                      </td>
                      <td>{f.fechaEmision}</td>
                      <td>{TIPO_COMPROBANTE_LABELS[f.tipoComprobanteCodigo] || f.tipoComprobanteCodigo}</td>
                      <td>{f.denominacionEmisor}</td>
                      <td>{f.cuit}</td>
                      <td>{f.puntoVenta}-{f.numero}</td>
                      <td className="num">{money(f.impTotal)}</td>
                      <td>
                        {yaCargado && <span className="badge badge-ok">Ya cargado</span>}
                        {!yaCargado && errorVerificando && (
                          <span className="badge badge-error" title={f.error || 'Fallo al consultar Odoo'}>
                            Error al verificar — no confiar, reintentar
                          </span>
                        )}
                        {!yaCargado && !errorVerificando && revisar && (
                          <span className="badge badge-warning" title={`Diferencia sin discriminar: $${money(-f.cierre.diferencia)}`}>
                            Se carga como borrador
                          </span>
                        )}
                        {!yaCargado && !errorVerificando && !revisar && <span className="badge badge-pending">Pendiente</span>}
                      </td>
                      <td>
                        {!yaCargado && (
                          <select
                            value={st.journalKey || ''}
                            onChange={(e) => updateRow(key, { journalKey: e.target.value })}
                          >
                            <option value="">Elegir…</option>
                            {journals.map((j) => (
                              <option key={j.key} value={j.key}>{j.label}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        {!yaCargado && (
                          <AccountPicker value={st.account} onChange={(acc) => updateRow(key, { account: acc })} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="actions">
            <button disabled={!listoParaCargar || cargando} onClick={handleCargar}>
              {cargando ? 'Cargando…' : `Cargar ${seleccionadas.length || ''} en Odoo`}
            </button>
            {seleccionadas.length > 0 && !listoParaCargar && (
              <span className="hint">Falta elegir modo de pago y/o cuenta en alguna fila seleccionada.</span>
            )}
          </div>
        </>
      )}

      {resultados && (
        <div className="resultados">
          <h2>Resultado de la carga</h2>
          {sinProveedor.length > 0 && (
            <div className="banner banner-warning">
              {sinProveedor.length} comprobante(s) no se pudieron cargar porque el proveedor no existe en Odoo —
              cargalos primero como contacto y volvé a intentar:
              <ul className="lista-proveedores-faltantes">
                {sinProveedor.map((r, i) => (
                  <li key={i}>
                    {r.comprobante.denominacionEmisor} (CUIT {r.comprobante.cuit})
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul>
            {resultados.map((r, i) => (
              <li
                key={i}
                className={
                  r.ok
                    ? r.status === 'borrador_revisar' ? 'res-warning' : 'res-ok'
                    : r.code === 'proveedor_no_encontrado' ? 'res-missing' : 'res-error'
                }
              >
                {r.ok
                  ? r.status === 'borrador_revisar'
                    ? `${r.documentNumber}: cargado como BORRADOR en Odoo (move #${r.moveId}) — revisar diferencia de $${money(-r.diferencia)}`
                    : `${r.documentNumber}: cargado y pagado (move #${r.moveId})`
                  : r.code === 'proveedor_no_encontrado'
                    ? `⚠ Proveedor no existe en Odoo: ${r.comprobante.denominacionEmisor} (CUIT ${r.comprobante.cuit})`
                    : `Error: ${r.error}`}
              </li>
            ))}
          </ul>
        </div>
      )}
        </>
      )}
    </div>
  );
}

export default function App() {
  const [autenticado, setAutenticado] = useState(!!getStoredAuth());
  const [theme, setTheme] = useState(getStoredTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    function onUnauthorized() {
      setAutenticado(false);
    }
    window.addEventListener('arca-unauthorized', onUnauthorized);
    return () => window.removeEventListener('arca-unauthorized', onUnauthorized);
  }, []);

  function handleLogout() {
    clearStoredAuth();
    setAutenticado(false);
  }

  function handleToggleTheme() {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }

  if (!autenticado) {
    return <Login onSuccess={() => setAutenticado(true)} theme={theme} onToggleTheme={handleToggleTheme} />;
  }
  return <ComprobantesApp onLogout={handleLogout} theme={theme} onToggleTheme={handleToggleTheme} />;
}
