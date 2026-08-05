# Ajuste de precio por paramétrica — documentación

> Estado al **5-ago-2026**. Pantalla `/parametrica` + `/historial-parametricas`.
> Rama `feat/parametrica-retroactivo` (`e3804ed`) — **sin mergear y sin probar en sandbox**.
> Lo de selección/buscador ya está en `pruebas` (`2f583e3`).

---

## 1. Qué es y para qué existe

Algunos contratos de iJServ (Petróleo) tienen una **cláusula paramétrica**: el precio se reajusta
periódicamente contra índices. La fórmula real del cliente es semestral:

```
Pn = Po × (0,86 × IPC + 0,14 × DÓLAR)
```

**El motor NO resuelve esa fórmula.** Por decisión de la usuaria (10-jul-2026), el alcance se achicó
a **ingresar el porcentaje ya calculado** y aplicarlo. Todo lo que sigue es el andamiaje alrededor de
ese porcentaje: a quién se le aplica, qué pasa con lo ya facturado, cómo se deshace y cómo se audita.

Ejemplo real de la planilla de Victoria: `5000 → 5021,32` = **+0,4264 %**.

---

## 2. El flujo, de punta a punta

```
lista de elegibles  →  se marcan los que van  →  previsualización  →  se aplica
       ↑                        ↑                       ↓                 ↓
   buscador           prearmado guardable      se puede editar      extracto por mail
                                                                   + historial + reversa
```

1. **Lista.** Todos los line items del producto iJServ, separados en *elegibles* y *excluidos con
   motivo*.
2. **Selección.** Checkbox por fila, más un botón que alterna **Seleccionar todo / Desmarcar todo**.
   Opera sobre **lo que dejó el buscador**, no sobre la lista entera.
3. **Previsualización.** Se ingresa el porcentaje (y opcionalmente el mes de vigencia y el respaldo
   del cálculo). Muestra precio actual → precio nuevo, avisos, y el ajuste retroactivo si corresponde.
   Se puede **editar**: sacar filas, o volver a la selección y agregar más sin perder el lote.
4. **Aplicar.** Escribe en HubSpot, crea los retroactivos y manda el extracto por mail.
5. **Reversa.** Por lote o por line item, restaurando el precio anterior exacto.

---

## 3. Quién entra a la lista

**Elegible** = line item del producto iJServ que cumple TODO:

| Requisito | Motivo de exclusión si falla |
|---|---|
| No es espejo intercompany (`of_line_item_py_origen_id` vacío) | `espejo_intercompany` |
| No es un ajuste retroactivo creado por esta misma pantalla | `li_de_ajuste_retroactivo` |
| No es nota de crédito (`nc` ≠ true) | `nota_de_credito` |
| Tiene negocio asociado | `sin_deal` |
| El negocio está de **cierre ganado en adelante** | `deal_no_ganado` |
| El contrato está **vigente hoy** (`fin_del_contrato` ≥ hoy, o vacío) | `contrato_vencido` |
| Tiene precio | `sin_precio` |

**Por qué cada uno:**

- **Espejos**: el cron de mirroring deriva su price del costo del line item de PY y pisaría el cambio.
- **Ajustes retroactivos**: son pagos únicos ya cerrados; ajustar el ajuste no tiene sentido. Se
  reconocen por `nota = AJUSTE_RETROACTIVO_PARAMETRICA` o por el nombre.
- **Notas de crédito**: su importe corrige una factura ya emitida, con el precio que tenía entonces.
- **Cierre ganado en adelante**: antes de ganar, el motor rearma el negocio libremente.
  Se usa `isDealGanadoStage()`, no el Set crudo — un stage vacío hacía match de más.
- **Contrato vigente**: ajustar algo que ya terminó no cambia nada y ensucia la lista.

Los excluidos **se listan aparte con su motivo y se pueden bajar en CSV**, para poder auditar por qué
algo quedó afuera.

---

## 4. El buscador

Tres campos, que se combinan con Y:

