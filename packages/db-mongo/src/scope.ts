import type {
  AggregateOptions,
  Collection,
  CountDocumentsOptions,
  Db,
  DeleteResult,
  Document,
  Filter,
  FindCursor,
  FindOneAndUpdateOptions,
  FindOptions,
  InsertManyResult,
  InsertOneOptions,
  InsertOneResult,
  BulkWriteOptions,
  DeleteOptions,
  ObjectId,
  OptionalUnlessRequiredId,
  UpdateFilter,
  UpdateOptions,
  UpdateResult,
  WithId,
} from 'mongodb';

/** Who a request acts for (TRD §8.2). Built once per request from the authenticated user, never from input. */
export type Scope =
  | { kind: 'platform' }
  | { kind: 'tenant'; tenantId: ObjectId }
  /** rootId: the top-level (level 1) reseller of the branch; it owns the reseller plans the branch may sell. */
  | { kind: 'branch'; tenantId: ObjectId; resellerId: ObjectId; rootId?: ObjectId };

type BranchRule =
  /** Reseller sees rows it owns or that sit anywhere below it. */
  | { ownerField: string; ancestorsField?: string }
  /** Reseller may read every row of its tenant (e.g. plans), never write. */
  | 'tenant-read'
  /**
   * Tenant rows without `ownerField` (ISP-wide) plus rows owned by the branch's top-level reseller. Only that
   * top-level reseller writes, and only its own rows (reseller plans).
   */
  | { rootOwnedField: string }
  | 'deny';

export interface CollectionPolicy {
  tenantField: string;
  /** Rows with tenantField = null (built-in records) are readable by every tenant, writable only by the platform. */
  sharedGlobal?: boolean;
  branch: BranchRule;
}

export const POLICIES: Record<string, CollectionPolicy> = {
  tenants: { tenantField: '_id', branch: 'tenant-read' },
  users: { tenantField: 'tenantId', branch: { ownerField: 'resellerId' } },
  roles: { tenantField: 'tenantId', sharedGlobal: true, branch: 'tenant-read' },
  nas_devices: { tenantField: 'tenantId', branch: 'deny' },
  plans: { tenantField: 'tenantId', branch: { rootOwnedField: 'resellerId' } },
  subscribers: { tenantField: 'tenantId', branch: { ownerField: 'resellerId', ancestorsField: 'ancestors' } },
  resellers: { tenantField: 'tenantId', branch: { ownerField: '_id', ancestorsField: 'ancestors' } },
  outbox: { tenantField: 'tenantId', branch: 'deny' },
  coa_log: { tenantField: 'tenantId', branch: 'deny' },
  audit_logs: { tenantField: 'tenantId', branch: 'deny' },
  import_batches: { tenantField: 'tenantId', branch: { ownerField: 'resellerId' } },
  recharges: {
    tenantField: 'tenantId',
    branch: { ownerField: 'siteResellerId', ancestorsField: 'ancestors' },
  },
  invoices: { tenantField: 'tenantId', branch: { ownerField: 'ancestors', ancestorsField: 'ancestors' } },
  credit_notes: { tenantField: 'tenantId', branch: { ownerField: 'ancestors', ancestorsField: 'ancestors' } },
  payments: { tenantField: 'tenantId', branch: { ownerField: 'ancestors', ancestorsField: 'ancestors' } },
  // Wallets: a reseller sees its own and its direct children's (checked in the wallet service on the raw collection).
  wallets: { tenantField: 'tenantId', branch: 'deny' },
  wallet_txns: { tenantField: 'tenantId', branch: 'deny' },
  wallet_transfers: { tenantField: 'tenantId', branch: 'deny' },
  reseller_rates: { tenantField: 'tenantId', branch: 'deny' },
  message_templates: { tenantField: 'tenantId', branch: 'deny' },
  notifications: { tenantField: 'tenantId', branch: 'deny' },
  tickets: { tenantField: 'tenantId', branch: { ownerField: 'ancestors', ancestorsField: 'ancestors' } },
  kyc_documents: {
    tenantField: 'tenantId',
    branch: { ownerField: 'ancestors', ancestorsField: 'ancestors' },
  },
  // Read through the ticket (already scoped); resellers never query events directly.
  ticket_events: { tenantField: 'tenantId', branch: 'deny' },
};

export class ScopeViolation extends Error {
  override name = 'ScopeViolation';
}

/** Stages that read other collections or write output; they would bypass the injected $match. */
const UNSAFE_STAGES = new Set(['$lookup', '$graphLookup', '$unionWith', '$out', '$merge']);

