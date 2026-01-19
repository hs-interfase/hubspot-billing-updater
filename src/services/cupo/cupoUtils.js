// src/services/cupo/cupoUtils.js
export function hasParteDelCupoActiva(lineItems = []) {
  return (lineItems || []).some(li => {
    const lp = li?.properties || {};
    const parte = lp.parte_del_cupo === true || lp.parte_del_cupo === 'true';
    const activa = lp.facturacion_activa === true || lp.facturacion_activa === 'true';
    return parte && activa;
  });
}
