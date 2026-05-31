const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  PageBreak, LevelFormat, PageNumber,
  Header, Footer,
} = require('docx');
const fs = require('fs');

// ── Colors ──
const C = {
  primary: '1A5276',
  secondary: '2E86C1',
  accent: '27AE60',
  warn: 'E67E22',
  light: 'EBF5FB',
  lightGreen: 'E8F8F5',
  lightOrange: 'FEF5E7',
  lightPurple: 'F4ECF7',
  lightGray: 'F2F3F4',
  headerBg: '1A5276',
  headerText: 'FFFFFF',
  catFact: 'D5E8D4',
  catId: 'DAE8FC',
  catControl: 'FFF2CC',
  catMirror: 'E1D5E7',
  catMontos: 'F8CECC',
  catFechas: 'D5E8D4',
  catCupo: 'FFE6CC',
  catAlerta: 'FFF2CC',
};

const border = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };
const headerBorders = { top: border, bottom: { style: BorderStyle.SINGLE, size: 2, color: C.primary }, left: border, right: border };

// ── Helper functions ──

function headerCell(text, width, color = C.headerBg) {
  return new TableCell({
    borders: headerBorders,
    width: { size: width, type: WidthType.DXA },
    shading: { fill: color, type: ShadingType.CLEAR },
    margins: cellMargins,
    verticalAlign: 'center',
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: C.headerText, font: 'Arial', size: 18 })] })],
  });
}

function cell(text, width, color = null) {
  const opts = {
    borders,
    width: { size: width, type: WidthType.DXA },
    margins: cellMargins,
    children: [new Paragraph({ children: [new TextRun({ text: text || '—', font: 'Arial', size: 18 })] })],
  };
  if (color) opts.shading = { fill: color, type: ShadingType.CLEAR };
  return new TableCell(opts);
}

function codeCell(text, width, color = null) {
  const opts = {
    borders,
    width: { size: width, type: WidthType.DXA },
    margins: cellMargins,
    children: [new Paragraph({ children: [new TextRun({ text: text || '—', font: 'Courier New', size: 17 })] })],
  };
  if (color) opts.shading = { fill: color, type: ShadingType.CLEAR };
  return new TableCell(opts);
}

function boldCell(text, width, color = null) {
  const opts = {
    borders,
    width: { size: width, type: WidthType.DXA },
    margins: cellMargins,
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, font: 'Arial', size: 18 })] })],
  };
  if (color) opts.shading = { fill: color, type: ShadingType.CLEAR };
  return new TableCell(opts);
}

function makeTable(colWidths, headerTexts, rows, rowColors = null) {
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  const headerRow = new TableRow({
    children: headerTexts.map((t, i) => headerCell(t, colWidths[i])),
    tableHeader: true,
  });
  const dataRows = rows.map((row, ri) => {
    const bg = rowColors ? rowColors[ri] : (ri % 2 === 1 ? C.lightGray : null);
    return new TableRow({
      children: row.map((c, ci) => {
        if (typeof c === 'object' && c._type === 'code') return codeCell(c.text, colWidths[ci], bg);
        if (typeof c === 'object' && c._type === 'bold') return boldCell(c.text, colWidths[ci], c.color || bg);
        return cell(String(c), colWidths[ci], bg);
      }),
    });
  });
  return new Table({
    width: { size: totalWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [headerRow, ...dataRows],
  });
}

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({ heading: level, children: [new TextRun({ text, font: 'Arial' })] });
}

function para(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, font: 'Arial', size: 22, ...opts })],
  });
}

function spacer() {
  return new Paragraph({ spacing: { after: 200 }, children: [] });
}

function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

function catHeader(text, color) {
  return new Paragraph({
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text: `■ ${text}`, bold: true, font: 'Arial', size: 24, color: C.primary })],
  });
}

// ── DATA ──

