// src/services/export/sharepointUploader.js
//
// Sube los CSV del reporte a una carpeta de SharePoint vía Microsoft Graph.
//
// Pedido de Pablo (Interfase, 31-jul): "Los csv, para que procesen nuestras aplicaciones,
// queremos que los dejes acá" → sitio `PresupuestoFacturacinyMargenBruto`, biblioteca
// `Shared Documents`, carpeta `Output Hubspot`.
//
// ⚠️ La URL que mandó Pablo es la VISTA WEB de la carpeta (…/Forms/AllItems.aspx?id=…),
// no un endpoint donde se pueda depositar. Para escribir ahí hace falta que el IT de
// ellos registre una aplicación en su Azure AD y le dé permiso sobre ese sitio. Sin esas
// credenciales este módulo queda INERTE (no rompe el cron, solo avisa que falta config).
//
// Autenticación: client credentials (app-only, sin usuario). Permiso de aplicación
// recomendado: `Sites.Selected` acotado SOLO a ese sitio (menos privilegio que
// Sites.ReadWrite.All, que da acceso a TODO SharePoint de la organización).
//
// Envs:
//   SHAREPOINT_TENANT_ID       - GUID del tenant (Directory ID)
//   SHAREPOINT_CLIENT_ID       - Application (client) ID de la app registrada
//   SHAREPOINT_CLIENT_SECRET   - secreto de esa app
//   SHAREPOINT_HOSTNAME        - default 'isaltdauy.sharepoint.com'
//   SHAREPOINT_SITE_PATH       - default '/sites/PresupuestoFacturacinyMargenBruto'
//   SHAREPOINT_FOLDER          - default 'Output Hubspot'
//   SHAREPOINT_UPLOAD_XLSX     - 'true' para subir también el Excel (default: solo CSV)

import axios from 'axios';
import logger from '../../../lib/logger.js';

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

const cfg = () => ({
  tenantId: (process.env.SHAREPOINT_TENANT_ID || '').trim(),
  clientId: (process.env.SHAREPOINT_CLIENT_ID || '').trim(),
  clientSecret: (process.env.SHAREPOINT_CLIENT_SECRET || '').trim(),
  hostname: (process.env.SHAREPOINT_HOSTNAME || 'isaltdauy.sharepoint.com').trim(),
  sitePath: (process.env.SHAREPOINT_SITE_PATH || '/sites/PresupuestoFacturacinyMargenBruto').trim(),
  folder: (process.env.SHAREPOINT_FOLDER || 'Output Hubspot').trim(),
  subirXlsx: String(process.env.SHAREPOINT_UPLOAD_XLSX || '').toLowerCase() === 'true',
});

export function sharepointConfigurado() {
  const c = cfg();
  return Boolean(c.tenantId && c.clientId && c.clientSecret);
}

// Token app-only. No se cachea entre corridas: el cron corre una vez por día.
async function getToken({ tenantId, clientId, clientSecret }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const { data } = await axios.post(`${LOGIN}/${tenantId}/oauth2/v2.0/token`, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30_000,
  });
  if (!data?.access_token) throw new Error('Azure AD no devolvió access_token');
  return data.access_token;
}

// siteId a partir de hostname + path (no hace falta conocer el GUID).
async function getSiteId(token, { hostname, sitePath }) {
  const url = `${GRAPH}/sites/${hostname}:${sitePath}`;
  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000,
  });
  if (!data?.id) throw new Error(`No se pudo resolver el sitio ${hostname}${sitePath}`);
  return data.id;
}

// Sube UN archivo por PUT simple. Graph admite hasta 4 MB así; los CSV del reporte
// pesan pocos cientos de KB. Si algún día crecen, hay que pasar a upload session.
async function subirArchivo(token, siteId, folder, filename, contenido, contentType) {
  const buf = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, 'utf8');
  if (buf.length > 4 * 1024 * 1024) {
    throw new Error(`${filename}: ${Math.round(buf.length / 1024)} KB supera el límite de 4 MB del PUT simple`);
  }
  // El ':' del path-addressing hay que cerrarlo con ':' antes del verbo (/content).
  const ruta = `${folder}/${filename}`.split('/').map(encodeURIComponent).join('/');
  const url = `${GRAPH}/sites/${siteId}/drive/root:/${ruta}:/content`;

  await axios.put(url, buf, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    timeout: 120_000,
    maxBodyLength: Infinity,
  });
  return buf.length;
}

/**
 * Sube los 3 CSV (y opcionalmente el xlsx) a la carpeta de SharePoint.
 * Nunca lanza: devuelve el resultado para que el cron siga aunque falle.
 *
 * @param {Object} args
 * @param {Object} args.csvData   - { forecast, backlog, facturado } con el CSV como string
 * @param {Buffer} [args.xlsxBuffer]
 * @param {string} [args.xlsxFilename]
 * @param {string} args.fecha     - 'YYYY-MM-DD' para nombrar los archivos
 */
export async function subirReporteASharepoint({ csvData, xlsxBuffer, xlsxFilename, fecha }) {
  const c = cfg();
  if (!sharepointConfigurado()) {
    logger.info({ module: 'sharepointUploader' },
      '[sharepoint] sin credenciales (SHAREPOINT_TENANT_ID/CLIENT_ID/CLIENT_SECRET) — no se sube nada');
    return { subido: false, motivo: 'sin_configurar' };
  }

  try {
    const token = await getToken(c);
    const siteId = await getSiteId(token, c);

    const subidos = [];
    for (const [hoja, csv] of Object.entries(csvData || {})) {
      if (csv == null) continue;
      const filename = `${hoja}_${fecha}.csv`;
      const bytes = await subirArchivo(token, siteId, c.folder, filename, csv, 'text/csv; charset=utf-8');
      subidos.push({ filename, kb: Math.round(bytes / 1024) });
    }

    if (c.subirXlsx && xlsxBuffer) {
      const bytes = await subirArchivo(token, siteId, c.folder, xlsxFilename, xlsxBuffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      subidos.push({ filename: xlsxFilename, kb: Math.round(bytes / 1024) });
    }

    logger.info({ module: 'sharepointUploader', carpeta: c.folder, subidos },
      `[sharepoint] ${subidos.length} archivo(s) subidos a "${c.folder}"`);
    return { subido: true, archivos: subidos };
  } catch (err) {
    // 401/403 => credenciales o permisos; 404 => sitio/carpeta mal escritos.
    const status = err?.response?.status;
    const detalle = err?.response?.data?.error?.message || err.message;
    logger.error({ module: 'sharepointUploader', status, detalle },
      `[sharepoint] falló la subida: ${status || ''} ${detalle}`);
    return { subido: false, motivo: 'error', status, detalle };
  }
}
