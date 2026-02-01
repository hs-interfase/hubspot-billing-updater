// util/cloneUtils.js
export function sanitizeLineItemDatesIfCloned(lineItem) {
  const props = lineItem.properties;
  // heurística: si last_ticketed_date existe pero no hay ticket canónico asociado
  // o si la fecha es > hoy (copia de un clon), se limpia
  const lastTicketed = props.last_ticketed_date?.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (lastTicketed && lastTicketed > today) {
    return {
      last_ticketed_date: '',
      billing_last_billed_date: '',
      billing_next_date: '',
      billing_anchor_date: '',
      irregular: '',
      fecha_irregular_puntual: '',
    };
  }
  return {};
}
