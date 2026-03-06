// api/debug-urgent.js
//
// Endpoint de diagnóstico para facturación urgente + mirror UY.
// USO: POST /api/debug-urgent
// Body: { "lineItemId": "123456" }
//
// IMPORTANTE: deshabilitar o proteger con token antes de ir a producción.

import { hubspotClient } from '../src/hubspotClient.js';
import { findMirrorLineItem } from '../src/services/mirrorUtils.js';
import { mirrorDealToUruguay } from '../src/dealMirroring.js';

const DEBUG_TOKEN = process.env.DEBUG_TOKEN || null;

async function getDealIdForLineItem(lineItemId) {
  const resp = await hubspotClient.crm.associations.v4.basicApi.getPage(
    'line_items',
    String(lineItemId),
    'deals',
    10
  );
  return String((resp.results || [])[0]?.toObjectId || '').trim() || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Protección mínima por token (opcional)
  if (DEBUG_TOKEN) {
    const token = req.headers['x-debug-token'] || req.body?.token;
    if (token !== DEBUG_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const lineItemId = String(req.body?.lineItemId || '').trim();
  if (!lineItemId) {
    return res.status(400).json({ error: 'lineItemId requerido en body' });
  }

  const result = {
    lineItemId,
    steps: [],
  };

  function step(name, data) {
    result.steps.push({ step: name, ...data });
  }

  try {
    // PASO 1: Leer line item PY
    let lineItemProps;
    try {
      const li = await hubspotClient.crm.lineItems.basicApi.getById(lineItemId, [
        'name', 'uy', 'pais_operativo', 'line_item_key',
        'of_line_item_py_origen_id', 'facturar_ahora', 'billing_next_date',
      ]);
      lineItemProps = li.properties || {};
      step('1_read_line_item', {
        ok: true,
        name: lineItemProps.name,
        uy: lineItemProps.uy,
        pais_operativo: lineItemProps.pais_operativo,
        line_item_key: lineItemProps.line_item_key,
        of_line_item_py_origen_id: lineItemProps.of_line_item_py_origen_id,
        facturar_ahora: lineItemProps.facturar_ahora,
        billing_next_date: lineItemProps.billing_next_date,
      });
    } catch (err) {
      step('1_read_line_item', { ok: false, error: err?.message });
      return res.status(200).json(result);
    }

    // PASO 2: Obtener dealId
    let dealId;
    try {
      dealId = await getDealIdForLineItem(lineItemId);
      step('2_get_deal_id', { ok: !!dealId, dealId: dealId || null });
      if (!dealId) return res.status(200).json(result);
    } catch (err) {
      step('2_get_deal_id', { ok: false, error: err?.message });
      return res.status(200).json(result);
    }

    // PASO 3: Leer deal PY
    let dealProps;
    try {
      const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, [
        'dealname', 'pais_operativo', 'es_mirror_de_py',
        'deal_uy_mirror_id', 'deal_py_origen_id',
      ]);
      dealProps = deal.properties || {};
      step('3_read_deal', {
        ok: true,
        dealname: dealProps.dealname,
        pais_operativo: dealProps.pais_operativo,
        es_mirror_de_py: dealProps.es_mirror_de_py,
        deal_uy_mirror_id: dealProps.deal_uy_mirror_id,
        deal_py_origen_id: dealProps.deal_py_origen_id,
      });
    } catch (err) {
      step('3_read_deal', { ok: false, error: err?.message });
      return res.status(200).json(result);
    }

    // PASO 4: Primer intento findMirrorLineItem
    let mirror;
    try {
      mirror = await findMirrorLineItem(lineItemId);
      step('4_find_mirror_first_attempt', {
        ok: true,
        found: !!mirror,
        mirrorLineItemId: mirror?.mirrorLineItemId || null,
        mirrorDealId: mirror?.mirrorDealId || null,
      });
    } catch (err) {
      step('4_find_mirror_first_attempt', { ok: false, error: err?.message });
    }

    // PASO 5: Si no encontró mirror, correr mirrorDealToUruguay
    if (!mirror) {
      try {
        const mirrorResult = await mirrorDealToUruguay(dealId);
        step('5_mirror_deal_to_uruguay', {
          ok: true,
          mirrored: mirrorResult?.mirrored,
          targetDealId: mirrorResult?.targetDealId || null,
          reason: mirrorResult?.reason || null,
          uyLineItemsCount: mirrorResult?.uyLineItemsCount || 0,
          createdLineItems: mirrorResult?.createdLineItems || 0,
        });
      } catch (err) {
        step('5_mirror_deal_to_uruguay', { ok: false, error: err?.message });
      }

      // PASO 6: Segundo intento findMirrorLineItem
      try {
        mirror = await findMirrorLineItem(lineItemId);
        step('6_find_mirror_second_attempt', {
          ok: true,
          found: !!mirror,
          mirrorLineItemId: mirror?.mirrorLineItemId || null,
          mirrorDealId: mirror?.mirrorDealId || null,
        });
      } catch (err) {
        step('6_find_mirror_second_attempt', { ok: false, error: err?.message });
      }
    }

    // PASO 7: Si hay mirror, leer sus props
    if (mirror?.mirrorLineItemId) {
      try {
        const mirrorLi = await hubspotClient.crm.lineItems.basicApi.getById(
          mirror.mirrorLineItemId,
          ['name', 'uy', 'pais_operativo', 'of_line_item_py_origen_id',
           'line_item_key', 'billing_next_date', 'facturar_ahora']
        );
        const mp = mirrorLi.properties || {};
        step('7_read_mirror_line_item', {
          ok: true,
          mirrorLineItemId: mirror.mirrorLineItemId,
          name: mp.name,
          uy: mp.uy,
          pais_operativo: mp.pais_operativo,
          of_line_item_py_origen_id: mp.of_line_item_py_origen_id,
          line_item_key: mp.line_item_key,
          billing_next_date: mp.billing_next_date,
        });
      } catch (err) {
        step('7_read_mirror_line_item', { ok: false, error: err?.message });
      }
    }

    result.summary = mirror
      ? `Mirror encontrado: lineItemId=${mirror.mirrorLineItemId} en deal=${mirror.mirrorDealId}`
      : 'Sin mirror UY — revisar uy=true en line item PY y deal_uy_mirror_id en deal';

    return res.status(200).json(result);

  } catch (err) {
    result.fatalError = err?.message || String(err);
    return res.status(500).json(result);
  }
}