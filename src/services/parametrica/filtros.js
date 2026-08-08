// src/services/parametrica/filtros.js
//
// Filtro del buscador de la pantalla de paramétricas (código de empresa /
// nombre de empresa / número de contrato). Puro: lo usa el front sobre las
// filas ya cargadas y el router para validar la selección. Sin HubSpot ni DB.

/** Normaliza para comparar: sin acentos, sin espacios de más, en minúscula. */
export function normalizar(txt) {
  return String(txt ?? '')
    .normalize('NFD').replace(/\p{M}/gu, '')   // saca los acentos ya separados por NFD
    .trim().toLowerCase();
}

/**
 * Los códigos vienen con ceros a la izquierda ("0003137") y la gente los
 * escribe sin ellos ("3137"). Se compara por subcadena sobre el código tal
 * cual Y sobre el código sin ceros a la izquierda.
 */
function matchCodigo(valor, termino) {
  const v = normalizar(valor);
  if (!v) return false;
  const t = normalizar(termino);
  return v.includes(t) || v.replace(/^0+/, '').includes(t.replace(/^0+/, ''));
}

/**
 * ¿La fila pasa el buscador? Los criterios se combinan con Y: si escribís
 * empresa y contrato, tiene que cumplir los dos. Un criterio vacío no filtra.
 *
 * @param {object} fila       fila de /line-items
 * @param {object} criterios  {codigoEmpresa, nombreEmpresa, numeroContrato}
 */
export function filaMatchea(fila, criterios = {}) {
  const { codigoEmpresa, nombreEmpresa, numeroContrato } = criterios;

  if (codigoEmpresa && String(codigoEmpresa).trim()) {
    const t = String(codigoEmpresa).trim();
    // El «Codigo Contacto» también matchea: comparte rango con el de empresa
    // y quien busca puede tener a mano el equivocado.
    if (!matchCodigo(fila.codigoEmpresa, t) && !matchCodigo(fila.codigoContacto, t)) return false;
  }

  // Sólo campos de EMPRESA — el nombre del negocio no cuenta a propósito, para
  // que buscar "tel" no traiga un negocio llamado "Hotel …" de otro cliente.
  if (nombreEmpresa && String(nombreEmpresa).trim()) {
    const t = normalizar(nombreEmpresa);
    const enCliente = normalizar(fila.clienteFactura).includes(t);
    const enEmpresa = normalizar(fila.empresa).includes(t);
    if (!enCliente && !enEmpresa) return false;
  }

  if (numeroContrato && String(numeroContrato).trim()) {
    const t = normalizar(numeroContrato);
    if (!normalizar(fila.numeroContrato).includes(t)) return false;
  }

  return true;
}

/** Aplica el buscador a una lista de filas. */
export function filtrarFilas(filas, criterios = {}) {
  return (filas || []).filter(f => filaMatchea(f, criterios));
}
