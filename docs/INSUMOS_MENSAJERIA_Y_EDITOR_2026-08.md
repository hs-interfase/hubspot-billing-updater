# Insumos para el bloque de Mensajería + Editor de facturas

**Armado el 3/4-ago-2026. Actualizado el 6-ago-2026.** Recopila los pedidos de Victoria y María
(correos), el estado real del código y los huecos, para las cuatro cosas que se van a atacar:

1. Mensajes de facturación y mensajes de Mantsoft — formato que quiere Victoria.
2. Sacar los crons de mensajes y disparar el aviso al emitir «Facturar ahora» desde el ticket.
3. Correcciones del editor de facturas externo.
4. Mensajes del mirror con correo para María.

> Convención de este documento: **✅ verificado en código** · **🟡 mapeo propuesto, falta confirmar** ·
> **❌ no existe** · **🔴 trampa**.

---

## 0. ESTADO AL 6-AGO-2026 — leer esto primero

Las secciones 2 y 3 quedaron **superadas** por la lista nueva del 5-ago (ver §2.bis). El resto del
documento sigue vigente salvo donde diga lo contrario.

### Dónde vive cada cosa

`pruebas` es **superconjunto de `main`**: el 6-ago se cherry-pickearon a `pruebas` los dos únicos
commits de mensajería que estaban sólo en `main` (`9179829`, `dea241e`). ⇒ la diferencia es
**unidireccional** y el merge a `main` va en un solo sentido. **No cherry-pickear de `main` a
`pruebas` nunca más sin volver a chequear esto.**

| Tema | Estado |
|---|---|
| Cron de facturación apagado + cooldown eliminado | ✅ **en `main`** (PROD) |
| Disparo puntual desde «Facturar ahora» | ✅ **en `main`** — `urgentBillingService.js:1256` |
| Latencia del índice de HubSpot | ✅ **en `main`** |
| Las 3 fechas de contrato en `TICKET_PROPS` | ✅ **en `main`** |
| Empresa Principal ≠ Empresa Factura | ✅ **en `main`** — el builder ya las distingue |
| Avisos del espejo, lado LINE ITEM (7 props) | ✅ sólo en `pruebas` (`b96f9ec`) |
| `of_billing_error` acumula por día | ✅ sólo en `pruebas` (`45b4719`) — ver §4.3 |
| Las dos listas del 5-ago en los mensajes | ✅ sólo en `pruebas` (`c6fc843`) — ver §2.bis |

### Lo que queda abierto

1. **`DEAL_ALERTS_ENABLED` en Railway production.** Si está en `false`, el correo del espejo no sale
   igual. Sólo se confirma en el panel. **Es el último bloqueante del bloque 4.**
2. **Crear `condicion_de_pago`** (`scripts/tools/crearCondicionDePago.mjs`) y **suscribir**
   `line_item.propertyChange / condicion_de_pago`.
