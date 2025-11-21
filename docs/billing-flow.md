# Guía de configuración del flujo de facturación

Este documento explica cómo preparar negocios y líneas de pedido (line items) para que el motor de facturación funcione correctamente. Se asume que el negocio está en la etapa **“Cierre ganado”** y que la propiedad **`facturacion_activa`** está en `true`.

## Propiedades clave del negocio

| Propiedad                         | Descripción                                                                      |
|----------------------------------|----------------------------------------------------------------------------------|
| `facturacion_activa`             | Activa/desactiva el motor de facturación para este negocio. Debe estar en `true` |
| `facturacion_frecuencia_de_facturacion` | Valor general del negocio: `Pago Único`, `Recurrente` o `Irregular`. Sólo a efectos informativos; la lógica se maneja en las líneas |
| `facturacion_proxima_fecha`      | Fecha de la próxima facturación (la actualiza el motor)                          |
| `facturacion_mensaje_proximo_aviso` | Texto que describe qué se facturará (lo construye el motor)                     |
| `facturacion_ultima_fecha`       | Fecha en que se emitió la última factura (opcional, para informes)               |

## Propiedades clave del line item

| Propiedad                         | Descripción                                                                        |
|----------------------------------|------------------------------------------------------------------------------------|
| `frecuencia_de_facturacion`      | `única`, `mensual`, `bimestral`, `trimestral`, `semestral`, `anual` o `irregular`. No usar tildes para evitar problemas |
| `fecha_inicio_de_facturacion`    | Fecha inicial de facturación (YYYY-MM-DD). Marca el primer pago                    |
| `contrato_a`                     | Duración expresada en años (1 año, 2 años, …) o “Cantidad de meses”                |
| `hs_recurring_billing_period`    | Para términos “Cantidad de meses”: número de meses que dura el contrato            |
| `total_de_pagos`                 | Número total de pagos calculado automáticamente (p. ej. 12 para mensual a 1 año)    |
| `pagos_emitidos`                 | Contador de pagos ya facturados (se incrementa cada vez que se envía un aviso)     |
| `pagos_restantes`                | Calculado automáticamente: `total_de_pagos - pagos_emitidos`                       |
| `fecha_2 … fecha_48`             | Fechas de facturación futuras calculadas automáticamente. Para contratos irregulares se rellenan manualmente |
| `renovacion_automatica`          | Si es `true`, al terminar los pagos previstos el motor reiniciará el calendario    |

### Contratos recurrentes (mensual, bimestral, etc.)

1. **Elegir la frecuencia** (`frecuencia_de_facturacion`).
2. **Elegir la duración**:
   - Si es “1 año”, “2 años”… en `contrato_a`.
   - Si es “Cantidad de meses”, dejar `contrato_a` en “Cantidad de meses” y poner el número de meses en `hs_recurring_billing_period`.
3. **Fecha inicial** (`fecha_inicio_de_facturacion`) indica el día/mes a respetar en todos los pagos.
4. El motor calculará `total_de_pagos`, `pagos_emitidos`, `pagos_restantes` y rellenará `fecha_2`, `fecha_3`, etc.
5. Cuando se envíe cada factura, `pagos_emitidos` aumentará en 1. Si hay `renovacion_automatica`, al finalizar el total de pagos el motor reiniciará la cuenta (en versiones futuras).

### Contratos irregulares

- Selecciona `frecuencia_de_facturacion = irregular`.
- Introduce manualmente todas las fechas en `fecha_2`, `fecha_3`, etc. siguiendo el orden cronológico.
- Ajusta `total_de_pagos`, `pagos_emitidos` y `pagos_restantes` manualmente si fuera necesario.
- El motor usará la fecha más próxima en el futuro de entre todas las que hayas puesto.

### Flujos de trabajo

- Cada X horas, el motor revisa negocios en “Cierre ganado” con `facturacion_activa = true`.
- Para cada negocio:
  1. Actualiza los calendarios de las líneas (menos las irregulares).
  2. Calcula la próxima fecha de facturación entre todas las líneas (`facturacion_proxima_fecha`).
  3. Construye `facturacion_mensaje_proximo_aviso`, listando sólo las líneas que se facturan en esa fecha.
  4. El workflow de HubSpot enviará el aviso al equipo de facturación y aumentará `pagos_emitidos`.

### Consejos para el equipo comercial

- No uses acentos en los valores de `frecuencia_de_facturacion` para evitar problemas al comparar.
- Para contratos de más de cuatro años, amplía las propiedades de fechas (actualmente hay hasta `fecha_48`).
- Si cambias manualmente alguna `fecha_n` (por ejemplo, mover de día 5 al día 15), el motor respetará la fecha editada; no recalculará esa línea automáticamente.
- En facturaciones irregulares o bolsa de horas, debes rellenar todas las fechas y contadores a mano.






node ./src/testProcessDeal.js 48596647267

node ./src/testDealMirroring.js 49641854506