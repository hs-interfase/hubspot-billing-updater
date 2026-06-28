// api/exportRouter.js
//
// GET /api/export/latest       → descarga el último xlsx generado por cronExportReporte
// GET /api/export/info         → metadata sin descargar el archivo
// GET /api/export/csv/:sheet   → descarga el CSV de una hoja puntual
//
// Todas las rutas protegidas con Basic Auth (mismo middleware del invoice editor).

import { Router } from 'express';
import { getLatestExportSnapshot } from '../src/db-export.js';
import { invoiceEditorAuth } from './invoice-editor/auth.js';

const router = Router();

// Lista blanca: clave de URL → nombre de hoja (solo informativo).
// El :sheet de la URL debe existir como clave acá, si no → 404.
const SHEET_KEYS = {
  forecast_debil:     'FORECAST DEBIL',
  forecast_strech:    'FORECAST En Strech',
  forecast_firme:     'FORECAST FIRME',
  forecast_pendiente: 'Forecast (pendiente)',
  listo:              'Listo para Facturar',
  facturado:          'Facturado',
};

// ── Descargar último reporte (xlsx) ─────────────────────────────────────────
router.get('/latest', async (req, res) => {
  try {
    const snapshot = await getLatestExportSnapshot();
    if (!snapshot) {
      return res.status(404).json({
        error: 'No hay reporte disponible todavía',
        hint: 'El cron de exportación corre a las 5 AM (MVD) de lunes a viernes.',
      });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.filename}"`);
    res.setHeader('X-Generated-At', snapshot.generatedAt.toISOString());
    res.setHeader('X-Row-Counts', JSON.stringify(snapshot.rowCounts));
    res.send(snapshot.xlsxData);
  } catch (err) {
    console.error('[export] Error sirviendo snapshot:', err.message);
    res.status(500).json({ error: 'Error interno al leer el reporte' });
  }
});

// ── Descargar CSV de una hoja ───────────────────────────────────────────────
router.get('/csv/:sheet', async (req, res) => {
  const sheet = req.params.sheet;

  if (!Object.prototype.hasOwnProperty.call(SHEET_KEYS, sheet)) {
    return res.status(404).json({
      error: 'Hoja inválida',
      validas: Object.keys(SHEET_KEYS),
    });
  }

  try {
    const snapshot = await getLatestExportSnapshot();
    if (!snapshot) {
      return res.status(404).json({
        error: 'No hay reporte disponible todavía',
        hint: 'El cron de exportación corre a las 5 AM (MVD) de lunes a viernes.',
      });
    }

    const csv = snapshot.csvData?.[sheet];
    if (csv == null) {
      return res.status(404).json({
        error: 'El CSV de esa hoja no está en el último snapshot',
        hint: 'Puede ser un snapshot viejo generado antes de habilitar CSVs. Esperá la próxima corrida del cron.',
      });
    }

    const fecha = snapshot.generatedAt.toISOString().slice(0, 10);
    const filename = `${sheet}_${fecha}.csv`;

    // charset=utf-8 + el BOM (ya incrustado en el string) → tildes OK en Excel.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Generated-At', snapshot.generatedAt.toISOString());
    res.send(csv);
  } catch (err) {
    console.error('[export] Error sirviendo CSV:', err.message);
    res.status(500).json({ error: 'Error interno al leer el CSV' });
  }
});

// ── Info del último reporte (sin descargar) ─────────────────────────────────
router.get('/info', async (req, res) => {
  try {
    const snapshot = await getLatestExportSnapshot();
    if (!snapshot) {
      return res.status(404).json({ available: false });
    }

    res.json({
      available: true,
      filename: snapshot.filename,
      generatedAt: snapshot.generatedAt.toISOString(),
      rowCounts: snapshot.rowCounts,
      sizeKB: Math.round(snapshot.xlsxData.length / 1024),
      csvsDisponibles: Object.keys(snapshot.csvData || {}),  // para que la web sepa qué botones habilitar
    });
  } catch (err) {
    console.error('[export] Error leyendo info:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;