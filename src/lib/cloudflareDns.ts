/**
 * Cloudflare DNS API — subdomain creation
 * Docs: https://developers.cloudflare.com/api/
 *
 * Creates A records for subdomains with proxy enabled
 */

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Convert any string to a DNS-safe slug: lowercase, spaces→hyphens, strip non-alphanumeric */
export function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')   // strip special chars
    .replace(/\s+/g, '-')            // spaces → hyphens
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .replace(/^-|-$/g, '');          // trim leading/trailing hyphens
}

/**
 * Create an A record subdomain via Cloudflare DNS API.
 * Returns the full subdomain string (e.g. "grace-church.churchcentral.church")
 * or null if creation fails (non-fatal — caller should log and continue).
 */
export async function createSubdomain(slug: string): Promise<string | null> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const domain = process.env.CLOUDFLARE_DOMAIN || 'churchcentral.church';
  const ip = process.env.DNS_TARGET_IP || '91.108.121.232';

  if (!apiToken || !zoneId) {
    console.error('[cloudflareDns] Missing env vars: CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID');
    return null;
  }

  const safeSlug = toSlug(slug);
  if (!safeSlug) {
    console.error('[cloudflareDns] Slug is empty after sanitization:', slug);
    return null;
  }

  try {
    const res = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/dns_records`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name: `${safeSlug}.${domain}`,
        content: ip,
        ttl: 1, // 1 = auto (Cloudflare-managed)
        proxied: true, // Enable Cloudflare proxy (orange cloud)
      }),
    });

    const data = await res.json() as any;

    if (!data.success) {
      console.error('[cloudflareDns] API error:', JSON.stringify(data.errors));
      return null;
    }

    const fullSubdomain = `${safeSlug}.${domain}`;
    console.log(`[cloudflareDns] Created subdomain: ${fullSubdomain}`);
    return fullSubdomain;
  } catch (err) {
    console.error('[cloudflareDns] Network error:', err);
    return null;
  }
}

/** List all DNS records for the zone — useful for debugging */
export async function listRecords(): Promise<any> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (!apiToken || !zoneId) {
    throw new Error('Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID');
  }

  const res = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/dns_records`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  });

  return res.json();
}

/** Delete a DNS record by ID */
export async function deleteRecord(recordId: string): Promise<boolean> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (!apiToken || !zoneId) {
    console.error('[cloudflareDns] Missing env vars: CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID');
    return false;
  }

  try {
    const res = await fetch(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await res.json() as any;

    if (!data.success) {
      console.error('[cloudflareDns] Delete error:', JSON.stringify(data.errors));
      return false;
    }

    console.log(`[cloudflareDns] Deleted record: ${recordId}`);
    return true;
  } catch (err) {
    console.error('[cloudflareDns] Delete network error:', err);
    return false;
  }
}