| Campo | Contra qué compara |
|---|---|
| **Código de empresa** | `codigo_cliente_nodum` de la company **y** `codigo_empresa_contactos` |
| **Nombre de empresa** | cliente factura y `nombre_empresa` del line item |
| **Número de contrato** | la propiedad nueva del line item (bloque 2, todavía sin crear) |

**Detalles que importan:**

- El código tolera los **ceros a la izquierda**: escribís `3137` y encuentra `0003137`.
- Matchea también el *Código Contacto* porque **comparten rango numérico** y quien busca puede tener
  a mano el equivocado. La clave de verdad es `codigo_cliente_nodum`.
- **NO matchea el nombre del negocio**, a propósito: si lo hiciera, buscar "tel" traería un negocio
  llamado "Hotel Carrasco" de otro cliente.
- Está presente en los **tres momentos**: lista, previsualización y resultado.

🪤 El módulo del buscador (`src/services/parametrica/filtros.js`) **se sirve al navegador** desde
`GET /parametrica/api/filtros.js`, así front, backend y tests usan la misma implementación. Si se
mueve el archivo hay que tocar `FILTROS_PATH` en el router.

---

## 5. Columnas y de dónde sale cada dato

| Columna | Origen |
|---|---|
| Entidad facturadora | `empresa_que_factura` **del line item** |
| Cliente factura | company del deal con etiqueta *Empresa Factura* → company principal → `nombre_empresa` |
| Código de empresa | `codigo_cliente_nodum` de esa company |
| N° contrato | prop nueva (bloque 2) — **vacía hasta que se cree** |
| Negocio | `dealname` |
| Descripción del producto | `description` del line item |
| Área | `area` |
| Producto | `nombre_producto`, o "iJServ" |
| Rubro | `servicio` del line item (la que mapea a `of_rubro` del ticket) — **no** el `rubro` del deal |
| Moneda | `of_moneda` → `deal_currency_code` |
| Importe s/IVA | `price` (siempre neto) |
| Últ. ajuste | `fecha_ultimo_ajuste` + `porcentaje_ultimo_ajuste` |
| Meses sin ajustar | calculado; se marca a partir de **6**, porque la fórmula es semestral |

⚠️ **`empresa_que_factura` significa distinto según el objeto**: en el line item es la entidad
emisora del grupo (Interfase UY / ISA UY / ISA PY / Interfase PY); en el **ticket** es la empresa
cliente, y la entidad del grupo ahí se llama `entidad_facturadora`.

---

## 6. El ajuste retroactivo de pago único

### Cuándo aplica

La **fecha de vigencia es opcional**:

- **Vacía** → el ajuste rige desde hoy. No hay retroactivo. Es el comportamiento histórico.
- **Con mes y año** (ej. "julio 2026") → el porcentaje debería haber estado vigente desde ese mes.
  Lo que ya se facturó al precio viejo se cobra en un line item aparte.

El parser acepta `julio 2026`, `jul 2026`, `julio de 2026`, `07/2026`, `7-2026`, `2026-07` y el
value de un `<input type="month">`. Rechaza meses futuros y más viejos que
`PARAMETRICA_MAX_MESES_RETRO` (default 24).

### 🔑 Cómo se cuentan los pagos — la regla

**Se cuentan TICKETS y POR FECHA.** No se recalcula el calendario ni se mira el estado del ticket.
El razonamiento (definición de la usuaria, 4-ago-2026):

> El ticket **es** la factura, así que el momento de facturación ya está metido en su fecha.

- **`adelantado` y `mes vencido`** caen siempre el 1° → el mes en curso **siempre** cuenta como
  retroactivo, **aunque hoy sea el 1°**.
- **`fin_de_mes`** es el **único caso relativo**: cuenta sólo si el día que factura este mes ya pasó.
  A mitad de mes, el de este mes todavía no salió y va a salir ya ajustado, así que no cuenta.

