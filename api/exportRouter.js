// api/exportRouter.js
//
// GET /api/export/latest  → descarga el último xlsx generado por cronExportReporte
// GET /api/export/info    → metadata sin descargar el archivo

import { Router } from 'express';
import { getLatestExportSnapshot } from '../src/db-export.js';

const router = Router();

// ── Descargar último reporte ────────────────────────────────────────────────
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
    });
  } catch (err) {
    console.error('[export] Error leyendo info:', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

export default router;