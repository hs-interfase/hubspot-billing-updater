// api/parametrica/router.js
//
// API de la pantalla "Ajuste de precio por paramétrica" (/parametrica).
// Caso MVP: masivo iJServ — un % único aplicado al price de todos los LIs
// elegibles. Auth: invoiceEditorAuth (montado en server.js); usuario del
// header x-app-user (mismo criterio que invoice-editor).
//
//   GET  /line-items                        → lista elegibles + excluidos
//   POST /preview {porcentaje, lineItemIds} → crea batch 'preview' + snapshot de los ELEGIDOS
//   PUT  /preview/:id/items {lineItemIds}   → rehace la selección del preview (agrega/quita)
//   POST /preview/:id/cancel                → descarta un preview sin aplicar
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
import path from 'path';
import { fileURLToPath } from 'url';
import pool from './Db.js';
import { acquireDealLock, releaseDealLock } from '../../src/db.js';
import { sendAlertTo } from '../../lib/alertService.js';
import { calcularPriceNuevo, validarPorcentaje } from '../../src/services/parametrica/calc.js';
import {
  listarLineItemsIjserv,
  contarTicketsProtegidosFuturos,
  contarPeriodosFacturados,
  leerPriceActual,
  aplicarAjusteLineItem,
  revertirLineItem,
  crearLineItemRetroactivo,
  archivarLineItemRetroactivo,
  hoyMvd,
  IJSERV_PRODUCT_ID,
} from '../../src/services/parametrica/parametricaService.js';
import {
  parseMesAjuste,
  etiquetaMes,
  calcularRetroactivo,
  evaluarRetroactivo,
  descripcionRetro,
  MOTIVOS_RETRO,
  NOMBRE_LI_RETRO,
} from '../../src/services/parametrica/retroactivo.js';
import { isDryRun } from '../../src/config/constants.js';
import logger from '../../lib/logger.js';

const MOD = 'parametrica/router';
const router = Router();

const MAX_PCT = Number(process.env.PARAMETRICA_MAX_PCT || 30);
// Tope de antigüedad del mes del ajuste — freno a un dedazo en el año.
const MAX_MESES_RETRO = Number(process.env.PARAMETRICA_MAX_MESES_RETRO || 24);
const ALERT_TO = (process.env.PARAMETRICA_ALERT_TO || process.env.ALERT_TO_EMAIL || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const getUser = (req) => (req.headers['x-app-user'] || 'admin').toString().slice(0, 80);

// ── Extracto por email ──────────────────────────────────────
async function enviarExtracto({ accion, batch, items, usuario }) {
  const filas = items.map(it => {
    const retro = it.retro_estado === 'creado'
      ? ` | retroactivo ${it.periodos_retro} período(s) = ${it.moneda || ''} ${it.importe_retro} (LI ${it.li_retro_id})`
      : it.retro_estado === 'archivado' ? ' | retroactivo archivado'
      : it.retro_estado === 'error' ? ` | retroactivo NO creado (${it.retro_error || 'error'})`
      : '';
    return `${it.cliente_factura || it.empresa || '—'} | ${it.deal_name || '—'} (${it.deal_id || '—'}) | ` +
      `LI ${it.line_item_id} "${it.servicio || ''}" | ` +
      `${it.moneda || ''} ${it.price_viejo} → ${it.price_nuevo} | ${it.estado}` +
      `${it.error ? ` (${it.error})` : ''}${retro}`;
  });
  const ok = items.filter(i => i.estado === 'applied' || i.estado === 'reverted').length;
  const retroCreados = items.filter(i => i.retro_estado === 'creado');
  try {
    await sendAlertTo({
      to: ALERT_TO,
      level: 'info',
      title: `[Paramétrica iJServ] ${accion} ${batch.porcentaje}% — batch ${batch.id} (${ok}/${items.length} ok)`,
      meta: {
        accion,
        batch: batch.id,
        porcentaje: `${batch.porcentaje}%`,
        vigencia: batch.mes_ajuste ? `desde ${etiquetaMes(batch.mes_ajuste)}` : 'desde hoy',
        usuario,
        dry_run: batch.dry_run ? 'SÍ' : 'no',
        total_line_items: items.length,
        exitosos: ok,
        fallidos: items.length - ok,
        ...(batch.mes_ajuste ? {
          ajustes_retroactivos: `${retroCreados.length} line item(s) «${NOMBRE_LI_RETRO}» por ` +
            `${retroCreados.reduce((a, i) => a + Number(i.importe_retro || 0), 0).toFixed(2)} en total`,
        } : {}),
        detalle: filas.join('\n'),
      },
    });
  } catch (err) {
    logger.error({ module: MOD, fn: 'enviarExtracto', err: err?.message }, 'No se pudo enviar el extracto');
  }
}

// ── GET /filtros.js ─────────────────────────────────────────
// El buscador de la pantalla usa EL MISMO módulo que el backend y los tests:
// se sirve el archivo tal cual (es ESM puro, sin imports) en vez de repetir
// la lógica de matcheo dentro del HTML.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILTROS_PATH = path.join(__dirname, '..', '..', 'src', 'services', 'parametrica', 'filtros.js');

router.get('/filtros.js', (_req, res) => {
  res.type('application/javascript').sendFile(FILTROS_PATH);
});

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

// ── Helpers de preview ──────────────────────────────────────

/** Normaliza y deduplica los ids que mandó la pantalla. */
function parseSeleccion(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.map(id => String(id ?? '').trim()).filter(Boolean))];
  return ids.length ? ids : null;
}

