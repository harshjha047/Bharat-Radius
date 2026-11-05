import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import '../app.js';
import { listRoutes } from '../http/openapi.js';
import { changes, REDACTED, redact } from './diff.js';

const REVEALS = ['/api/v1/nas/:id/secret', '/api/v1/subscribers/:id/password', '/api/v1/subscribers/export'];

describe('audit coverage', () => {
  const routes = listRoutes('api/v1');

  it('every signed-in change declares an audit action', () => {
    const missing = routes
      .filter((r) => r.method !== 'GET' && r.opts.auth !== 'public' && !r.opts.audit)
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('routes that reveal secrets or bulk data are audited', () => {
    for (const p of REVEALS) {
      const r = routes.find((x) => x.method === 'GET' && x.path === p);
      expect(r?.opts.audit, p).toBeTruthy();
    }
  });

  it('action names are entity.verb', () => {
    for (const r of routes.filter((x) => x.opts.audit)) expect(r.opts.audit).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
  });
});

describe('redact', () => {
  it('replaces secrets at any depth and normalises values', () => {
    const id = new ObjectId();
    expect(
      redact({
        password: 'x',
        nested: { radiusSecret: 's', pppoePassword: { iv: 'a' }, ok: 1 },
        passwordHash: null,
        id,
        at: new Date(0),
        file: Buffer.alloc(3),
        long: 'a'.repeat(600),
      }),
    ).toEqual({
      password: REDACTED,
      nested: { radiusSecret: REDACTED, pppoePassword: REDACTED, ok: 1 },
      passwordHash: null,
      id: id.toHexString(),
      at: '1970-01-01T00:00:00.000Z',
      file: '[3 bytes]',
      long: `${'a'.repeat(500)}…`,
    });
  });
});

describe('changes', () => {
  it('keeps only changed fields and ignores bookkeeping', () => {
    expect(
      changes(
        { name: 'A', city: 'Noida', version: 1, updatedAt: new Date(0) },
        { name: 'B', city: 'Noida', version: 2, updatedAt: new Date() },
      ),
    ).toEqual({ before: { name: 'A' }, after: { name: 'B' } });
  });

  it('says a secret changed without showing it', () => {
    expect(changes({ radiusSecret: { c: '1' } }, { radiusSecret: { c: '2' } })).toEqual({
      before: { radiusSecret: REDACTED },
      after: { radiusSecret: REDACTED },
    });
    expect(changes({ radiusSecret: { c: '1' } }, { radiusSecret: { c: '1' } })).toEqual({});
  });

  it('a created record keeps what a person entered, not ids and bookkeeping', () => {
    const id = new ObjectId();
    expect(
      changes(null, {
        _id: id,
        tenantId: id,
        ancestors: [],
        search: ['abc'],
        syncStatus: 'pending',
        version: 0,
        createdAt: new Date(0),
        createdBy: 'x',
        name: 'ABC',
        username: 'test.lab',
        pppoePassword: { iv: 'a' },
      }),
    ).toEqual({ after: { name: 'ABC', username: 'test.lab', pppoePassword: REDACTED } });
  });

  it('create and delete keep one side', () => {
    expect(changes(null, { name: 'A' })).toEqual({ after: { name: 'A' } });
    expect(changes({ name: 'A' }, null)).toEqual({ before: { name: 'A' } });
  });
});
