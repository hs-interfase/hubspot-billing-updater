/**
 * Mapeo de nombres de propiedades entre el código y HubSpot.
 * Esto permite que el código funcione con diferentes nombres de propiedades.
 */

export const PROPERTY_MAPPING = {
  // Line Item - Recurring Billing
  recurring_frequency: 'recurringbillingfrequency', // Tu HubSpot
  recurring_start_date: 'recurringbillingstartdate', // Tu HubSpot
  recurring_interval: 'recurringbillinginterval', // Tu HubSpot
  
  // Fallbacks para compatibilidad
  recurring_frequency_fallback: 'facturacion_frecuencia',
  recurring_start_date_fallback: 'fecha_inicio_de_facturacion',
};

/**
 * Helper para obtener el valor de una propiedad con fallbacks.
 */
export function getProperty(obj, ...keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}