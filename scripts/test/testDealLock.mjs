import { acquireDealLock, releaseDealLock } from './src/db.js';

const deal = '999_test_lock';
const t1 = await acquireDealLock(deal, 'test-A');
const t2 = await acquireDealLock(deal, 'test-B'); // debe ser null (ocupado)
console.log('t1 (debe tener token):', t1);
console.log('t2 (debe ser null):  ', t2);
await releaseDealLock(deal, t1);
const t3 = await acquireDealLock(deal, 'test-C'); // debe tener token otra vez
console.log('t3 (debe tener token):', t3);
await releaseDealLock(deal, t3);
process.exit(0);