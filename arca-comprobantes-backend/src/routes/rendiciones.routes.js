// Sección "Rendiciones" - nexo con Planificación Planta: listado de
// rendiciones YA aprobadas por logística (izquierda) y, al entrar a una, el
// detalle de sus gastos. Mientras no esté conectado el correo de pagos con
// tarjeta, desde acá se mandan los gastos a Odoo a mano (factura + pago en
// borrador, ver services/rendicionOdooLoader.js). La base de Planta se lee,
// nunca se escribe.
const express = require('express');
const plantaDb = require('../plantaDb');
const { crearBorradorDesdeGasto, buscarGastosCargados } = require('../services/rendicionOdooLoader');

const router = express.Router();

// Una fila por viaje con rendición aprobada, con el total ya sumado.
router.get('/', async (req, res) => {
  try {
    const { rows } = await plantaDb.query(
      `select vi.id as viaje_id, vi.nombre as viaje_nombre, vi.fecha::text as viaje_fecha,
              vi.rendicion_aprobada_por, vi.rendicion_aprobada_at, vi.fondo_efectivo,
              c.nombre as cuadrilla_nombre,
              count(g.id)::int as cantidad_gastos,
              coalesce(sum(g.monto), 0) as total,
              coalesce(sum(g.monto) filter (where g.medio_pago = 'efectivo'), 0) as total_efectivo
         from public.logistica_viajes vi
         join public.logistica_gastos g on g.viaje_id = vi.id
         left join public.logistica_cuadrillas c on c.id = vi.cuadrilla_id
        where vi.rendicion_aprobada_at is not null
        group by vi.id, vi.nombre, vi.fecha, vi.rendicion_aprobada_por, vi.rendicion_aprobada_at, vi.fondo_efectivo, c.nombre
        order by vi.rendicion_aprobada_at desc;`
    );
    const rendiciones = rows.map((r) => ({
      ...r,
      saldo_a_devolver: r.fondo_efectivo != null ? Number(r.fondo_efectivo) - Number(r.total_efectivo) : null,
    }));
    res.json({ rendiciones });
  } catch (err) {
    console.error('Error en GET /rendiciones:', err);
    res.status(500).json({ error: err.message });
  }
});

async function leerViajeAprobado(viajeId) {
  const { rows } = await plantaDb.query(
    `select vi.id as viaje_id, vi.nombre as viaje_nombre, vi.fecha::text as viaje_fecha,
            vi.hora_salida_real, vi.hora_llegada_real, vi.rendicion_aprobada_por, vi.rendicion_aprobada_at,
            vi.fondo_efectivo, c.nombre as cuadrilla_nombre
       from public.logistica_viajes vi
       left join public.logistica_cuadrillas c on c.id = vi.cuadrilla_id
      where vi.id = $1 and vi.rendicion_aprobada_at is not null;`,
    [viajeId]
  );
  return rows[0] || null;
}

async function leerGastos(viajeId) {
  const { rows } = await plantaDb.query(
    `select id, fecha::text as fecha, motivo, monto, storage_path, nombre_archivo, tipo_mime, cargado_por,
            tipo_comprobante, medio_pago, estado_revision, detalle_revision, campos_inciertos, created_at
       from public.logistica_gastos
      where viaje_id = $1
      order by fecha asc, created_at asc;`,
    [viajeId]
  );
  return rows;
}

// Detalle de una rendición: datos del viaje + cada gasto cargado, con su estado en Odoo.
router.get('/:viajeId', async (req, res) => {
  try {
    const viajeId = Number(req.params.viajeId);
    const viaje = await leerViajeAprobado(viajeId);
    if (!viaje) return res.status(404).json({ error: 'Rendición no encontrada (o todavía no aprobada por logística)' });

    const gastosDb = await leerGastos(viajeId);

    // Si Odoo no responde, el detalle se muestra igual pero sin poder enviar
    // (no se sabe qué ya está cargado y no queremos duplicar).
    let cargados = new Map();
    let errorOdoo = null;
    try {
      cargados = await buscarGastosCargados(gastosDb.map((g) => g.id));
    } catch (err) {
      errorOdoo = `No se pudo consultar Odoo: ${err.message}`;
    }

    const gastos = gastosDb.map(({ storage_path, ...g }) => ({ ...g, odoo: cargados.get(g.id) || null }));

    const total = gastos.reduce((acc, g) => acc + Number(g.monto), 0);
    const totalEfectivo = gastos.filter((g) => g.medio_pago === 'efectivo').reduce((acc, g) => acc + Number(g.monto), 0);
    const fondoEfectivo = viaje.fondo_efectivo != null ? Number(viaje.fondo_efectivo) : null;
    const saldoADevolver = fondoEfectivo != null ? fondoEfectivo - totalEfectivo : null;

    res.json({ ...viaje, gastos, total, total_efectivo: totalEfectivo, saldo_a_devolver: saldoADevolver, error_odoo: errorOdoo });
  } catch (err) {
    console.error('Error en GET /rendiciones/:viajeId:', err);
    res.status(500).json({ error: err.message });
  }
});

// Envía a Odoo los gastos seleccionados: body { gastos: [{ gastoId, partnerId, accountId, journalKey }] }.
// Fecha, monto y comprobante se toman SIEMPRE de la base de Planta, no del navegador.
router.post('/:viajeId/cargar', async (req, res) => {
  try {
    const viajeId = Number(req.params.viajeId);
    const pedidos = Array.isArray(req.body?.gastos) ? req.body.gastos : [];
    if (!pedidos.length) return res.status(400).json({ error: 'No se recibieron gastos para enviar' });

    const viaje = await leerViajeAprobado(viajeId);
    if (!viaje) return res.status(404).json({ error: 'Rendición no encontrada (o todavía no aprobada por logística)' });

    const gastosPorId = new Map((await leerGastos(viajeId)).map((g) => [g.id, g]));
    const cargados = await buscarGastosCargados(pedidos.map((p) => p.gastoId));

    const resultados = [];
    // Secuencial a propósito, igual que el importador: son escrituras reales en Odoo.
    for (const pedido of pedidos) {
      const gasto = gastosPorId.get(Number(pedido.gastoId));
      if (!gasto) {
        resultados.push({ ok: false, gastoId: pedido.gastoId, error: 'El gasto no pertenece a esta rendición.' });
        continue;
      }
      if (cargados.has(gasto.id)) {
        resultados.push({ ok: false, gastoId: gasto.id, code: 'ya_cargado', error: `Ya estaba cargado en Odoo (${cargados.get(gasto.id).name}).` });
        continue;
      }
      try {
        const r = await crearBorradorDesdeGasto(gasto, viaje, {
          partnerId: Number(pedido.partnerId),
          accountId: Number(pedido.accountId),
          journalKey: pedido.journalKey,
        });
        resultados.push({ ok: true, gastoId: gasto.id, ...r });
      } catch (err) {
        resultados.push({ ok: false, gastoId: gasto.id, error: err.message });
      }
    }

    res.json({ resultados });
  } catch (err) {
    console.error('Error en POST /rendiciones/:viajeId/cargar:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
