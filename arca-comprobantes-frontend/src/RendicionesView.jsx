import { useEffect, useState } from 'react';
import { fetchRendiciones, fetchRendicionDetalle } from './api.js';

const MOTIVO_LABELS = { Refrigerio: 'Refrigerio', Hospedaje: 'Hospedaje', Otros: 'Otros' };

function money(n) {
  return (n ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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
      .then(setDetalle)
      .catch((e) => setError(e.message))
      .finally(() => setCargandoDetalle(false));
  }, [seleccionada]);

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
              onClick={() => setSeleccionada(r.viaje_id)}
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
                    <th>Fecha</th>
                    <th>Motivo</th>
                    <th>Monto</th>
                    <th>Comprobante</th>
                    <th>Medio de pago</th>
                    <th>Cargado por</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {detalle.gastos.map((g) => (
                    <tr key={g.id} className={g.estado_revision === 'revisar' ? 'row-warning' : ''}>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="resumen-bar">
              <p className="resumen">Total: ${money(detalle.total)} — en efectivo: ${money(detalle.total_efectivo)}</p>
              {detalle.saldo_a_devolver != null && (
                <p className="resumen"><strong>A devolver a administración: ${money(detalle.saldo_a_devolver)}</strong></p>
              )}
            </div>
            <div className="banner banner-warning">
              Cruce contra Odoo / comprobantes ARCA / email de pagos con tarjeta: pendiente (falta terminar de
              conectar el correo de notificaciones).
            </div>
          </>
        )}
      </div>
    </div>
  );
}