function assertSafePipeline(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(assertSafePipeline);
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (UNSAFE_STAGES.has(k)) throw new ScopeViolation(`${k} is not allowed in a scoped aggregate`);
      assertSafePipeline(v);
    }
  }
}

function touchesField(update: Document, field: string): boolean {
  for (const [op, spec] of Object.entries(update)) {
    if (!op.startsWith('$') || !spec || typeof spec !== 'object') continue;
    for (const [path, val] of Object.entries(spec as Document)) {
      if (path === field || path.startsWith(`${field}.`)) return true;
      if (op === '$rename' && (val === field || String(val).startsWith(`${field}.`))) return true;
    }
  }
  return false;
}

const and = <T>(a: Filter<T>, b: Filter<T> | null): Filter<T> =>
  b === null ? a : Object.keys(a).length === 0 ? b : ({ $and: [a, b] } as Filter<T>);

export class ScopedCollection<T extends Document> {
  constructor(
    readonly raw: Collection<T>,
    private readonly policy: CollectionPolicy,
    readonly scope: Scope,
  ) {}

  private branchFilter(
    rule: Exclude<BranchRule, 'tenant-read' | 'deny' | { rootOwnedField: string }>,
    resellerId: ObjectId,
  ): Document {
    const own = { [rule.ownerField]: resellerId };
    return rule.ancestorsField ? { $or: [own, { [rule.ancestorsField]: resellerId }] } : own;
  }

  /** Filter every read gets; null = unrestricted (platform). */
  readScope(): Filter<T> | null {
    const s = this.scope;
    if (s.kind === 'platform') return null;
    const { tenantField, sharedGlobal, branch } = this.policy;
    const tenant: Document = sharedGlobal
      ? { [tenantField]: { $in: [s.tenantId, null] } }
      : { [tenantField]: s.tenantId };
    if (s.kind === 'tenant') return tenant as Filter<T>;
    if (branch === 'deny') throw new ScopeViolation(`${this.raw.collectionName} is not visible to resellers`);
    if (branch === 'tenant-read') return tenant as Filter<T>;
    if ('rootOwnedField' in branch) {
      const f = branch.rootOwnedField;
      const shared = { [f]: { $exists: false } };
      return { $and: [tenant, s.rootId ? { $or: [shared, { [f]: s.rootId }] } : shared] } as Filter<T>;
    }
    return { $and: [tenant, this.branchFilter(branch, s.resellerId)] } as Filter<T>;
  }

  /** Top-level reseller writing its own rows under a `rootOwnedField` policy; otherwise a violation. */
  private rootOwner(field: string): Document {
    const s = this.scope as Extract<Scope, { kind: 'branch' }>;
    if (!s.rootId?.equals(s.resellerId)) {
      throw new ScopeViolation(`${this.raw.collectionName} is read-only below the top-level reseller`);
    }
    return { [field]: s.resellerId };
  }

  /** Filter every write gets: never shared global rows, never tenant-wide rows for a reseller. */
  writeScope(): Filter<T> | null {
    const s = this.scope;
    if (s.kind === 'platform') return null;
    const { tenantField, branch } = this.policy;
    const tenant: Document = { [tenantField]: s.tenantId };
    if (s.kind === 'tenant') return tenant as Filter<T>;
    if (branch === 'deny' || branch === 'tenant-read') {
      throw new ScopeViolation(`${this.raw.collectionName} is read-only for resellers`);
    }
    if ('rootOwnedField' in branch)
      return { $and: [tenant, this.rootOwner(branch.rootOwnedField)] } as Filter<T>;
    return { $and: [tenant, this.branchFilter(branch, s.resellerId)] } as Filter<T>;
  }

