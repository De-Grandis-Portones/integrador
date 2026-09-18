// Cliente IMAP para la casilla de notificaciones de pago con tarjeta
// (tarjetasedgrandisportones@gmail.com). Mismo espíritu que odooClient.js:
// una conexión mínima reutilizable, sin lógica de negocio acá — el
// matcheo contra gastos/Odoo se hace en services/, este módulo solo sabe
// leer el buzón.
require('dotenv').config();
const { ImapFlow } = require('imapflow');

const GMAIL_USER = process.env.GMAIL_TARJETAS_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_TARJETAS_APP_PASSWORD;

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.warn('[gmailClient] Faltan variables de entorno GMAIL_TARJETAS_* — revisá tu .env');
}

function nuevaConexion() {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false,
  });
}

// Trae los últimos `limite` mails de la bandeja de entrada (más recientes
// primero) con lo básico (asunto, remitente, fecha, texto plano/html).
// Pensado hoy para explorar el formato real de las notificaciones antes
// de escribir el parser definitivo; mañana lo va a usar la reconciliación
// para traer solo lo nuevo (por fecha o por UID ya procesado).
async function listarUltimosMails(limite = 20) {
  const client = nuevaConexion();
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true });
      const total = status.messages || 0;
      if (!total) return [];
      const desde = Math.max(1, total - limite + 1);
      const mensajes = [];
      for await (const msg of client.fetch(`${desde}:${total}`, {
        envelope: true,
        source: true,
      })) {
        mensajes.push({
          uid: msg.uid,
          asunto: msg.envelope?.subject || null,
          de: msg.envelope?.from?.map((f) => f.address).join(', ') || null,
          fecha: msg.envelope?.date || null,
          fuenteRaw: msg.source ? msg.source.toString('utf8') : null,
        });
      }
      mensajes.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      return mensajes;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function probarConexion() {
  const client = nuevaConexion();
  await client.connect();
  const status = await client.status('INBOX', { messages: true });
  await client.logout();
  return { ok: true, mensajesEnInbox: status.messages || 0 };
}

module.exports = { nuevaConexion, listarUltimosMails, probarConexion };