// SECTION 1: Properties by category
const categories = [
  {
    name: 'IDs & Claves de Idempotencia',
    color: C.catId,
    props: [
      ['Deal', 'hs_object_id', 'ID interno HubSpot del deal'],
      ['Deal', 'deal_py_origen_id', 'ID del deal PY que originó este mirror UY'],
      ['Deal', 'deal_uy_mirror_id', 'ID del deal espejo UY creado desde este PY'],
      ['Deal', 'cliente_beneficiario', 'ID de la empresa beneficiaria'],
      ['Line Item', 'hs_object_id', 'ID interno HubSpot del line item'],
      ['Line Item', 'line_item_key', 'LIK — Identificador lógico estable del LI'],
      ['Line Item', 'of_line_item_py_origen_id', 'ID del LI PY original (solo mirrors UY)'],
      ['Line Item', 'hs_product_id', 'ID del producto de catálogo asociado'],
      ['Line Item', 'hs_sku', 'SKU del producto'],
      ['Ticket', 'hs_object_id', 'ID interno HubSpot del ticket'],
      ['Ticket', 'of_ticket_key', 'Clave única: dealId::LIK:<lik>::YYYY-MM-DD'],
      ['Ticket', 'of_deal_id', 'ID del deal al que pertenece'],
      ['Ticket', 'of_line_item_ids', 'ID(s) del line item que generó este ticket'],
      ['Ticket', 'of_line_item_key', 'LIK del line item origen'],
      ['Ticket', 'of_invoice_id', 'ID de la factura emitida para este ticket'],
      ['Ticket', 'of_invoice_key', 'Clave de la factura asociada'],
      ['Invoice', 'hs_object_id', 'ID interno HubSpot de la factura'],
      ['Invoice', 'of_invoice_key', 'Clave única: dealId::lineItemId::YYYY-MM-DD'],
      ['Invoice', 'ticket_id', 'ID del ticket que generó esta factura'],
      ['Invoice', 'line_item_key', 'LIK del line item asociado'],
      ['Invoice', 'id_empresa', 'ID del deal (referencia al negocio)'],
      ['Invoice', 'id_factura_nodum', 'ID de la factura en el ERP Nodum'],
      ['Company', 'hs_object_id', 'ID interno HubSpot de la empresa'],
      ['Company', 'codigo_cliente_comercial', 'Código de cliente en Nodum (NroCliente)'],
    ],
  },
  {
    name: 'Facturación — Control de Flujo',
    color: C.catFact,
    props: [
      ['Deal', 'facturacion_activa', 'Motor procesa este deal (se activa en Cierre Ganado)'],
      ['Deal', 'pipeline', 'Pipeline del deal'],
      ['Deal', 'dealstage', 'Etapa actual del deal'],
      ['Line Item', 'facturacion_activa', 'LI participa en el motor de facturación'],
      ['Line Item', 'facturacion_automatica', 'true=auto (Phase 3), false=manual (Phase 2)'],
      ['Line Item', 'facturar_ahora', 'Flag para facturación urgente (solo manuales)'],
      ['Line Item', 'actualizar', 'Flag para forzar reprocesamiento del deal vía webhook'],
      ['Line Item', 'pausa', 'LI pausado, no genera tickets'],
      ['Line Item', 'motivo_de_pausa', 'Razón de la pausa'],
      ['Line Item', 'fechas_completas', 'Plan de pagos terminado, no generar más tickets'],
      ['Line Item', 'renovacion_automatica', 'Auto-renew: genera tickets indefinidamente'],
      ['Line Item', 'irregular', 'Fechas de facturación irregulares (manuales)'],
      ['Ticket', 'hs_pipeline', 'Pipeline del ticket (manual o automático)'],
      ['Ticket', 'hs_pipeline_stage', 'Stage actual del ticket'],
      ['Ticket', 'of_estado', 'Estado lógico del ticket (DUPLICADO_UI, DEPRECATED, etc.)'],
      ['Ticket', 'of_invoice_status', 'Espejo de etapa_de_la_factura'],
      ['Ticket', 'facturar_ahora', 'Flag de facturación urgente propagado al ticket'],
      ['Invoice', 'of_invoice_status', 'Estado legacy de la factura'],
      ['Invoice', 'etapa_de_la_factura', 'Etapa operativa: Pendiente→Emitida→Enviada→Paga/Cancelada'],
      ['Invoice', 'modo_de_generacion_de_factura', 'Cómo se generó: AUTO, MANUAL, FACTURAR_AHORA'],
      ['Invoice', 'usuario_disparador_de_factura', 'Quién disparó la facturación (si fue manual)'],
    ],
  },
  {
    name: 'Fechas de Facturación',
    color: C.catFechas,
    props: [
      ['Line Item', 'billing_anchor_date', 'Fecha ancla para cálculo de períodos'],
      ['Line Item', 'billing_next_date', 'Próxima fecha de facturación (derivada de tickets)'],
      ['Line Item', 'last_ticketed_date', 'Fecha del último ticket promovido'],
      ['Line Item', 'last_billing_period', 'Último período facturado (fecha plan)'],
      ['Line Item', 'billing_last_billed_date', 'Fecha REAL de última emisión'],
      ['Line Item', 'hs_recurring_billing_start_date', 'Fecha inicio de facturación recurrente'],
      ['Line Item', 'fecha_inicio_de_facturacion', 'Fallback de fecha inicio'],
      ['Line Item', 'fecha_irregular_puntual', 'Fecha para facturación irregular'],
      ['Line Item', 'fecha_2 ... fecha_24', 'Fechas irregulares adicionales'],
      ['Line Item', 'recurringbillingfrequency', 'Frecuencia: monthly, quarterly, annually, etc.'],
      ['Line Item', 'hs_recurring_billing_frequency', 'Frecuencia alternativa HubSpot'],
      ['Line Item', 'hs_recurring_billing_number_of_payments', 'Total de pagos contratados'],
      ['Line Item', 'hs_recurring_billing_period', 'Período recurrente (P3M, P12M, etc.)'],
      ['Line Item', 'pagos_emitidos', 'Cantidad de pagos ya emitidos'],
      ['Line Item', 'facturas_restantes', 'Pagos restantes por emitir'],
      ['Line Item', 'hs_billing_start_delay_type', 'Tipo de delay en inicio de facturación'],
      ['Line Item', 'hs_billing_start_delay_days', 'Días de delay'],
      ['Line Item', 'hs_billing_start_delay_months', 'Meses de delay'],
      ['Ticket', 'fecha_resolucion_esperada', 'Fecha planificada/esperada de facturación'],
      ['Ticket', 'of_fecha_de_facturacion', 'Fecha de orden de facturación (auto=esperada, manual=null)'],
      ['Ticket', 'fecha_real_de_facturacion', 'Fecha real en que se emitió la factura'],
      ['Invoice', 'hs_invoice_date', 'Fecha de la factura'],
      ['Invoice', 'hs_due_date', 'Fecha de vencimiento'],
      ['Invoice', 'fecha_de_emision', 'Fecha real de emisión'],
      ['Invoice', 'fecha_de_facturacion', 'Fecha de facturación copiada del ticket'],
    ],
  },
  {
    name: 'Montos y Cálculos (FREEZE RULE)',
    color: C.catMontos,
    props: [
      ['Line Item', 'price', 'Precio unitario'],
      ['Line Item', 'quantity', 'Cantidad'],
      ['Line Item', 'amount', 'Monto total (calculado por HubSpot)'],
      ['Line Item', 'discount', 'Descuento por unidad (monto)'],
      ['Line Item', 'hs_discount_percentage', 'Descuento en porcentaje'],
      ['Line Item', 'hs_cost_of_goods_sold', 'Costo unitario (COGS) — usado como precio en mirrors UY'],
      ['Line Item', 'hs_margin', 'Porcentaje de margen'],
      ['Line Item', 'hs_post_tax_amount', 'Monto post-impuestos'],
      ['Line Item', 'hs_tax_rate_group_id', 'ID del grupo de impuestos (16912720=IVA UY)'],
      ['Ticket', 'monto_unitario_real', 'Snapshot: precio unitario del LI'],
      ['Ticket', 'cantidad_real', 'Snapshot: cantidad del LI'],
      ['Ticket', 'subtotal_real', 'cantidad_real × monto_unitario_real (sin desc/IVA)'],
      ['Ticket', 'descuento_en_porcentaje', 'Snapshot: descuento % del LI (÷100)'],
      ['Ticket', 'descuento_por_unidad_real', 'Snapshot: descuento monto del LI'],
      ['Ticket', 'descuento_monto_total_real', 'descuento_por_unidad_real × cantidad_real'],
      ['Ticket', 'total_real_a_facturar', 'FUENTE DE VERDAD: subtotal - descuentos + IVA'],
      ['Ticket', 'of_iva', 'true/false — tiene IVA'],
      ['Ticket', 'of_irae', 'true/false — exonera IRAE'],
      ['Ticket', 'dolar', 'Tipo de cambio al momento de facturar'],
      ['Invoice', 'monto_a_facturar', 'Total a facturar (copiado del ticket)'],
      ['Invoice', 'hs_amount_billed', 'Monto facturado (= monto_a_facturar)'],
      ['Invoice', 'cantidad', 'Cantidad (copiada del ticket)'],
      ['Invoice', 'monto_unitario', 'Monto unitario (copiado del ticket)'],
      ['Invoice', 'descuento', 'Descuento % (copiado del ticket)'],
      ['Invoice', 'descuento_por_unidad', 'Descuento monto (copiado del ticket)'],
      ['Invoice', 'iva', 'true/false (copiado del ticket)'],
      ['Invoice', 'exonera_irae', 'true/false (copiado del ticket)'],
      ['Invoice', 'hs_currency', 'Moneda de la factura'],
    ],
  },
  {
    name: 'Cupo (Presupuesto)',
    color: C.catCupo,
    props: [
      ['Deal', 'tipo_de_cupo', 'Por Horas o Por Monto'],
      ['Deal', 'cupo_activo', 'true/false — cupo habilitado'],
      ['Deal', 'cupo_total', 'Total de horas (cupo por horas)'],
      ['Deal', 'cupo_total_monto', 'Total de monto (cupo por monto)'],
      ['Deal', 'cupo_consumido', 'Total consumido hasta ahora'],
      ['Deal', 'cupo_restante', 'Total restante'],
      ['Deal', 'cupo_umbral', 'Umbral de alerta'],
      ['Deal', 'cupo_estado', 'Ok / Bajo Umbral / Agotado / Pasado / Desactivado / Inconsistente'],
      ['Deal', 'cupo_ultima_actualizacion', 'Fecha del último consumo'],
      ['Line Item', 'parte_del_cupo', 'true = este LI consume cupo al facturar'],
      ['Ticket', 'of_aplica_para_cupo', 'Por Horas / Por Monto / null'],
      ['Ticket', 'of_cupo_consumido', 'true si ya se consumió cupo'],
      ['Ticket', 'of_cupo_consumo_valor', 'Monto/horas consumidas'],
      ['Ticket', 'cupo_consumo_invoice_id', 'ID de invoice que consumió cupo'],
      ['Ticket', 'of_cupo_consumido_fecha', 'Fecha del consumo'],
    ],
  },
  {
    name: 'Mirror PY ↔ UY',
    color: C.catMirror,
    props: [
      ['Deal', 'pais_operativo', 'Paraguay / Uruguay / Mixto'],
      ['Deal', 'es_mirror_de_py', 'true en deals espejo UY'],
      ['Deal', 'deal_py_origen_id', 'ID del deal PY original'],
      ['Deal', 'deal_uy_mirror_id', 'ID del deal espejo UY'],
      ['Deal', 'deal_currency_code', 'Moneda del deal (USD, UYU, PYG)'],
      ['Line Item', 'uy', 'true = esta línea se duplica en UY'],
      ['Line Item', 'of_line_item_py_origen_id', 'ID del LI PY original (solo en mirrors)'],
      ['Line Item', 'pais_operativo', 'País operativo del LI'],
      ['Ticket', 'of_pais_operativo', 'Snapshot: país operativo'],
      ['Ticket', 'of_moneda', 'Snapshot: moneda del deal'],
      ['Invoice', 'pais_operativo', 'País operativo de la factura'],
      ['Company', 'pais_operativo', 'Paraguay / Uruguay / Mixto'],
      ['Contact', 'pais_operativo', 'Paraguay / Uruguay / Mixto'],
    ],
  },
  {
    name: 'Snapshots (LI/Deal → Ticket)',
    color: C.catFact,
    props: [
      ['Ticket', 'of_producto_nombres', 'Snapshot: name del LI'],
      ['Ticket', 'of_descripcion_producto', 'Snapshot: description del LI'],
      ['Ticket', 'of_rubro', 'Snapshot: servicio del LI'],
      ['Ticket', 'of_subrubro', 'Snapshot: subrubro del LI'],
      ['Ticket', 'observaciones', 'Snapshot: mensaje_para_responsable del LI'],
      ['Ticket', 'nota', 'Snapshot: nota del LI'],
      ['Ticket', 'of_margen', 'Snapshot: hs_margin del LI'],
      ['Ticket', 'reventa', 'Snapshot: reventa del LI'],
      ['Ticket', 'of_costo', 'Snapshot: costo total (unitario × cantidad)'],
      ['Ticket', 'of_frecuencia_de_facturacion', 'Irregular / Único / Frecuente'],
      ['Ticket', 'repetitivo', 'true si frecuencia != único'],
      ['Ticket', 'of_cantidad_de_pagos', 'Snapshot: number_of_payments del LI'],
      ['Ticket', 'of_tipo_de_cupo', 'Snapshot: tipo_de_cupo del deal'],
      ['Ticket', 'of_propietario_secundario', 'Snapshot: hubspot_owner_id del deal (vendedor)'],
    ],
  },
  {
    name: 'Responsables & Owners',
    color: C.catAlerta,
    props: [
      ['Deal', 'hubspot_owner_id', 'Vendedor/propietario del deal'],
      ['Line Item', 'responsable_asignado', 'Responsable de facturación del LI'],
      ['Line Item', 'hubspot_owner_id', 'Owner del LI (puede diferir del deal)'],
      ['Ticket', 'hubspot_owner_id', 'Responsable del ticket (del LI, no del deal)'],
      ['Ticket', 'of_propietario_secundario', 'Vendedor (snapshot del deal owner)'],
      ['Invoice', 'responsable_asignado', 'Responsable (copiado del ticket)'],
      ['Invoice', 'vendedor_factura', 'Vendedor (copiado del ticket)'],
      ['Invoice', 'hubspot_owner_id', 'Owner de la factura (INVOICE_OWNER_ID env)'],
    ],
  },
  {
    name: 'Producto & Descripción',
    color: C.lightGreen,
    props: [
      ['Line Item', 'name', 'Nombre del producto/servicio'],
      ['Line Item', 'description', 'Descripción del producto'],
      ['Line Item', 'servicio', 'Rubro del servicio'],
      ['Line Item', 'subrubro', 'Sub-rubro'],
      ['Line Item', 'unidad_de_negocio', 'Unidad de negocio'],
      ['Line Item', 'reventa', 'Es reventa (true/false)'],
      ['Line Item', 'porcentaje_margen', 'Porcentaje de margen'],
      ['Line Item', 'mensaje_para_responsable', 'Observaciones para el responsable'],
      ['Line Item', 'nota', 'Nota interna'],
      ['Ticket', 'subject', 'Título: dealName | productName | rubro | fecha'],
      ['Ticket', 'unidad_de_negocio', 'Unidad de negocio'],
      ['Ticket', 'content', 'Comentarios del ticket'],
      ['Ticket', 'nombre_empresa', 'Nombre de la empresa (display)'],
      ['Invoice', 'hs_title', 'Título: cliente - producto - monto'],
      ['Invoice', 'nombre_producto', 'Nombre del producto'],
      ['Invoice', 'descripcion', 'Descripción'],
      ['Invoice', 'servicio', 'Rubro'],
      ['Invoice', 'unidad_de_negocio', 'Unidad de negocio'],
      ['Invoice', 'nombre_empresa', 'Nombre de la empresa'],
      ['Invoice', 'hs_comments', 'Comentarios (del ticket content)'],
    ],
  },
  {
    name: 'Notificaciones & Mantsoft',
    color: C.lightOrange,
    props: [
      ['Line Item', 'mantsoft_pendiente', 'Flag para cron Mantsoft (alta/edición/baja)'],
      ['Line Item', 'forecast_signature', 'Firma del forecast para detectar cambios'],
      ['Line Item', 'billing_error', 'Último error de billing en este LI'],
      ['Deal', 'mensaje_de_facturacion', 'HTML con resumen de facturación para el deal'],
      ['Ticket', 'ticket_emitio_aviso_a_admin', 'true si ya se notificó al admin'],
      ['Ticket', 'motivo_cancelacion_del_ticket', 'Razón de cancelación'],
      ['Ticket', 'of_motivo_pausa', 'Motivo de pausa (del LI o deal)'],
      ['Invoice', 'motivo_de_pausa', 'Motivo de pausa (copiado del ticket)'],
    ],
  },
];

