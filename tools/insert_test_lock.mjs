import 'dotenv/config';
import pool from '../src/db.js';

await pool.query(`
  INSERT INTO deal_locks (deal_id, lock_token, owner_label, expires_at)
  VALUES ($1, $2, $3, now() + interval '10 minutes')
`, ['60921512832', 'test-manual-t1', 'test_manual']);

const r = await pool.query(`SELECT * FROM deal_locks WHERE deal_id = $1`, ['60921512832']);
console.table(r.rows);
await pool.end();
