import { randomBytes } from 'node:crypto';
import { ObjectId, type ClientSession, type Db, type MongoClient } from 'mongodb';
import { z } from 'zod';
import { FieldCrypto } from '@isp/shared';
import {
  GST_STATES,
  createResellerWallet,
  endOfIstDay,
  ensureMasterWallet,
  insertSubscriber,
  pppoeAad,
  transfer,
  wallets,
  type AuditLogDoc,
  type NasDeviceDoc,
  type NewSubscriber,
  type OutboxDoc,
  type OutboxEntity,
  type PlanDoc,
  type ResellerDoc,
  type SubscriberDoc,
  type TenantDoc,
  type WalletDoc,
} from '@isp/db-mongo';
import { email, gstin, phone, pincode } from '../http/schemas.js';
import { derive } from '../network/plans.js';
import { createBody, mac as macSchema, staticIp as staticIpSchema } from '../subscribers/subscribers.js';

/* ---------- snapshot (deploy/ubuntu/migration/legacy-export.sql) ---------- */

const s = z
  .string()
  .nullish()
  .transform((v) => (v ?? '').trim());
const uuid = z.string().min(1);
const site = z.object({
  id: uuid,
  parentId: uuid.nullish(),
  msr: z.number().int(),
  parentMsr: z.number().int().nullish(),
  level: z.number().int(),
  name: s,
  company: s,
  email: s,
  mobile: s,
  address: s,
  city: s,
  state: s,
  zip: s,
  active: z.boolean(),
  deleted: z.boolean(),
  balance: z.string().nullish(),
});
const plan = z.object({
  id: uuid,
  siteId: uuid,
  name: s,
  download: z.string(),
  downloadUnit: s,
  upload: z.string(),
  uploadUnit: s,
  price: z.string(),
  validity: z.number().int(),
  validityType: s,
  active: z.boolean(),
});
const nas = z.object({
  id: uuid,
  siteId: uuid,
  name: s,
  ip: s,
  coaPort: z.number().int(),
  enabled: z.boolean(),
});
const subscriber = z.object({
  id: uuid,
  siteId: uuid,
  nasId: uuid.nullish(),
  planId: uuid.nullish(),
  name: s,
  company: s,
  mobile: s,
  email: s,
  address: s,
  city: s,
  state: s,
  zip: s,
  gstin: s,
  comment: s,
  username: s,
  password: z.string(),
  mac: s,
  staticIp: s,
  connectionEnabled: z.boolean(),
  expireDate: z.string().nullish(),
  createdAt: z.string(),
});
export const snapshotSchema = z.object({
  exportedAt: z.string(),
  sites: z.array(site),
  plans: z.array(plan),
  nas: z.array(nas),
  subscribers: z.array(subscriber),
});
export type Snapshot = z.output<typeof snapshotSchema>;
type LSite = z.output<typeof site>;
type LSub = z.output<typeof subscriber>;

/* ---------- pure mapping ---------- */

/** "98.00" / "1" / "-10830.5" → paise, without floating point. */
export function toPaise(v: string): number {
  const m = /^(-)?(\d+)(?:\.(\d{1,2})\d*)?$/.exec(v.trim());
  if (!m) throw new Error(`not an amount: ${v}`);
  const p = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -p : p;
}

export function toKbps(value: string, unit: string): number {
  const n = Number(value);
  const f = /^g/i.test(unit) ? 1_000_000 : /^k/i.test(unit) ? 1 : 1_000;
  return Math.round(n * f);
}

/** "1 Months" renews for 30 days (owner, 18 Nov 2026); our plans count days only. */
export function toValidityDays(n: number, type: string): number {
  const t = type.toLowerCase();
  const per = t.startsWith('year') ? 365 : t.startsWith('month') ? 30 : t.startsWith('week') ? 7 : 1;
  return Math.max(1, n * per);
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z]/g, '');
const STATE_BY_NAME = new Map(Object.entries(GST_STATES).map(([code, name]) => [norm(name), code]));
STATE_BY_NAME.set('orissa', '21');
STATE_BY_NAME.set('jammukashmir', '01');
STATE_BY_NAME.set('newdelhi', '07');
export const stateCodeOf = (state: string): string | undefined => STATE_BY_NAME.get(norm(state));

