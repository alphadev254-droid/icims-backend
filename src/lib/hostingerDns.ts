/**
 * Hostinger DNS API — subdomain creation
 * Docs: https://developers.hostinger.com
 *
 * Endpoints:
 *   GET    /api/dns/v1/zones/{domain}          — list all records
 *   PUT    /api/dns/v1/zones/{domain}          — create/update records
 *   DELETE /api/dns/v1/zones/{domain}          — delete records
 */

const API_BASE = 'https://developers.hostinger.com';

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
 * Create an A record subdomain via Hostinger DNS API.
 * Returns the full subdomain string (e.g. "grace-church.churchcentral.church")
 * or null if creation fails (non-fatal — caller should log and continue).
 */
export async function createSubdomain(slug: string): Promise<string | null> {
  const apiKey = process.env.HOSTINGER_API_KEY;
  const domain = process.env.HOSTINGER_DOMAIN;
  const type   = process.env.DNS_RECORD_TYPE || 'A';
  const ip     = process.env.DNS_TARGET_IP;
  const ttl    = parseInt(process.env.DNS_TTL || '3600', 10);

  if (!apiKey || !domain || !ip) {
    console.error('[hostingerDns] Missing env vars: HOSTINGER_API_KEY, HOSTINGER_DOMAIN, or DNS_TARGET_IP');
    return null;
  }

  const safeSlug = toSlug(slug);
  if (!safeSlug) {
    console.error('[hostingerDns] Slug is empty after sanitization:', slug);
    return null;
  }

  try {
    const res = await fetch(`${API_BASE}/api/dns/v1/zones/${domain}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        overwrite: false,   // false = append, don't wipe existing records
        zone: [
          {
            type,
            name: safeSlug,
            records: [
              {
                content: ip,
                ttl,
              },
            ],
          },
        ],
      }),
    });

    const data = await res.json() as any;

    if (!res.ok) {
      console.error('[hostingerDns] API error:', res.status, JSON.stringify(data));
      return null;
    }

    const fullSubdomain = `${safeSlug}.${domain}`;
    console.log(`[hostingerDns] Created subdomain: ${fullSubdomain}`);
    return fullSubdomain;
  } catch (err) {
    console.error('[hostingerDns] Network error:', err);
    return null;
  }
}

/** List all DNS records for the domain — useful for debugging */
export async function listRecords(): Promise<any> {
  const apiKey = process.env.HOSTINGER_API_KEY;
  const domain = process.env.HOSTINGER_DOMAIN;

  const res = await fetch(`${API_BASE}/api/dns/v1/zones/${domain}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  return res.json();
}
