// Sección "Rendiciones" - primer paso del nexo con Planificación Planta:
// listado de rendiciones YA aprobadas por logística (izquierda) y, al
// entrar a una, el detalle de sus gastos. Todavía no cruza contra Odoo/CSV
// ARCA/email de tarjetas (eso viene en una vuelta siguiente) - por ahora es
// una vista de solo lectura de lo que logística ya validó de su lado.
const express = require('express');
const plantaDb = require('../plantaDb');

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

// Detalle de una rendición: datos del viaje + cada gasto cargado.
router.get('/:viajeId', async (req, res) => {
  try {
    const viajeId = Number(req.params.viajeId);
    const { rows: viajeRows } = await plantaDb.query(
      `select vi.id as viaje_id, vi.nombre as viaje_nombre, vi.fecha::text as viaje_fecha,
              vi.hora_salida_real, vi.hora_llegada_real, vi.rendicion_aprobada_por, vi.rendicion_aprobada_at,
              vi.fondo_efectivo, c.nombre as cuadrilla_nombre
         from public.logistica_viajes vi
         left join public.logistica_cuadrillas c on c.id = vi.cuadrilla_id
        where vi.id = $1 and vi.rendicion_aprobada_at is not null;`,
      [viajeId]
    );
    const viaje = viajeRows[0];
    if (!viaje) return res.status(404).json({ error: 'Rendición no encontrada (o todavía no aprobada por logística)' });

    const { rows: gastos } = await plantaDb.query(
      `select id, fecha::text as fecha, motivo, monto, nombre_archivo, tipo_mime, cargado_por,
              tipo_comprobante, medio_pago, estado_revision, detalle_revision, campos_inciertos, created_at
         from public.logistica_gastos
        where viaje_id = $1
        order by fecha asc, created_at asc;`,
      [viajeId]
    );

    const total = gastos.reduce((acc, g) => acc + Number(g.monto), 0);
    const totalEfectivo = gastos.filter((g) => g.medio_pago === 'efectivo').reduce((acc, g) => acc + Number(g.monto), 0);
    const fondoEfectivo = viaje.fondo_efectivo != null ? Number(viaje.fondo_efectivo) : null;
    const saldoADevolver = fondoEfectivo != null ? fondoEfectivo - totalEfectivo : null;

    res.json({ ...viaje, gastos, total, total_efectivo: totalEfectivo, saldo_a_devolver: saldoADevolver });
  } catch (err) {
    console.error('Error en GET /rendiciones/:viajeId:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