const pick = <T>(schema: z.ZodType<T>, ...vals: string[]): { value: T; index: number } | null => {
  for (let i = 0; i < vals.length; i++) {
    if (!vals[i]) continue;
    const r = schema.safeParse(vals[i]);
    if (r.success) return { value: r.data, index: i };
  }
  return null;
};

export interface TenantDefaults {
  stateCode: string;
  city: string;
  state: string;
  pincode: string;
  line1: string;
}

export interface MappedSubscriber {
  input: Omit<NewSubscriber, 'planId'>;
  disabled: boolean;
  /** Fields copied from the reseller or the ISP because the old record had none (tagged legacy-fix). */
  filled: string[];
  /** Values dropped because they were invalid (not required). */
  dropped: string[];
  /** Row cannot be imported. */
  error?: string;
}

const PLACEHOLDER_PHONE = '+910000000000';

/** One old subscriber → create input. Required fields fall back to its reseller, then the ISP. */
export function mapSubscriber(
  x: LSub,
  owner: LSite | undefined,
  t: TenantDefaults,
  now: Date,
): MappedSubscriber {
  const filled: string[] = [];
  const dropped: string[] = [];
  const user = createBody.shape.username.safeParse(x.username);
  if (!user.success)
    return { input: undefined!, disabled: false, filled, dropped, error: 'invalid PPPoE username' };
  if (!createBody.shape.pppoePassword.safeParse(x.password).success)
    return {
      input: undefined!,
      disabled: false,
      filled,
      dropped,
      error: 'PPPoE password must be 4-64 printable characters without spaces',
    };

  const ph = pick(phone, x.mobile, owner?.mobile ?? '');
  if (!ph || ph.index > 0) filled.push('phone');
  const city = x.city || owner?.city || t.city;
  const state = x.state || owner?.state || t.state;
  if (!x.city) filled.push('city');
  if (!x.state) filled.push('state');
  const pin = pick(pincode, x.zip, owner?.zip ?? '', t.pincode);
  if (!pin || pin.index > 0) filled.push('pincode');
  const line1 = x.address || [city, state].filter(Boolean).join(', ') || owner?.address || t.line1;
  if (!x.address) filled.push('address');
  const mail = x.email ? email.safeParse(x.email) : null;
  if (mail && !mail.success) dropped.push('email');
  const gst = x.gstin ? gstin.safeParse(x.gstin.toUpperCase()) : null;
  if (gst && !gst.success) dropped.push('gstin');
  const mac = x.mac ? macSchema.safeParse(x.mac) : null;
  if (mac && !mac.success) dropped.push('mac');
  const ip = x.staticIp ? staticIpSchema.safeParse(x.staticIp) : null;
  if (ip && !ip.success) dropped.push('static_ip');
  const expiresAt = x.expireDate ? new Date(x.expireDate) : endOfIstDay(new Date(now.getTime() - 86_400_000));
  if (!x.expireDate) filled.push('expiry');

  const notes = [
    'Imported from old BharatRadius.',
    filled.length ? `Filled in: ${filled.join(', ')}.` : '',
    x.comment ? `Old note: ${x.comment}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 2000);
  return {
    input: {
      username: user.data,
      pppoePassword: x.password,
      name: (x.name || x.company || user.data).slice(0, 120),
      phone: ph?.value ?? PLACEHOLDER_PHONE,
      ...(mail?.success ? { email: mail.data } : {}),
      address: {
        line1: line1.slice(0, 200),
        city: city.slice(0, 80),
        state: state.slice(0, 80),
        stateCode: stateCodeOf(state) ?? t.stateCode,
        pincode: pin?.value ?? t.pincode,
      },
      ...(gst?.success ? { gstin: gst.data } : {}),
      billingType: 'prepaid',
      expiresAt,
      network: {
        ...(mac?.success ? { macLock: mac.data } : {}),
        ...(ip?.success ? { staticIp: ip.data } : {}),
      },
      tags: filled.length ? ['legacy', 'legacy-fix'] : ['legacy'],
      notes,
    },
    disabled: !x.connectionEnabled,
    filled,
    dropped,
  };
}

/* ---------- import ---------- */

type Kind = 'reseller' | 'plan' | 'nas' | 'subscriber';
interface MapDoc {
  _id: string;
  tenantId: ObjectId;
  kind: Kind;
  legacyId: string;
  entityId: ObjectId;
  openingPaise?: number;
  createdAt: Date;
  updatedAt: Date;
}

interface Counter {
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}
const counter = (): Counter => ({ created: 0, updated: 0, unchanged: 0, failed: 0 });

export interface ImportOptions {
  tenant: string;
  apply: boolean;
  /** Old site (reseller) numbers to import with their subscribers; empty = everything. */
  sites: number[];
  log: (line: string) => void;
}

export interface ImportReport {
  dryRun: boolean;
  counts: Record<Kind | 'wallet', Counter>;
  issues: Map<string, number>;
  rowErrors: { username: string; message: string }[];
  mismatches: string[];
}

const ACTOR = 'cli:import-legacy';
const AUDIT_ACTOR = { id: 'cli', type: 'system', name: 'old BharatRadius importer' };
const NOTE = 'Opening balance from old BharatRadius';

export async function importLegacy(
  client: MongoClient,
  db: Db,
  snapshot: Snapshot,
  o: ImportOptions,
): Promise<ImportReport> {
  const key = process.env.FIELD_ENCRYPTION_KEY;
  if (!key) throw new Error('FIELD_ENCRYPTION_KEY is required (run inside the api container)');
  const crypto = new FieldCrypto(key);
  const tenant = await db.collection<TenantDoc>('tenants').findOne({ slug: o.tenant.toLowerCase() });
  if (!tenant) throw new Error(`tenant ${o.tenant} not found`);
  const tenantId = tenant._id;
  const now = new Date();
  const dry = !o.apply;
  const report: ImportReport = {
    dryRun: dry,
    counts: {
      reseller: counter(),
      plan: counter(),
      nas: counter(),
      subscriber: counter(),
      wallet: counter(),
    },
    issues: new Map(),
    rowErrors: [],
    mismatches: [],
  };
  const issue = (k: string, n = 1) => report.issues.set(k, (report.issues.get(k) ?? 0) + n);

  /* scope */
  const siteById = new Map(snapshot.sites.filter((x) => !x.deleted).map((x) => [x.id, x]));
  const siteByMsr = new Map([...siteById.values()].map((x) => [x.msr, x]));
  const parentOf = (x: LSite) =>
    (x.parentId ? siteById.get(x.parentId) : undefined) ??
    (x.parentMsr != null ? siteByMsr.get(x.parentMsr) : undefined);
  for (const m of o.sites) if (!siteByMsr.has(m)) throw new Error(`no old site number ${m}`);
  const selected = new Set(o.sites.length ? o.sites.map((m) => siteByMsr.get(m)!.id) : siteById.keys());
  const chain = (x: LSite): LSite[] => {
    const out: LSite[] = [];
    for (let c: LSite | undefined = x; c && out.length < 10; c = parentOf(c)) out.unshift(c);
    return out;
  };
  const sitesNeeded = new Map<string, LSite>();
  for (const id of selected) for (const c of chain(siteById.get(id)!)) sitesNeeded.set(c.id, c);
  const subs = snapshot.subscribers.filter((x) => selected.has(x.siteId));
  const planIdsUsed = new Set(subs.map((x) => x.planId).filter(Boolean) as string[]);
  const plansNeeded = snapshot.plans.filter((p) => selected.has(p.siteId) || planIdsUsed.has(p.id));
  const nasNeeded = snapshot.nas.filter((n) => selected.has(n.siteId));

  /* existing state, loaded once */
  const mapCol = db.collection<MapDoc>('legacy_map');
  const map = new Map((await mapCol.find({ tenantId }).toArray()).map((d) => [`${d.kind}:${d.legacyId}`, d]));
  const mapped = (kind: Kind, id: string) => map.get(`${kind}:${id}`);
  const remember = async (kind: Kind, legacyId: string, entityId: ObjectId, session?: ClientSession) => {
    const d: MapDoc = {
      _id: `${tenantId.toHexString()}:${kind}:${legacyId}`,
      tenantId,
      kind,
      legacyId,
      entityId,
      createdAt: now,
      updatedAt: now,
    };
    if (!dry)
      await mapCol.updateOne(
        { _id: d._id },
        { $setOnInsert: d },
        { upsert: true, ...(session ? { session } : {}) },
      );
    map.set(`${kind}:${legacyId}`, d);
    return d;
  };
  const audit = (
    action: string,
    type: string,
    id: ObjectId,
    after?: Record<string, unknown>,
  ): AuditLogDoc => ({
    _id: new ObjectId(),
    tenantId,
    actor: AUDIT_ACTOR,
    action,
    entity: { type, id: id.toHexString() },
    ...(after ? { after } : {}),
    createdAt: new Date(),
  });
  const audits: AuditLogDoc[] = [];
  const outboxRow = (entity: OutboxEntity, entityId: ObjectId): OutboxDoc => ({
    _id: new ObjectId(),
    tenantId,
    entity,
    entityId,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(),
    createdAt: new Date(),
  });
  const tx = <T>(fn: (session: ClientSession) => Promise<T>) =>
    client.withSession((ss) =>
      ss.withTransaction(() => fn(ss), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      }),
    );

  try {
    /* resellers, top-down */
    const resellers = db.collection<ResellerDoc>('resellers');
    const resellerOf = new Map<string, ResellerDoc>();
    const existingResellers = await resellers
      .find({
        tenantId,
        _id: { $in: [...map.values()].filter((d) => d.kind === 'reseller').map((d) => d.entityId) },
      })
      .toArray();
    const resellerById = new Map(existingResellers.map((r) => [r._id.toHexString(), r]));
    for (const x of [...sitesNeeded.values()].sort((a, b) => chain(a).length - chain(b).length)) {
      const m = mapped('reseller', x.id);
      const cur = m && resellerById.get(m.entityId.toHexString());
      if (cur && cur.status !== 'deleted') {
        resellerOf.set(x.id, cur);
        report.counts.reseller.unchanged++;
        continue;
      }
      const parentSite = parentOf(x);
      const parent = parentSite ? resellerOf.get(parentSite.id) : undefined;
      if (parentSite && !parent) {
        report.counts.reseller.failed++;
        issue(`reseller ${x.name}: parent not imported`);
        continue;
      }
      const ancestors = parent ? [...parent.ancestors, parent._id] : [];
      const ph = pick(phone, x.mobile);
      const mail = x.email ? email.safeParse(x.email) : null;
      const pin = pick(pincode, x.zip);
      const address = Object.fromEntries(
        Object.entries({ line1: x.address, city: x.city, state: x.state, pincode: pin?.value ?? '' }).filter(
          ([, v]) => v,
        ),
      );
      const doc: ResellerDoc = {
        _id: new ObjectId(),
        tenantId,
        parentId: parent?._id ?? null,
        ancestors,
        level: ancestors.length + 1,
        code: '',
        name: (x.company || x.name || `Site ${x.msr}`).slice(0, 120),
        ownerName: (x.name || x.company || `Site ${x.msr}`).slice(0, 120),
        ...(ph ? { phone: ph.value } : {}),
        ...(mail?.success ? { email: mail.data } : {}),
        ...(Object.keys(address).length ? { address } : {}),
        creditLimitPaise: 0,
        canCreateSubResellers: ancestors.length === 0,
        status: x.active ? 'active' : 'suspended',
        ...(x.active ? {} : { suspendReason: 'Inactive in old BharatRadius' }),
        version: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: ACTOR,
        updatedBy: ACTOR,
      };
      if (!dry) {
        await tx(async (session) => {
          const seq = await db
            .collection<{ _id: string; seq: number }>('counters')
            .findOneAndUpdate(
              { _id: `resellerCode:${tenantId.toHexString()}` },
              { $inc: { seq: 1 } },
              { upsert: true, returnDocument: 'after', includeResultMetadata: false, session },
            );
          doc.code = `R-${String(seq!.seq).padStart(4, '0')}`;
          await resellers.insertOne(doc, { session });
          await createResellerWallet(db, doc, session);
          await remember('reseller', x.id, doc._id, session);
        });
        audits.push(
          audit('reseller.legacy_import', 'reseller', doc._id, { name: doc.name, legacySite: x.msr }),
        );
      } else await remember('reseller', x.id, doc._id);
      resellerOf.set(x.id, doc);
      report.counts.reseller.created++;
    }

    /* opening balances: Master → … → reseller, so issued = held stays true */
    const allWallets = dry
      ? []
      : await wallets(db)
          .find({ tenantId, ownerId: { $in: [tenantId, ...[...resellerOf.values()].map((r) => r._id)] } })
          .toArray();
    const walletOf = new Map(allWallets.map((w) => [w.ownerId.toHexString(), w]));
    for (const id of selected) {
      const x = siteById.get(id)!;
      const r = resellerOf.get(id);
      if (!r || x.balance == null) continue;
      const legacy = toPaise(x.balance);
      if (legacy < 0)
        issue(`wallet ${x.name}: old balance ₹${(legacy / 100).toFixed(2)} imported as ₹0 (owner decision)`);
      const target = Math.max(0, legacy);
      const m = mapped('reseller', id)!;
      const applied = m.openingPaise ?? 0;
      const diff = target - applied;
      if (diff === 0) {
        report.counts.wallet.unchanged++;
        continue;
      }
      if (diff < 0) {
        report.counts.wallet.failed++;
        issue(
          `wallet ${x.name}: old balance fell by ₹${(-diff / 100).toFixed(2)} since the last import — adjust by hand`,
        );
        continue;
      }
      if (!dry) {
        await tx(async (session) => {
          const master = await ensureMasterWallet(db, tenantId, session);
          const path: WalletDoc[] = [master];
          for (const a of [...r.ancestors, r._id]) {
            const w =
              walletOf.get(a.toHexString()) ??
              (await wallets(db).findOne({ ownerId: a, tenantId }, { session }));
            if (!w) throw new Error(`reseller ${r.code} has no wallet`);
            path.push(w);
          }
          for (let i = 1; i < path.length; i++) {
            await transfer(db, session, {
              tenantId,
              from: path[i - 1]!,
              to: path[i]!,
              amountPaise: diff,
              idempotencyKey: `legacy:${tenantId.toHexString()}:${id}:${applied}->${target}:${i}`,
              actor: ACTOR,
              note: NOTE,
            });
          }
          await mapCol.updateOne(
            { _id: m._id },
            { $set: { openingPaise: target, updatedAt: now } },
            { session },
          );
        });
        audits.push(audit('wallet.legacy_opening', 'reseller', r._id, { amountPaise: diff }));
      }
      m.openingPaise = target;
      report.counts.wallet[applied ? 'updated' : 'created']++;
    }

    /* plans: one per distinct name + speed + validity + price */
    const plans = db.collection<PlanDoc>('plans');
    const tenantPlans = await plans.find({ tenantId, status: 'active' }).toArray();
    const planOf = new Map<string, ObjectId>();
    const byKey = new Map<string, ObjectId>();
    for (const p of plansNeeded) {
      const m = mapped('plan', p.id);
      if (m) {
        planOf.set(p.id, m.entityId);
        report.counts.plan.unchanged++;
        continue;
      }
      const downloadKbps = toKbps(p.download, p.downloadUnit);
      const uploadKbps = toKbps(p.upload, p.uploadUnit);
      const validityDays = toValidityDays(p.validity, p.validityType);
      const pricePaise = Math.max(0, toPaise(p.price));
      const name = p.name || `${downloadKbps / 1000} Mbps`;
      const k = `${name.toUpperCase()}|${downloadKbps}|${uploadKbps}|${validityDays}|${pricePaise}`;
      let id = byKey.get(k);
      if (id) report.counts.plan.unchanged++;
      else {
        const same = tenantPlans.find(
          (t) =>
            t.name.toUpperCase() === name.toUpperCase() &&
            t.downloadKbps === downloadKbps &&
            t.uploadKbps === uploadKbps &&
            t.validityDays === validityDays,
        );
        if (same) {
          id = same._id;
          report.counts.plan.unchanged++;
        } else {
          const taken = (n: string) => tenantPlans.some((t) => t.name.toUpperCase() === n.toUpperCase());
          let finalName = name.slice(0, 64);
          for (let i = 1; taken(finalName); i++) finalName = `${name.slice(0, 54)} (old ${i})`;
          const doc: PlanDoc = {
            _id: new ObjectId(),
            tenantId,
            name: finalName,
            description: 'Imported from old BharatRadius',
            downloadKbps,
            uploadKbps,
            ...derive({ downloadKbps, uploadKbps }),
            validityDays,
            simUse: 1,
            billingTypes: ['prepaid'],
            pricePaise,
            gstRatePercent: 18,
            hsnSac: '998422',
            extraAttributes: [],
            status: 'active',
            version: 0,
            createdAt: now,
            updatedAt: now,
            createdBy: ACTOR,
            updatedBy: ACTOR,
          };
          if (!dry) {
            await tx(async (session) => {
              await plans.insertOne(doc, { session });
              await db.collection<OutboxDoc>('outbox').insertOne(outboxRow('plan', doc._id), { session });
            });
            audits.push(audit('plan.legacy_import', 'plan', doc._id, { name: doc.name }));
          }
          tenantPlans.push(doc);
          id = doc._id;
          report.counts.plan.created++;
          if (pricePaise <= 100)
            issue(`plan ${finalName}: price ₹${(pricePaise / 100).toFixed(2)} — set the real MRP`);
        }
        byKey.set(k, id);
      }
      planOf.set(p.id, id);
      await remember('plan', p.id, id);
    }

    /* routers: never duplicate an IP; old secrets are not carried over (setup.rsc sets ours) */
    const nasCol = db.collection<NasDeviceDoc>('nas_devices');
    const nasNameOf = new Map<string, string>();
    const byIp = new Map(
      (await nasCol.find({ ip: { $in: nasNeeded.map((n) => n.ip.toLowerCase()) } }).toArray()).map((n) => [
        n.ip!,
        n,
      ]),
    );
    for (const n of nasNeeded) {
      nasNameOf.set(n.id, n.name);
      if (mapped('nas', n.id)) {
        report.counts.nas.unchanged++;
        continue;
      }
      const ip = n.ip.toLowerCase();
      const found = byIp.get(ip);
      if (found) {
        if (!found.tenantId.equals(tenantId)) {
          report.counts.nas.failed++;
          issue(`router ${n.name} (${ip}): IP belongs to another ISP`);
          continue;
        }
        nasNameOf.set(n.id, found.name);
        await remember('nas', n.id, found._id);
        report.counts.nas.unchanged++;
        continue;
      }
      const _id = new ObjectId();
      const doc: NasDeviceDoc = {
        _id,
        tenantId,
        name: n.name.slice(0, 64) || ip,
        ip,
        radiusSecret: crypto.encrypt(
          randomBytes(18).toString('base64url'),
          `nas.secret:${_id.toHexString()}`,
        ),
        coaPort: n.coaPort || 3799,
        location: { popName: n.name.slice(0, 80) },
        description: 'Imported from old BharatRadius; reveal the secret before running setup.rsc',
        status: n.enabled ? 'active' : 'disabled',
        version: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: ACTOR,
        updatedBy: ACTOR,
      };
      if (!dry) {
        await tx(async (session) => {
          await nasCol.insertOne(doc, { session });
          await db.collection<OutboxDoc>('outbox').insertOne(outboxRow('nas', _id), { session });
          await remember('nas', n.id, _id, session);
        });
        audits.push(audit('nas.legacy_import', 'nas', _id, { name: doc.name, ip }));
      } else await remember('nas', n.id, _id);
      report.counts.nas.created++;
    }

    /* subscribers */
    const subCol = db.collection<SubscriberDoc>('subscribers');
    const defaults: TenantDefaults = {
      stateCode: tenant.stateCode,
      city: tenant.address.city,
      state: tenant.address.state,
      pincode: tenant.address.pincode,
      line1: tenant.address.line1,
    };
    const runs = db.collection<{ _id: ObjectId; tenantId: ObjectId }>('legacy_runs');
    const runIds = (await runs.find({ tenantId }, { projection: { _id: 1 } }).toArray()).map((r) => r._id);
    const runId = new ObjectId();
    const mappedSubIds = subs.map((x) => mapped('subscriber', x.id)?.entityId).filter(Boolean) as ObjectId[];
    const existingSubs = await subCol
      .find(
        {
          tenantId,
          $or: [{ _id: { $in: mappedSubIds } }, { username: { $in: subs.map((x) => x.username) } }],
        },
        { collation: { locale: 'en', strength: 2 } },
      )
      .toArray();
    const subById = new Map(existingSubs.map((d) => [d._id.toHexString(), d]));
    const claimed = new Set(
      [...map.values()].filter((d) => d.kind === 'subscriber').map((d) => d.entityId.toHexString()),
    );
    const subByUser = new Map(
      existingSubs.filter((d) => d.username).map((d) => [d.username!.toLowerCase(), d]),
    );
    if (!dry)
      await runs.insertOne({
        _id: runId,
        tenantId,
        exportedAt: new Date(snapshot.exportedAt),
        sites: o.sites,
        startedAt: now,
        createdBy: ACTOR,
      } as never);

    for (const x of subs) {
      const owner = siteById.get(x.siteId);
      const r = resellerOf.get(x.siteId);
      const fail = (message: string) => {
        report.counts.subscriber.failed++;
        report.rowErrors.push({ username: x.username, message });
      };
      if (!r) {
        fail('its reseller was not imported');
        continue;
      }
      const m = mapSubscriber(x, owner, defaults, now);
      if (m.error) {
        fail(m.error);
        continue;
      }
      for (const f of m.filled) issue(`subscriber ${f} filled from reseller/ISP (tag legacy-fix)`);
      for (const f of m.dropped) issue(`subscriber ${f} invalid, left empty`);
      const planId = x.planId ? planOf.get(x.planId) : undefined;
      if (!planId) issue('subscriber without a plan');
      const network = {
        ...m.input.network,
        ...(x.nasId && nasNameOf.get(x.nasId) ? { popName: nasNameOf.get(x.nasId)!.slice(0, 80) } : {}),
      };
      const ancestors = [...r.ancestors, r._id];
      const status: SubscriberDoc['status'] = m.disabled ? 'disabled' : 'active';

      const mm = mapped('subscriber', x.id);
      const cur =
        (mm && subById.get(mm.entityId.toHexString())) ||
        (() => {
          const u = subByUser.get(m.input.username.toLowerCase());
          /* created by an earlier run that stopped before recording it */
          return u &&
            !claimed.has(u._id.toHexString()) &&
            u.importBatchId &&
            runIds.some((id) => id.equals(u.importBatchId!))
            ? u
            : undefined;
        })();
      if (cur && cur.status !== 'deleted') {
        /* delta: password, plan, validity, status and owner follow the old system */
        const set: Record<string, unknown> = {};
        if (crypto.decrypt(cur.pppoePassword, pppoeAad(cur._id)) !== m.input.pppoePassword)
          set.pppoePassword = crypto.encrypt(m.input.pppoePassword, pppoeAad(cur._id));
        if (planId && !cur.planId?.equals(planId)) set.planId = planId;
        /* no old expiry: keep ours (staff may have set one); only a real old date is followed */
        if (x.expireDate && cur.expiresAt?.getTime() !== m.input.expiresAt?.getTime())
          set.expiresAt = m.input.expiresAt;
        if (cur.status !== status && cur.status !== 'suspended') set.status = status;
        if (!cur.resellerId?.equals(r._id)) Object.assign(set, { resellerId: r._id, ancestors });
        if (!mm) {
          await remember('subscriber', x.id, cur._id);
          claimed.add(cur._id.toHexString());
        }
        if (!Object.keys(set).length) {
          report.counts.subscriber.unchanged++;
          continue;
        }
        if (!dry) {
          await tx(async (session) => {
            await subCol.updateOne(
              { _id: cur._id },
              {
                $set: { ...set, syncStatus: 'pending', updatedAt: new Date(), updatedBy: ACTOR },
                $inc: { version: 1 },
              },
              { session },
            );
            await db.collection<OutboxDoc>('outbox').insertOne(outboxRow('subscriber', cur._id), { session });
          });
          audits.push(
            audit('subscriber.legacy_update', 'subscriber', cur._id, {
              fields: Object.keys(set).map((k) => (k === 'pppoePassword' ? 'pppoePassword [redacted]' : k)),
            }),
          );
        }
        report.counts.subscriber.updated++;
        continue;
      }
      const clash = subByUser.get(m.input.username.toLowerCase());
      if (clash && clash.status !== 'deleted') {
        fail(`username already used by ${clash.customerNo} (not from this import) — rename or delete one`);
        continue;
      }
      if (dry) {
        report.counts.subscriber.created++;
        continue;
      }
      try {
        const doc = await insertSubscriber(
          client,
          db,
          crypto,
          { tenantId, actor: ACTOR, resellerId: r._id, ancestors, importBatchId: runId },
          { ...m.input, ...(planId ? { planId } : {}), network },
        );
        if (status === 'disabled')
          await tx(async (session) => {
            await subCol.updateOne({ _id: doc._id }, { $set: { status: 'disabled' } }, { session });
            await db.collection<OutboxDoc>('outbox').insertOne(outboxRow('subscriber', doc._id), { session });
          });
        await remember('subscriber', x.id, doc._id);
        claimed.add(doc._id.toHexString());
        subByUser.set(doc.username!.toLowerCase(), doc);
        audits.push(audit('subscriber.legacy_import', 'subscriber', doc._id, { customerNo: doc.customerNo }));
        report.counts.subscriber.created++;
      } catch (e) {
        fail(
          (e as { code?: number }).code === 11000
            ? 'username or static IP already taken'
            : `not created: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
        );
      }
    }

    if (!dry) {
      await runs.updateOne(
        { _id: runId },
        {
          $set: { finishedAt: new Date(), counts: report.counts, issues: Object.fromEntries(report.issues) },
        },
      );
      report.mismatches = await reconcile(db, crypto, tenantId, snapshot, selected, map, planOf);
    }
  } finally {
    if (audits.length) await db.collection<AuditLogDoc>('audit_logs').insertMany(audits);
  }
  return report;
}

