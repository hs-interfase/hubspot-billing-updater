# Capítulo 2 — README / Overview

## Qué es hubspot-billing-updater

Motor de automatización de facturación que orquesta el ciclo completo de billing dentro de HubSpot Pro CRM, integrado con el ERP Nodum. Desarrollado para **Interfase**, con operaciones en Uruguay y Paraguay.

No es un simple generador de facturas. Es un sistema de orquestación que normaliza fechas, genera promesas de facturación (forecast), promueve tickets, emite facturas, gestiona cupo, maneja espejos PY→UY, y corrige inconsistencias — todo bajo un modelo idempotente y convergente.

---

## Stack tecnológico

### Runtime y hosting

- **Node.js** con ESModules (`"type": "module"` en package.json)
- **Express 5** como servidor HTTP
- **Railway** para deployment (servidor + PostgreSQL + crons)

### Integraciones externas

- **HubSpot Pro** (Sales Hub + Service Hub): CRM principal. Se accede mediante el SDK oficial (`@hubspot/api-client` v13) y axios para llamadas directas
- **Nodum**: ERP de facturación (Uruguay). Integración vía SOAP web services y upload de archivos `.xlsx`
- **BCU** (Banco Central del Uruguay): cotizaciones UYU y EUR vía SOAP
- **BCP** (Banco Central del Paraguay): cotización PYG vía scraping web

### Base de datos

- **PostgreSQL** (provisto por Railway): almacena estado de crons, tipos de cambio, logs de auditoría del editor de facturas, y registros de fallos

### Logging y monitoreo

- **Pino** para logging estructurado JSON
- **BetterStack / Logtail** para agregación centralizada de logs en producción
- **pino-pretty** para logs legibles en desarrollo local

### Dependencias principales

| Paquete | Uso |
|---|---|
| `@hubspot/api-client` | SDK oficial de HubSpot |
| `axios` | Llamadas HTTP directas (HubSpot API, BCU, BCP) |
| `pg` | Cliente PostgreSQL |
| `pino` + `@logtail/pino` | Logging estructurado + envío a BetterStack |
| `express` + `express-rate-limit` | Servidor HTTP + rate limiting en webhooks |
| `exceljs` | Generación de reportes Excel |
| `xlsx` | Lectura de archivos Nodum |
| `multer` | Upload de archivos |
| `dotenv` | Variables de entorno en desarrollo |

---

## Variables de entorno

### Requeridas (la app no arranca sin ellas)

| Variable | Descripción |
|---|---|
| `HUBSPOT_PRIVATE_TOKEN` | Token de la Private App de HubSpot |
| `DATABASE_URL` | Connection string de PostgreSQL (Railway la provee automáticamente) |

### Importantes (la app arranca pero en modo degradado)

| Variable | Descripción |
|---|---|
| `BILLING_TICKET_PIPELINE_ID` | ID del pipeline de tickets de facturación manual |
| `BILLING_AUTOMATED_PIPELINE_ID` | ID del pipeline de tickets de facturación automática |
| `BILLING_TICKET_STAGE_ID` | Stage "Listo para Facturar" en pipeline manual |
| `BILLING_AUTOMATED_READY` | Stage "Listo para Facturar" en pipeline automático |
| `DEAL_STAGE_85` | ID del stage "Cierre Ganado" (85% probabilidad) |
| `DEAL_STAGE_95` | ID del stage "En Ejecución" (95%) |
| `BILLING_TZ` | Zona horaria de facturación (default: `America/Montevideo`) |

### Stages de tickets (forecast y facturación)

| Variable | Descripción |
|---|---|
| `BILLING_TICKET_FORECAST` | Stage forecast manual 25% |
| `BILLING_TICKET_FORECAST_50` | Stage forecast manual 50% |
| `BILLING_TICKET_FORECAST_75` | Stage forecast manual 75% |
| `BILLING_TICKET_FORECAST_85` | Stage forecast manual 85% |
| `BILLING_TICKET_FORECAST_95` | Stage forecast manual 95% |
| `BILLING_AUTOMATED_FORECAST` | Stage forecast automático 25% |
| `BILLING_AUTOMATED_FORECAST_50` | Stage forecast automático 50% |
| `BILLING_AUTOMATED_FORECAST_75` | Stage forecast automático 75% |
| `BILLING_AUTOMATED_FORECAST_85` | Stage forecast automático 85% |
| `BILLING_AUTOMATED_FORECAST_95` | Stage forecast automático 95% |
| `BILLING_TICKET_STAGE_ID_BILLED` | Stage "Emitido" manual |
| `BILLING_TICKET_STAGE_ID_CREATED` | Stage "Creado" manual |
| `BILLING_TICKET_STAGE_ID_LATE` | Stage "Atrasado" manual |
| `BILLING_TICKET_PIPELINE_ID_PAID` | Stage "Pagado" manual |
| `BILLING_AUTOMATED_CREATED` | Stage "Creado" automático |
| `BILLING_AUTOMATED_LATE` | Stage "Atrasado" automático |
| `BILLING_AUTOMATED_PAID` | Stage "Pagado" automático |
| `BILLING_AUTOMATED_CANCELLED` | Stage "Cancelado" automático |

