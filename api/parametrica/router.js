// api/parametrica/router.js
//
// API de la pantalla "Ajuste de precio por paramétrica" (/parametrica).
// Caso MVP: masivo iJServ — un % único aplicado al price de todos los LIs
// elegibles. Auth: invoiceEditorAuth (montado en server.js); usuario del
// header x-app-user (mismo criterio que invoice-editor).
//
//   GET  /line-items          → lista elegibles + excluidos (espejos, deals no activos)
//   POST /preview {porcentaje}→ crea batch 'preview' + snapshot de items
//   POST /apply   {batchId, confirm:true}
//   POST /revert  {batchId, lineItemId?}   (lote completo o un LI)
//   GET  /batches             → historial (para reversa y CSV)
//   GET  /batches/:id         → detalle con items
//
// Guards:
//   - Doble click / re-aplicación: transición atómica preview→applying en DB
//     (segundo request → 409) + re-lectura del price actual antes de escribir
//     cada LI (si difiere del snapshot → failed price_changed).
//   - Concurrencia con el cron: acquireDealLock por deal (label 'parametrica').

import { Router } from 'express';
import pool from './Db.js';
import { acquireDealLock, releaseDealLock } from '../../src/db.js';
import { sendAlertTo } from '../../lib/alertService.js';
import { calcularPriceNuevo, validarPorcentaje } from '../../src/services/parametrica/calc.js';
import {
  listarLineItemsIjserv,
  contarTicketsProtegidosFuturos,
  leerPriceActual,
  aplicarAjusteLineItem,
  revertirLineItem,
  IJSERV_PRODUCT_ID,
} from '../../src/services/parametrica/parametricaService.js';
import { isDryRun } from '../../src/config/constants.js';
import logger from '../../lib/logger.js';

const MOD = 'parametrica/router';
const router = Router();