// SECTION 3: Cross-object relationship matrix
const crossObjRows = [
  // [Concepto, Deal, Line Item, Ticket, Invoice, Company]
  ['ID único HubSpot', 'hs_object_id', 'hs_object_id', 'hs_object_id', 'hs_object_id', 'hs_object_id'],
  ['Clave idempotencia', '—', 'line_item_key (LIK)', 'of_ticket_key', 'of_invoice_key', '—'],
  ['País operativo', 'pais_operativo', 'pais_operativo', 'of_pais_operativo ←snap', 'pais_operativo ←snap', 'pais_operativo'],
  ['Moneda', 'deal_currency_code', '—', 'of_moneda ←snap', 'hs_currency ←snap', '—'],
  ['Nombre producto', 'dealname', 'name', 'of_producto_nombres ←snap', 'nombre_producto ←snap', 'name'],
  ['Descripción', '—', 'description', 'of_descripcion_producto ←snap', 'descripcion ←snap', '—'],
  ['Rubro/Servicio', '—', 'servicio', 'of_rubro ←snap', 'servicio ←snap', '—'],
  ['Unidad de negocio', 'unidad_de_negocio', 'unidad_de_negocio', 'unidad_de_negocio', 'unidad_de_negocio', '—'],
  ['Facturación activa', 'facturacion_activa', 'facturacion_activa', '—', '—', '—'],
  ['Tipo facturación', '—', 'facturacion_automatica', 'hs_pipeline (auto/man)', 'modo_de_generacion', '—'],
  ['Precio unitario', '—', 'price', 'monto_unitario_real ←snap', 'monto_unitario ←snap', '—'],
  ['Cantidad', '—', 'quantity', 'cantidad_real ←snap', 'cantidad ←snap', '—'],
  ['Total', '—', 'amount (HS calc)', 'total_real_a_facturar', 'monto_a_facturar ←ticket', '—'],
  ['Descuento %', '—', 'hs_discount_percentage', 'descuento_en_porcentaje ←snap÷100', 'descuento ←ticket', '—'],
  ['IVA', '—', 'hs_tax_rate_group_id', 'of_iva ←snap(bool)', 'iva ←ticket', '—'],
  ['Owner/Responsable', 'hubspot_owner_id (vendedor)', 'responsable_asignado', 'hubspot_owner_id ←LI', 'responsable_asignado ←ticket', '—'],
  ['Vendedor', 'hubspot_owner_id', '—', 'of_propietario_secundario ←deal', 'vendedor_factura ←ticket', '—'],
  ['Fecha próxima', '—', 'billing_next_date', 'fecha_resolucion_esperada', 'hs_invoice_date', '—'],
  ['Última facturación', '—', 'last_billing_period (plan)', 'fecha_real_de_facturacion', 'fecha_de_emision', '—'],
  ['Ref a invoice', '—', 'invoice_id, invoice_key', 'of_invoice_id, of_invoice_key', '— (es el obj)', '—'],
  ['Ref a deal', '— (es el obj)', 'via asociación', 'of_deal_id', 'id_empresa (deal_id)', 'via asociación'],
  ['Ref a LI', '—', '— (es el obj)', 'of_line_item_key (LIK)', 'line_item_key', '—'],
  ['Ref a ticket', '—', '—', '— (es el obj)', 'ticket_id', '—'],
  ['Mirror PY→UY', 'es_mirror_de_py, deal_py_origen_id', 'of_line_item_py_origen_id', 'via deal', 'via deal', '—'],
  ['Cupo', 'tipo/activo/total/consumido/restante', 'parte_del_cupo', 'of_aplica_para_cupo, of_cupo_*', '— (consume al crear)', '—'],
  ['Nodum', '—', '—', 'numero_de_factura', 'id_factura_nodum', 'codigo_cliente_comercial'],
];