### Webhooks y seguridad

| Variable | Descripción |
|---|---|
| `HUBSPOT_CLIENT_SECRET` | Secret de la app HubSpot para verificar firmas v3 de webhooks. Si no está definido, la verificación se omite (modo desarrollo) |

### Invoice Editor

| Variable | Descripción |
|---|---|
| `APP_EDITOR_USER` | Usuario para Basic Auth del editor de facturas |
| `APP_EDITOR_PASSWORD` | Contraseña para Basic Auth del editor |

### Operación

| Variable | Descripción |
|---|---|
| `DRY_RUN` | `true` para modo simulación (no crea/modifica objetos en HubSpot) |
| `USER_BILLING` | ID del usuario HubSpot para asignar como responsable de facturas (default: `65820526`) |
| `USER_ADMIN_MIRROR` | ID del usuario admin para line items espejo UY (default: `89701984`) |
| `HS_RATE_LIMIT_RPS` | Requests por segundo al API de HubSpot (default: `9`) |
| `DEBUG_TOKEN` | Token para proteger el endpoint `/api/debug-urgent` |
| `INTERFASE_PY_COMPANY_ID` | ID de la empresa Interfase PY en HubSpot (para mirrors) |

### Logging

| Variable | Descripción |
|---|---|
| `LOG_LEVEL` | Nivel de log: `debug`, `info`, `warn`, `error` (default: `info` en producción, `debug` en desarrollo) |
| `PRETTY_LOGS` | `true` para logs formateados en consola (solo desarrollo) |
| `LOGTAIL_SOURCE_TOKEN` | Token de BetterStack/Logtail para envío remoto de logs |
| `LOGTAIL_INGESTING_HOST` | Host de ingesta de Logtail (opcional) |

### Base de datos

| Variable | Descripción |
|---|---|
| `DATABASE_PUBLIC_URL` | URL pública de PostgreSQL (alternativa a `DATABASE_URL`) |

---

## Cómo levantar en local

### 1. Clonar e instalar

```bash
git clone <repo-url>
cd hubspot-billing-updater
npm install
```

### 2. Configurar variables de entorno

Crear un archivo `.env` en la raíz con las variables requeridas:

```env
HUBSPOT_PRIVATE_TOKEN=pat-na1-xxxxxxxx
DATABASE_URL=postgresql://user:pass@host:port/db?sslmode=require

# Pipelines y stages (obtener desde HubSpot Settings → Objects → Tickets → Pipelines)
BILLING_TICKET_PIPELINE_ID=...
BILLING_AUTOMATED_PIPELINE_ID=...
BILLING_TICKET_STAGE_ID=...
BILLING_AUTOMATED_READY=...
# ... (ver sección de variables de entorno para la lista completa)

# Invoice Editor
APP_EDITOR_USER=admin
APP_EDITOR_PASSWORD=tu_password

# Logging local
PRETTY_LOGS=true
LOG_LEVEL=debug
```

### 3. Iniciar el servidor

```bash
npm start
# o equivalente: node server.js
```

El servidor arranca en `http://localhost:8080` (o el puerto definido en `PORT`).

Al arrancar, el servidor:
1. Valida variables de entorno requeridas (`validateEnv`)
2. Inicializa tablas PostgreSQL (`cron_state`, `exchange_rates`, `invoice_audit_logs`, `nodum_uploads`)
3. Registra rutas Express
4. Escucha en `0.0.0.0:PORT`

### 4. Comandos útiles

```bash
# Procesar un deal específico
node src/runBilling.js --deal 12345

# Procesar todos los deals ganados
node src/runBilling.js --allWon

# Modo simulación (no modifica HubSpot)
# En PowerShell:
$env:DRY_RUN="true"; node src/runBilling.js --deal 12345

# Ejecutar cron de deals manualmente
node src/jobs/cronDealsBatch.js

# Ejecutar cron con logs legibles
node -e "process.env.PRETTY_LOGS='true'; import('./src/jobs/cronDealsBatch.js')"

# Ejecutar cron de tipos de cambio
node src/jobs/cronExchangeRates.js

# Test de idempotencia
node src/__tests__/ticketKeyIdempotency.js
```

