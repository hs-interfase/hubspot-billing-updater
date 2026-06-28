import 'dotenv/config';
import pool from '../src/db.js';
const r = await pool.query(`DELETE FROM deal_locks WHERE lock_token = 'test-manual-t1' RETURNING deal_id`);
console.log('Locks borrados:', r.rowCount);
await pool.end();
