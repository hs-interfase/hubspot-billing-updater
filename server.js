// server.js
import express from 'express'
import escucharCambios from './api/escuchar-cambios.js'
import actualizarWebhook from './api/actualizar-webhook.js'

const app = express()
app.use(express.json())

app.post('/api/escuchar-cambios', escucharCambios)
app.post('/api/actualizar-webhook', actualizarWebhook)

// Health check para Railway
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }))

const PORT = process.env.PORT || 8080
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`))