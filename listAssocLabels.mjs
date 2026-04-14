#!/usr/bin/env node
import 'dotenv/config';
import { hubspotClient } from './src/hubspotClient.js';

async function listLabels(fromType, toType) {
  try {
    const resp = await hubspotClient.crm.associations.v4.schema.definitionsApi.getAll(fromType, toType);
    const results = resp?.results || [];
    console.log(`\n=== ${fromType} → ${toType} (${results.length} labels) ===`);
    for (const r of results) {
      console.log(`  typeId=${r.typeId}  category=${r.category}  label="${r.label || '(sin label)'}"`);
    }
  } catch (err) {
    console.error(`Error ${fromType}→${toType}:`, err.message);
  }
}

await listLabels('deals', 'companies');
await listLabels('deals', 'contacts');
