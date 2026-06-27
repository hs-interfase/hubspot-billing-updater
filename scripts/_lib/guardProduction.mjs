// scripts/_lib/guardProduction.mjs
//
// Segunda traba de seguridad para scripts destructivos (cleanup, fix).
//
// Cada script ya define su propio "dry-run" (simulación) con su propia
// convención (--execute, --dry, --apply, etc.). Este guard se llama DESPUÉS de
// calcular ese dry-run y SÓLO actúa cuando la corrida es REAL: si el entorno no
// es de prueba, exige además el flag --confirm-production.
//
// Detección de entorno: variable HUBSPOT_ENV (se setea en el .env local).
//   - 'sandbox' | 'test' | 'dev' | 'development' | 'local' → entorno seguro
//   - cualquier otro valor, o sin definir → se trata como PRODUCCIÓN (fail-safe)
//
// Uso:
//   import { guardProduction } from '../_lib/guardProduction.mjs';
//   const DRY_RUN = !process.argv.includes('--execute');
//   guardProduction({ scriptName: 'deleteOrphanInvoices.mjs', dryRun: DRY_RUN });

const SAFE_ENVS = new Set(['sandbox', 'test', 'dev', 'development', 'local']);

/**
 * Lee HUBSPOT_ENV y decide si el entorno se trata como producción.
 * @returns {{ env: string|null, isProd: boolean }}
 */
export function resolveEnv() {
  const envRaw = (process.env.HUBSPOT_ENV || '').trim().toLowerCase();
  return { env: envRaw || null, isProd: !SAFE_ENVS.has(envRaw) };
}

/**
 * Bloquea la ejecución real contra producción salvo que se pase --confirm-production.
 * No hace nada en dry-run ni en entornos declarados como seguros.
 *
 * @param {Object} params
 * @param {string} params.scriptName  Nombre del script (para los mensajes).
 * @param {boolean} params.dryRun     true si la corrida es simulación.
 */
export function guardProduction({ scriptName = 'script', dryRun }) {
  if (dryRun) return; // simulación: no hay nada que confirmar

  const { env, isProd } = resolveEnv();
  if (!isProd) return; // entorno de prueba declarado: el flag de ejecución alcanza

  if (!process.argv.includes('--confirm-production')) {
    console.error('');
    console.error(`❌ ${scriptName}: estás por EJECUTAR DE VERDAD contra un entorno tratado como PRODUCCIÓN.`);
    console.error(`   HUBSPOT_ENV=${env ?? '<sin definir>'} — sólo 'sandbox', 'test' o 'dev' se consideran seguros.`);
    console.error('   Para confirmar, repetí el comando agregando el flag:  --confirm-production');
    console.error('   Si en realidad es un entorno de prueba, seteá HUBSPOT_ENV=sandbox en tu .env.');
    console.error('');
    process.exit(1);
  }

  console.log(`⚠️  ${scriptName}: ejecución REAL en PRODUCCIÓN confirmada (--confirm-production).`);
}
