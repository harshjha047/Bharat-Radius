import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import type { Db, ObjectId } from 'mongodb';
import type { KycDocumentDoc, KycKind, MongoHandle, SubscriberDoc, TenantDoc } from '@isp/db-mongo';
import type { Files } from '../storage/storage.js';
import { sha256Hex } from '../storage/storage.js';
import { KycService } from './kyc.js';

const EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);

/** Kind from words in the path; unknown files are kept as `other` (a person sorts them in the panel). */
export function kindOf(path: string): KycKind {
  const p = path.toLowerCase();
  if (/aadh?a+r|uidai/.test(p)) return 'aadhaar';
  if (/\bpan\b|pan[\s_-]?card/.test(p)) return 'pan';
  if (/voter|epic/.test(p)) return 'voter_id';
  if (/passport/.test(p)) return 'passport';
  if (/licen[cs]e|\bdl\b/.test(p)) return 'driving_licence';
  if (/photo|\bpic\b|selfie/.test(p)) return 'photo';
  if (/\bcaf\b|caf[\s_-]|application|form/.test(p)) return 'caf_signed';
  if (/address|bill|electric|rent/.test(p)) return 'address_proof';
  return 'other';
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && EXT.has(extname(e.name).toLowerCase())) out.push(p);
  }
  return out.sort();
}

export interface KycImportReport {
  dryRun: boolean;
  files: number;
  imported: number;
  duplicates: number;
  unmatched: string[];
  ambiguous: string[];
  rejected: string[];
  byKind: Record<string, number>;
}

/**
 * Old CAF / ID files (WP 4.5): each file is matched to a customer by a folder or file-name token equal to the
 * username, customer number, 10-digit phone or old BharatRadius subscriber id. Dry run unless `apply`.
 * Re-runnable: the same file (sha256) for the same customer is skipped.
 */
export async function importKycFiles(
  db: Db,
  files: Files,
  o: { tenant: string; dir: string; apply: boolean; log: (m: string) => void },
): Promise<KycImportReport> {
  const tenant = await db.collection<TenantDoc>('tenants').findOne({ slug: o.tenant.toLowerCase() });
  if (!tenant) throw new Error(`tenant ${o.tenant} not found`);
  if (!(await stat(o.dir)).isDirectory()) throw new Error(`${o.dir} is not a directory`);
  const subs = await db
    .collection<SubscriberDoc>('subscribers')
    .find({ tenantId: tenant._id, status: { $ne: 'deleted' } })
    .toArray();
  const legacy = await db
    .collection<{ kind: string; legacyId: string; entityId: ObjectId; tenantId: ObjectId }>('legacy_map')
    .find({ tenantId: tenant._id, kind: 'subscriber' })
    .toArray();
  const index = new Map<string, Set<string>>();
  const add = (k: string | undefined, id: ObjectId) => {
    if (!k) return;
    const key = k.toLowerCase();
    const set = index.get(key) ?? new Set<string>();
    set.add(id.toHexString());
    index.set(key, set);
  };
  const byId = new Map(subs.map((s) => [s._id.toHexString(), s]));
  for (const s of subs) {
    add(s.username, s._id);
    add(s.customerNo, s._id);
    add(s.phone.replace(/\D/g, '').slice(-10), s._id);
  }
  for (const m of legacy) if (byId.has(m.entityId.toHexString())) add(`legacy:${m.legacyId}`, m.entityId);

  const kyc = new KycService({ db } as MongoHandle, files);
  const docs = db.collection<KycDocumentDoc>('kyc_documents');
  const r: KycImportReport = {
    dryRun: !o.apply,
    files: 0,
    imported: 0,
    duplicates: 0,
    unmatched: [],
    ambiguous: [],
    rejected: [],
    byKind: {},
  };
  for (const path of await walk(o.dir)) {
    r.files++;
    const rel = relative(o.dir, path);
    const tokens = rel
      .split(sep)
      .flatMap((seg, i, all) => {
        const stem = i === all.length - 1 ? basename(seg, extname(seg)) : seg;
        return [stem, ...stem.split(/[\s_.,()-]+/)];
      })
      .filter(Boolean);
    const hits = new Set<string>();
    for (const t of tokens) {
      for (const k of [
        t,
        `legacy:${t}`,
        t.replace(/\D/g, '').length >= 10 ? t.replace(/\D/g, '').slice(-10) : '',
      ]) {
        const ids = k ? index.get(k.toLowerCase()) : undefined;
        if (ids?.size === 1) hits.add([...ids][0]!);
        else if (ids && ids.size > 1) ids.forEach((x) => hits.add(x));
      }
      if (hits.size) break;
    }
    if (!hits.size) {
      r.unmatched.push(rel);
      continue;
    }
    if (hits.size > 1) {
      r.ambiguous.push(rel);
      continue;
    }
    const s = byId.get([...hits][0]!)!;
    const body = await readFile(path);
    const kind = kindOf(rel);
    const dup = await docs.findOne({
      tenantId: s.tenantId,
      subscriberId: s._id,
      sha256: sha256Hex(body),
      removed: { $exists: false },
    });
    if (dup) {
      r.duplicates++;
      continue;
    }
    r.byKind[kind] = (r.byKind[kind] ?? 0) + 1;
    if (!o.apply) {
      o.log(`would import ${rel} → ${s.customerNo} ${s.name} as ${kind}`);
      r.imported++;
      continue;
    }
    try {
      await kyc.upload('cli:import-kyc', 'import', s, body, { kind }, basename(path));
      o.log(`imported ${rel} → ${s.customerNo} as ${kind}`);
      r.imported++;
    } catch (e) {
      r.rejected.push(`${rel}: ${(e as Error).message}`);
    }
  }
  return r;
}

export function formatKycReport(r: KycImportReport): string {
  const lines = [
    `${r.dryRun ? 'DRY RUN — nothing stored. Re-run with --apply.' : 'Applied.'}`,
    `files ${r.files} · ${r.dryRun ? 'would import' : 'imported'} ${r.imported} · already there ${r.duplicates}`,
    `by kind: ${
      Object.entries(r.byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ') || '—'
    }`,
  ];
  if (r.unmatched.length)
    lines.push(`no customer matched (${r.unmatched.length}):`, ...r.unmatched.map((x) => `  ${x}`));
  if (r.ambiguous.length)
    lines.push(
      `more than one customer matched (${r.ambiguous.length}):`,
      ...r.ambiguous.map((x) => `  ${x}`),
    );
  if (r.rejected.length) lines.push(`rejected (${r.rejected.length}):`, ...r.rejected.map((x) => `  ${x}`));
  return lines.join('\n');
}
