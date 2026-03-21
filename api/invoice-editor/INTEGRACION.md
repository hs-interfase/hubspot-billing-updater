# Integración Invoice Editor → Proyecto principal

## Qué agregar al proyecto

### 1. Archivos a copiar

```
api/invoice-editor/
├── auth.js                    ← middleware Basic Auth
├── invoices.js                ← rutas GET y PATCH
└── invoiceFields.config.json  ← campos editables (sin tocar código)

public/
└── invoice-editor.html        ← frontend completo
```

### 2. Modificar server.js

Agregar estas 4 líneas al `server.js` existente:

```js
// Imports a agregar arriba
import invoiceEditorRouter from './api/invoice-editor/invoices.js'
import { invoiceEditorAuth } from './api/invoice-editor/auth.js'

// Rutas a agregar (antes del static/health)
app.use('/invoice-editor/api', invoiceEditorAuth, invoiceEditorRouter)
app.get('/invoice-editor', invoiceEditorAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'invoice-editor.html'))
})
```

### 3. Variables de entorno (.env y Railway)

Agregar al `.env` existente:

```
APP_EDITOR_USER=admin
APP_EDITOR_PASSWORD=contrasena_segura
```

> El token de HubSpot ya existe como `HUBSPOT_PRIVATE_TOKEN` — no hay que duplicarlo.

---

## URL de acceso

Una vez deployado:

```
https://tu-app.railway.app/invoice-editor
```

El browser pedirá usuario y contraseña automáticamente (Basic Auth del navegador).

---

## Notas

- El log de auditoría se guarda en `logs/invoice-editor-audit.json` (misma carpeta `logs/` que ya usa el proyecto).
- La config de campos está en `api/invoice-editor/invoiceFields.config.json`. Se puede editar sin reiniciar (solo afecta al próximo request si el servidor hace cache, pero en este caso lee en startup — reinicio necesario al cambiar la config).
- Auth **completamente separado** del resto de la app: usa `APP_EDITOR_USER` / `APP_EDITOR_PASSWORD`, no interfiere con nada existente.
