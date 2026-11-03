import type { Pool } from 'pg';
import type { NasTarget, SessionRef } from './client.js';

export interface OpenSession {
  target: NasTarget;
  session: SessionRef;
  tenantSlug: string;
}

/** Open sessions for a username (optionally within one tenant), heard from within 3 interim periods. */
export async function findOpenSessions(
  pool: Pool,
  userName: string,
  tenantSlug?: string,
): Promise<OpenSession[]> {
  const { rows } = await pool.query<{
    acctsessionid: string;
    framedip: string | null;
    nasip: string;
    secret: string;
    coa_port: number;
    slug: string;
  }>(
    `SELECT a.acctsessionid, host(a.framedipaddress) AS framedip, host(a.nasipaddress) AS nasip,
            n.secret, n.coa_port, t.slug
       FROM radacct a
       JOIN tenants t ON t.id = a.tenant_id
       JOIN nas n ON n.nasname = a.nasipaddress AND n.tenant_id = a.tenant_id
      WHERE a.username = $1 AND a.acctstoptime IS NULL
        AND a.acctupdatetime > now() - make_interval(secs => 3 * t.interim_interval)
        AND ($2::text IS NULL OR t.slug = $2)`,
    [userName, tenantSlug ?? null],
  );
  return rows.map((r) => {
    const session: SessionRef = { userName, acctSessionId: r.acctsessionid };
    if (r.framedip) session.framedIp = r.framedip;
    return { target: { host: r.nasip, port: r.coa_port, secret: r.secret }, session, tenantSlug: r.slug };
  });
}
