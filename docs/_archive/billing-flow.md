# Guía de configuración del flujo de facturación

Este documento explica cómo preparar negocios y líneas de pedido (line items) para que el motor de facturación funcione correctamente. Se asume que el negocio está en la etapa **“Cierre ganado”** o que la propiedad **`facturacion_activa`** está en `true`.

## Propiedades clave del negocio

| Propiedad                         | Descripción                                                                      |
|----------------------------------|----------------------------------------------------------------------------------|
| `facturacion_activa`             | Activa/desactiva el motor de facturación para este negocio. Debe estar en `true` | Se puede lograr  a través de la etapa de negocio: Cierre Ganado.

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

//////
//////
/////
/////
/////
se modifica anchor date. eso modifca el inicio del motor, si se quiere modificar de nuevo se modifca otra vez anchor date.
/////
/////
/////
/////

### Flujos de trabajo

- Todas las noches, corremos el cron, el motor revisa negocios en “Cierre ganado” con `facturacion_activa = true`.
- Para cada negocio:
  1. Actualiza fechas de las líneas.
  //a modo de resumen desde la vista de negocio. JAMAS como fuente de verdad. 
  2. Calcula la próxima fecha de facturación entre todas las líneas (`facturacion_proxima_fecha`). en deal
  3. Construye `facturacion_mensaje_proximo_aviso`, listando sólo las líneas que se facturan en esa fecha. es a modo de 


### Consejos para el equipo comercial

- MANTSOFT siempre usa frecuencia.
- Para contratos de auto renew se crean 24 tickets. y se van actualizando.
- Si deseas cambiar una fecha cuyo ticket aun no esta en uso. cambias manualmente alguna `anchor date`. Si deseas cambiar una cuyo ticket ya esta en modo manual deberas modificar desde el ticket. 
- En facturaciones irregulares o bolsa de horas (cupo), debes rellenar todas las fechas y contadores a mano. cada fecha en un line item