// ── BUILD DOCUMENT ──

const children = [];

// Title page
children.push(spacer(), spacer(), spacer(), spacer());
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 200 },
  children: [new TextRun({ text: 'HubSpot Billing Updater', font: 'Arial', size: 52, bold: true, color: C.primary })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 100 },
  children: [new TextRun({ text: 'Mapeo Completo de Propiedades', font: 'Arial', size: 36, color: C.secondary })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 400 },
  children: [new TextRun({ text: 'Fuente de Verdad del Sistema', font: 'Arial', size: 28, color: '666666' })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 100 },
  children: [new TextRun({ text: `Generado: ${new Date().toISOString().slice(0, 10)}`, font: 'Arial', size: 22, color: '888888' })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  children: [new TextRun({ text: 'Deal → Line Item → Ticket → Invoice → Company', font: 'Arial', size: 22, color: '888888' })],
}));

// ════════════════════════════════════════════════════════════
// SECTION 1: Properties by Category
// ════════════════════════════════════════════════════════════
children.push(pageBreak());
children.push(heading('Sección 1 — Propiedades por Categoría'));
children.push(para('Todas las propiedades custom y estándar de HubSpot utilizadas por el sistema, organizadas por función.'));

for (const cat of categories) {
  children.push(catHeader(cat.name, cat.color));
  const rows = cat.props.map(([obj, prop, desc]) => [
    { _type: 'bold', text: obj, color: null },
    { _type: 'code', text: prop },
    desc,
  ]);
  children.push(makeTable(
    [1600, 3800, 3960],
    ['Objeto', 'Propiedad', 'Descripción'],
    rows,
  ));
  children.push(spacer());
}

