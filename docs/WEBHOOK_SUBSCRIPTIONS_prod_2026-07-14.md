# Suscripciones de webhook — app privada `billing-updates-api` (PROD)

> Extraído 2026-07-14 del portal de PRODUCCIÓN (developer account interfaseisa.com, portal 50148277, app id **24185440**) vía la API interna `/api/webhooks/v1/24185440/subscriptions` (con header CSRF de la sesión).
> **URL de destino:** `https://webhooks-production-6c1b.up.railway.app/api/escuchar-cambios` · máx concurrencia 10 · máx reintentos 10.
> **Total: 123 suscripciones, todas `*.propertyChange`, todas activas.** Sirve de checklist para replicar en la app de PRUEBAS (portal 51101688).

## line_item / "Elemento de pedido" — 45 (`line_item.propertyChange`)
actualizar, ajuste_factura_aparte, area, billing_anchor_date, description, discount, empresa_que_factura, es_definitivo, exonera_irae, facturacion_automatica, facturar_ahora, fecha_de_baja, fecha_vencimiento_contrato, fin_del_contrato, hs_billing_start_delay_type, hs_discount_percentage, hs_recurring_billing_period, hs_recurring_billing_start_date, hs_tax_rate_group_id, hubspot_owner_id, inicio_del_contrato, line_item_key, mensaje_para_responsable, momento_de_facturacion, monto_unitario_actual, motivo_de_pausa, name, nc, nombre_producto, nota, opera_trading, pais_operativo, parte_del_cupo, pausa, price, quantity, recurringbillingfrequency, responsable_asignado, reventa, servicio, subrubro, terceros, tipo_de_parametrica, unidad_de_negocio, uy

## ticket / "Ticket" — 58 (`ticket.propertyChange`)
ajuste_factura_aparte, area, cancelar_ticket, cantidad_real, cliente_partner, comentarios_pm, content, descuento_en_porcentaje, descuento_por_unidad_real, dolar, empresa_id, empresa_que_factura, entidad_facturadora, exonera_irae, facturacion_automatica, facturar_ahora, fecha_inicio_de_facturacion, fecha_real_de_facturacion, fecha_resolucion_esperada, fin_del_contrato, hay_ajuste, hs_resolution, inicio_del_contrato, momento_de_facturacion, monto_unitario_real, motivo_cancelacion_del_ticket, motivo_del_ajuste, nc, negocio_compartido, nombre_empresa, nota, observaciones, observaciones_ventas, of_aplica_para_cupo, of_cantidad_de_pagos, of_costo_usd, of_frecuencia_de_facturacion, of_line_item_ids, of_moneda, of_monto_total, of_motivo_pausa, of_pais_operativo, of_producto, of_producto_nombres, of_propietario_secundario, of_rubro, of_subrubro, opera_trading, producto_id, renovacion_automatica, repetitivo, reventa, revisado_por, servicio, source_type, subject, tipo_de_parametrica, unidad_de_negocio

## deal / "Negocio" — 17 (`deal.propertyChange`)
amount, cliente_beneficiario, cupo_activo, cupo_total, cupo_total_monto, cupo_umbral, deal_currency_code, dealname, dealstage, description, exonera_irae, facturacion_automatica, facturacion_activa, hs_exchange_rate, hubspot_owner_id, pais_operativo, tipo_de_cupo

## product / "Producto" — 3 (`product.propertyChange`)
area, name, unidad_de_negocio

---

## Cómo replicar en PRUEBAS
- Portal de pruebas = 51101688. Hay que ubicar la app privada equivalente (su propio app id) en su developer account y su pestaña Webhooks.
- Opción A (manual): crear una suscripción `propertyChange` por cada propiedad de arriba, por objeto.
- Opción B (API interna, como se extrajo esto): con la sesión abierta en el portal de pruebas, `POST /api/webhooks/v1/{APP_ID_PRUEBAS}/subscriptions?portalId=51101688` (header `X-HubSpot-CSRF-hubspotapi` de la cookie `hubspotapi-csrf`), body `{subscriptionDetails:{subscriptionType:"<obj>.propertyChange", propertyName:"<prop>"}, enabled:true}` por cada una. **Crear/​modificar suscripciones = config persistente → pedir OK antes de escribir.**
