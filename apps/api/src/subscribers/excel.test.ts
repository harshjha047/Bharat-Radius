import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';
import { describe, expect, it } from 'vitest';
import { FieldCrypto } from '@isp/shared';
import { COLUMNS, SubscriberExcel } from './excel.js';

const T = new ObjectId();
const P = new ObjectId();
const plans = [
  {
    _id: P,
    name: 'Home 50',
    status: 'active',
    billingTypes: ['prepaid'],
    downloadKbps: 50_000,
    uploadKbps: 20_000,
  },
  {
    _id: new ObjectId(),
    name: 'Old',
    status: 'archived',
    billingTypes: ['prepaid'],
    downloadKbps: 1000,
    uploadKbps: 1000,
  },
];
const existing = [{ username: 'taken', network: { staticIp: '100.64.0.9' } }];
const mongo = {
  db: {
    collection: (name: string) => ({
      find: (f: Record<string, any>) => ({
        toArray: async () => {
          if (name === 'plans') return plans;
          if (f.username) return existing.filter((s) => f.username.$in.includes(s.username));
          return existing.filter((s) => f['network.staticIp']?.$in.includes(s.network.staticIp));
        },
      }),
      findOne: async () => ({ stateCode: '09' }),
    }),
  },
} as any;
const ctx = { tenantId: T, userId: new ObjectId(), scope: { kind: 'tenant', tenantId: T } } as any;
const excel = new SubscriberExcel(mongo, new FieldCrypto(randomBytes(32).toString('base64')));

const row = (o: Record<string, string | number | Date>) => COLUMNS.map((c) => o[c.key] ?? null);
const base = {
  name: 'A B',
  phone: 9876543210,
  address_line1: 'x',
  city: 'Noida',
  state: 'UP',
  pincode: 201301,
};

describe('Excel import validation', () => {
  it('template has the columns, plans and help sheets', async () => {
    const sheets = await readXlsxFile(await excel.template(ctx));
    expect(sheets.map((s) => s.sheet)).toEqual(['Subscribers', 'Plans', 'Help']);
    expect(sheets[0]!.data[0]![0]).toBe('username*');
    expect(sheets[1]!.data[1]![0]).toBe('Home 50');
  });

  it('accepts good rows (numbers, dates, MACs normalised) and reports every problem with row and column', async () => {
    const data: SheetData = [
      COLUMNS.map((c) => (c.required ? `${c.key}*` : c.key)),
      row({
        ...base,
        username: 'good1',
        plan: 'home 50',
        expires_on: new Date('2026-12-31T00:00:00Z'),
        mac_lock: 'aa-bb-cc-dd-ee-ff',
        sim_use: 2,
        tags: 'a, b',
      }),
      row({ ...base, username: 'good2', state_code: 7 }),
      [],
      row({ ...base, username: 'x', phone: 123 }),
      row({ ...base, username: 'good1' }),
      row({ ...base, username: 'taken' }),
      row({ ...base, username: 'oldplan', plan: 'Old' }),
      row({ ...base, username: 'noplan', plan: 'Nope' }),
      row({ ...base, username: 'ipdup', static_ip: '100.64.0.9' }),
      row({ ...base, username: 'baddate', expires_on: '31/12/2026' }),
    ];
    const file = await writeXlsxFile(data, { dateFormat: 'yyyy-mm-dd' }).toBuffer();
    const r = await excel.validate(ctx, file);
    expect(r.read).toBe(9);
    expect(r.valid.map((v) => v.row)).toEqual([2, 3]);
    const g1 = r.valid[0]!.input;
    expect(g1).toMatchObject({
      phone: '+919876543210',
      planId: P,
      network: { macLock: 'AA:BB:CC:DD:EE:FF', simUse: 2 },
      tags: ['a', 'b'],
    });
    expect(g1.expiresAt?.toISOString()).toBe('2026-12-31T18:29:59.000Z');
    expect(r.valid[1]!.input.address.stateCode).toBe('07');
    const byRow = (n: number) => r.issues.filter((i) => i.row === n).map((i) => i.column);
    expect(byRow(5)).toEqual(expect.arrayContaining(['username', 'phone']));
    expect(byRow(6)).toEqual(['username']);
    expect(byRow(7)).toEqual(['username']);
    expect(byRow(8)).toEqual(['plan']);
    expect(byRow(9)).toEqual(['plan']);
    expect(byRow(10)).toEqual(['static_ip']);
    expect(byRow(11)).toEqual(['expires_on']);
  });

  it('rejects a file without the required columns or that is not xlsx', async () => {
    await expect(excel.validate(ctx, await writeXlsxFile([['foo']]).toBuffer())).rejects.toThrow(
      /Missing columns/,
    );
    await expect(excel.validate(ctx, Buffer.from('not a zip'))).rejects.toThrow(/readable .xlsx/);
  });
});
