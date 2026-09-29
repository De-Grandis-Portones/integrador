// Crea en Odoo, para un gasto de una rendición de logística, la factura de compra
// en BORRADOR + el pago en BORRADOR ya asociado a esa factura.
//
// A diferencia del importador de ARCA (odooLoader.js), un gasto de rendición no
// trae CUIT, número de comprobante ni desglose de IVA — solo fecha, motivo, monto
// total, tipo ("Factura A", "Ticket"...) y la foto/PDF. Por eso:
// - el proveedor lo elige la usuaria en la pantalla;
// - la factura lleva UNA línea por el total, SIN impuestos, marcada "A REVISAR":
//   en Odoo se completa número e IVA mirando el comprobante adjunto y recién ahí
//   se confirma (el diario de compras exige número de documento para confirmar);
// - el pago queda en borrador con el modo de pago elegido, y se confirma después
//   de confirmar la factura.
//
// Gastos de viáticos SIN proveedor (la usuaria deja el proveedor vacío): en vez
// de factura + pago se prepara un ASIENTO MANUAL en borrador en "Operaciones
// varias" (MISC): debe la cuenta elegida, haber la cuenta del modo de pago
// (la cuenta por defecto de ese diario: caja o tarjeta a pagar). Pedido
// explícito del usuario, 2026-09-29.
//
// Idempotencia: cada factura/asiento lleva en invoice_origin una marca por gasto
// (origenGasto), y antes de crear se busca por esa marca — así un gasto no se
// carga dos veces aunque se reintente. La base de Planta se sigue usando solo
// para leer.
const { odooExecuteKw, ODOO_COMPANY_ID } = require('../odooClient');
const { getJournalByKey } = require('../config/paymentJournals');
const { findDocumentTypeByCode } = require('./matcher');
const { PRODUCTO_ID } = require('./breakdown');
const { descargarComprobante, storageConfigurado } = require('../plantaStorage');

// tipo_comprobante que carga la cuadrilla en Planta -> código ARCA del
// l10n_latam.document.type. Si no está acá, el borrador va sin tipo y se elige en Odoo.
const TIPO_A_CODIGO_ARCA = {
  'Factura A': '1',
  'Factura B': '6',
  'Factura C': '11',
  Ticket: '83',
};

function origenGasto(gastoId) {
  return `Rendición logística - gasto #${gastoId}`;
}