// ════════════════════════════════════════════════════════════
// SECTION 2: Property Details
// ════════════════════════════════════════════════════════════
children.push(pageBreak());
children.push(heading('Sección 2 — Detalle de Propiedades Clave'));
children.push(para('Explicación ampliada de las propiedades más importantes y sus reglas de negocio.'));

const details = [
  ['of_ticket_key', 'Ticket', 'Clave de idempotencia del ticket. Formato: dealId::LIK:<lineItemKey>::YYYY-MM-DD. Garantiza que no se creen duplicados. Si ya existe un ticket con esta key, el motor no crea otro. Es la propiedad más crítica para la convergencia del sistema.'],
  ['of_invoice_key', 'Invoice', 'Clave de idempotencia de la factura. Formato: dealId::<lineItemId>::YYYY-MM-DD. Mismo principio que ticket_key. El motor verifica existencia antes de crear.'],
  ['line_item_key (LIK)', 'Line Item', 'Identificador lógico estable del line item. No cambia aunque HubSpot cambie el ID interno. Es la referencia canónica para vincular tickets, forecasts y mirrors.'],
  ['billing_next_date', 'Line Item', 'Próxima fecha de facturación. NO se calcula aritméticamente — se deriva de los tickets forecast existentes (recalcFromTickets). La fecha más próxima futura entre los tickets pendientes. Single-writer: solo recalcFromTickets escribe esta propiedad.'],
  ['billing_anchor_date', 'Line Item', 'Fecha ancla desde la cual se calculan los períodos futuros. Se establece en Phase 1. Una vez que existe el primer ticket promovido, el anchor ya no se modifica. Es la referencia para el motor matemático (billingEngine.js).'],
  ['total_real_a_facturar', 'Ticket', 'FUENTE DE VERDAD para montos. El backend NO calcula cantidad × precio - descuento + IVA. Lee este valor calculado por HubSpot y lo copia a la factura (FREEZE RULE). Solo se recalcula en el ticket, nunca en el backend.'],
  ['facturacion_automatica', 'Line Item', 'Determina el flujo: true → Phase 3 emite factura directamente. false → Phase 2 crea ticket de revisión manual. En mirrors UY siempre es false (forzado por dealMirroring.js).'],
  ['facturar_ahora', 'Line Item', 'Flag manual para facturación urgente. Solo para LIs manuales. Dispara webhook que ejecuta facturación inmediata (processUrgentLineItem). Se resetea a false después de procesar.'],
  ['fechas_completas', 'Line Item', 'Marca que el plan de pagos está terminado. El motor no genera más tickets para este LI. Se usa en filterActiveLineItems() para excluir LIs completados en runs weekday.'],
  ['recalcFromTickets', 'Line Item', 'Función (no propiedad) que es la FUENTE DE VERDAD para billing_next_date, last_ticketed_date, y last_billing_period. Mira los tickets reales y calcula. Todos los demás cálculos aritméticos son poco confiables.'],
  ['mantsoft_pendiente', 'Line Item', 'Flag para el cron de notificaciones Mantsoft. Se marca true en Phase 3 cuando se emite la primera factura de un plan. El cronMensajeMantsoft lo detecta y envía notificación de alta/edición/baja.'],
  ['cupo_estado', 'Deal', 'Estado calculado del cupo: Ok (dentro de límites), Bajo Umbral (cerca del límite), Agotado (restante=0), Pasado (restante<0), Desactivado (activo=false con restante>0), Inconsistente (datos no cuadran). Se recalcula en consumeCupo y updateDealCupo.'],
  ['of_aplica_para_cupo', 'Ticket', 'Snapshot del tipo de cupo que aplica. Se determina en snapshotService: si parte_del_cupo=true en el LI, se copia el tipo_de_cupo del deal (Por Horas / Por Monto). Si parte_del_cupo=false, queda null.'],
  ['es_mirror_de_py', 'Deal', 'Identifica deals espejo UY. Cuando es true, el deal fue creado automáticamente por mirrorDealToUruguay() desde un deal PY. Los LIs del mirror tienen facturacion_automatica forzado a false y precio = COGS del LI PY.'],
  ['forecast_signature', 'Line Item', 'Firma hash del forecast actual. Se usa para detectar cambios en el contrato que requieran recalcular los tickets forecast. Si la firma cambia, Phase P regenera el plan.'],
  ['propagateInvoiceStateToTicket', 'Ticket/Invoice', 'Función que sincroniza el estado de la factura al ticket. Mapea etapa_de_la_factura → hs_pipeline_stage del ticket. Se ejecuta ante cambios en la factura desde el editor o Nodum.'],
];