Comparar `fecha_resolucion_esperada` con hoy resuelve los dos casos. **No cuentan** los cancelados
(no hubo factura) ni las notas de crédito. Los que están en la ventana pero todavía no llegaron a una
etapa de facturado **sí cuentan** —su precio ya está fijado— y se informan aparte en el preview.

**Ejemplos, que están como tests con nombre:**

| Caso | Ventana | Pagos |
|---|---|---|
| Mensual el 1°, ajuste de julio, hoy 4-ago | jul-01 → ago-04 | **2** |
| Mensual el 1°, ajuste de julio, hoy **es** 1-ago | jul-01 → ago-01 | **2** |
| Fin de mes, ajuste de junio, hoy 15-ago | jun-01 → ago-15 | **2** (el de 31-ago no) |
| Fin de mes, ajuste de julio, hoy 2-set | jul-01 → set-02 | **2** |

### Qué line item se crea

| | |
|---|---|
| **Nombre** | `Ajuste retroactivo` |
| **Cantidad** | `1` — es un **monto único** |
| **Precio** | `(precio nuevo − precio viejo) × cantidad del original × pagos` |
| **Fecha** | la **próxima fecha de facturación del line item ajustado**, releída al aplicar |
| **Frecuencia** | **ausente** (no vacía) → el motor lo trata como pago único |
| **Costo** | 0, para que no ensucie el margen del negocio |
| **Impuestos** | hereda `hs_tax_rate_group_id` y `exonera_irae` del original |
| **Marca** | `nota = AJUSTE_RETROACTIVO_PARAMETRICA` |

Ejemplo de la usuaria: ajuste de 100 por mes × 3 meses → el line item vale **300**.

**Descripción generada:**

> Ajuste retroactivo por 3 pagos contando a partir de julio 2026. Line item original: "Capacidad"
> (ID 57417530802). Monto único de UYU 300,00 en moneda original, sin impuestos (UYU 100,00 por
> pago × 3).

**Pago único en este motor** = line item **sin frecuencia** + `hs_recurring_billing_start_date`
(ver `billingEngine.js`, sección *"2) Pago único (con startDate)"*). El motor lo factura una vez y
después deja `billing_next_date` vacío. **No** se usa el camino `irregular`.

🪤 La frecuencia se deja **ausente**, no en `''`: es un select y mandarle `''` en un `create` da 400.

### Cuándo NO se crea

| Motivo | Qué significa |
|---|---|
| `sin_facturas_en_el_periodo` | no salió ninguna factura entre el mes del ajuste y hoy |
| `sin_diferencia` | el ajuste no mueve el precio |
| `sin_proxima_fecha` | el line item no tiene próxima fecha — no hay a qué acompañar |

Un fallo creando el puntual **no revierte** el ajuste de precio ya aplicado: la fila queda con el
motivo y el resto del lote sigue.

---

## 7. Reversa

Restaura el **precio anterior exacto** guardado en la base. **No** se usa el porcentaje inverso: el
redondeo a 2 decimales no es reversible.

- Se puede revertir el **lote completo** o **un line item**.
- Si el ajuste creó un retroactivo, la reversa lo **archiva**. Si no puede, lo dice en la fila y en
  el extracto en vez de fallar en silencio.

### 🔴 Lo que la reversa NO puede deshacer

Si entre el ajuste y la reversa **ya salió una factura** con el precio nuevo, revertir el precio no
corrige esa factura: **eso se arregla con nota de crédito**.

Al revertir se cuentan las facturas emitidas desde que se aplicó el lote. La pantalla lo avisa en el
momento, y quedan **listadas arriba de todo en `/historial-parametricas`** para que administración
emita las NC.

---

## 8. Respaldo del cálculo

Como el porcentaje se ingresa a mano, cada lote guarda **de dónde salió**:

| Campo | Ejemplo |
|---|---|
| Índice | `IPC + dólar` |
| Valores usados | `IPC 1,0312 · dólar 41,25` |
| Período del índice | `ene–jun 2026` |
| Nota | libre |

Son **opcionales**, pero es el papel de trabajo ante el cliente o una auditoría: sin esto, dentro de
seis meses nadie reconstruye de dónde salió un 4,26 %. Viaja al extracto por mail, al CSV y al
historial.