/**
 * Calcula el ajuste retroactivo de una fila. Devuelve siempre un objeto: si no
 * corresponde, con `estado` explicando por qué (se muestra en el preview).
 */
function calcularRetroDeFila(li, pct, mes, conteos) {
  if (!mes) return { periodos: null, precio: null, importe: null, fecha: null, estado: null };

  const conteo = conteos.get(li.lineItemId) || { facturados: 0, pendientes: 0 };
  const priceNuevo = calcularPriceNuevo(li.price, pct);
  const { deltaUnitario, ajustePorPago, importe } = calcularRetroactivo({
    priceViejo: li.price, priceNuevo, cantidad: li.cantidad, periodos: conteo.facturados,
  });
  const { aplica, motivo } = evaluarRetroactivo({
    periodos: conteo.facturados, proximaFecha: li.proximaFecha, deltaUnitario,
  });

  return {
    periodos: conteo.facturados,
    pendientes: conteo.pendientes,
    deltaUnitario,
    precio: aplica ? ajustePorPago : null,   // lo que se ajusta por pago
    importe: aplica ? importe : null,        // el monto único del line item
    fecha: aplica ? li.proximaFecha : null,
    estado: aplica ? 'pendiente' : motivo,
  };
}

/** Descripción del puntual: de qué line item viene, cuántos pagos y desde cuándo. */
const descripcionDeItem = (item, mes) => descripcionRetro({
  servicio: item.servicio,
  lineItemId: item.line_item_id,
  mesLabel: mes?.label || '',
  periodos: Number(item.periodos_retro),
  ajustePorPago: Number(item.precio_retro),
  importe: Number(item.importe_retro),
  moneda: item.moneda,
});

/** Inserta el snapshot de un line item elegido en el batch. */
async function insertarItem(batchId, li, pct, retro = {}) {
  const priceNuevo = calcularPriceNuevo(li.price, pct);
  const { rows: [item] } = await pool.query(
    `INSERT INTO parametrica_items
       (batch_id, line_item_id, deal_id, deal_name, empresa, area, servicio, moneda,
        price_viejo, price_nuevo,
        entidad_facturadora, cliente_factura, codigo_empresa, numero_contrato,
        descripcion, rubro, producto, cantidad,
        periodos_retro, precio_retro, importe_retro, fecha_retro, retro_estado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (batch_id, line_item_id) DO NOTHING
     RETURNING *`,
    [batchId, li.lineItemId, li.dealId, li.dealName, li.empresa, li.area, li.servicio, li.moneda,
     li.price, priceNuevo,
     li.entidadFacturadora, li.clienteFactura, li.codigoEmpresa, li.numeroContrato,
     li.descripcion, li.rubro, li.producto, li.quantity,
     retro.periodos ?? null, retro.precio ?? null, retro.importe ?? null,
     retro.fecha ?? null, retro.estado ?? null]
  );
  return item || null;
}

/**
 * Inserta un conjunto de filas resolviendo antes, de una sola vez, cuántas
 * facturas ya salieron por line item (una búsqueda de tickets por LI).
 */