for (const [prop, obj, desc] of details) {
  children.push(new Paragraph({
    spacing: { before: 200, after: 60 },
    children: [
      new TextRun({ text: prop, bold: true, font: 'Courier New', size: 22, color: C.primary }),
      new TextRun({ text: `  (${obj})`, font: 'Arial', size: 20, color: '888888' }),
    ],
  }));
  children.push(para(desc));
}

// ════════════════════════════════════════════════════════════
// SECTION 3: Cross-Object Relationship Matrix
// ════════════════════════════════════════════════════════════
children.push(pageBreak());
children.push(heading('Sección 3 — Matriz de Relación entre Objetos'));
children.push(para('Cómo se relaciona cada concepto a través de los objetos HubSpot. Las flechas ←snap indican que el valor es un snapshot (copia inmutable) del objeto origen. Las flechas ←ticket indican que se copia del ticket al crear la factura.'));
children.push(spacer());

// Landscape table with smaller font — 6 columns
const matrixColWidths = [1800, 1600, 2000, 2000, 2000, 1200];
const matrixHeaders = ['Concepto', 'Deal', 'Line Item', 'Ticket', 'Invoice', 'Company'];

const matrixHeaderRow = new TableRow({
  children: matrixHeaders.map((t, i) => headerCell(t, matrixColWidths[i])),
  tableHeader: true,
});

