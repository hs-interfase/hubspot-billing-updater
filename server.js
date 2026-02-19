// server.js
import express from 'express'
import { createRequire } from 'module'
import escucharCambios from './api/escuchar-cambios.js'
import actualizarWebhook from './api/actualizar-webhook.js'

const require = createRequire(import.meta.url)
const updateBilling = require('./api/update-billing.js')

const app = express()
app.use(express.json())

app.post('/api/escuchar-cambios', escucharCambios)
app.post('/api/actualizar-webhook', actualizarWebhook)
app.post('/api/update-billing', updateBilling)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))