3. **Los 4 horarios se mudaron de mensaje** — ver §1.1.
4. **«Ajusta Precio»** (#21 de la lista mansoft): no existe la prop y **no está en el PDF**. Lo más
   cercano es `tipo_de_parametrica`, sin confirmar.
5. **Lado TICKET del pedido de María**: sigue sin existir (§4.2).
6. **`INTEGRACION.md` del editor**: sigue con fecha 28-feb (§5.3).

---

## 1. Cómo funciona HOY la mensajería (verificado en código)

### 1.1 Los dos crons

> 🔴 **6-ago: LOS HORARIOS SE MUDARON DE MENSAJE.** Es lo más fácil de pasar por alto de todo esto.
> Los cuatro horarios eran del mensaje **manual** y se los sacamos el 4-ago al pasarlo a «Facturar
> ahora». La lista del 5-ago pide **7:00 / 11:00 / 14:00 / 16:30 para los AUTOMÁTICOS**, que hoy
> corren **una sola vez a las 07:10**. ⇒ hay que **replicar los servicios de Railway del cron de
> mansoft** para que haya uno por horario. El manual ya quedó como lo piden: disparo al click.

| Cron | Archivo | Horario (America/Montevideo) | Qué hace |
|---|---|---|---|
| Mensaje de facturación | `src/jobs/cronMensajeFacturacion.js` | ~~08:10, 11:10, 14:10, 17:10~~ → **YA NO ES CRON** (4-ago): se dispara al pedir «Facturar ahora» | Tickets en stage READY del pipeline manual con `ticket_emitio_aviso_a_admin ≠ true` → agrupa por `of_deal_id` → escribe `mensaje_de_facturacion` en el **negocio** → marca cada ticket con `ticket_emitio_aviso_a_admin = true` |
| Mensaje Mantsoft | `src/jobs/cronMensajeMantsoft.js` | hoy **07:10** · **pedido: 7:00 / 11:00 / 14:00 / 16:30** ⇒ faltan 3 servicios | Line items con `mansoft_pendiente = true` **y** `facturacion_automatica = true` → agrupa por deal → escribe `mensaje_mansoft` en el negocio → guarda `mansoft_ultimo_snapshot`, resetea `mansoft_pendiente=false` y `mansoft_tipo_aviso=''` |

Constructores del HTML:
- `src/services/billing/buildMensajeFacturacion.js`
- `src/services/billing/buildMensajeMantsoft.js` (+ `mansoftSnapshot.js` para el diff de cambios)

**Cooldown de 10 minutos** (`COOLDOWN_MINUTES`, `cronMensajeFacturacion.js:42`): si algún ticket del deal
se modificó hace menos de 10 min, ese deal se saltea en esa corrida. Es lo que evita mandar el aviso
a mitad de una edición.

### 1.2 🔴 El motor NO manda el correo

El motor **sólo escribe una propiedad en el negocio**. El mail lo manda un **workflow de HubSpot** que
mira esa propiedad:

- Workflow **`1808680730`** — *"aviso para facturacion mansoft"*, portal **50148277** (producción).
- Última modificación registrada en el correo de ejemplo: **Michelle Rodriguez, 21-may-2026**.

Esto importa para el punto 2: **sacar el cron no alcanza**. Si el disparo pasa a ser en el momento de
«Facturar ahora», hay que decidir si el workflow sigue siendo el que manda el mail (y entonces el
motor sólo tiene que escribir la prop antes) o si el mail pasa al motor.

### 1.3 El gancho que ya existe para disparar en el momento

```
src/jobs/cronMensajeFacturacion.js:231
  export async function refreshMensajeFacturacionParaDeal(dealId)
```

Ya está **importado y usado por `src/services/urgentBillingService.js:17`**. Es decir: el camino de
«recalcular el mensaje de este deal ahora mismo» **ya está construido y en uso**. El trabajo del punto 2
es principalmente:

- llamar a ese hook desde el evento de emisión del ticket,
- decidir qué pasa con el cooldown de 10 min (en un disparo puntual sobra, y de hecho estorba),
- apagar/reducir los cuatro horarios del cron,
- y resolver el 1.2 (quién manda el mail).

---

## 2.bis 🆕 LA LISTA VIGENTE (5-ago-2026) — reemplaza a las 22 de §2

Llegaron **dos listas separadas**, una por mensaje. Confirmado: los dos mensajes muestran cosas
distintas a propósito. Implementado en `c6fc843` (`pruebas`).

**Regla que se aplicó:** se respeta el orden de la lista; lo que no está pero ya se mandaba **se deja**,
agrupado al final del bloque del ítem. Los campos 1-4 son del negocio (encabezado) y del 5 en adelante
son del ítem — la estructura que ya existía calzaba con el orden pedido.

### Automáticos / Mansoft — 21 campos, aviso de ALTA (más baja y modificación de contrato)

Entidad Facturadora · Nombre del negocio · Empresa Principal · Cliente Factura · Fecha inicio de
facturación · Fecha inicio de contrato · Fecha fin de contrato · Momento de Facturación ·
Descripción del ticket · Rubro · Área · Moneda · Cantidad · Precio unitario · Monto total · IVA ·
Monto total con impuestos · IRAE · Opera Trading · Condición de Pago · **Ajusta Precio** ❌

### Manual — 18 campos, se dispara al click en «Facturar Ahora»

Entidad facturadora · Nombre del negocio · Empresa Principal · Cliente Factura · **Fecha de
facturación esperada** · Descripción del ticket · Rubro · Área · Moneda · Cantidad · Precio
unitario · Monto total · IVA · Monto total con impuestos · IRAE · Opera Trading · Condición de
Pago · Observaciones

### Definiciones que costó cerrar

| Campo | De dónde sale |
|---|---|
| «Fecha de facturación esperada» (manual) | `fecha_resolucion_esperada` **del ticket** — NO `fecha_inicio_de_facturacion` |
| «Monto total» | sin impuestos. Ticket: `subtotal_real`. LI: `amount` (ya con descuento) |
| «Monto total con impuestos» | Ticket: `total_real_a_facturar` (calculada en HubSpot, **SÍ lleva IVA**). LI: **`hs_post_tax_amount`**, nativa de HubSpot ⇒ no hay que inventar la tasa de cada país |
| Las etiquetas | **no tienen que ser textuales**, alcanza con que se parezcan |

🔴 **La lista pone CANTIDAD antes que PRECIO UNITARIO**, o sea al revés de lo pedido el 4-ago. Se
respetó la lista nueva en los dos mensajes. Si fue un descuido de ella, se da vuelta en dos líneas.

### `condicion_de_pago` — select NUEVO, hay que crearlo

Las 6 opciones salen del PDF **«Definición Vistas v2»** (`~/Downloads`), sección *Condiciones de
facturación*:

> **Contado · 8 días de fecha factura · 30 días de fecha factura · 45 días de fecha factura ·
> 60 días de fecha factura · 90 días de fecha factura**

Vive en **line item y ticket** (aparece en las dos secciones del PDF) y viaja del LI al ticket por el
snapshot, igual que `opera_trading`. Script: **`scripts/tools/crearCondicionDePago.mjs`** (idempotente,
tiene `--dry`). Después hay que **suscribir `line_item.propertyChange / condicion_de_pago`**, si no
editarla en el LI no la baja al ticket.

> 💡 El PDF no se deja leer con `pdftoppm` (no está instalado) ni extrayendo los streams a mano — usa
> fuentes subset con CMap. Lo que sí funciona: **`pdftotext -layout -enc UTF-8`**, que está en
> `/mingw64/bin`.

---

## 2. ~~Lo que pidió VICTORIA — las 22 propiedades del correo~~ (superada por §2.bis)

**Fuente:** correo *"Listado de propiedades por mail"*, Victoria Caimi → Michelle, **1-jul-2026 15:54 UTC**.
Encabezado textual: *"PARA MANTSOFT — Listado mas completo que abarca facturación directa y repetitiva.
LSITADO DE PROPIEDADES para notificaciones por Mail."*

Esta lista es **una sola** y cubre las dos mensajerías (directa = facturación, repetitiva = Mantsoft).

| # | Propiedad pedida | Aclaración de Victoria | Mapeo | Estado |
|---|---|---|---|---|
| 1 | Empresa que factura | ISA o INTERFASE | `empresa_que_factura` | ✅ está en ambos crons |
| 2 | Nombre del Negocio | — | `dealName` | ✅ |
| 3 | Empresa Principal | Cliente del Negocio | `nombre_empresa` | 🟡 **verificar** — ver nota abajo |
| 4 | Empresa Factura | Cliente al que se emite la factura | asociación `ASSOC_LABEL_EMPRESA_FACTURA` | ✅ ya importada en ambos crons |
| 5 | Fecha inicio de Facturación | — | `fecha_inicio_de_facturacion` | ✅ en LI · ❌ **falta en el ticket** |
| 6 | Fecha inicio del Contrato | — | `inicio_del_contrato` | ✅ en LI · ❌ **falta en el ticket** |
| 7 | Fecha fin del Contrato | — | `fin_del_contrato` / `fecha_vencimiento_contrato` | ✅ en LI · ❌ **falta en el ticket** |
| 8 | Momento de Facturación | Mes Anticipado, Fin de Mes, Mes Vencido | `momento_de_facturacion` | ✅ |
| 9 | Frecuencia de Facturación | Mensual, Semestral, Anual | `of_frecuencia_de_facturacion` | ✅ |
| 10 | Descripción de la factura | — | `of_descripcion_producto` | ✅ |
| 11 | Rubro | — | `of_rubro` | ✅ |
| 12 | Unidad de Negocio | — | `unidad_de_negocio` | ✅ |
| 13 | Moneda | — | `of_moneda` | ✅ |
| 14 | Cantidad | — | `cantidad_real` | ✅ |
| 15 | Precio unitario (sin IVA) | — | `monto_unitario_real` | ✅ |
| 16 | Subtotal | — | `subtotal_real` | ✅ |
| 17 | IVA | — | `of_iva` | ✅ |
| 18 | Monto Total a facturar | — | `total_real_a_facturar` | ✅ |
| 19 | IRAE | — | `exonera_irae` | ✅ |
| 20 | TRADING | — | `opera_trading` | ✅ |
| 21 | **Condición de Pago** | — | — | ❌ **no está en `TICKET_PROPS` ni en `LI_PROPS`** |
| 22 | Observaciones | — | `observaciones` | ✅ |

### Los tres huecos reales

1. **`Condición de Pago` (#21) no existe en ninguno de los dos crons.** Hay que averiguar de qué
   propiedad de HubSpot sale (o si hay que crearla) antes de poder ponerla en el mensaje.
2. **Las tres fechas de contrato (#5, #6, #7) están en el camino de Mantsoft (LI) pero no en
   `TICKET_PROPS`** (`cronMensajeFacturacion.js:46-58`). Si Victoria las quiere en los dos mensajes,
   hay que sumarlas a la lista de props del ticket.
3. 🟡 **`Empresa Principal` vs `Empresa Factura` (#3 vs #4).** Son dos cosas distintas para Victoria
   (cliente del negocio vs cliente al que se emite). Cuidado: `empresa_que_factura` **significa cosas
   distintas en el line item y en el ticket** — está anotado como trampa conocida del proyecto.
   Confirmar el mapeo antes de escribir el builder.

---

## 3. El formato que Victoria APROBÓ (ejemplo real)

**Fuente:** *"RV: Mansoft Aviso"*, Victoria → Michelle, **23-jun-2026 20:04 UTC**, con el comentario
*"Llegó el que hicimos juntas."* Es el correo real que salió del workflow. Estructura textual:

```
📋 Aviso Mantsoft — 2026-06-23

🔹 Datos del negocio
   Empresa emisora:      Interfase
   Nombre del negocio:   Prueba Admin Contrato Mantsoft
   Fecha del aviso:      2026-06-23

🔄 Ediciones de hoy (1)
   ┌ 🔄 PayRoll ajuste
   │  Descripción:            ajuste de Soporte Repetitivo Payroll
   │  Unidad de negocio:      Negocios Digitales
   │  Precio unitario:        500.00
   │  Cantidad:               1.00
   │  Descuento (%):          -
   │  Total:                  500.00
   │  Impuestos:              IVA 22% (UY)
   │  Frecuencia:             monthly
   │  Inicio de facturación:  2026-07-08
   │  Próxima fecha:          2026-07-08
   │  Tipo:                   Plan fijo
   │  Vencimiento contrato:   2026-12-08
   │  Pagos:                  Quedan 11 / 6 pagos
   │
   │  🔄 Cambios detectados:
   │    • Fecha ancla:            2026-06-08 → 2026-07-08
   │    • Inicio de facturación:  2026-06-08 → 2026-07-08
   │    • Precio unitario:        2000 → 500
   │    • Nro. de pagos:          12 → 6
   │    • Descripción:            Soporte Repetitivo Payroll → ajuste de …
   └

Generado automáticamente — 2026-06-23 04:31 p. m. — 1 elemento(s) notificado(s)

Para editar datos acceder a https://webhooks-production-6c1b.up.railway.app/invoice-editor
con 562007838851
```

**Lo que hay que conservar de este formato** (es lo que le gustó):
- El bloque **«Datos del negocio»** arriba, separado del detalle.
- El contador en el título de sección: **«Ediciones de hoy (N)»**.
- La sección **«🔄 Cambios detectados»** con `viejo → nuevo` en monoespaciado. Ese diff sale de
  `mansoftSnapshot.js` y es lo más valioso del mensaje.
- El pie con **«N elemento(s) notificado(s)»**.
- **El link al editor de facturas con el ID abajo** — hoy el ID va suelto (`con 562007838851`).

⚠️ **«Ediciones de hoy» se cae con el disparo puntual.** El título asume una tanda diaria. Al pasar al
disparo en el momento de «Facturar ahora», hay que redefinir ese encabezado — y también qué pasa con el
diff acumulado del snapshot, que hoy se arma contra la última corrida del cron.

---

## 4. Lo que pidió MARÍA — mirror y avisos por correo

**Fuente principal:** *"Notificaciones PY + Lógica edición de ticket (vendedores)"*, María Bittencourt →
Michelle (cc Paola), **6-jul-2026 16:20 UTC**, más el seguimiento de las 17:37 y 17:46 del mismo día.

### 4.1 Qué avisos quiere, textual

> **1. Line item:** Que se reflejen automáticamente todas las propiedades de PY en UY durante todo el
> pipeline de ventas, y que se nos notifique por mail cuando cambien las siguientes propiedades:
> - Monto y costo de PY
> - Fecha de facturación esperada
> - Campo UY (si un line item pasa a formar parte de UY o si deja de serlo)
>
> **2. Tickets:** Que se reflejen automáticamente todas las propiedades, y que se nos avise por mail
> cuando cambien:
> - Monto y costo de PY
> - Fecha de resolución esperada
> - Estado del ticket

> **3. Libertad de edición:** necesitamos poder editar libremente **el costo de UY** (tanto en line items
> como en tickets) durante todo el pipeline de ventas. Para el resto de las propiedades, que se sigan
> completando de forma automática **hasta el momento de facturación de PY**. A partir de ese momento,
> libertad completa de edición en nuestro ticket, en todas las propiedades.

> **4. Vinculación de los mirrors:** … El funcionamiento correcto debería ser el primero: **durante toda
> la vida del negocio** la información se refleja y completa automáticamente … y recién en el momento de
> facturación en PY nosotros podemos editar nuestros campos.
> *(Descarta explícitamente la variante de desvincular 30 días antes de la fecha de resolución esperada.)*

Y sobre los mirrors de la migración:

> Los que no estarán vinculados formalmente pero que recibiremos avisos de los cambios hechos en PY:
> **¿recibiremos notificaciones de TODOS los cambios realizados en PY, correcto?** Ya que necesitamos
> saber cuándo se cambian las fechas de cierre, cuando se agrega un line item, cuando se cambia la
> información en dicho line item, en los tickets, etc. **Necesitamos aviso de cualquier modificación**
> para poder corregir el cambio en UY también, ya que no se realizará de forma automática.

### 4.2 Contraste con lo que construimos — actualizado el 5-ago-2026

| Pedido de María | Estado |
|---|---|
| **LINE ITEM** — **monto y costo de PY** | ✅ `price`, `quantity`, `hs_cost_of_goods_sold`, `costo_total_usd` |
| **LINE ITEM** — **fecha de facturación esperada** | ✅ **cerrado 5-ago** — `hs_recurring_billing_start_date` + `fecha_inicio_de_facturacion` |
| **LINE ITEM** — **campo UY** (entra/sale del mirror) | ✅ **cerrado 5-ago** — `uy`, sólo avisa (no se copia: el espejo ES el lado UY) |
| **TICKET** — **fecha de resolución esperada** | 🙋 **no existe la escucha** |
| **TICKET** — **estado del ticket** | 🙋 **no existe la escucha** |
| «Aviso de **cualquier** modificación» en los sellados | 🟡 verificar cobertura real contra "cualquier" |
| Aviso **por correo** | 🔴 ver 4.3 — sigue siendo el bloqueante |

**El lado LINE ITEM quedó completo** (commit `b96f9ec`, sólo en `pruebas`: la tanda D no está en
`main` a propósito y `mirrorLiPropMap.js` ni siquiera existe ahí). La lista sensible pasó de 4 a 7.

📌 A propósito **no** se sumó `billing_next_date`: la recalcula el motor en cada ciclo, así que
avisar por ella sería ruido constante y no una edición de nadie.

**🔴 Sumar la prop a la lista NO alcanzaba.** Había dos cortes antes, y ninguno era obvio:

1. `api/escuchar-cambios.js` (RUTA 4) encolaba sólo si `isTransferableLiProp`, que exige que la prop
   tenga equivalente en el ticket. `uy` no lo tiene ⇒ **el evento no se encolaba**.
2. `syncLineItemPropToTickets` salía por `sin_claves_afectadas` **antes** del bloque del espejo
   cuando no había nada que escribir en el ticket — otra vez `uy`.

⚠️ **Regla que deja:** una prop que le avisa al espejo pero no se escribe en ningún ticket hay que
tocarla en **tres** lugares: la lista sensible, el ruteo del webhook y el guard del sync.

**🙋 Lo que falta de su pedido: el lado TICKET.** No hay ninguna escucha del ticket del original que
avise al espejo. Las rutas de ticket son `actualizar`, `cancelar_ticket`, `revertir_factura` y
`ticket_label_sync` — ninguna mira `fecha_resolucion_esperada` ni `hs_pipeline_stage`. (En
`mirrorTicketAlert.js:102-111` esas dos aparecen, pero son las que **lee** para encontrar el ticket
espejo, no una lista de vigilancia.) Es una **funcionalidad nueva**, no una línea en una lista.

### 4.3 🔴 Los dos bloqueantes del correo a María

1. 🔴 **SIGUE ABIERTO — el correo del espejo NO sale.** `DEAL_ALERTS_ENABLED` apaga también el mail
   del mirror (`src/services/notifications/mirrorAlert.js`), dejando el `billing_error` intacto. El
   destino es `MIRROR_ALERT_TO_EMAIL`, con fallback al `ALERT_TO_EMAIL` general de
   `lib/alertService.js`. **Sólo se confirma en el panel de Railway, no se puede leer del repo.**
2. ✅ **RESUELTO el 6-ago (`45b4719`, `pruebas`) — el aviso ya no dura 5 segundos.**
   `writeTicketBillingError` **acumula** los avisos del mismo día en vez de pisarlos: el más nuevo
   arriba, y al primer aviso de un día nuevo el bloque arranca limpio (tope 20 entradas). El arreglo
   va en esa función porque es el punto único por donde pasan **todos** los productores: aviso del
   espejo, aviso al responsable por sync de LI, cancelar y revertir.

   Detalles que importan si se toca:
   - El día se corta en **BILLING_TZ**, no en UTC. Cada línea sigue con timestamp UTC (que es lo que
     `ts()` ya escribe y lo que hay en PROD), así que un aviso de las 22:00 de Montevideo se guarda
     como `01:00` del día siguiente: cortar por UTC arrancaría bloque nuevo todas las tardes.
   - 🔴 **`ts()` escribe UTC SIN sufijo.** Al re-parsear hay que reponer la `Z` o JS lo lee como hora
     local y el corte de día se corre 3 horas.
   - El valor **siempre** cambia (timestamp nuevo) ⇒ el workflow de HubSpot que crea la tarea sigue
     disparando igual. Hay un test que lo fija.

⇒ Ya no es cierto que "del aviso no queda nada": la propiedad ahora sobrevive. **Falta sólo el
punto 1** para que a María le llegue el correo.

3. Bug menor ya diagnosticado: `buildTextoAvisoEspejo` (`src/services/notifications/mirrorTicketAlert.js:134`)
   tiene la rama «ya notificado, no se tocó» pero `mirrorLiPuntualSync` nunca le pasa `cruzoFrontera`
   (el texto se arma antes de saber sobre qué ticket cae). Arreglo chico.

### 4.4 Dato operativo de María (17:37 del 6-jul)

Para determinar qué line items de PY tienen mirror en UY: los que coincidan en **fecha, rubro, etc.** y
donde el **COSTO PY sea igual al MONTO UY** → esos son los que deben tener `campo UY = Sí`.
Caso de ejemplo que pasó: **ID UY `133ECBE0F924B69703258CEA006A224A` / ID PY `C73940C95AAD6ACE03258CE40005E137`**
(dos LIs en PY, uno solo en UY que es la suma de ambos costos).
Aclaración del 17:46: el desajuste costo PY > costo UY pasa **principalmente en órdenes ya emitidas**;
los negocios activos están limpios.

---

## 5. Editor de facturas externo — el estado real de la documentación

### 5.1 Dónde vive

- **URL producción:** `https://webhooks-production-6c1b.up.railway.app/invoice-editor`
- **Auth:** Basic Auth del navegador, `APP_EDITOR_USER` / `APP_EDITOR_PASSWORD` — completamente
  separado del resto de la app.
- **Rutas** (`server.js:66-72`):
  - `GET /invoice-editor` → `public/invoice-editor.html`
  - `/invoice-editor/api` → `api/invoice-editor/invoices.js`
  - `/invoice-editor/audit` → `public/invoice-editor-audit.html`
  - `/invoice-editor/api/audit` → `api/invoice-editor/audit.js`
  - `/api/export` → `api/exportRouter.js` (comparte el mismo auth)

### 5.2 Los módulos

```
api/invoice-editor/
├── auth.js                     ← Basic Auth
├── invoices.js                 ← rutas GET y PATCH
├── invoiceFields.config.json   ← 26 campos, editables sin tocar código
├── stageTransitions.js         ← transiciones de etapa de la factura
├── syncInvoiceToTicket.js      ← round-trip factura → ticket
├── advanceDealToEnEjecucion.js
├── audit.js                    ← log de auditoría
└── Db.js
```

### 5.3 🔴 `INTEGRACION.md` está desactualizado

El único doc del editor (`api/invoice-editor/INTEGRACION.md`) describe **la versión original de tres
archivos** (`auth.js`, `invoices.js`, `invoiceFields.config.json` + el HTML). No menciona
`stageTransitions.js`, `syncInvoiceToTicket.js`, `audit.js`, `advanceDealToEnEjecucion.js` ni `Db.js`,
que es donde vive casi toda la lógica actual. También dice que el log de auditoría va a
`logs/invoice-editor-audit.json`, cuando ya hay un `Db.js` y un router de auditoría.

**Es correcto lo que dijiste: el editor es lo peor documentado del proyecto.** Al tocarlo esta semana
conviene reescribir ese archivo con el mapa real.

### 5.4 Los 26 campos configurados

24 editables + 2 de sólo lectura (`mensaje_del_vendedor`, `of_invoice_key`, `line_item_key` — este
último y `of_invoice_key` son las llaves).

| Campo | Label | Tipo |
|---|---|---|
| `etapa_de_la_factura` | Etapa de la Factura | select: Pendiente · Emitida · Enviada · Paga · Atrasada · Cancelada |
| `motivo_de_cancelacion` | Motivo de Cancelación | textarea |
| `fecha_de_cancelacion` | Fecha de Cancelación | date — *si se cancela sin fecha, se pone la del día* |
| `fecha_de_emision` | Fecha de Emisión | date |
| `hs_due_date` | Fecha de Vencimiento | date |
| `descripcion` | Descripción | textarea |
| `mensaje_del_vendedor` | Observaciones | textarea — **sólo lectura** |
| `nombre_empresa` | Nombre Empresa | text |
| `nombre_producto` | Nombre Producto | text |
| `servicio` | Servicio | select: Outsourcing · Hardware y Software · Desarrollo y Proyecto · Licencias · Soporte · Otros |
| `unidad_de_negocio` | Unidad de Negocio | text |
| `pais_operativo` | País Operativo | select: UY · PY |
| `iva` | IVA | select |
| `exonera_irae` | Exonera IRAE | select |
| `reventa` | Reventa | select |
| `monto_real_a_facturar` | Monto a Facturar | number |
| `dolar` | Dólar | number |
| `monto_unitario` | Monto Unitario | number |
| `cantidad` | Cantidad | number |
| `descuento` | Descuento % | text |
| `descuento_por_unidad` | Descuento por Unidad | number |
| `id_factura_nodum` | ID Factura Nodum | text |
| `ticket_id` | Ticket ID | text |
| `id_empresa` | ID Empresa | text |
| `of_invoice_key` | Invoice Key | text — **sólo lectura** |
| `line_item_key` | Line Item Key | text — **sólo lectura** |

### 5.5 🔴 Trampa al tocar el editor: el campo `dolar`

`dolar` es **editable desde el editor** y es un **DIVISOR**. Escribirle ahí el tipo de cambio del peso
a un negocio en USD rompe `monto_usd` y el COGS. El TC a pesos va en la propiedad `tc_pesos`, que es
otra. Cualquier corrección sobre ese campo tiene que respetar esa semántica.

### 5.6 Contexto de decisiones ya cerradas sobre el editor

- **Ticket emitido NO es editable en HubSpot** → se edita desde acá. Por eso salió del control de
  cambios el ítem *"editable en emitido"* de USD 60.
- **Revertir no es una propiedad de HubSpot: es un BOTÓN del editor**, que llama a
  `processRevertTicketRequest` (ya existe). Regla acordada: todo pedido que empiece con *"que se pueda
  hacer desde la factura…"* entra en la sección del editor, no en una propiedad.
- Cancelar/revertir está **encendido en producción** desde el 30-jul (`main` = `1986897`).
- Pendientes conocidos de `urgentBillingService`: el `Período: desconocido` y seis `slice(0,250)`.

---

## 6. Los correos fuente, para volver a buscarlos

| Fecha | De | Asunto | Qué aporta |
|---|---|---|---|
| 23-jun-2026 | Victoria | **RV: Mansoft Aviso** | El correo real aprobado — *"Llegó el que hicimos juntas"* |
| 1-jul-2026 | Victoria | **Listado de propiedades por mail** | Las 22 propiedades (directa + repetitiva) |
| 1-jul-2026 | Victoria | Version de vista Victoria | Vista de Elementos de Pedido en modo listado |
| 6-jul-2026 | María | **Notificaciones PY + Lógica edición de ticket (vendedores)** | Qué avisos del mirror quiere, y la regla de vinculación |
| 6-jul-2026 (17:37) | María | *(mismo hilo)* | Regla costo PY = monto UY + el caso de ejemplo |
| 7-jul y 15-jul-2026 | María | Pruebas mirror / Pruebas Mirror. | Errores concretos encontrados en los mirrors |
| 3-ago-2026 | María | **Definción Vistas y Campos** | 🆕 Cadena nueva para vistas y nombres de campos, con PDF adjunto — insumo del hito del 14-ago |

---

## 7. Orden de ataque — actualizado 6-ago

Lo tachado ya está hecho.

1. ~~Cerrar la lista de props sensibles del mirror~~ ✅ lado LINE ITEM completo (`b96f9ec`).
2. ~~Arreglar el pisado del `of_billing_error`~~ ✅ acumula por día (`45b4719`).
3. ~~Sumar los huecos de Victoria al builder~~ ✅ superado por las dos listas del 5-ago (`c6fc843`).
4. ~~Mover el disparo al momento de la emisión~~ ✅ en `main`; cooldown eliminado.

**Lo que sigue, en orden:**

1. **Confirmar `DEAL_ALERTS_ENABLED=true` en Railway production.** Último bloqueante del bloque 4:
   sin eso el correo del espejo no sale aunque la propiedad ahora sobreviva.
2. **Crear `condicion_de_pago`** con el script y suscribir el webhook del LI.
3. **Replicar los servicios de cron de mansoft** para los 4 horarios (§1.1).
4. **Merge `pruebas` → `main`.** La diferencia es unidireccional (§0). ⚠️ Las llaves
   `MIRROR_PUNTUAL_ENABLED` y `DEAL_PROP_SYNC_ENABLED` siguen en **OFF**: el merge no las prende.
5. **Lado TICKET del pedido de María** (§4.2) — funcionalidad nueva, decidir si se construye.
6. **Editor**: correcciones + reescribir `INTEGRACION.md` con el mapa real de §5.2.

### Preguntas todavía abiertas

- **Victoria:** al pasar al aviso en el momento, ¿qué reemplaza a *«Ediciones de hoy (N)»*? Sigue
  tal cual en `buildMensajeMantsoft.js`, y del lado manual ya no hay tanda diaria que lo justifique.
- **Victoria/María:** ¿qué es **«Ajusta Precio»**? No existe la prop ni está en el PDF; lo más
  cercano es `tipo_de_parametrica`.
- **María:** ¿ampliamos los avisos al lado TICKET (fecha de resolución esperada y estado), o queda
  el recorte y se le explica?
- **Quién manda el mail** de facturación: hoy sigue siendo el workflow `1808680730` (§1.2).