const matrixDataRows = crossObjRows.map((row, ri) => {
  const bg = ri % 2 === 1 ? C.lightGray : null;
  return new TableRow({
    children: [
      boldCell(row[0], matrixColWidths[0], bg),
      ...row.slice(1).map((c, ci) => {
        const opts = {
          borders,
          width: { size: matrixColWidths[ci + 1], type: WidthType.DXA },
          margins: cellMargins,
          children: [new Paragraph({ children: [new TextRun({ text: c || '—', font: 'Courier New', size: 15 })] })],
        };
        if (bg) opts.shading = { fill: bg, type: ShadingType.CLEAR };
        return new TableCell(opts);
      }),
    ],
  });
});

children.push(new Table({
  width: { size: 10600, type: WidthType.DXA },
  columnWidths: matrixColWidths,
  rows: [matrixHeaderRow, ...matrixDataRows],
}));

children.push(spacer());

// ── Associations section ──
children.push(heading('Asociaciones entre Objetos', HeadingLevel.HEADING_2));
children.push(para('Las asociaciones en HubSpot v4 definen las relaciones entre objetos. El sistema usa association types específicos:'));

const assocRows = [
  ['Deal → Company', 'Primary (HUBSPOT_DEFINED)', 'Empresa cliente principal del deal'],
  ['Deal → Company', 'Empresa Factura (USER_DEFINED, typeId=9)', 'Empresa que emite la factura (ej: Interfase PY en mirrors UY)'],
  ['Deal → Contact', 'Persona Factura (USER_DEFINED, typeId=7)', 'Contacto responsable de facturación'],
  ['Deal → Line Item', 'Estándar (HUBSPOT_DEFINED, typeId=20)', 'Líneas de pedido del deal'],
  ['Ticket → Deal', 'Estándar', 'Via of_deal_id + asociación HubSpot'],
  ['Ticket → Line Item', 'Estándar', 'Via of_line_item_ids + asociación HubSpot'],
  ['Ticket → Company', 'Estándar', 'Copiada del deal al crear ticket'],
  ['Ticket → Contact', 'Estándar', 'Copiado del deal al crear ticket'],
  ['Invoice → Deal', 'Estándar', 'Asociada al crear factura'],
  ['Invoice → Ticket', 'Estándar', 'Asociada al crear factura'],
  ['Invoice → Contact', 'Estándar', 'Copiado del deal'],
  ['Invoice → Line Item', 'NO SE ASOCIA', 'Evita que HubSpot borre line items'],
];

