// src/pages/TicketsPage.jsx — crear tickets y ver los propios. Van a la
// misma base de "planificación" que usan todas las apps del ecosistema
// (ver Backend/server.js: planificacionPool, endpoints /api/tickets*); se
// gestionan todos desde /admin/tickets en planificación, no hay pantalla
// de gestión acá.
import { useEffect, useState } from 'react';
import {
  fileToTicketAttachment,
  formatTicketAttachmentMeta,
  isImageTicketAttachment,
  openTicketAttachment,
  downloadTicketAttachment,
} from '../utils/ticketAttachment';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

const TICKET_CATEGORIAS = [
  'Duda sobre el sistema',
  'Error / algo no funciona',
  'Solicitud de acceso o permiso',
  'Consulta sobre un pedido / NV',
  'Otro',
];

const ESTADO_LABEL = { pending: 'Pendiente', in_progress: 'En curso', closed: 'Cerrado' };
const ESTADO_BADGE = { pending: 'badge-warn', in_progress: 'badge-warn', closed: 'badge-ok' };

export default function TicketsPage({ authHeader }) {
  const [tab, setTab] = useState('nuevo'); // 'nuevo' | 'mios'

  const [categoria, setCategoria] = useState(TICKET_CATEGORIAS[0]);
  const [mensaje, setMensaje] = useState('');
  const [adjuntos, setAdjuntos] = useState([]);
  const [subiendoAdjunto, setSubiendoAdjunto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [errorNuevo, setErrorNuevo] = useState('');

  const [misTickets, setMisTickets] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [errorLista, setErrorLista] = useState('');
  const [seleccionado, setSeleccionado] = useState(null);
  const [respuesta, setRespuesta] = useState('');

  useEffect(() => {
    if (tab === 'mios') cargarMisTickets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function cargarMisTickets() {
    setCargando(true);
    setErrorLista('');
    try {
      const res = await fetch(`${API_BASE_URL}/api/tickets/mine`, { headers: authHeader || {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      setMisTickets(Array.isArray(data.tickets) ? data.tickets : []);
    } catch (err) {
      setErrorLista(err.message || String(err));
    } finally {
      setCargando(false);
    }
  }

  async function abrirTicket(id) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/tickets/mine/${id}`, { headers: authHeader || {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      setSeleccionado(data.ticket || null);
    } catch (err) {
      setErrorLista(err.message || String(err));
    }
  }

  async function onSeleccionarArchivos(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setErrorNuevo('');
    setSubiendoAdjunto(true);
    try {
      const nuevos = [];
      for (const file of files) {
        nuevos.push(await fileToTicketAttachment(file));
      }
      setAdjuntos((prev) => [...prev, ...nuevos].slice(0, 5));
    } catch (err) {
      setErrorNuevo(err.message || 'No se pudo adjuntar el archivo.');
    } finally {
      setSubiendoAdjunto(false);
    }
  }

  function quitarAdjunto(idx) {
    setAdjuntos((prev) => prev.filter((_, i) => i !== idx));
  }

  async function enviarNuevoTicket(e) {
    e.preventDefault();
    if (!mensaje.trim()) {
      setErrorNuevo('Escribí el detalle antes de enviar.');
      return;
    }
    setErrorNuevo('');
    setEnviando(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authHeader || {}) },
        body: JSON.stringify({ categoria, mensaje: mensaje.trim(), rutaOrigen: 'integrador', adjuntos }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      setMensaje('');
      setAdjuntos([]);
      setEnviado(true);
      setTimeout(() => setEnviado(false), 4000);
    } catch (err) {
      setErrorNuevo(err.message || String(err));
    } finally {
      setEnviando(false);
    }
  }

  async function enviarRespuesta(e) {
    e.preventDefault();
    if (!seleccionado || !respuesta.trim()) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/tickets/mine/${seleccionado.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authHeader || {}) },
        body: JSON.stringify({ mensaje: respuesta.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      setRespuesta('');
      await abrirTicket(seleccionado.id);
    } catch (err) {
      setErrorLista(err.message || String(err));
    }
  }

  return (
    <div className="import-panel" style={{ maxWidth: 640, margin: '20px auto' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          className={tab === 'nuevo' ? 'nav-btn active' : 'nav-btn'}
          onClick={() => setTab('nuevo')}
        >
          Nuevo ticket
        </button>
        <button
          type="button"
          className={tab === 'mios' ? 'nav-btn active' : 'nav-btn'}
          onClick={() => setTab('mios')}
        >
          Mis tickets
        </button>
      </div>

      {tab === 'nuevo' && (
        <form onSubmit={enviarNuevoTicket}>
          <div className="field-row">
            <label>Categoría</label>
            <select value={categoria} onChange={(e) => setCategoria(e.target.value)}>
              {TICKET_CATEGORIAS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="field-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <label>Contanos tu ticket</label>
            <textarea
              value={mensaje}
              onChange={(e) => setMensaje(e.target.value)}
              rows={6}
              placeholder="Escribí acá el detalle..."
              style={{ width: '100%', padding: 8, borderRadius: 'var(--radius)', border: '1px solid var(--color-border)' }}
            />
          </div>

          <div className="field-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <label>Adjuntar foto, video o PDF (opcional)</label>
            <input
              type="file"
              accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf"
              multiple
              onChange={onSeleccionarArchivos}
              disabled={subiendoAdjunto || adjuntos.length >= 5}
            />
            {subiendoAdjunto && <div className="hint">Procesando...</div>}
            {adjuntos.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {adjuntos.map((a, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      fontSize: 12, padding: '4px 8px', marginBottom: 4,
                      borderRadius: 6, border: '1px solid var(--color-border)',
                    }}
                  >
                    <span>{formatTicketAttachmentMeta(a)}</span>
                    <button type="button" className="btn-small" onClick={() => quitarAdjunto(idx)}>Quitar</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {errorNuevo && <div className="error">⚠ {errorNuevo}</div>}
          {enviado && <div className="hint">¡Listo! Tu ticket fue enviado.</div>}

          <button type="submit" className="save-btn" disabled={enviando} style={{ marginTop: 10 }}>
            {enviando ? 'Enviando...' : 'Enviar ticket'}
          </button>
        </form>
      )}

      {tab === 'mios' && !seleccionado && (
        <div>
          {cargando && <div className="hint">Cargando...</div>}
          {errorLista && <div className="error">⚠ {errorLista}</div>}
          {!cargando && misTickets.length === 0 && <div className="hint">Todavía no enviaste ningún ticket.</div>}

          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {misTickets.map((t) => (
                  <tr key={t.id} onClick={() => abrirTicket(t.id)} style={{ cursor: 'pointer' }}>
                    <td>{t.categoria}</td>
                    <td>{new Date(t.created_at).toLocaleString()}</td>
                    <td>
                      <span className={`badge ${ESTADO_BADGE[t.estado] || ''}`}>
                        {ESTADO_LABEL[t.estado] || t.estado}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'mios' && seleccionado && (
        <div>
          <button
            type="button"
            className="btn-small"
            onClick={() => setSeleccionado(null)}
            style={{ marginBottom: 10 }}
          >
            ← Volver
          </button>

          <div style={{ fontWeight: 600 }}>{seleccionado.categoria}</div>
          <span className={`badge ${ESTADO_BADGE[seleccionado.estado] || ''}`}>
            {ESTADO_LABEL[seleccionado.estado] || seleccionado.estado}
          </span>
          <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{seleccionado.mensaje}</div>

          {(seleccionado.adjuntos || []).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {seleccionado.adjuntos.map((a, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="btn-small"
                  onClick={() => openTicketAttachment(a)}
                  onDoubleClick={() => downloadTicketAttachment(a)}
                  title={`${formatTicketAttachmentMeta(a)} (clic para ver, doble clic para descargar)`}
                >
                  {isImageTicketAttachment(a) ? (
                    <img src={a.data_url} alt={a.name} style={{ width: 50, height: 50, objectFit: 'cover', borderRadius: 4, display: 'block' }} />
                  ) : (
                    <span>📎 {formatTicketAttachmentMeta(a)}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
            {(seleccionado.mensajes || []).map((m) => (
              <div key={m.id} style={{ marginBottom: 10 }}>
                <div className="hint-small">
                  {m.es_admin ? (m.autor_username || 'Soporte') : 'Vos'} · {new Date(m.created_at).toLocaleString()}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.mensaje}</div>
              </div>
            ))}
            {(!seleccionado.mensajes || seleccionado.mensajes.length === 0) && (
              <div className="hint">Todavía no hay respuestas.</div>
            )}
          </div>

          {seleccionado.estado !== 'closed' && (
            <form onSubmit={enviarRespuesta} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <input
                value={respuesta}
                onChange={(e) => setRespuesta(e.target.value)}
                placeholder="Agregar un comentario..."
                style={{ flex: 1, padding: 8, borderRadius: 'var(--radius)', border: '1px solid var(--color-border)' }}
              />
              <button type="submit" className="save-btn">Enviar</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
