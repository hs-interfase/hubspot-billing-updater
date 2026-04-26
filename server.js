// server.js
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import rateLimit from 'express-rate-limit'
import logger from './lib/logger.js'
import { validateEnv } from './src/config/validateEnv.js'
import { verifyHubSpotSignature } from './api/hubspotSignature.js'
import escucharCambios from './api/escuchar-cambios.js'
import actualizarWebhook from './api/actualizar-webhook.js'
import auditRouter from './api/invoice-editor/audit.js'         
import { initDB } from './api/invoice-editor/Db.js'
import { initExchangeRatesTable } from './src/db.js'
import debugUrgent from './api/debugUrgent.js'  
import healthAuditRouter from './api/healthAudit.js'
// ── Nodum Upload ─────────────────────────────────
import nodumUploadRouter from './api/nodum/nodumUpload.js'
import { initNodumUploadsTable } from './api/nodum/nodumUpload.js'
// ─────────────────────────────────────────────────              

// ── Invoice Editor ──────────────────────────────
import invoiceEditorRouter from './api/invoice-editor/invoices.js'
import { invoiceEditorAuth } from './api/invoice-editor/auth.js'
// ────────────────────────────────────────────────

validateEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}))

// Rate limit para webhooks de HubSpot: máx 120 requests/minuto
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
})

// ── Rutas existentes ──
app.post('/api/escuchar-cambios', webhookLimiter, verifyHubSpotSignature, escucharCambios)
app.post('/api/actualizar-webhook', webhookLimiter, verifyHubSpotSignature, actualizarWebhook)

// ── Invoice Editor (con auth propio) ──
app.use('/invoice-editor/api/audit', invoiceEditorAuth, auditRouter)   // ← ANTES ✅
app.get('/invoice-editor/audit', invoiceEditorAuth, (req, res) => {    // ← ANTES ✅
  res.sendFile(path.join(__dirname, 'public', 'invoice-editor-audit.html'))
})
app.use('/invoice-editor/api', invoiceEditorAuth, invoiceEditorRouter) // ← DESPUÉS ✅
app.get('/invoice-editor', invoiceEditorAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invoice-editor.html'))
})

app.post('/api/debug-urgent', debugUrgent)

// ── Nodum Upload ──
app.get('/nodum', (req, res) => {                                      
  res.sendFile(path.join(__dirname, 'public', 'nodum-upload.html'))
})
app.use('/nodum', nodumUploadRouter)                                  

// ── Guía de Facturación ──
app.get('/guia', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guia-facturacion-interfase.html'))
})

// ── Static & Health ──
app.use(express.static(path.join(__dirname, 'public')))

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }))
app.use('/health/audit', healthAuditRouter)

await initDB()
await initExchangeRatesTable() 
await initNodumUploadsTable() 
const PORT = process.env.PORT || 8080
app.listen(PORT, '0.0.0.0', () => logger.info({ port: PORT }, 'Server running'))