---

## 9. Historial

**En HubSpot cada line item guarda SOLO el último ajuste** — `fecha_ultimo_ajuste` y
`porcentaje_ultimo_ajuste` se pisan en cada corrida. La historia completa vive en Postgres.

**`/historial-parametricas`** responde la pregunta real de administración: *"¿qué ajustes tuvo este
contrato?"*. Busca por cliente, negocio, contrato o ID, con rango de fechas, y baja CSV. Arriba de
todo muestra las **reversas pendientes de nota de crédito**.

La pantalla `/parametrica` conserva su historial **por lote**, con detalle y reversa.

---

## 10. Selección guardada (el "prearmado")

Dos capas, para no rehacer a mano una lista de 40 contratos:

1. **Borrador automático** en `localStorage`: lo que tenías marcado se recupera al volver a entrar.
   Sobrevive a una recarga o a una sesión caída.
2. **Selecciones con nombre** en la base (`parametrica_selecciones`), compartidas: se guardan, se
   cargan y se borran. Guardar con un nombre que ya existe lo pisa.

Al cargar una selección, los line items que ya no son elegibles se omiten y se avisa cuántos.

---

## 11. Guards y concurrencia

| Riesgo | Cómo se cubre |
|---|---|
| Doble click / re-aplicar | transición atómica `preview → applying` en la base; el segundo request recibe 409 |
| El precio cambió desde el preview | se relee el price antes de escribir cada line item; si difiere → `failed price_changed` |
| Choque con el cron | `acquireDealLock` por deal (label `parametrica`), con 3 reintentos |
| Dos personas ajustando a la vez | el segundo lote falla por `price_changed`, porque su snapshot ya no coincide |
| Escribir sin querer | `DRY_RUN` corta todas las escrituras y lo avisa en el preview |
| Porcentaje absurdo | aviso (no bloqueo) sobre `PARAMETRICA_MAX_PCT` |

⚠️ **Los tickets ya promovidos con fecha futura conservan el precio viejo** — Phase P no los
re-snapshotea. El preview lo avisa por line item, pero **la corrección es manual**.

---

## 12. Archivos

| Archivo | Qué hace |
|---|---|
| `public/parametrica.html` | la pantalla del ajuste |
| `public/historial-parametricas.html` | historial por line item + pendientes de NC |
| `api/parametrica/router.js` | la API |
| `api/parametrica/Db.js` | tablas; **se auto-crean y se auto-migran** al arrancar |
| `src/services/parametrica/calc.js` | porcentaje → precio nuevo (puro) |
| `src/services/parametrica/filtros.js` | el buscador (puro, se sirve al navegador) |
| `src/services/parametrica/retroactivo.js` | parseo del mes, monto y descripción (puro) |
| `src/services/parametrica/empresaLookup.js` | cliente factura y código de empresa |
| `src/services/parametrica/parametricaService.js` | todo lo que toca HubSpot |

**Tests:** `parametricaCalc`, `parametricaSeleccion`, `parametricaRetroactivo`,
`parametricaConteoPeriodos`. Corren con `node --test src/__tests__/*.test.mjs`.

### Tablas

- `parametrica_batches` — una corrida: porcentaje, usuario, estado, mes de vigencia, respaldo.
- `parametrica_items` — snapshot por line item: precios, datos de la fila, retroactivo, facturas
  post-ajuste.
- `parametrica_selecciones` — los prearmados guardados.

