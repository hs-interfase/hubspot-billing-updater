# Guía de configuración del flujo de facturación

Este documento explica cómo preparar negocios y líneas de pedido (line items) para que el motor de facturación funcione correctamente. Se asume que el negocio está en la etapa **“Cierre ganado”** o que la propiedad **`facturacion_activa`** está en `true`.

## Propiedades clave del negocio

| Propiedad                         | Descripción                                                                      |
|----------------------------------|----------------------------------------------------------------------------------|
| `facturacion_activa`             | Activa/desactiva el motor de facturación para este negocio. Debe estar en `true` | Se puede lograr  a través d ela etapa de negocio: Cierre Ganado.

## Propiedades clave del line item

| Propiedad                         | Descripción                                                                        |
|----------------------------------|------------------------------------------------------------------------------------|
| `hs_recurring_billing_frequency`  o recurringbillingfrequency    | `única`, `semanal`, `quincenal`, `mensual`, `trimestral`, `semestral`, `anual` etc. No usar tildes para evitar problemas |
| `hs_recurring_billing_start_date`    | Fecha inicial de facturación (YYYY-MM-DD). Marca el primer pago                    |
| `hs_recurring_billing_number_of_payments`                     | Duración expresada en años (1 año, 2 años, …) o “Cantidad de meses”    o semanas.            |
| `hs_recurring_billing_period`    | Para términos “Cantidad de meses”: número de meses que dura el contrato            |
| `hs_recurring_billing_number_of_payments`                 | Número total de pagos calculado automáticamente (p. ej. 12 para mensual a 1 año)    |
| `pagos_restantes`                | Calculado automáticamente: `total_de_pagos - pagos_emitidos`                       |
           
| `hs_recurring_billing_terms`  = AUTOMATICALLY_RENEW        | contratos hasta 2099   |

### Contratos recurrentes (mensual, bimestral, etc.)

1. **Elegir la frecuencia** (`recurringbillingfrequency`).
2. **Elegir la duración**:
   - en `hs_recurring_billing_number_of_payments`.

3. **Fecha inicial** (`billing_anchor_date` o `hs_recurring_billing_start_date`) indica el día/mes a respetar en todos los pagos.
4. El motor calculará `hs_recurring_billing_number_of_payments`,  `pagos_restantes` descontara la cantidad de tickets emitidos.  y rellenará `billing_next_date`,
5. Cuando se cree un ticket, `pagos_restantes` Restará en 1. 

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