---

## Cómo se despliega en Railway

El proyecto corre en Railway con múltiples servicios:

### Servicio principal: servidor web

- **Start command**: `node server.js`
- **Puerto**: Railway asigna `PORT` automáticamente
- Maneja webhooks de HubSpot, Invoice Editor, upload de Nodum, guía de facturación, y health checks

### Servicios cron (workers independientes)

Cada cron corre como un servicio Railway separado con su propio schedule:

| Cron | Comando | Schedule | Descripción |
|---|---|---|---|
| Deals Batch | `node src/jobs/cronDealsBatch.js` | Varía según día (ver Cap. 5) | Procesamiento principal de deals |
| Exchange Rates | `node src/jobs/cronExchangeRates.js` | `0 6 * * *` (6 AM UTC) | Cotizaciones BCU + BCP |
| Mensajes Facturación | `node src/jobs/cronMensajeFacturacion.js` | 4×/día (8:10, 11:10, 14:10, 17:10 MVD) | Notificaciones de facturación manual |
| Mensajes Mantsoft | `node src/jobs/cronMensajeMantsoft.js` | `0 7 * * *` (7:10 AM MVD) | Notificaciones de facturación automática |

### PostgreSQL

Railway provee la instancia PostgreSQL y expone `DATABASE_URL` automáticamente. El sistema crea las tablas al arrancar si no existen:

- `cron_state`: estado de cursores y progreso de crons
- `cron_failures`: registro de deals fallidos por cron (con contexto JSON)
- `exchange_rates`: tipos de cambio diarios (UYU, EUR, PYG por USD)
- `invoice_audit_logs`: auditoría de cambios en el editor de facturas
- `nodum_uploads`: registro de uploads de archivos Nodum

### Variables de entorno en Railway

Se configuran en el dashboard de Railway por servicio. `DATABASE_URL` se inyecta automáticamente al linkear el servicio PostgreSQL.

---

## Endpoints disponibles

El servidor expone estas rutas (detalle completo en Capítulo 4):

| Ruta | Método | Descripción |
|---|---|---|
| `/api/escuchar-cambios` | POST | Webhook de HubSpot para cambios en deals/line items |
| `/api/actualizar-webhook` | POST | Webhook de HubSpot para actualizaciones de line items |
| `/api/debug-urgent` | POST | Diagnóstico de facturación urgente + mirror |
| `/invoice-editor` | GET | UI del editor de facturas (con Basic Auth) |
| `/invoice-editor/api/:id` | GET/PATCH | API del editor de facturas |
| `/invoice-editor/api/audit/*` | GET | Logs de auditoría del editor |
| `/invoice-editor/audit` | GET | UI de auditoría del editor |
| `/nodum` | GET | UI de upload de archivos Nodum |
| `/nodum/upload` | POST | Endpoint de upload de `.xlsx` de Nodum |
| `/guia` | GET | Guía de facturación para usuarios de Interfase |
| `/health` | GET | Health check (`{ status: 'ok' }`) |
| `/health/audit` | GET | Auditoría de salud del sistema |

Los webhooks de HubSpot (`/api/escuchar-cambios`, `/api/actualizar-webhook`) están protegidos con verificación de firma v3 de HubSpot y rate limiting (120 req/min).

---

## Mecanismos de resiliencia

### Rate limiting hacia HubSpot

El `hubspotClient.js` implementa un proxy recursivo que envuelve todas las llamadas al SDK de HubSpot con:

- **Token bucket** a 9 requests/segundo (configurable vía `HS_RATE_LIMIT_RPS`)
- **Retry automático** con backoff exponencial para errores 429 (rate limit) y 5xx (errores transitorios)
- Respeta el header `Retry-After` de HubSpot cuando está presente
- Máximo 4 reintentos por operación, con jitter ±30% para evitar thundering herd

### Verificación de webhooks

Los webhooks de HubSpot se verifican con firma HMAC-SHA256 v3 usando `HUBSPOT_CLIENT_SECRET`. Incluye:

- Verificación de timestamp (ventana de 5 minutos contra replay attacks)
- Comparación timing-safe del hash
- Rate limiting de 120 requests/minuto

### Validación de entorno

Al arrancar, `validateEnv.js` verifica que las variables críticas estén definidas. Si faltan variables requeridas, la app no arranca. Si faltan variables importantes, arranca en modo degradado con un warning.

### Locking de crons

`cronDealsBatch.js` usa un file lock con TTL para evitar ejecuciones concurrentes. Si se detecta un lock viejo (stale), se remueve automáticamente.
