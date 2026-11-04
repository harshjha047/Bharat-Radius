import { ObjectId, type Collection, type Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { ScopedCollection, ScopedDb, ScopeViolation, POLICIES, type Scope } from '../src/scope.js';

const T1 = new ObjectId();
const T2 = new ObjectId();
const R1 = new ObjectId();

function fake(name: string) {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return method === 'find' || method === 'aggregate'
        ? { toArray: async () => [] }
        : Promise.resolve(null);
    };
  const raw = {
    collectionName: name,
    find: rec('find'),
    findOne: rec('findOne'),
    countDocuments: rec('countDocuments'),
    aggregate: rec('aggregate'),
    insertOne: rec('insertOne'),
    insertMany: rec('insertMany'),
    updateOne: rec('updateOne'),
    updateMany: rec('updateMany'),
    findOneAndUpdate: rec('findOneAndUpdate'),
    deleteOne: rec('deleteOne'),
  } as unknown as Collection<Document>;
  return { raw, calls };
}

const col = (name: string, scope: Scope) => {
  const f = fake(name);
  return { c: new ScopedCollection(f.raw, POLICIES[name]!, scope), calls: f.calls };
};

const tenant: Scope = { kind: 'tenant', tenantId: T1 };
const branch: Scope = { kind: 'branch', tenantId: T1, resellerId: R1 };

describe('ScopedCollection', () => {
  it('ANDs the tenant into reads without letting the caller widen it', async () => {
    const { c, calls } = col('users', tenant);
    await c.findOne({ tenantId: T2 });
    expect(calls[0]!.args[0]).toEqual({ $and: [{ tenantId: T2 }, { tenantId: T1 }] });
    await c.findOne();
    expect(calls[1]!.args[0]).toEqual({ tenantId: T1 });
  });

  it('platform scope is unfiltered', async () => {
    const { c, calls } = col('users', { kind: 'platform' });
    await c.findOne({ email: 'a@b' });
    expect(calls[0]!.args[0]).toEqual({ email: 'a@b' });
  });

  it('shared global rows are readable but not writable by a tenant', async () => {
    const { c, calls } = col('roles', tenant);
    await c.findOne({ name: 'x' });
    expect(calls[0]!.args[0]).toEqual({ $and: [{ name: 'x' }, { tenantId: { $in: [T1, null] } }] });
    await c.updateOne({ name: 'x' }, { $set: { name: 'y' } });
    expect(calls[1]!.args[0]).toEqual({ $and: [{ name: 'x' }, { tenantId: T1 }] });
  });

  it('reseller scope sees owned rows and anything below it', async () => {
    const { c, calls } = col('subscribers', branch);
    await c.find({ status: 'active' });
    expect(calls[0]!.args[0]).toEqual({
      $and: [
        { status: 'active' },
        { $and: [{ tenantId: T1 }, { $or: [{ resellerId: R1 }, { ancestors: R1 }] }] },
      ],
    });
  });

  it('reseller scope is denied on router config and read-only on plans', () => {
    expect(() => col('nas_devices', branch).c.findOne()).toThrow(ScopeViolation);
    expect(() => col('plans', branch).c.findOne()).not.toThrow();
    expect(() => col('plans', branch).c.updateOne({}, { $set: { name: 'x' } })).toThrow(ScopeViolation);
  });

  it('stamps the tenant on insert and refuses foreign tenants or branches', async () => {
    const { c, calls } = col('users', tenant);
    await c.insertOne({ name: 'a' });
    expect((calls[0]!.args[0] as Document).tenantId).toBe(T1);
    expect(() => c.insertOne({ tenantId: T2 })).toThrow(/tenant mismatch/);
    const b = col('subscribers', branch).c;
    expect(() => b.insertOne({ resellerId: new ObjectId(), ancestors: [] })).toThrow(/outside/);
    expect(() => b.insertOne({ resellerId: new ObjectId(), ancestors: [R1] })).not.toThrow();
  });

  it('refuses updates to the tenant field, pipeline updates and cross-collection aggregate stages', () => {
    const { c } = col('users', tenant);
    expect(() => c.updateOne({}, { $set: { tenantId: T2 } })).toThrow(ScopeViolation);
    expect(() => c.updateOne({}, { $rename: { name: 'tenantId' } })).toThrow(ScopeViolation);
    expect(() => c.updateOne({}, [{ $set: { a: 1 } }] as never)).toThrow(ScopeViolation);
    expect(() => c.aggregate([{ $facet: { x: [{ $lookup: { from: 'users' } }] } }])).toThrow(/\$lookup/);
    expect(() => col('roles', tenant).c.updateOne({}, { $set: { a: 1 } }, { upsert: true })).toThrow(
      /upsert/,
    );
  });

  it('prepends the scope $match to aggregates', () => {
    const { c, calls } = col('users', tenant);
    c.aggregate([{ $group: { _id: '$type' } }]);
    expect(calls[0]!.args[0]).toEqual([{ $match: { tenantId: T1 } }, { $group: { _id: '$type' } }]);
  });

  it('tenants: a tenant sees only itself and cannot create tenants', async () => {
    const { c, calls } = col('tenants', tenant);
    await c.findOne();
    expect(calls[0]!.args[0]).toEqual({ _id: T1 });
    expect(() => c.insertOne({ slug: 'x' })).toThrow(/platform/);
  });

  it('unknown collections are refused', () => {
    expect(() => new ScopedDb({} as never, tenant).collection('wallets_typo')).toThrow(/no scope policy/);
  });
});