async function insertarItems(batchId, filas, pct, mes) {
  const conteos = mes
    ? await contarPeriodosFacturados(filas.map(f => f.lineItemId), mes.desde)
    : new Map();
  for (const li of filas) {
    await insertarItem(batchId, li, pct, calcularRetroDeFila(li, pct, mes, conteos));
  }
  return conteos;
}

/** Reconstruye el `mes` parseado a partir de lo guardado en el batch. */
const mesDelBatch = (batch) => batch.mes_ajuste
  ? { ym: batch.mes_ajuste, desde: `${batch.mes_ajuste}-01`, label: etiquetaMes(batch.mes_ajuste) }
  : null;

const setRetro = (id, estado, campos = {}) => pool.query(
  `UPDATE parametrica_items
      SET retro_estado = $2, li_retro_id = COALESCE($3, li_retro_id), retro_error = $4
    WHERE id = $1`,
  [id, estado, campos.liRetroId ?? null, campos.error ?? null]
);

/**
 * Crea el «Ajuste retroactivo de pago único» de una fila ya ajustada.
 * No tira: un fallo del puntual queda registrado en la fila y sale en el
 * extracto, pero no revierte el ajuste de precio que ya se aplicó bien.
 */
async function crearRetroDeItem(item, actual, batch) {
  if (item.retro_estado !== 'pendiente') return;

  const mes = mesDelBatch(batch);
  // La próxima fecha se relee del line item: entre el preview y el apply el
  // cron pudo recalcularla, y el puntual tiene que acompañar a la de verdad.
  const fecha = actual.proximaFecha || item.fecha_retro;
  if (!fecha) {
    await setRetro(item.id, 'sin_proxima_fecha');
    return;
  }

  try {
    const { id, dryRun } = await crearLineItemRetroactivo({
      origen: { properties: actual.props },
      dealId: item.deal_id,
      importe: Number(item.importe_retro),
      fecha,
      descripcion: descripcionDeItem(item, mes),
    });
    await pool.query(
      `UPDATE parametrica_items SET retro_estado = $2, li_retro_id = $3, fecha_retro = $4 WHERE id = $1`,
      [item.id, dryRun ? 'dry_run' : 'creado', id, fecha]
    );
  } catch (err) {
    await setRetro(item.id, 'error', { error: (err?.message || 'error').slice(0, 300) });
    logger.error({ module: MOD, fn: 'crearRetroDeItem', lineItemId: item.line_item_id, err: err?.message },
      'No se pudo crear el line item de ajuste retroactivo');
  }
}

/** Fila que consume la pantalla, a partir del item guardado. */
const filaPreview = (it, elegible, protegidos, mes) => ({
  lineItemId: it.line_item_id,
  dealId: it.deal_id,
  dealName: it.deal_name,
  entidadFacturadora: it.entidad_facturadora || '',
  clienteFactura: it.cliente_factura || '',
  codigoEmpresa: it.codigo_empresa || '',
  codigoContacto: elegible?.codigoContacto || '',
  numeroContrato: it.numero_contrato || '',
  empresa: it.empresa,
  descripcion: it.descripcion || '',
  area: it.area || '',
  producto: it.producto || '',
  rubro: it.rubro || '',
  servicio: it.servicio,
  moneda: it.moneda,
  priceViejo: Number(it.price_viejo),
  priceNuevo: Number(it.price_nuevo),
  fechaUltimoAjuste: elegible?.fechaUltimoAjuste || null,
  pausa: elegible?.pausa || false,
  ticketsProtegidos: protegidos.get(it.line_item_id) || null,
  // Ajuste retroactivo
  periodosRetro: it.periodos_retro,
  precioRetro: it.precio_retro != null ? Number(it.precio_retro) : null,
  importeRetro: it.importe_retro != null ? Number(it.importe_retro) : null,
  fechaRetro: it.fecha_retro || null,
  retroEstado: it.retro_estado || null,
  retroMotivo: MOTIVOS_RETRO[it.retro_estado] || null,
  liRetroId: it.li_retro_id || null,
  retroError: it.retro_error || null,
  // La descripción exacta que va a llevar el line item, para poder leerla en
  // el preview antes de confirmar.
  retroDescripcion: it.retro_estado === 'pendiente' ? descripcionDeItem(it, mes) : null,
});

