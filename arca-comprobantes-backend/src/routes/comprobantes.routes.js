const express = require('express');
const multer = require('multer');
const { parseComprobantesRecibidosCsv } = require('../services/csvParser');
const { isComprobanteLoaded } = require('../services/matcher');
const { validarCierre } = require('../services/breakdown');
const { crearFacturaYPago } = require('../services/odooLoader');
const { PAYMENT_JOURNALS } = require('../config/paymentJournals');
const { odooExecuteKw, ODOO_COMPANY_ID } = require('../odooClient');
const { mapWithConcurrency, conReintento } = require('../services/concurrency');

// Cuántas verificaciones contra Odoo corren en simultáneo al procesar un CSV. Con esto
// sin límite, un archivo de 150-200 filas disparaba cientos de llamadas a la vez y una
// parte fallaba por sobrecarga (ver services/concurrency.js).
const CONCURRENCIA_MATCHING = 8;

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// CUIT de DFLEX, para el chequeo de sanidad contra "Nro. Doc. Receptor" del CSV.
const CUIT_PROPIO = '33716081759';

// Diarios de pago disponibles, para poblar el desplegable en el frontend.
router.get('/journals', (req, res) => {
  res.json(PAYMENT_JOURNALS.map(({ key, label, type }) => ({ key, label, type })));
});

// Búsqueda de cuentas contables (para el selector por fila). GET /accounts?q=texto
router.get('/accounts', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const domain = q
      ? ['&', '|', ['name', 'ilike', q], ['code', 'ilike', q], ['company_ids', 'in', [ODOO_COMPANY_ID]]]
      : [['company_ids', 'in', [ODOO_COMPANY_ID]]];
    const cuentas = await odooExecuteKw('account.account', 'search_read', [domain], {
      fields: ['id', 'code', 'name', 'account_type'],
      limit: 30,
      order: 'code',
    });
    res.json(cuentas);
  } catch (err) {
    console.error('Error en /accounts:', err);
    res.status(500).json({ error: err.message });
  }
});

// Búsqueda de proveedores (para las rendiciones, que no traen CUIT). GET /partners?q=texto
// Busca por nombre o CUIT; con 2+ caracteres para no traer la agenda entera.
router.get('/partners', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const partners = await odooExecuteKw('res.partner', 'search_read', [
      ['&', '|', ['name', 'ilike', q], ['vat', 'ilike', q], '|', ['company_id', '=', false], ['company_id', '=', ODOO_COMPANY_ID]],
    ], { fields: ['id', 'name', 'vat'], limit: 30, order: 'supplier_rank desc, name' });
    res.json(partners);
  } catch (err) {
    console.error('Error en /partners:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sube el CSV, lo parsea y devuelve cada fila con su estado (ya cargada / cierra bien).
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo CSV' });

    const { filas, cuitReceptorDetectado } = parseComprobantesRecibidosCsv(req.file.buffer);

    let avisoEmpresaDistinta = null;
    if (cuitReceptorDetectado && cuitReceptorDetectado !== CUIT_PROPIO) {
      avisoEmpresaDistinta =
        `El CSV corresponde al CUIT ${cuitReceptorDetectado}, que no es el de DFLEX (${CUIT_PROPIO}). ` +
        `Puede ser un archivo de otra empresa — revisá antes de cargar.`;
    }

    const filasConEstado = await mapWithConcurrency(filas, CONCURRENCIA_MATCHING, async (fila) => {
      const cierre = validarCierre(fila);
      try {
        const estado = await conReintento(() => isComprobanteLoaded(fila));
        return { ...fila, ...estado, cierre };
      } catch (err) {
        return { ...fila, loaded: false, reason: 'error_verificando', error: err.message, cierre };
      }
    });

    res.json({ total: filasConEstado.length, filas: filasConEstado, avisoEmpresaDistinta });
  } catch (err) {
    console.error('Error en /upload:', err);
    res.status(500).json({ error: err.message });
  }
});

// Carga masiva: recibe los comprobantes seleccionados, cada uno con journalKey y accountId.
router.post('/cargar', async (req, res) => {
  const { comprobantes } = req.body; // [{ ...fila, journalKey, accountId }]
  if (!Array.isArray(comprobantes) || comprobantes.length === 0) {
    return res.status(400).json({ error: 'No se recibieron comprobantes para cargar' });
  }

  const resultados = [];
  // Secuencial a propósito: son escrituras contables reales en Odoo, mejor no paralelizar.
  for (const comprobante of comprobantes) {
    try {
      const resultado = await crearFacturaYPago(comprobante, comprobante.journalKey, comprobante.accountId);
      resultados.push({ ok: true, ...resultado });
    } catch (err) {
      resultados.push({ ok: false, comprobante, error: err.message, code: err.code || null });
    }
  }

  res.json({ resultados });
});

module.exports = router;
