// src/utils/propertyHelpers.js
import { parseNumber, parseBool, safeString } from './utils/parsers.js';
import { hubspotClient } from './hubspotClient.js';
import { hasParteDelCupoActiva } from './services/cupo/cupoUtils.js';
import { calculateCupoEstado } from './utils/propertyHelpers.js';


/*export function calculateCupoEstado(input) {
  const cupoActivo = parseBool(input.cupo_activo);

  const tipo = safeString(input.tipo_de_cupo).trim();
  const consumido = parseNumber(input.cupo_consumido, NaN);
  const restante = parseNumber(input.cupo_restante, NaN);
  const umbral = parseNumber(input.cupo_umbral, NaN);

  // Total según tipo
  const totalHoras = parseNumber(input.cupo_total, NaN);
  const totalMonto = parseNumber(input.cupo_total_monto, NaN);
  const totalGenerico = parseNumber(input.cupo_total, NaN);

  let total = NaN;
  if (tipo === "Por Horas") total = !isNaN(totalHoras) ? totalHoras : totalGenerico;
  else if (tipo === "Por Monto") total = !isNaN(totalMonto) ? totalMonto : totalGenerico;
  else total = totalGenerico;

  // ✅ Regla: si cupo_activo=false y cupo_total null => cupo_estado null
  // (en HubSpot normalmente se guarda como '' para “vacío”)
  const totalMissing =
    input.cupo_total == null || String(input.cupo_total).trim() === "";
  const totalMontoMissing =
    input.cupo_total_monto == null || String(input.cupo_total_monto).trim() === "";

  const noHayTotalConfigurado =
    totalMissing && totalMontoMissing; // por si es Monto y solo usas cupo_total_monto

  if (!cupoActivo && noHayTotalConfigurado) return "";

  // Si faltan números clave y hay total, es inconsistente (no puedo validar)
  if (isNaN(total) || isNaN(consumido) || isNaN(restante)) return "Inconsistente";

  const EPS = 0.01;

  // ✅ Regla: si restante + consumido != total => Inconsistente
  const diff = Math.abs((consumido + restante) - total);
  if (diff > EPS) return "Inconsistente";

  // ✅ Regla: si restante < 0 => Pasado
  if (restante < 0 - EPS) return "Pasado";

  // ✅ Regla: si cupo_activo=false y restante == 0 => Agotado
  // (en general, si restante <= 0 también es agotado, pero Pasado ya capturó negativos)
  if (restante <= 0 + EPS) return "Agotado";

  // ✅ Regla: si cupo_activo=false (y restante > 0) => Desactivado
  if (!cupoActivo) return "Desactivado";

  // ✅ Regla: si restante <= umbral => Bajo Umbral
  if (!isNaN(umbral) && restante <= umbral + EPS) return "Bajo Umbral";

  return "Ok";
}
*/