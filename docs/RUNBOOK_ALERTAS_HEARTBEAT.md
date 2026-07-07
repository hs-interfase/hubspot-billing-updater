# Runbook — Alertas dead-man's-switch de crons (BetterStack)

> **Estado (2026-07-07):** el CÓDIGO ya está en `main`/prod (commits `817ad02` + `a63a1eb`).
> Falta **solo la parte de BetterStack + Railway**, que requiere **plan pago de BetterStack**
> (para llamada + SMS). Pedírselo a **Maxi**. Este documento es la guía para implementarlo
> ese día.

## Contexto — por qué existe esto

El 7-jul el `cronDealsBatch` estuvo caído ~5 días y **nadie se enteró**: el heartbeat
existía pero su único canal era email, y un email no despierta a nadie. La conclusión fue
_"era una alerta demasiado obvia como para que no existiera"_.

La solución tiene dos mitades:
1. **Código (HECHO):** cada cron pinguea su propio heartbeat de BetterStack al terminar su
   corrida. Si el cron no corre (scheduler caído, proceso que nunca arrancó, ventana que lo
   saltea), el ping no llega.
2. **BetterStack (PENDIENTE, requiere plan pago):** cada heartbeat es un "monitor" que
   alerta si el ping no llega dentro de su ventana esperada. La **escalation policy** define
   el canal — y acá es donde va **llamada + SMS**, no solo email.

## Cómo funciona el código (ya desplegado)

- `lib/alertService.js` expone `pingHeartbeat(kind)`. Hay un heartbeat **por cron** (mapa
  `HEARTBEAT_ENV` / `HEARTBEATS`), cada uno con su propia variable de entorno.
- **Semántica del ping:** significa _"el cron corrió hasta el final"_, **no** _"todo salió
  perfecto"_. Los errores de datos / deals individuales siguen yendo por email
  (`sendAlert` / `sendSummary`). El heartbeat es específicamente para detectar
  **"el cron no corrió"**.
- **Sin fallback entre heartbeats:** si a un cron le falta su env, **omite el ping** (lo
  loguea en debug) en vez de pinguear el monitor de otro. Esto evita esconder una caída
  pinguéando el monitor equivocado.
- **Efecto hoy:** como las 5 envs nuevas todavía no están seteadas, esos 5 crons no
  pinguean nada (inofensivo). El heartbeat de `cronDealsBatch` (weekday) sigue igual que
  siempre. Cada heartbeat "se activa" en cuanto se setea su env.

## Mapa cron → kind → env → schedule

Las variables valen una **URL** (no `true`/`false`). Cada una va **solo en su propio
servicio-cron** de Railway (o todas en un *shared variable group*; cada cron solo lee la
suya). La weekday (`BETTERSTACK_HEARTBEAT_URL`) **ya existe** en prod.

| Cron (servicio Railway) | `kind` | Variable de entorno | Schedule | Ventana esperada sugerida en BetterStack |
|---|---|---|---|---|
| `cronDealsBatch` | `weekday` | `BETTERSTACK_HEARTBEAT_URL` *(ya existe)* | L-V, ventana 03:01-10:00 UTC | period ~1 día + **grace amplio** para tolerar el gap Sáb→Lun (ver nota) |
| `cronWeekendFull` | `weekend` | `BETTERSTACK_HEARTBEAT_URL_WEEKEND` | Sábado, termina ~8am UY | period semanal (7 días) + grace de unas horas |
| `cronExchangeRates` (moneda) | `fx` | `BETTERSTACK_HEARTBEAT_URL_FX` | `0 6 * * *` UTC (diario) | period 1 día + grace 2-3 h |
| `cronMensajeMantsoft` | `msjMantsoft` | `BETTERSTACK_HEARTBEAT_URL_MSJ_MANTSOFT` | `0 7 * * *` UTC (diario) | period 1 día + grace 2-3 h |
| `cronMensajeFacturacion` | `msjFacturacion` | `BETTERSTACK_HEARTBEAT_URL_MSJ_FACTURACION` | 4×/día (8:10, 11:10, 14:10, 17:10 MVD) | period ~4 h + grace 1 h (basta 1 de las 4 corridas del día) |
| `cronExportReporte` | `export` | `BETTERSTACK_HEARTBEAT_URL_EXPORT` | **a confirmar en Railway** | **definir post-migración** (ver nota) |

**Nota grace weekday:** el `cronDealsBatch` no corre sáb/dom. Si el period fuera "1 día
exacto", el lunes daría falso positivo por el gap del finde. Poné un grace que cubra desde
la última corrida del viernes hasta la primera del lunes (~72 h de margen), o usá un period
más laxo. Por eso weekday y weekend son heartbeats **separados**: un solo heartbeat no
distingue "no corrió el weekday" de "es sábado y toca el weekend".

**Nota cronExportReporte:** su schedule y tiempo de corrida se evalúan **cuando se termine
de normalizar y subir todo a migración** — hay que medir cuánto tarda para asegurar que
termine **antes de que los usuarios inicien la jornada**. Recién ahí se fija el period del
monitor. Hasta entonces, se puede crear el monitor con un period provisorio o dejarlo para
el final.

## Pasos de implementación (día del plan pago)

1. **Contratar/activar plan pago de BetterStack** (necesario para call + SMS). — Maxi.
2. **Crear 5 heartbeat monitors nuevos** en BetterStack (la weekday ya existe), uno por cron
   de la tabla. Nombrarlos claro, p.ej. `Cron BILLING Weekend`, `Cron FX (moneda)`,
   `Cron Msj Mantsoft`, `Cron Msj Facturación`, `Cron Export Reporte`. Setear en cada uno el
   **expected period + grace** según la tabla.
3. **Copiar la URL de cada monitor** y setearla como la variable de entorno correspondiente
   en Railway (en el servicio del cron, o en un shared group). Actualizar también
   `.env.real` local (ya tiene los 5 placeholders comentados).
4. **Configurar la escalation policy** en los **6** monitores (incluida la weekday
   existente): **llamada + SMS + email, inmediata**. Este es el punto que faltó el 7-jul.
5. **Verificar** (ver abajo).

## Verificación

- **Ping manual:** correr cada cron una vez a mano (sin `--dry`) y confirmar en BetterStack
  que el monitor recibió el ping y quedó "up".
  - `node src/jobs/cronExchangeRates.js`
  - `node src/jobs/cronMensajeMantsoft.js`
  - `node src/jobs/cronMensajeFacturacion.js`
  - `node src/jobs/cronExportReporte.js` (ojo: hace la corrida real; usar `--dry` **no**
    pinguea, es a propósito)
  - Los `--deal <id>` / `--dry` / `--local-only` **no** pinguean (gateado en el código).
- **Prueba de la alerta que despierta:** en un monitor de prueba, dejar pasar la ventana sin
  pinguear y confirmar que llega **la llamada + el SMS** (no solo el email).
- **Logs:** si una env falta, el log de debug dice `... no configurado — heartbeat (<kind>)
  omitido`. Si pinguea OK: `[alertService] Heartbeat ping OK` con `{ kind }`.

## Regla que NO hay que romper

**No** usar "sin webhook en N horas" como señal de salud. Los triggers del webhook son
esporádicos (flags de control) y dan falsos positivos — fue una de las falsas alarmas del
7-jul. La señal de salud es **solo** el heartbeat de cada cron.