const MAX_PCT = Number(process.env.PARAMETRICA_MAX_PCT || 30);
const ALERT_TO = (process.env.PARAMETRICA_ALERT_TO || process.env.ALERT_TO_EMAIL || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const getUser = (req) => (req.headers['x-app-user'] || 'admin').toString().slice(0, 80);

// ── Extracto por email ──────────────────────────────────────
async function enviarExtracto({ accion, batch, items, usuario }) {
  const filas = items.map(it =>
    `${it.empresa || '—'} | ${it.deal_name || '—'} (${it.deal_id || '—'}) | LI ${it.line_item_id} "${it.servicio || ''}" | ` +
    `${it.moneda || ''} ${it.price_viejo} → ${it.price_nuevo} | ${it.estado}${it.error ? ` (${it.error})` : ''}`
  );
  const ok = items.filter(i => i.estado === 'applied' || i.estado === 'reverted').length;
  try {
    await sendAlertTo({
      to: ALERT_TO,
      level: 'info',
      title: `[Paramétrica iJServ] ${accion} ${batch.porcentaje}% — batch ${batch.id} (${ok}/${items.length} ok)`,
      meta: {
        accion,
        batch: batch.id,
        porcentaje: `${batch.porcentaje}%`,
        usuario,
        dry_run: batch.dry_run ? 'SÍ' : 'no',
        total_line_items: items.length,
        exitosos: ok,
        fallidos: items.length - ok,
        detalle: filas.join('\n'),
      },
    });
  } catch (err) {
    logger.error({ module: MOD, fn: 'enviarExtracto', err: err?.message }, 'No se pudo enviar el extracto');
  }
}

// ── GET /line-items ─────────────────────────────────────────
router.get('/line-items', async (_req, res) => {
  try {
    const data = await listarLineItemsIjserv();
    res.json(data);
  } catch (err) {
    logger.error({ module: MOD, fn: 'line-items', err: err?.message }, 'Error listando LIs iJServ');
    res.status(500).json({ error: err?.message || 'Error listando line items' });
  }
});

// ── POST /preview ───────────────────────────────────────────
router.post('/preview', async (req, res) => {
  try {
    const val = validarPorcentaje(req.body?.porcentaje, MAX_PCT);
    if (!val.ok) return res.status(400).json({ error: val.error });
    const pct = val.pct;

    const { elegibles } = await listarLineItemsIjserv();
    if (!elegibles.length) return res.status(400).json({ error: 'No hay line items elegibles para ajustar' });

    const usuario = getUser(req);
    const dryRun = isDryRun();

    const { rows: [batch] } = await pool.query(
      `INSERT INTO parametrica_batches (producto_id, porcentaje, usuario, dry_run)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [IJSERV_PRODUCT_ID, pct, usuario, dryRun]
    );

    const items = [];
    for (const li of elegibles) {
      const priceNuevo = calcularPriceNuevo(li.price, pct);
      const { rows: [item] } = await pool.query(
        `INSERT INTO parametrica_items
           (batch_id, line_item_id, deal_id, deal_name, empresa, area, servicio, moneda, price_viejo, price_nuevo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [batch.id, li.lineItemId, li.dealId, li.dealName, li.empresa, li.area, li.servicio, li.moneda, li.price, priceNuevo]
      );
      items.push({ ...item, pausa: li.pausa });
    }

    const protegidos = await contarTicketsProtegidosFuturos(elegibles.map(li => li.lineItemId));

    res.json({
      batchId: batch.id,
      porcentaje: pct,
      dryRun,
      warning: val.warning || null,
      totalLis: items.length,
      rows: items.map(it => ({
        lineItemId: it.line_item_id,
        dealName: it.deal_name,
        empresa: it.empresa,
        servicio: it.servicio,
        moneda: it.moneda,
        priceViejo: Number(it.price_viejo),
        priceNuevo: Number(it.price_nuevo),
        pausa: it.pausa || false,
        ticketsProtegidos: protegidos.get(it.line_item_id) || null,
      })),
    });
  } catch (err) {
    logger.error({ module: MOD, fn: 'preview', err: err?.message }, 'Error en preview');
    res.status(500).json({ error: err?.message || 'Error generando preview' });
  }
});

// ── POST /apply ─────────────────────────────────────────────
router.post('/apply', async (req, res) => {
  const { batchId, confirm } = req.body || {};
  if (!batchId || confirm !== true) {
    return res.status(400).json({ error: 'Falta batchId o confirm:true' });
  }
  try {
    // Guard atómico anti doble-click / re-aplicación
    const { rows: [batch] } = await pool.query(
      `UPDATE parametrica_batches SET estado = 'applying'
       WHERE id = $1 AND estado = 'preview' RETURNING *`,
      [batchId]
    );
    if (!batch) return res.status(409).json({ error: 'El batch ya fue procesado (o no existe)' });

    const { rows: items } = await pool.query(
      `SELECT * FROM parametrica_items WHERE batch_id = $1 AND estado = 'pending' ORDER BY id`,
      [batchId]
    );

    // Agrupar por deal para tomar el lock una sola vez por deal
    const porDeal = new Map();
    for (const it of items) {
      const key = it.deal_id || `li-${it.line_item_id}`;
      if (!porDeal.has(key)) porDeal.set(key, []);
      porDeal.get(key).push(it);
    }

    const setItem = (id, estado, error = null) => pool.query(
      `UPDATE parametrica_items SET estado = $2, error = $3,
              applied_at = CASE WHEN $2 = 'applied' THEN NOW() ELSE applied_at END
       WHERE id = $1`,
      [id, estado, error]
    );

    for (const [dealKey, dealItems] of porDeal) {
      const dealId = dealItems[0].deal_id;
      let lockToken = null;

      if (dealId) {
        for (let intento = 0; intento < 3 && !lockToken; intento++) {
          lockToken = await acquireDealLock(dealId, 'parametrica');
          if (!lockToken) await new Promise(r => setTimeout(r, 700 * (intento + 1)));
        }
        if (!lockToken) {
          for (const it of dealItems) await setItem(it.id, 'failed', 'deal_locked');
          logger.warn({ module: MOD, fn: 'apply', dealId, batchId }, 'Deal lockeado — items marcados failed');
          continue;
        }
      }

      try {
        for (const it of dealItems) {
          try {
            const actual = await leerPriceActual(it.line_item_id);
            if (actual.price == null || Math.abs(actual.price - Number(it.price_viejo)) > 0.005) {
              await setItem(it.id, 'failed', `price_changed (actual: ${actual.price})`);
              continue;
            }
            await aplicarAjusteLineItem({
              lineItemId: it.line_item_id,
              priceViejo: Number(it.price_viejo),
              priceNuevo: Number(it.price_nuevo),
              pct: Number(batch.porcentaje),
              montoUnitarioOriginal: actual.montoUnitarioOriginal,
            });
            await setItem(it.id, 'applied');
          } catch (err) {
            await setItem(it.id, 'failed', (err?.message || 'error').slice(0, 300));
            logger.error({ module: MOD, fn: 'apply', lineItemId: it.line_item_id, err: err?.message }, 'Fallo aplicando LI');
          }
        }
      } finally {
        if (lockToken && dealId) await releaseDealLock(dealId, lockToken);
      }
    }

    const { rows: finalItems } = await pool.query(
      `SELECT * FROM parametrica_items WHERE batch_id = $1 ORDER BY id`, [batchId]
    );
    const aplicados = finalItems.filter(i => i.estado === 'applied').length;
    const fallidos = finalItems.filter(i => i.estado === 'failed').length;
    const estadoFinal = aplicados === 0 ? 'failed' : (fallidos > 0 ? 'partial' : 'applied');

    await pool.query(
      `UPDATE parametrica_batches SET estado = $2, applied_at = NOW() WHERE id = $1`,
      [batchId, estadoFinal]
    );

    await enviarExtracto({
      accion: batch.dry_run ? 'DRY-RUN Ajuste' : 'Ajuste aplicado',
      batch, items: finalItems, usuario: getUser(req),
    });

    res.json({
      estado: estadoFinal,
      aplicados,
      fallidos,
      items: finalItems.map(i => ({
        lineItemId: i.line_item_id, dealName: i.deal_name, empresa: i.empresa,
        servicio: i.servicio, moneda: i.moneda,
        priceViejo: Number(i.price_viejo), priceNuevo: Number(i.price_nuevo),
        estado: i.estado, error: i.error,
      })),
    });
  } catch (err) {
    logger.error({ module: MOD, fn: 'apply', batchId, err: err?.message }, 'Error en apply');
    res.status(500).json({ error: err?.message || 'Error aplicando ajuste' });
  }
});

// ── POST /revert ────────────────────────────────────────────
router.post('/revert', async (req, res) => {
  const { batchId, lineItemId } = req.body || {};
  if (!batchId) return res.status(400).json({ error: 'Falta batchId' });
  try {
    const { rows: [batch] } = await pool.query(
      `SELECT * FROM parametrica_batches WHERE id = $1`, [batchId]
    );
    if (!batch) return res.status(404).json({ error: 'Batch no encontrado' });
    if (!['applied', 'partial', 'reverted_partial'].includes(batch.estado)) {
      return res.status(409).json({ error: `El batch está en estado '${batch.estado}' — no hay nada para revertir` });
    }

    const params = lineItemId ? [batchId, String(lineItemId)] : [batchId];
    const { rows: items } = await pool.query(
      `SELECT * FROM parametrica_items
       WHERE batch_id = $1 AND estado = 'applied' ${lineItemId ? 'AND line_item_id = $2' : ''}
       ORDER BY id`,
      params
    );
    if (!items.length) {
      return res.status(409).json({ error: 'No hay items aplicados para revertir (¿ya se revirtieron?)' });
    }

    const setItem = (id, estado, error = null) => pool.query(
      `UPDATE parametrica_items SET estado = $2, error = $3,
              reverted_at = CASE WHEN $2 = 'reverted' THEN NOW() ELSE reverted_at END
       WHERE id = $1`,
      [id, estado, error]
    );

    const porDeal = new Map();
    for (const it of items) {
      const key = it.deal_id || `li-${it.line_item_id}`;
      if (!porDeal.has(key)) porDeal.set(key, []);
      porDeal.get(key).push(it);
    }

    for (const [, dealItems] of porDeal) {
      const dealId = dealItems[0].deal_id;
      let lockToken = null;
      if (dealId) {
        for (let intento = 0; intento < 3 && !lockToken; intento++) {
          lockToken = await acquireDealLock(dealId, 'parametrica-revert');
          if (!lockToken) await new Promise(r => setTimeout(r, 700 * (intento + 1)));
        }
        if (!lockToken) {
          for (const it of dealItems) await setItem(it.id, 'applied', 'revert_deal_locked');
          continue;
        }
      }
      try {
        for (const it of dealItems) {
          try {
            const actual = await leerPriceActual(it.line_item_id);
            if (actual.price == null || Math.abs(actual.price - Number(it.price_nuevo)) > 0.005) {
              await setItem(it.id, 'revert_failed', `price_changed_since_apply (actual: ${actual.price})`);
              continue;
            }
            await revertirLineItem({ lineItemId: it.line_item_id, priceViejo: Number(it.price_viejo) });
            await setItem(it.id, 'reverted');
          } catch (err) {
            await setItem(it.id, 'revert_failed', (err?.message || 'error').slice(0, 300));
          }
        }
      } finally {
        if (lockToken && dealId) await releaseDealLock(dealId, lockToken);
      }
    }

    const { rows: finalItems } = await pool.query(
      `SELECT * FROM parametrica_items WHERE batch_id = $1 ORDER BY id`, [batchId]
    );
    const quedanAplicados = finalItems.some(i => i.estado === 'applied');
    const huboRevertidos = finalItems.some(i => i.estado === 'reverted');
    const estadoFinal = huboRevertidos && !quedanAplicados ? 'reverted'
      : huboRevertidos ? 'reverted_partial' : batch.estado;

    await pool.query(
      `UPDATE parametrica_batches SET estado = $2, reverted_at = NOW() WHERE id = $1`,
      [batchId, estadoFinal]
    );

    const revertidosAhora = finalItems.filter(i =>
      items.some(orig => orig.id === i.id)
    );
    await enviarExtracto({
      accion: lineItemId ? `Reversa LI ${lineItemId}` : 'Reversa de lote',
      batch: { ...batch, estado: estadoFinal }, items: revertidosAhora, usuario: getUser(req),
    });

    res.json({
      estado: estadoFinal,
      revertidos: revertidosAhora.filter(i => i.estado === 'reverted').length,
      fallidos: revertidosAhora.filter(i => i.estado === 'revert_failed').length,
      items: revertidosAhora.map(i => ({
        lineItemId: i.line_item_id, estado: i.estado, error: i.error,
        priceViejo: Number(i.price_viejo), priceNuevo: Number(i.price_nuevo),
      })),
    });
  } catch (err) {
    logger.error({ module: MOD, fn: 'revert', batchId, err: err?.message }, 'Error en revert');
    res.status(500).json({ error: err?.message || 'Error revirtiendo' });
  }
});

// ── GET /batches ────────────────────────────────────────────
router.get('/batches', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT b.*,
             COUNT(i.id)::int                                        AS total_items,
             COUNT(i.id) FILTER (WHERE i.estado = 'applied')::int    AS aplicados,
             COUNT(i.id) FILTER (WHERE i.estado = 'reverted')::int   AS revertidos,
             COUNT(i.id) FILTER (WHERE i.estado LIKE '%failed%')::int AS fallidos
      FROM parametrica_batches b
      LEFT JOIN parametrica_items i ON i.batch_id = b.id
      GROUP BY b.id ORDER BY b.id DESC LIMIT 100
    `);
    res.json({ batches: rows });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Error listando batches' });
  }
});

// ── GET /batches/:id ────────────────────────────────────────
router.get('/batches/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const { rows: [batch] } = await pool.query(
      `SELECT * FROM parametrica_batches WHERE id = $1`, [req.params.id]
    );
    if (!batch) return res.status(404).json({ error: 'Batch no encontrado' });
    const { rows: items } = await pool.query(
      `SELECT * FROM parametrica_items WHERE batch_id = $1 ORDER BY id`, [req.params.id]
    );
    res.json({ batch, items });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Error leyendo batch' });
  }
});

export default router;
