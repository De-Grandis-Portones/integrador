// src/components/TicketWidget.jsx — botón "Tickets" en el header: abre un
// panel chico para mandar un ticket y ver los propios. Van a la misma base
// compartida con todas las apps del ecosistema; se gestionan todos desde
// /admin/tickets en Planificación, no hay pantalla de gestión acá. Colores
// hardcodeados (no el theme propio de esta app) para que el widget se vea
// igual en todas las apps.
import { useEffect, useRef, useState } from 'react';
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
const ESTADO_COLOR = { pending: '#b45309', in_progress: '#92720c', closed: '#15803d' };

const T = {
  surface: '#ffffff',
  ink: '#0f172a',
  inkWeak: '#475569',
  border: '#dfe3e8',
  brand: '#008241',
  brand700: '#0a6a33',
  brand100: '#e8f6ee',
  danger: '#b3261e',
};

export default function TicketWidget({ authHeader }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('nueva');
  const panelRef = useRef(null);

  const [categoria, setCategoria] = useState(TICKET_CATEGORIAS[0]);
  const [mensaje, setMensaje] = useState('');
  const [adjuntos, setAdjuntos] = useState([]);
  const [subiendoAdjunto, setSubiendoAdjunto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [errorNueva, setErrorNueva] = useState('');

  const [misTickets, setMisTickets] = useState([]);
  const [cargandoMias, setCargandoMias] = useState(false);
  const [ticketSeleccionado, setTicketSeleccionado] = useState(null);
  const [respuesta, setRespuesta] = useState('');

  useEffect(() => {
    function onDocClick(e) {
      if (open && panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open && tab === 'mias') cargarMisTickets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);

  async function cargarMisTickets() {
    setCargandoMias(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/tickets/mine`, { headers: authHeader || {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMisTickets(Array.isArray(data.tickets) ? data.tickets : []);
    } catch (err) {
      console.error('Error cargando mis tickets:', err);
    } finally {
      setCargandoMias(false);
    }
  }

  async function abrirTicket(id) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/tickets/mine/${id}`, { headers: authHeader || {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTicketSeleccionado(data.ticket || null);
    } catch (err) {
      console.error('Error abriendo ticket:', err);
    }
  }

  async function agregarArchivos(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setErrorNueva('');
    setSubiendoAdjunto(true);
    try {
      const nuevos = [];
      for (const file of files) {
        nuevos.push(await fileToTicketAttachment(file));
      }
      setAdjuntos((prev) => [...prev, ...nuevos].slice(0, 5));
    } catch (err) {
      setErrorNueva(err.message || 'No se pudo adjuntar el archivo.');
    } finally {
      setSubiendoAdjunto(false);
    }
  }

  async function onSeleccionarArchivos(e) {
    // Copiar el FileList a un array ANTES de limpiar e.target.value - si no,
    // vaciar el input también vacía esta misma referencia (es "viva").
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await agregarArchivos(files);
  }

  function onDropArchivos(e) {
    e.preventDefault();
    if (subiendoAdjunto || adjuntos.length >= 5) return;
    agregarArchivos(e.dataTransfer.files);
  }

  function quitarAdjunto(idx) {
    setAdjuntos((prev) => prev.filter((_, i) => i !== idx));
  }

  async function enviarNuevoTicket(e) {
    e.preventDefault();
    if (!mensaje.trim()) {
      setErrorNueva('Escribí el detalle antes de enviar.');
      return;
    }
    setErrorNueva('');
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
      setErrorNueva(err.message || 'No se pudo enviar el ticket. Probá de nuevo.');
    } finally {
      setEnviando(false);
    }
  }

  async function enviarRespuesta(e) {
    e.preventDefault();
    if (!ticketSeleccionado || !respuesta.trim()) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/tickets/mine/${ticketSeleccionado.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authHeader || {}) },
        body: JSON.stringify({ mensaje: respuesta.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRespuesta('');
      await abrirTicket(ticketSeleccionado.id);
    } catch (err) {
      console.error('Error enviando respuesta:', err);
    }
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Tickets"
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 12px', borderRadius: 10,
          border: `1px solid ${T.border}`, background: T.surface, color: T.ink,
          cursor: 'pointer', fontWeight: 700, fontSize: 14,
        }}
      >
        <img src="/ticket-logo.png" alt="" style={{ width: 16, height: 16, objectFit: 'contain' }} />
        Tickets
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0,
            width: 360, maxWidth: '90vw',
            background: T.surface, color: T.ink,
            border: `1px solid ${T.border}`, borderRadius: 12,
            boxShadow: '0 12px 32px rgba(15,23,42,.18)', zIndex: 1000, overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}` }}>
            <button
              type="button"
              onClick={() => setTab('nueva')}
              style={{
                flex: 1, padding: '10px 8px', border: 'none', cursor: 'pointer',
                background: tab === 'nueva' ? T.brand100 : 'transparent',
                color: tab === 'nueva' ? T.brand700 : T.ink,
                fontWeight: tab === 'nueva' ? 700 : 400,
              }}
            >
              Nuevo ticket
            </button>
            <button
              type="button"
              onClick={() => setTab('mias')}
              style={{
                flex: 1, padding: '10px 8px', border: 'none', cursor: 'pointer',
                background: tab === 'mias' ? T.brand100 : 'transparent',
                color: tab === 'mias' ? T.brand700 : T.ink,
                fontWeight: tab === 'mias' ? 700 : 400,
              }}
            >
              Mis tickets
            </button>
          </div>

          <div style={{ padding: 14, maxHeight: 460, overflowY: 'auto' }}>
            {tab === 'nueva' && (
              <form onSubmit={enviarNuevoTicket} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: T.inkWeak }}>
                    Categoría
                  </label>
                  <select
                    value={categoria}
                    onChange={(e) => setCategoria(e.target.value)}
                    style={{ width: '100%', padding: '9px 10px', borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13, boxSizing: 'border-box' }}
                  >
                    {TICKET_CATEGORIAS.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: T.inkWeak }}>
                    Contanos tu ticket
                  </label>
                  <textarea
                    value={mensaje}
                    onChange={(e) => setMensaje(e.target.value)}
                    rows={5}
                    placeholder="Escribí acá el detalle..."
                    style={{ width: '100%', padding: 10, borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, color: T.ink, fontSize: 13, resize: 'vertical', lineHeight: 1.4, boxSizing: 'border-box' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5, color: T.inkWeak }}>
                    Adjuntos (opcional)
                  </label>
                  <label
                    htmlFor="ticket-adjuntos-input-integrador"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={onDropArchivos}
                    style={{
                      position: 'relative',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      padding: '14px 10px', borderRadius: 10, textAlign: 'center',
                      border: `1.5px dashed ${T.border}`, background: T.brand100,
                      opacity: (subiendoAdjunto || adjuntos.length >= 5) ? 0.6 : 1,
                      cursor: (subiendoAdjunto || adjuntos.length >= 5) ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <span style={{ fontSize: 20, lineHeight: 1 }}>📎</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.brand700 }}>
                      {subiendoAdjunto ? 'Procesando...' : 'Foto, video o PDF'}
                    </span>
                    <span style={{ fontSize: 11, color: T.inkWeak }}>
                      Elegí un archivo o arrastralo acá · máx. 5
                    </span>
                    <input
                      id="ticket-adjuntos-input-integrador"
                      type="file"
                      accept="image/*,video/mp4,video/quicktime,video/webm,application/pdf"
                      multiple
                      onChange={onSeleccionarArchivos}
                      disabled={subiendoAdjunto || adjuntos.length >= 5}
                      style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                    />
                  </label>

                  {adjuntos.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {adjuntos.map((a, idx) => (
                        <div
                          key={idx}
                          title={formatTicketAttachmentMeta(a)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, maxWidth: '100%',
                            padding: '4px 6px 4px 4px', borderRadius: 999,
                            border: `1px solid ${T.border}`, background: T.surface, fontSize: 12,
                          }}
                        >
                          {isImageTicketAttachment(a) ? (
                            <img
                              src={a.data_url}
                              alt={a.name}
                              style={{ width: 22, height: 22, objectFit: 'cover', borderRadius: '50%', flexShrink: 0 }}
                            />
                          ) : (
                            <span style={{ fontSize: 14, flexShrink: 0 }}>📄</span>
                          )}
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
                            {a.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => quitarAdjunto(idx)}
                            aria-label={`Quitar ${a.name}`}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                              width: 18, height: 18, borderRadius: '50%', border: 'none', padding: 0,
                              background: 'rgba(179,38,30,0.12)', color: T.danger,
                              cursor: 'pointer', fontSize: 12, lineHeight: 1,
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {errorNueva && <div style={{ color: T.danger, fontSize: 12 }}>{errorNueva}</div>}
                {enviado && (
                  <div style={{ color: T.brand700, fontSize: 12, fontWeight: 600 }}>
                    ¡Listo! Tu ticket fue enviado.
                  </div>
                )}

                <button
                  type="submit"
                  disabled={enviando || !mensaje.trim()}
                  style={{
                    width: '100%', padding: '10px 12px', fontSize: 13, borderRadius: 10,
                    border: 'none', background: T.brand, color: '#fff', fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  {enviando ? 'Enviando...' : 'Enviar ticket'}
                </button>
              </form>
            )}

            {tab === 'mias' && !ticketSeleccionado && (
              <div>
                {cargandoMias && <div style={{ fontSize: 13, color: T.inkWeak }}>Cargando...</div>}
                {!cargandoMias && misTickets.length === 0 && (
                  <div style={{ fontSize: 13, color: T.inkWeak }}>Todavía no enviaste ningún ticket.</div>
                )}
                {misTickets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => abrirTicket(t.id)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '8px 10px', marginBottom: 6, borderRadius: 8,
                      border: `1px solid ${T.border}`, background: 'transparent', cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.ink }}>{t.categoria}</div>
                    <div style={{ fontSize: 12, color: T.inkWeak, margin: '2px 0' }}>
                      {new Date(t.created_at).toLocaleString()}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: ESTADO_COLOR[t.estado] || T.ink }}>
                      {ESTADO_LABEL[t.estado] || t.estado}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {tab === 'mias' && ticketSeleccionado && (
              <div>
                <button
                  type="button"
                  onClick={() => setTicketSeleccionado(null)}
                  style={{ background: 'none', border: 'none', color: T.brand700, cursor: 'pointer', padding: 0, marginBottom: 8 }}
                >
                  ← Volver
                </button>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.ink }}>{ticketSeleccionado.categoria}</div>
                <span style={{ fontSize: 11, fontWeight: 700, color: ESTADO_COLOR[ticketSeleccionado.estado] || T.ink }}>
                  {ESTADO_LABEL[ticketSeleccionado.estado] || ticketSeleccionado.estado}
                </span>
                <div style={{ fontSize: 13, marginTop: 8, whiteSpace: 'pre-wrap', color: T.ink }}>{ticketSeleccionado.mensaje}</div>

                {(ticketSeleccionado.adjuntos || []).length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ticketSeleccionado.adjuntos.map((a, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => openTicketAttachment(a)}
                        onDoubleClick={() => downloadTicketAttachment(a)}
                        title={`${formatTicketAttachmentMeta(a)} (clic para ver, doble clic para descargar)`}
                        style={{
                          border: `1px solid ${T.border}`, borderRadius: 6, padding: 4,
                          background: 'transparent', cursor: 'pointer', fontSize: 11, textAlign: 'left',
                        }}
                      >
                        {isImageTicketAttachment(a) ? (
                          <img src={a.data_url} alt={a.name} style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 4, display: 'block' }} />
                        ) : (
                          <span>📎 {formatTicketAttachmentMeta(a)}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                  {(ticketSeleccionado.mensajes || []).map((m) => (
                    <div key={m.id} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: T.inkWeak }}>
                        {m.es_admin ? (m.autor_username || 'Soporte') : 'Vos'} · {new Date(m.created_at).toLocaleString()}
                      </div>
                      <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: T.ink }}>{m.mensaje}</div>
                    </div>
                  ))}
                  {(!ticketSeleccionado.mensajes || ticketSeleccionado.mensajes.length === 0) && (
                    <div style={{ fontSize: 13, color: T.inkWeak }}>Todavía no hay respuestas.</div>
                  )}
                </div>

                {ticketSeleccionado.estado !== 'closed' && (
                  <form onSubmit={enviarRespuesta} style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                    <input
                      value={respuesta}
                      onChange={(e) => setRespuesta(e.target.value)}
                      placeholder="Agregar un comentario..."
                      style={{ flex: 1, padding: 8, borderRadius: 8, border: `1px solid ${T.border}` }}
                    />
                    <button
                      type="submit"
                      style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: T.brand, color: '#fff', fontWeight: 700, cursor: 'pointer' }}
                    >
                      Enviar
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