  private stampInsert(doc: Document): Document {
    const s = this.scope;
    if (s.kind === 'platform') return doc;
    const { tenantField, branch } = this.policy;
    if (tenantField === '_id')
      throw new ScopeViolation(`${this.raw.collectionName} rows are created by the platform`);
    const given = doc[tenantField] as ObjectId | null | undefined;
    if (given != null && !given.equals(s.tenantId)) throw new ScopeViolation('tenant mismatch on insert');
    if (s.kind === 'branch') {
      if (branch === 'deny' || branch === 'tenant-read') {
        throw new ScopeViolation(`${this.raw.collectionName} is read-only for resellers`);
      }
      if ('rootOwnedField' in branch) {
        const want = this.rootOwner(branch.rootOwnedField)[branch.rootOwnedField] as ObjectId;
        const given = doc[branch.rootOwnedField] as ObjectId | undefined;
        if (!given?.equals(want)) throw new ScopeViolation('insert outside the reseller branch');
        return { ...doc, [tenantField]: s.tenantId };
      }
      const owner = doc[branch.ownerField] as ObjectId | undefined;
      const anc = branch.ancestorsField ? (doc[branch.ancestorsField] as ObjectId[] | undefined) : undefined;
      const inBranch = owner?.equals(s.resellerId) || anc?.some((a) => a.equals(s.resellerId));
      if (!inBranch) throw new ScopeViolation('insert outside the reseller branch');
    }
    return { ...doc, [tenantField]: s.tenantId };
  }

  private checkUpdate(update: UpdateFilter<T> | Document[]): void {
    if (this.scope.kind === 'platform') return;
    if (Array.isArray(update))
      throw new ScopeViolation('pipeline updates are not allowed in a scoped collection');
    if (touchesField(update as Document, this.policy.tenantField)) {
      throw new ScopeViolation(`${this.policy.tenantField} cannot be changed`);
    }
  }

  private checkUpsert(opts?: { upsert?: boolean }): void {
    if (
      opts?.upsert &&
      this.scope.kind !== 'platform' &&
      (this.scope.kind === 'branch' || this.policy.sharedGlobal)
    ) {
      throw new ScopeViolation('upsert is only allowed for tenant-owned collections at tenant scope');
    }
  }

  find(filter: Filter<T> = {}, opts?: FindOptions): FindCursor<WithId<T>> {
    return this.raw.find(and(filter, this.readScope()), opts);
  }

  findOne(filter: Filter<T> = {}, opts?: FindOptions): Promise<WithId<T> | null> {
    return this.raw.findOne(and(filter, this.readScope()), opts);
  }

  countDocuments(filter: Filter<T> = {}, opts?: CountDocumentsOptions): Promise<number> {
    return this.raw.countDocuments(and(filter, this.readScope()), opts);
  }

  aggregate<R extends Document = Document>(pipeline: Document[], opts?: AggregateOptions) {
    assertSafePipeline(pipeline);
    const scope = this.readScope();
    return this.raw.aggregate<R>(scope ? [{ $match: scope }, ...pipeline] : pipeline, opts);
  }

  insertOne(doc: OptionalUnlessRequiredId<T>, opts?: InsertOneOptions): Promise<InsertOneResult<T>> {
    return this.raw.insertOne(this.stampInsert(doc) as OptionalUnlessRequiredId<T>, opts);
  }

  insertMany(docs: OptionalUnlessRequiredId<T>[], opts?: BulkWriteOptions): Promise<InsertManyResult<T>> {
    return this.raw.insertMany(
      docs.map((d) => this.stampInsert(d) as OptionalUnlessRequiredId<T>),
      opts,
    );
  }

  updateOne(filter: Filter<T>, update: UpdateFilter<T>, opts?: UpdateOptions): Promise<UpdateResult<T>> {
    this.checkUpdate(update);
    this.checkUpsert(opts);
    return this.raw.updateOne(and(filter, this.writeScope()), update, opts);
  }

  updateMany(filter: Filter<T>, update: UpdateFilter<T>, opts?: UpdateOptions): Promise<UpdateResult<T>> {
    this.checkUpdate(update);
    this.checkUpsert(opts);
    return this.raw.updateMany(and(filter, this.writeScope()), update, opts);
  }

  findOneAndUpdate(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    opts: FindOneAndUpdateOptions = {},
  ): Promise<WithId<T> | null> {
    this.checkUpdate(update);
    this.checkUpsert(opts);
    return this.raw.findOneAndUpdate(and(filter, this.writeScope()), update, {
      ...opts,
      includeResultMetadata: false,
    });
  }

  deleteOne(filter: Filter<T>, opts?: DeleteOptions): Promise<DeleteResult> {
    return this.raw.deleteOne(and(filter, this.writeScope()), opts ?? {});
  }
}

export class ScopedDb {
  constructor(
    readonly db: Db,
    readonly scope: Scope,
  ) {}

  collection<T extends Document>(name: string): ScopedCollection<T> {
    const policy = POLICIES[name];
    if (!policy) throw new ScopeViolation(`no scope policy for collection ${name}`);
    return new ScopedCollection<T>(this.db.collection<T>(name), policy, this.scope);
  }
}
