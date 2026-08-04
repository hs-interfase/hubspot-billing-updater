// src/services/parametrica/empresaLookup.js
//
// Resuelve, por negocio, la EMPRESA que se factura y su código — datos que la
// pantalla de paramétricas necesita para el buscador y las columnas, y que NO
// viven en el line item.
//
// "Cliente factura" = la company asociada al deal con la etiqueta «Empresa
// Factura»; si el deal no la tiene, se cae a la company principal (mismo
// criterio que resolveDealCompanies() de cronExportReporte.js).
//
// "Código de empresa" = `codigo_cliente_nodum` ← el «Codigo Empresa» del origen,
// que es LA CLAVE (identifica la sucursal). `codigo_empresa_contactos` es el
// «Codigo Contacto» y NUNCA es clave de empresa — se lee igual porque los dos
// comparten rango numérico y quien busca puede tener a mano el equivocado.

import { hubspotClient } from '../../hubspotClient.js';
import { ASSOC_LABEL_EMPRESA_FACTURA } from '../../config/constants.js';
import logger from '../../../lib/logger.js';

const MOD = 'parametrica/empresaLookup';

// typeId de la asociación primaria deal→company (estándar de HubSpot).
const ASSOC_PRIMARY_COMPANY = 5;

const COMPANY_PROPS = ['name', 'codigo_cliente_nodum', 'codigo_empresa_contactos'];

/** typeIds de una entrada `to` de la v4 (batch y basic traen formas distintas). */
function typeIdsDe(to) {
  const tipos = to?.associationTypes || to?.associationSpec || [];
  const lista = Array.isArray(tipos) ? tipos : [tipos];
  return lista
    .map(t => t?.typeId ?? t?.associationTypeId)
    .filter(t => t != null)
    .map(Number);
}

/**
 * Elige qué company representa al cliente que se factura:
 * etiqueta «Empresa Factura» → company principal → la primera que haya.
 */
export function elegirCompanyFactura(tos = []) {
  let facturaId = null;
  let primaryId = null;

  for (const to of tos) {
    const companyId = String(to?.toObjectId || '');
    if (!companyId) continue;
    const tipos = typeIdsDe(to);
    if (tipos.includes(ASSOC_LABEL_EMPRESA_FACTURA)) facturaId = companyId;
    else if (tipos.includes(ASSOC_PRIMARY_COMPANY)) primaryId = companyId;
    else if (!primaryId && !tipos.length) primaryId = companyId;
  }

  if (facturaId) return facturaId;
  if (primaryId) return primaryId;
  const primera = tos.find(t => t?.toObjectId);
  return primera ? String(primera.toObjectId) : null;
}

/**
 * Para una lista de deals, resuelve la empresa que se factura y sus códigos.
 * Un fallo de HubSpot no rompe la pantalla: el deal queda sin datos de empresa.
 *
 * @param {string[]} dealIds
 * @returns {Promise<Map<string, {companyId, clienteFactura, codigoEmpresa, codigoContacto}>>}
 */
export async function resolveEmpresasPorDeal(dealIds) {
  const out = new Map();
  const ids = [...new Set((dealIds || []).map(String).filter(Boolean))];
  if (!ids.length) return out;

  // 1) deal → companies (con etiquetas)
  const companyPorDeal = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const inputs = ids.slice(i, i + 100).map(id => ({ id }));
    try {
      const resp = await hubspotClient.crm.associations.v4.batchApi.getPage(
        'deals', 'companies', { inputs }
      );
      for (const item of resp?.results || []) {
        const dealId = String(item?._from?.id || item?.from?.id || '');
        if (!dealId) continue;
        const companyId = elegirCompanyFactura(item?.to || []);
        if (companyId) companyPorDeal.set(dealId, companyId);
      }
    } catch (err) {
      logger.warn({ module: MOD, fn: 'resolveEmpresasPorDeal', err: err?.message },
        'No se pudieron leer las empresas de un lote de negocios — quedan sin datos de empresa');
    }
  }

  // 2) companies → nombre + códigos
  const companyIds = [...new Set(companyPorDeal.values())];
  const companies = new Map();
  for (let i = 0; i < companyIds.length; i += 100) {
    const inputs = companyIds.slice(i, i + 100).map(id => ({ id }));
    try {
      const resp = await hubspotClient.crm.companies.batchApi.read(
        { inputs, properties: COMPANY_PROPS }, false
      );
      for (const c of resp?.results || []) {
        const p = c.properties || {};
        companies.set(String(c.id), {
          clienteFactura: p.name || '',
          codigoEmpresa: p.codigo_cliente_nodum || '',
          codigoContacto: p.codigo_empresa_contactos || '',
        });
      }
    } catch (err) {
      logger.warn({ module: MOD, fn: 'resolveEmpresasPorDeal', err: err?.message },
        'No se pudo leer un lote de empresas — quedan sin nombre ni código');
    }
  }

  for (const [dealId, companyId] of companyPorDeal) {
    const datos = companies.get(companyId) || { clienteFactura: '', codigoEmpresa: '', codigoContacto: '' };
    out.set(dealId, { companyId, ...datos });
  }
  return out;
}
