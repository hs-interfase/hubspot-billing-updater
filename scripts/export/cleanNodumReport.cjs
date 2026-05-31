const fs = require('fs')
const raw = JSON.parse(fs.readFileSync('zzzcopy.json', 'utf8'))
const arr = Array.isArray(raw) ? raw : (raw.resultados || raw.para_revision || [])
const clean = arr.map(r => ({
  resultado: r.resultado,
  motivo: r.motivo,
  moneda: r.moneda,
  importe: r.importe,
  fechaValor: r.fechaValor,
  metodoEmpresa: r.metodoEmpresa,
  tieneCompany: !!r.companyHsId,
  tieneNroCliente: !!r.nroCliente
}))
fs.writeFileSync('nodum-clean.json', JSON.stringify(clean, null, 2))
console.log('Listo:', clean.length, 'filas')