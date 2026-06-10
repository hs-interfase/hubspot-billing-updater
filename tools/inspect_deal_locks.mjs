import 'dotenv/config';
import pool from '../src/db.js';

const cols = await pool.query(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name = 'deal_locks'
  ORDER BY ordinal_position
`);
console.log('--- columnas de deal_locks ---');
console.table(cols.rows);

const rows = await pool.query(`SELECT * FROM deal_locks LIMIT 5`);
console.log('--- filas actuales (max 5) ---');
console.table(rows.rows);

await pool.end();