/** Arma la respuesta completa de un preview leyendo sus items de la DB. */
async function responderPreview(batch, elegiblesPorId, warning) {
  const { rows: items } = await pool.query(
    `SELECT * FROM parametrica_items WHERE batch_id = $1 ORDER BY id`, [batch.id]
  );
  const protegidos = await contarTicketsProtegidosFuturos(items.map(i => i.line_item_id));
  const conRetro = items.filter(i => i.retro_estado === 'pendiente');
  return {
    batchId: batch.id,
    porcentaje: Number(batch.porcentaje),
    dryRun: batch.dry_run,
    warning: warning || null,
    totalLis: items.length,
    mesAjuste: batch.mes_ajuste || null,
    mesAjusteLabel: batch.mes_ajuste ? etiquetaMes(batch.mes_ajuste) : null,
    retro: {
      lineItems: conRetro.length,
      importeTotal: conRetro.reduce((acc, i) => acc + Number(i.importe_retro || 0), 0),
      nombre: NOMBRE_LI_RETRO,
    },
    rows: items.map(it => filaPreview(it, elegiblesPorId.get(it.line_item_id), protegidos, mesDelBatch(batch))),
  };
}

// ── POST /preview ───────────────────────────────────────────
router.post('/preview', async (req, res) => {
  try {
    const val = validarPorcentaje(req.body?.porcentaje, MAX_PCT);
    if (!val.ok) return res.status(400).json({ error: val.error });
    const pct = val.pct;

    const seleccion = parseSeleccion(req.body?.lineItemIds);
    if (!seleccion) {
      return res.status(400).json({ error: 'Elegí al menos un line item para ajustar' });
    }

    // Fecha del ajuste: OPCIONAL. Vacía = rige desde hoy y no hay retroactivo.
    // Con mes y año, lo ya facturado a precio viejo se cobra en un puntual.
    let mes = null;
    if (String(req.body?.mesAjuste ?? '').trim()) {
      const val = parseMesAjuste(req.body.mesAjuste, hoyMvd(), MAX_MESES_RETRO);
      if (!val.ok) return res.status(400).json({ error: val.error });
      mes = val;
    }

    const { elegibles } = await listarLineItemsIjserv();
    if (!elegibles.length) return res.status(400).json({ error: 'No hay line items elegibles para ajustar' });

    const elegiblesPorId = new Map(elegibles.map(li => [li.lineItemId, li]));
    const elegidos = seleccion.map(id => elegiblesPorId.get(id)).filter(Boolean);
    if (!elegidos.length) {
      return res.status(400).json({ error: 'Ninguno de los line items elegidos sigue siendo elegible — recargá la lista' });
    }
    const descartados = seleccion.length - elegidos.length;

    const { rows: [batch] } = await pool.query(
      `INSERT INTO parametrica_batches (producto_id, porcentaje, usuario, dry_run, scope, mes_ajuste)
       VALUES ($1, $2, $3, $4, 'seleccion', $5) RETURNING *`,
      [IJSERV_PRODUCT_ID, pct, getUser(req), isDryRun(), mes?.ym || null]
    );

    await insertarItems(batch.id, elegidos, pct, mes);

    const avisos = [
      val.warning,
      descartados ? `${descartados} line item(s) elegidos ya no son elegibles y quedaron fuera` : null,
    ].filter(Boolean).join(' · ');

    res.json(await responderPreview(batch, elegiblesPorId, avisos));
  } catch (err) {
    logger.error({ module: MOD, fn: 'preview', err: err?.message }, 'Error en preview');
    res.status(500).json({ error: err?.message || 'Error generando preview' });
  }
});

