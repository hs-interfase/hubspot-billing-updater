// server.js
import express from 'express'
import escucharCambios from './api/escuchar-cambios.js'
import actualizarWebhook from './api/actualizar-webhook.js'

const app = express()
app.use(express.json())

app.post('/api/escuchar-cambios', escucharCambios)
app.post('/api/actualizar-webhook', actualizarWebhook)

const PORT = process.env.PORT || 8080
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))