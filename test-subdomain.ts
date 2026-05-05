/**
 * Test script: Hostinger DNS subdomain creation
 *
 * Run with:
 *   npx ts-node test-subdomain.ts
 */

import 'dotenv/config';
import { createSubdomain, listRecords, toSlug } from './src/lib/hostingerDns';

const TEST_MINISTRY_NAMES = [
  'Grace Community Church',
  'Alpha & Omega Ministry',
  'New Life Fellowship',
  "St. Paul's Cathedral",
];

async function runTests() {
  console.log('=== Hostinger DNS Subdomain Test ===\n');

  // 1. Slug generation (no API call)
  console.log('--- Slug generation ---');
  const domain = process.env.HOSTINGER_DOMAIN || 'churchcentral.church';
  for (const name of TEST_MINISTRY_NAMES) {
    const slug = toSlug(name);
    console.log(`  "${name}" → "${slug}" → https://${slug}.${domain}`);
  }

  // 2. Env check
  console.log('\n--- Environment variables ---');
  const required = ['HOSTINGER_API_KEY', 'HOSTINGER_DOMAIN', 'DNS_TARGET_IP'];
  let envOk = true;
  for (const key of required) {
    const val = process.env[key];
    if (!val) {
      console.error(`  ✗ ${key} is NOT set`);
      envOk = false;
    } else {
      const display = key === 'HOSTINGER_API_KEY' ? val.slice(0, 8) + '...' : val;
      console.log(`  ✓ ${key} = ${display}`);
    }
  }
  console.log(`  ℹ DNS_RECORD_TYPE = ${process.env.DNS_RECORD_TYPE || 'A (default)'}`);
  console.log(`  ℹ DNS_TTL         = ${process.env.DNS_TTL || '3600 (default)'}`);

  if (!envOk) {
    console.error('\n✗ Missing required env vars. Check your .env file.');
    process.exit(1);
  }

  // 3. GET existing records first — confirms domain is in Hostinger & API key works
  console.log('\n--- GET existing DNS records ---');
  const records = await listRecords();
  if (records?.error || records?.message) {
    console.error('  ✗ GET failed:', JSON.stringify(records));
    console.error('\n  Possible causes:');
    console.error('  • Domain is not managed by Hostinger DNS (check nameservers)');
    console.error('  • API key does not have DNS permissions (regenerate in hPanel)');
    process.exit(1);
  }
  const zoneRecords: any[] = Array.isArray(records) ? records : (records?.zone ?? records?.records ?? []);
  console.log(`  ✓ Found ${zoneRecords.length} existing record(s)`);
  // Show first 5 records as a sanity check
  zoneRecords.slice(0, 5).forEach((r: any) => {
    console.log(`    ${r.type?.padEnd(6)} ${String(r.name).padEnd(30)} → ${r.content}`);
  });

  // 4. Live create test
  const testSlug = `test-${Date.now()}`;
  console.log(`\n--- Create subdomain test ---`);
  console.log(`  Slug: ${testSlug}.${domain}`);

  const result = await createSubdomain(testSlug);

  if (result) {
    console.log(`\n✓ SUCCESS — subdomain created: ${result}`);
    console.log('  DNS propagation may take a few minutes.');
  } else {
    console.error('\n✗ FAILED — check logs above for details.');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