Las tres se crean solas al arrancar (`initParametricaTables` en `server.js`), y las columnas nuevas
entran por `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. **No hay migración a mano.**

### Endpoints

```
GET    /parametrica/api/line-items
POST   /parametrica/api/preview            {porcentaje, lineItemIds, mesAjuste?, fuenteIndice?, ...}
PUT    /parametrica/api/preview/:id/items  {lineItemIds}     rehace la selección del preview
POST   /parametrica/api/preview/:id/cancel                   descarta sin aplicar
POST   /parametrica/api/apply              {batchId, confirm:true}
POST   /parametrica/api/revert             {batchId, lineItemId?}
GET    /parametrica/api/batches | /batches/:id
GET    /parametrica/api/historial          ?q=&desde=&hasta=&soloAplicados=
GET    /parametrica/api/pendientes-nc
GET|POST|DELETE /parametrica/api/selecciones
```

### Variables de entorno

| Variable | Default | Necesaria |
|---|---|---|
| `IJSERV_PRODUCT_ID` | — | **SÍ** (prod `33688695870`, pruebas `41943895217`) |
| `PARAMETRICA_MAX_PCT` | 30 | no — sólo umbral de aviso |
| `PARAMETRICA_MAX_MESES_RETRO` | 24 | no |
| `PARAMETRICA_ALERT_TO` | `ALERT_TO_EMAIL` | no |
| `PARAMETRICA_PROP_NUMERO_CONTRATO` | vacío | no — hasta que exista la prop |

🪤 `PARAMETRICA_PROP_NUMERO_CONTRATO` sólo se pide a HubSpot **si está seteada**: pedir una propiedad
inexistente en el search hace fallar el request entero.

---

## 13. Propiedades de HubSpot

**Ya existen** (creadas por la usuaria, mismos nombres en ambos portales): `ajuste_factura_aparte`,
`monto_unitario_actual`, `monto_unitario_original`, `tipo_de_parametrica`, `fecha_ultimo_ajuste`,
`porcentaje_ultimo_ajuste`.

📌 **`monto_unitario_original`** guarda el **primer** monto unitario del line item, porque algunos
ajustes se calculan sobre el valor **actual** y otros sobre el **original**. Por eso el servicio la
escribe sólo si estaba vacía. **NO archivarla.**

⚠️ **`ajuste_factura_aparte` NO se usa como marca del line item retroactivo.** Es una preferencia del
line item **original** ("cuando me ajusten, cobrame la diferencia aparte"), no un sello.

---

## 14. Pendientes

### Bloqueantes para usarlo

- [ ] **Probar en sandbox el ciclo del retroactivo.** Es la **primera vez que el motor crea line
      items** fuera de los espejos. Verificar: que se cree con el IVA correcto, que genere **un**
      ticket, y que después deje de facturar.
- [ ] Mergear la rama `feat/parametrica-retroactivo`.
- [ ] `IJSERV_PRODUCT_ID` en las variables de Railway.

### Definiciones pendientes de la usuaria

- 🙋 **¿El ajuste debe mover también el costo?** Hoy sube el `price` y deja `hs_cost_of_goods_sold`
  y `costo_total_usd` como estaban, así que **cada corrida mejora el margen reportado**. Es una
  decisión de negocio, no de código. **Quedó en conversarlo.**

### Fases siguientes ya definidas

- **Número de contrato** (bloque 2): propiedad nueva del line item, que **carga el vendedor a mano** y
  se propaga a sus tickets. Falta crearla en los dos portales, mapearla en `snapshotService` y
  sumarla a `LI_PROP_TO_TICKET_KEYS`. El sync no toca tickets ya notificados.
- **Tipos de paramétrica**: las propiedades ya existen y se van a ir llenando. Recién ahí se podrá
  distinguir qué contrato tiene cláusula y filtrar por tipo.
- **Base de cálculo** (sobre monto actual vs original): va por una propiedad booleana, más adelante.
- **Otros productos**: hoy está clavado a iJServ. A futuro será "ajuste por paramétrica" filtrado por
  tipo.

### Mirado y descartado

- **Tope por importe**: no se quiere. El `PARAMETRICA_MAX_PCT` es sólo aviso.
- **Usuario individual / doble aprobación**: `invoiceEditorAuth` usa una clave compartida y el
  historial guarda `admin`. **Por ahora está bien así.**
- **Aviso de contratos sin ajustar hace 6+ meses**: interesante, no se hizo. La columna "meses sin
  ajustar" ya da el dato.
