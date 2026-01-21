// src/utils/cupoEstado.js (nuevo archivo recomendado)
// O si no querés archivo nuevo, al menos exportalo desde propertyHelpers sin imports raros.

import { parseNumber, parseBool, safeString } from './utils/parsers.js';

export function calculateCupoEstado(input) {
  const cupoActivo = parseBool(input.cupo_activo);

  const tipo = safeString(input.tipo_de_cupo).trim();
  const consumido = parseNumber(input.cupo_consumido, NaN);
  const restante = parseNumber(input.cupo_restante, NaN);
  const umbral = parseNumber(input.cupo_umbral, NaN);

  const totalHoras = parseNumber(input.cupo_total, NaN);
  const totalMonto = parseNumber(input.cupo_total_monto, NaN);
  const totalGenerico = parseNumber(input.cupo_total, NaN);

  let total = NaN;
  if (tipo === "Por Horas") total = !isNaN(totalHoras) ? totalHoras : totalGenerico;
  else if (tipo === "Por Monto") total = !isNaN(totalMonto) ? totalMonto : totalGenerico;
  else total = totalGenerico;

  const totalMissing = input.cupo_total == null || String(input.cupo_total).trim() === "";
  const totalMontoMissing = input.cupo_total_monto == null || String(input.cupo_total_monto).trim() === "";
  const noHayTotalConfigurado = totalMissing && totalMontoMissing;

  if (!cupoActivo && noHayTotalConfigurado) return "";

  if (isNaN(total) || isNaN(consumido) || isNaN(restante)) return "Inconsistente";

  const EPS = 0.01;

  const diff = Math.abs((consumido + restante) - total);
  if (diff > EPS) return "Inconsistente";

  if (restante < 0 - EPS) return "Pasado";

  if (restante <= 0 + EPS) return "Agotado";

  if (!cupoActivo) return "Desactivado";

  if (!isNaN(umbral) && restante <= umbral + EPS) return "Bajo Umbral";

  return "Ok";
}

// ✅ Builder: siempre pasa TODO lo necesario
export function computeCupoEstadoFrom(dealProps = {}, updateProps = {}) {
  const merged = { ...dealProps, ...updateProps };

  return calculateCupoEstado({
    cupo_activo: merged.cupo_activo,
    tipo_de_cupo: merged.tipo_de_cupo,
    cupo_total: merged.cupo_total,
    cupo_total_monto: merged.cupo_total_monto,
    cupo_consumido: merged.cupo_consumido,
    cupo_restante: merged.cupo_restante,
    cupo_umbral: merged.cupo_umbral,
  });
}