/** After an apply: every old record in scope must exist here with the same login, plan, validity and owner. */
async function reconcile(
  db: Db,
  crypto: FieldCrypto,
  tenantId: ObjectId,
  snapshot: Snapshot,
  selected: Set<string>,
  map: Map<string, MapDoc>,
  planOf: Map<string, ObjectId>,
): Promise<string[]> {
  const out: string[] = [];
  const subs = snapshot.subscribers.filter((x) => selected.has(x.siteId));
  const ids = subs.map((x) => map.get(`subscriber:${x.id}`)?.entityId).filter(Boolean) as ObjectId[];
  const docs = new Map(
    (
      await db
        .collection<SubscriberDoc>('subscribers')
        .find({ tenantId, _id: { $in: ids } })
        .toArray()
    ).map((d) => [d._id.toHexString(), d]),
  );
  const bad = { missing: 0, password: 0, plan: 0, expiry: 0, owner: 0, status: 0 };
  for (const x of subs) {
    const d = docs.get(map.get(`subscriber:${x.id}`)?.entityId.toHexString() ?? '');
    if (!d || d.status === 'deleted') {
      bad.missing++;
      continue;
    }
    if (crypto.decrypt(d.pppoePassword, pppoeAad(d._id)) !== x.password) bad.password++;
    const p = x.planId ? planOf.get(x.planId) : undefined;
    if (p && !d.planId?.equals(p)) bad.plan++;
    if (x.expireDate && d.expiresAt?.getTime() !== new Date(x.expireDate).getTime()) bad.expiry++;
    const r = map.get(`reseller:${x.siteId}`)?.entityId;
    if (r && !d.resellerId?.equals(r)) bad.owner++;
    if ((d.status === 'disabled') !== !x.connectionEnabled) bad.status++;
  }
  for (const [k, v] of Object.entries(bad))
    if (v)
      out.push(k === 'missing' ? `subscribers: ${v} not imported` : `subscribers: ${v} with ${k} mismatch`);
  const walletDocs = await wallets(db).find({ tenantId, ownerType: 'reseller' }).toArray();
  const walletByOwner = new Map(walletDocs.map((w) => [w.ownerId.toHexString(), w]));
  for (const id of selected) {
    const m = map.get(`reseller:${id}`);
    if (!m) continue;
    const w = walletByOwner.get(m.entityId.toHexString());
    if (
      w &&
      m.openingPaise !== undefined &&
      w.balancePaise !== m.openingPaise &&
      w.totals.rechargedPaise === 0
    )
      out.push(
        `wallet ${m.entityId.toHexString()}: balance ${w.balancePaise} ≠ opening ${m.openingPaise} paise`,
      );
  }
  return out;
}

export function formatReport(r: ImportReport, total: { subscribers: number }): string {
  const lines: string[] = [];
  lines.push(r.dryRun ? '== DRY RUN (nothing written; add --apply to import)' : '== APPLIED');
  lines.push('kind        created  updated  unchanged  failed');
  for (const [k, c] of Object.entries(r.counts))
    lines.push(
      `${k.padEnd(11)} ${String(c.created).padStart(7)}  ${String(c.updated).padStart(7)}  ${String(c.unchanged).padStart(9)}  ${String(c.failed).padStart(6)}`,
    );
  lines.push(`old subscribers in scope: ${total.subscribers}`);
  if (r.issues.size) {
    lines.push('== notes');
    for (const [k, v] of [...r.issues].sort()) lines.push(`${String(v).padStart(4)} × ${k}`);
  }
  if (r.rowErrors.length) {
    lines.push('== subscribers not imported');
    for (const e of r.rowErrors) lines.push(`  ${e.username || '(no username)'}: ${e.message}`);
  }
  if (!r.dryRun) {
    lines.push('== reconciliation');
    lines.push(r.mismatches.length ? r.mismatches.map((m) => `  MISMATCH ${m}`).join('\n') : '  all match');
  }
  return lines.join('\n');
}
