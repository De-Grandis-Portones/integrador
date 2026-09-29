import { useEffect, useState } from 'react';
import AccountPicker from './components/AccountPicker.jsx';
import { fetchRendiciones, fetchRendicionDetalle, getJournals, searchPartners, cargarRendicion } from './api.js';

const MOTIVO_LABELS = { Refrigerio: 'Refrigerio', Hospedaje: 'Hospedaje', Otros: 'Otros' };

function money(n) {
  return (n ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const formatProveedor = (p) => (p.vat ? `${p.name} (${p.vat})` : p.name);

function fecha(iso) {
  return String(iso || '').slice(0, 10).split('-').reverse().join('/');
}

export default function RendicionesView() {
  const [rendiciones, setRendiciones] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [seleccionada, setSeleccionada] = useState(null); // viajeId
  const [detalle, setDetalle] = useState(null);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);
  const [journals, setJournals] = useState([]);
  const [rowState, setRowState] = useState({}); // gastoId -> { selected, partner, account, journalKey }
  const [enviando, setEnviando] = useState(false);
  const [resultados, setResultados] = useState(null);
  const [recargar, setRecargar] = useState(0);

  useEffect(() => {
    getJournals().then(setJournals).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    fetchRendiciones()
      .then((d) => setRendiciones(d.rendiciones || []))
      .catch((e) => setError(e.message))
      .finally(() => setCargando(false));
  }, []);

  useEffect(() => {
    if (!seleccionada) { setDetalle(null); return; }
    setCargandoDetalle(true);
    setError(null);
    fetchRendicionDetalle(seleccionada)
      .then((d) => {
        setDetalle(d);
        // Preselecciona "Efectivo" en los gastos que la cuadrilla marcó como pagados en efectivo.
        setRowState((prev) => {
          const next = {};
          for (const g of d.gastos) {
            next[g.id] = prev[g.id] || { journalKey: g.medio_pago === 'efectivo' ? 'efectivo' : '' };
          }
          return next;
        });
      })
      .catch((e) => setError(e.message))
      .finally(() => setCargandoDetalle(false));
  }, [seleccionada, recargar]);

  function elegirRendicion(viajeId) {
    if (viajeId === seleccionada) return;
    setRowState({});
    setResultados(null);
    setSeleccionada(viajeId);
  }

  function updateRow(gastoId, patch) {
    setRowState((prev) => ({ ...prev, [gastoId]: { ...prev[gastoId], ...patch } }));
  }

  const puedeEnviar = !!detalle && !detalle.error_odoo;
  const seleccionados = (detalle?.gastos || []).filter((g) => !g.odoo && rowState[g.id]?.selected);
  const listoParaEnviar =
    puedeEnviar &&
    seleccionados.length > 0 &&
    seleccionados.every((g) => {
      const st = rowState[g.id];
      return st?.partner?.id && st?.account?.id && st?.journalKey;
    });

  async function handleEnviar() {
    const mensaje =
      `Vas a enviar ${seleccionados.length} gasto(s) a Odoo: se crea cada factura de compra en BORRADOR ` +
      `(total sin IVA, a revisar) con el comprobante adjunto, y su pago en BORRADOR.\n\n¿Confirmás?`;
    if (!window.confirm(mensaje)) return;

    setEnviando(true);
    setError(null);
    try {
      const payload = seleccionados.map((g) => ({
        gastoId: g.id,
        partnerId: rowState[g.id].partner.id,
        accountId: rowState[g.id].account.id,
        journalKey: rowState[g.id].journalKey,
      }));
      const data = await cargarRendicion(detalle.viaje_id, payload);
      setResultados(data.resultados);
      setRecargar((n) => n + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="rendiciones-layout">
      <div className="rendiciones-lista">
        <h2 className="rendiciones-titulo">Rendiciones aprobadas por logística</h2>
        {cargando && <p className="hint">Cargando…</p>}
        {!cargando && rendiciones.length === 0 && (
          <p className="hint">Todavía no hay ninguna rendición aprobada por logística.</p>
        )}
        <ul className="rendiciones-ul">
          {rendiciones.map((r) => (
            <li
              key={r.viaje_id}
              className={`rendiciones-item ${seleccionada === r.viaje_id ? 'rendiciones-item-activo' : ''}`}
              onClick={() => elegirRendicion(r.viaje_id)}
            >
              <div className="rendiciones-item-top">
                <strong>{r.viaje_nombre?.trim() || `Viaje #${r.viaje_id}`}</strong>
                <span className="num">${money(r.total)}</span>
              </div>
              <div className="hint">
                {fecha(r.viaje_fecha)} · {r.cuadrilla_nombre || 'sin cuadrilla'} · {r.cantidad_gastos} gasto(s)
              </div>
              <div className="hint">Aprobó: {r.rendicion_aprobada_por || '—'}</div>
              {r.saldo_a_devolver != null && (
                <div className="hint">
                  A devolver: <strong>${money(r.saldo_a_devolver)}</strong>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="rendiciones-detalle">
        {error && <div className="banner banner-error">{error}</div>}
        {!seleccionada && !error && <p className="hint">Elegí una rendición de la izquierda para ver sus gastos.</p>}
        {cargandoDetalle && <p className="hint">Cargando…</p>}
        {detalle && !cargandoDetalle && (
          <>
            <h2>{detalle.viaje_nombre?.trim() || `Viaje #${detalle.viaje_id}`}</h2>
            <p className="hint">
              {fecha(detalle.viaje_fecha)} · {detalle.cuadrilla_nombre || 'sin cuadrilla'} · aprobó{' '}
              {detalle.rendicion_aprobada_por} el {new Date(detalle.rendicion_aprobada_at).toLocaleString('es-AR')}
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Fecha</th>
                    <th>Motivo</th>
                    <th>Monto</th>
                    <th>Comprobante</th>
                    <th>Medio de pago</th>
                    <th>Cargado por</th>
                    <th>Estado</th>
                    <th>Odoo</th>
                    <th>Proveedor</th>
                    <th>Modo de pago</th>
                    <th>Cuenta</th>
                  </tr>
                </thead>
                <tbody>
                  {detalle.gastos.map((g) => {
                    const st = rowState[g.id] || {};
                    const enOdoo = !!g.odoo;
                    return (
                    <tr key={g.id} className={enOdoo ? 'row-loaded' : g.estado_revision === 'revisar' ? 'row-warning' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          disabled={enOdoo || !puedeEnviar}
                          checked={!!st.selected && !enOdoo}
                          onChange={(e) => updateRow(g.id, { selected: e.target.checked })}
                        />
                      </td>
                      <td>{fecha(g.fecha)}</td>
                      <td>{MOTIVO_LABELS[g.motivo] || g.motivo}</td>
                      <td className="num">${money(g.monto)}</td>
                      <td>{g.tipo_comprobante || '—'}</td>
                      <td>{g.medio_pago || '—'}</td>
                      <td>{g.cargado_por || '—'}</td>
                      <td>
                        {g.estado_revision === 'revisar' ? (
                          <span className="badge badge-warning" title={g.detalle_revision || 'Requiere verificación manual'}>
                            ⚠ A revisar{g.campos_inciertos?.length ? ` (${g.campos_inciertos.join(', ')})` : ''}
                          </span>
                        ) : (
                          <span className="badge badge-ok">Verificado</span>
                        )}
                      </td>
                      <td>
                        {enOdoo ? (
                          <span className="badge badge-ok" title={`account.move #${g.odoo.moveId}`}>
                            {g.odoo.state === 'draft' ? 'En Odoo (borrador)' : 'En Odoo'}
                          </span>
                        ) : (
                          <span className="badge badge-pending">Pendiente</span>
                        )}
                      </td>
                      <td>
                        {!enOdoo && (
                          <AccountPicker
                            value={st.partner}
                            onChange={(p) => updateRow(g.id, { partner: p })}
                            search={searchPartners}
                            format={formatProveedor}
                            placeholder="Buscar proveedor..."
                          />
                        )}
                      </td>
                      <td>
                        {!enOdoo && (
                          <select value={st.journalKey || ''} onChange={(e) => updateRow(g.id, { journalKey: e.target.value })}>
                            <option value="">Elegir…</option>
                            {journals.map((j) => (
                              <option key={j.key} value={j.key}>{j.label}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        {!enOdoo && (
                          <AccountPicker value={st.account} onChange={(acc) => updateRow(g.id, { account: acc })} />
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="resumen-bar">
              <p className="resumen">Total: ${money(detalle.total)} — en efectivo: ${money(detalle.total_efectivo)}</p>
              {detalle.saldo_a_devolver != null && (
                <p className="resumen"><strong>A devolver a administración: ${money(detalle.saldo_a_devolver)}</strong></p>
              )}
            </div>
            {detalle.error_odoo && (
              <div className="banner banner-error">
                {detalle.error_odoo} — no se puede enviar hasta saber qué gastos ya están cargados. Recargá en un rato.
              </div>
            )}
            <div className="actions">
              <button disabled={!listoParaEnviar || enviando} onClick={handleEnviar}>
                {enviando ? 'Enviando…' : `Enviar ${seleccionados.length || ''} a Odoo`}
              </button>
              {seleccionados.length > 0 && !listoParaEnviar && puedeEnviar && (
                <span className="hint">Falta elegir proveedor, modo de pago y/o cuenta en algún gasto seleccionado.</span>
              )}
            </div>
            <p className="hint">
              Cada gasto se crea en Odoo como factura en borrador (una línea por el total, sin IVA, a revisar) con el
              comprobante adjunto, y un pago en borrador con el modo de pago elegido. En Odoo hay que completar número de
              comprobante e IVA, confirmar la factura y después el pago.
            </p>
            {resultados && (
              <div className="resultados">
                <h2>Resultado del envío</h2>
                <ul>
                  {resultados.map((r, i) => (
                    <li key={i} className={r.ok ? (r.avisos?.length ? 'res-warning' : 'res-ok') : 'res-error'}>
                      {r.ok
                        ? `Gasto #${r.gastoId}: factura en borrador (move #${r.moveId})` +
                          (r.paymentId ? ` + pago en borrador (#${r.paymentId})` : '') +
                          (r.avisos?.length ? ` — ${r.avisos.join(' ')}` : '')
                        : `Gasto #${r.gastoId}: ${r.error}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