// ── PUT /preview/:id/items ──────────────────────────────────
// Rehace la selección de un preview ya generado: agrega los que faltan y saca
// los que sacaste. Sólo mientras el batch está en 'preview' — una vez aplicado
// no se toca (para eso está la reversa).
router.put('/preview/:id/items', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  const batchId = Number(req.params.id);
  try {
    const seleccion = parseSeleccion(req.body?.lineItemIds);
    if (!seleccion) {
      return res.status(400).json({ error: 'La previsualización no puede quedar vacía — dejá al menos un line item' });
    }

    const { rows: [batch] } = await pool.query(
      `SELECT * FROM parametrica_batches WHERE id = $1`, [batchId]
    );
    if (!batch) return res.status(404).json({ error: 'Batch no encontrado' });
    if (batch.estado !== 'preview') {
      return res.status(409).json({ error: `El batch está en estado '${batch.estado}' — ya no se puede editar` });
    }

    const { elegibles } = await listarLineItemsIjserv();
    const elegiblesPorId = new Map(elegibles.map(li => [li.lineItemId, li]));
    const elegidos = seleccion.filter(id => elegiblesPorId.has(id));
    if (!elegidos.length) {
      return res.status(400).json({ error: 'Ninguno de los line items elegidos sigue siendo elegible — recargá la lista' });
    }

    // Fuera los que sacaste (sólo 'pending': en un preview no hay otro estado).
    await pool.query(
      `DELETE FROM parametrica_items
       WHERE batch_id = $1 AND estado = 'pending' AND NOT (line_item_id = ANY($2::text[]))`,
      [batchId, elegidos]
    );
    // Y adentro los que agregaste (ON CONFLICT ignora los que ya estaban, así
    // que sólo los nuevos pagan el conteo de facturas del retroactivo).
    const { rows: yaEstan } = await pool.query(
      `SELECT line_item_id FROM parametrica_items WHERE batch_id = $1`, [batchId]
    );
    const conocidos = new Set(yaEstan.map(r => r.line_item_id));
    const nuevos = elegidos.filter(id => !conocidos.has(id)).map(id => elegiblesPorId.get(id));
    await insertarItems(batchId, nuevos, Number(batch.porcentaje), mesDelBatch(batch));

    const descartados = seleccion.length - elegidos.length;
    res.json(await responderPreview(batch, elegiblesPorId,
      descartados ? `${descartados} line item(s) elegidos ya no son elegibles y quedaron fuera` : null));
  } catch (err) {
    logger.error({ module: MOD, fn: 'preview-items', batchId, err: err?.message }, 'Error editando preview');
    res.status(500).json({ error: err?.message || 'Error editando la previsualización' });
  }
});

// ── POST /preview/:id/cancel ────────────────────────────────
// Descarta un preview sin aplicarlo, para que no quede colgado en el historial.
router.post('/preview/:id/cancel', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const { rows: [batch] } = await pool.query(
      `UPDATE parametrica_batches SET estado = 'cancelled'
       WHERE id = $1 AND estado = 'preview' RETURNING *`,
      [req.params.id]
    );
    if (!batch) return res.status(409).json({ error: 'El batch ya fue procesado (o no existe)' });
    res.json({ estado: batch.estado });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Error cancelando la previsualización' });
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
            // El retroactivo va DESPUÉS del ajuste y sólo si el ajuste salió
            // bien: si falla el puntual, el precio nuevo igual queda aplicado
            // y la fila lo dice, en vez de dejar el lote a medias.
            await crearRetroDeItem(it, actual, batch);
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
      mesAjuste: batch.mes_ajuste || null,
      mesAjusteLabel: batch.mes_ajuste ? etiquetaMes(batch.mes_ajuste) : null,
      items: finalItems.map(i => ({
        lineItemId: i.line_item_id, dealId: i.deal_id, dealName: i.deal_name, empresa: i.empresa,
        entidadFacturadora: i.entidad_facturadora || '', clienteFactura: i.cliente_factura || '',
        codigoEmpresa: i.codigo_empresa || '', numeroContrato: i.numero_contrato || '',
        descripcion: i.descripcion || '', area: i.area || '',
        producto: i.producto || '', rubro: i.rubro || '',
        servicio: i.servicio, moneda: i.moneda,
        priceViejo: Number(i.price_viejo), priceNuevo: Number(i.price_nuevo),
        estado: i.estado, error: i.error,
        periodosRetro: i.periodos_retro,
        importeRetro: i.importe_retro != null ? Number(i.importe_retro) : null,
        fechaRetro: i.fecha_retro || null,
        retroEstado: i.retro_estado || null,
        retroMotivo: MOTIVOS_RETRO[i.retro_estado] || null,
        liRetroId: i.li_retro_id || null,
        retroError: i.retro_error || null,
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
            // Si el ajuste generó un retroactivo, ese cobro tampoco corresponde.
            if (it.li_retro_id && it.retro_estado === 'creado') {
              try {
                await archivarLineItemRetroactivo(it.li_retro_id);
                await setRetro(it.id, 'archivado');
              } catch (err) {
                await setRetro(it.id, 'creado', {
                  error: `no se pudo archivar el retroactivo: ${(err?.message || 'error').slice(0, 200)}`,
                });
                logger.error({ module: MOD, fn: 'revert', liRetroId: it.li_retro_id, err: err?.message },
                  'Reversa: quedó vivo el line item de ajuste retroactivo');
              }
            }
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