children.push(makeTable(
  [2400, 3200, 3760],
  ['Relación', 'Tipo de Asociación', 'Notas'],
  assocRows,
));

children.push(spacer());

// ── Flow of data ──
children.push(heading('Flujo de Datos', HeadingLevel.HEADING_2));
children.push(para('El flujo de datos sigue una cadena unidireccional con snapshots inmutables:'));
children.push(spacer());

const flowRows = [
  ['1. Deal → Line Item', 'Asociación directa. El deal provee: moneda, país, tipo de cupo, vendedor.'],
  ['2. Deal+LI → Ticket (Snapshot)', 'snapshotService.js crea copia inmutable. Los montos, producto, rubro, etc. se congelan en el ticket al momento de creación.'],
  ['3. Ticket → Invoice (FREEZE RULE)', 'invoiceService.js copia los valores del ticket a la factura. El backend NO recalcula montos.'],
  ['4. Invoice → Ticket (Propagación)', 'Cambios de estado de la factura (Emitida, Paga, Cancelada) se propagan al ticket via propagateInvoiceStateToTicket.'],
  ['5. Invoice → Line Item (Recalc)', 'Después de crear factura: recalcFromTickets actualiza billing_next_date, last_billing_period, facturas_restantes.'],
  ['6. Invoice → Deal (Cupo)', 'consumeCupoAfterInvoice actualiza cupo_consumido, cupo_restante, cupo_estado.'],
];

children.push(makeTable(
  [2800, 6560],
  ['Paso', 'Descripción'],
  flowRows,
));

// ── Footer note ──
children.push(spacer());
children.push(new Paragraph({
  spacing: { before: 400 },
  children: [
    new TextRun({ text: 'Nota: ', bold: true, font: 'Arial', size: 20, color: C.warn }),
    new TextRun({ text: 'Este documento refleja el estado del código al momento de generación. Las propiedades pueden cambiar conforme evoluciona el sistema. Verificar siempre contra el código fuente (hubspotClient.js, snapshotService.js, invoiceService.js) ante dudas.', font: 'Arial', size: 20, color: '666666' }),
  ],
}));

// ── Create document ──
const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Arial', size: 22 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 36, bold: true, font: 'Arial', color: C.primary },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 28, bold: true, font: 'Arial', color: C.secondary },
        paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 1 } },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 15840, height: 12240, orientation: 'landscape' },
        margin: { top: 720, right: 720, bottom: 720, left: 720 },
      },
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: 'HubSpot Billing Updater — Mapeo de Propiedades', font: 'Arial', size: 16, color: '999999' })],
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: 'Página ', font: 'Arial', size: 16, color: '999999' }),
            new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: '999999' }),
          ],
        })],
      }),
    },
    children,
  }],
});

Packer.toBuffer(doc).then(buffer => {
  const outPath = '/mnt/user-data/outputs/mapeo-propiedades-hubspot.docx';
  fs.writeFileSync(outPath, buffer);
  console.log('OK:', outPath);
});