// Devuelve Map<gastoId, { moveId, name, state, tipo }> de los gastos que ya están en
// Odoo, como factura (tipo 'factura') o como asiento manual (tipo 'asiento').
async function buscarGastosCargados(gastoIds) {
  const ids = (gastoIds || []).map(Number).filter(Number.isFinite);
  const resultado = new Map();
  if (!ids.length) return resultado;

  // En tandas: el listado de rendiciones consulta los gastos de todas las aprobadas.
  const moves = [];
  const TANDA = 200;
  for (let i = 0; i < ids.length; i += TANDA) {
    const origenes = ids.slice(i, i + TANDA).map(origenGasto);
    moves.push(...await odooExecuteKw('account.move', 'search_read', [
      [
        ['move_type', 'in', ['in_invoice', 'entry']],
        ['company_id', '=', ODOO_COMPANY_ID],
        ['invoice_origin', 'in', origenes],
      ],
    ], { fields: ['id', 'name', 'state', 'invoice_origin', 'move_type'] }));
  }

  for (const m of moves) {
    const gastoId = Number(String(m.invoice_origin).match(/#(\d+)$/)?.[1]);
    if (Number.isFinite(gastoId)) {
      resultado.set(gastoId, {
        moveId: m.id,
        name: m.name && m.name !== '/' ? m.name : `borrador #${m.id}`,
        state: m.state,
        tipo: m.move_type === 'entry' ? 'asiento' : 'factura',
      });
    }
  }
  return resultado;
}

function escaparHtml(texto) {
  return String(texto ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * @param {object} gasto - fila de logistica_gastos (incluye storage_path)
 * @param {object} viaje - datos del viaje (viaje_id, viaje_nombre, viaje_fecha, cuadrilla_nombre)
 * @param {{ partnerId: number, accountId: number, journalKey: string }} config - lo que eligió la usuaria
 */
async function crearBorradorDesdeGasto(gasto, viaje, { partnerId, accountId, journalKey }) {
  if (!partnerId) throw new Error('Falta elegir el proveedor.');
  if (!accountId) throw new Error('Falta elegir la cuenta contable.');
  const journal = getJournalByKey(journalKey);
  if (!journal) throw new Error(`Modo de pago desconocido: ${journalKey}`);

  const monto = Math.round((Number(gasto.monto) + Number.EPSILON) * 100) / 100;
  if (!(monto > 0)) throw new Error('El gasto no tiene un monto válido.');

  const viajeNombre = viaje.viaje_nombre?.trim() || `Viaje #${viaje.viaje_id}`;
  const codigoArca = TIPO_A_CODIGO_ARCA[gasto.tipo_comprobante];
  const docType = codigoArca ? await findDocumentTypeByCode(codigoArca) : null;

  const invoiceVals = {
    move_type: 'in_invoice',
    company_id: ODOO_COMPANY_ID,
    partner_id: partnerId,
    invoice_date: gasto.fecha,
    invoice_origin: origenGasto(gasto.id),
    narration:
      `<p>Rendición de logística: ${escaparHtml(viajeNombre)} (${escaparHtml(viaje.viaje_fecha)}, ` +
      `${escaparHtml(viaje.cuadrilla_nombre || 'sin cuadrilla')}) — gasto #${gasto.id}: ${escaparHtml(gasto.motivo)}, ` +
      `${escaparHtml(gasto.tipo_comprobante || 'sin tipo')}, medio de pago informado: ${escaparHtml(gasto.medio_pago || '—')}.</p>` +
      `<p>A REVISAR: cargado sin número de comprobante ni desglose de IVA. Completar ambos mirando el ` +
      `comprobante adjunto antes de confirmar la factura. Pago en borrador: ${escaparHtml(journal.label)}.</p>`,
    invoice_line_ids: [[0, 0, {
      name: `Rendición ${viajeNombre} — ${gasto.motivo} — A REVISAR (total sin discriminar IVA)`,
      product_id: PRODUCTO_ID,
      account_id: accountId,
      quantity: 1,
      price_unit: monto,
      // Explícito: el producto VIATICOS trae IVA 21% por defecto y se lo sumaría al total.
      tax_ids: [[6, 0, []]],
    }]],
  };
  if (docType) invoiceVals.l10n_latam_document_type_id = docType.id;

  const moveId = await odooExecuteKw('account.move', 'create', [invoiceVals]);
  const avisos = [];
  await adjuntarComprobante(gasto, moveId, avisos);

  let paymentId = null;
  try {
    paymentId = await odooExecuteKw('account.payment', 'create', [{
      payment_type: 'outbound',
      partner_type: 'supplier',
      partner_id: partnerId,
      amount: monto,
      date: gasto.fecha,
      journal_id: journal.journalId,
      company_id: ODOO_COMPANY_ID,
      memo: origenGasto(gasto.id),
      invoice_ids: [[6, 0, [moveId]]],
    }]);
  } catch (err) {
    avisos.push(`La factura se creó pero el pago no: ${err.message}. Registralo a mano en Odoo.`);
  }

  return { status: 'borrador', moveId, paymentId, avisos };
}

// Foto/PDF del comprobante de Planta adjunto al movimiento. Si falla, el
// movimiento ya está creado: se avisa, no se corta.
async function adjuntarComprobante(gasto, moveId, avisos) {
  if (!gasto.storage_path) return;
  if (!storageConfigurado()) {
    avisos.push('No se adjuntó el comprobante (falta configurar Supabase Storage en el servidor).');
    return;
  }
  try {
    const archivo = await descargarComprobante(gasto.storage_path);
    await odooExecuteKw('ir.attachment', 'create', [{
      name: gasto.nombre_archivo || `comprobante-gasto-${gasto.id}`,
      datas: archivo.toString('base64'),
      res_model: 'account.move',
      res_id: moveId,
      mimetype: gasto.tipo_mime || 'application/octet-stream',
    }]);
  } catch (err) {
    avisos.push(`No se pudo adjuntar el comprobante: ${err.message}`);
  }
}

let diarioMiscId = null;
async function getDiarioOperacionesVarias() {
  if (diarioMiscId) return diarioMiscId;
  const [diario] = await odooExecuteKw('account.journal', 'search_read', [
    [['type', '=', 'general'], ['code', '=', 'MISC'], ['company_id', '=', ODOO_COMPANY_ID]],
  ], { fields: ['id'], limit: 1 });
  if (!diario) throw new Error('No se encontró en Odoo el diario de Operaciones varias (código MISC).');
  diarioMiscId = diario.id;
  return diarioMiscId;
}

const cuentaPorDiario = new Map();
async function getCuentaDelDiario(journalId) {
  if (cuentaPorDiario.has(journalId)) return cuentaPorDiario.get(journalId);
  const [diario] = await odooExecuteKw('account.journal', 'read', [[journalId], ['default_account_id']]);
  const cuentaId = diario?.default_account_id?.[0];
  if (!cuentaId) throw new Error('El diario del modo de pago no tiene cuenta por defecto en Odoo.');
  cuentaPorDiario.set(journalId, cuentaId);
  return cuentaId;
}

/**
 * Asiento manual en borrador para un gasto sin proveedor.
 * @param {{ accountId: number, journalKey: string }} config - cuenta (debe) y modo de pago (haber)
 */
async function crearAsientoDesdeGasto(gasto, viaje, { accountId, journalKey }) {
  if (!accountId) throw new Error('Falta elegir la cuenta contable.');
  const journal = getJournalByKey(journalKey);
  if (!journal) throw new Error(`Modo de pago desconocido: ${journalKey}`);

  const monto = Math.round((Number(gasto.monto) + Number.EPSILON) * 100) / 100;
  if (!(monto > 0)) throw new Error('El gasto no tiene un monto válido.');

  const [diarioId, cuentaHaber] = await Promise.all([getDiarioOperacionesVarias(), getCuentaDelDiario(journal.journalId)]);
  if (cuentaHaber === Number(accountId)) {
    throw new Error('La cuenta elegida es la misma que la del modo de pago: el asiento quedaría en cero.');
  }

  const viajeNombre = viaje.viaje_nombre?.trim() || `Viaje #${viaje.viaje_id}`;
  const detalle = `Rendición ${viajeNombre} — gasto #${gasto.id} — ${gasto.motivo}`;

  const moveId = await odooExecuteKw('account.move', 'create', [{
    move_type: 'entry',
    company_id: ODOO_COMPANY_ID,
    journal_id: diarioId,
    date: gasto.fecha,
    ref: detalle,
    invoice_origin: origenGasto(gasto.id),
    narration:
      `<p>Viático sin proveedor de la rendición de logística ${escaparHtml(viajeNombre)} (${escaparHtml(viaje.viaje_fecha)}, ` +
      `${escaparHtml(viaje.cuadrilla_nombre || 'sin cuadrilla')}) — gasto #${gasto.id}: ${escaparHtml(gasto.motivo)}, ` +
      `${escaparHtml(gasto.tipo_comprobante || 'sin tipo')}. Pagado con: ${escaparHtml(journal.label)}.</p>`,
    line_ids: [
      [0, 0, { name: detalle, account_id: Number(accountId), debit: monto, credit: 0 }],
      [0, 0, { name: `${detalle} — ${journal.label}`, account_id: cuentaHaber, debit: 0, credit: monto }],
    ],
  }]);

  const avisos = [];
  await adjuntarComprobante(gasto, moveId, avisos);
  return { status: 'asiento_borrador', moveId, avisos };
}

module.exports = { crearBorradorDesdeGasto, crearAsientoDesdeGasto, buscarGastosCargados, origenGasto };
