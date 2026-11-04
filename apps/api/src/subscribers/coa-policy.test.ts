import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { SubscriberDoc } from '@isp/db-mongo';
import { coaFor, radiusState, searchTokens } from './coa-policy.js';

const P1 = new ObjectId();
const P2 = new ObjectId();
const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 1000);
type S = Pick<SubscriberDoc, 'status' | 'planId' | 'expiresAt' | 'fup' | 'network'>;
const s = (o: Partial<S> = {}): S => ({ status: 'active', planId: P1, expiresAt: future, network: {}, ...o });

describe('radiusState', () => {
  it('mirrors radius_check/radius_reply', () => {
    expect(radiusState(s())).toBe('active');
    expect(radiusState(s({ status: 'suspended' }))).toBe('blocked');
    expect(radiusState(s({ expiresAt: past }))).toBe('expired');
    const noPlan = s();
    delete noPlan.planId;
    expect(radiusState(noPlan)).toBe('expired');
    expect(radiusState(s({ fup: { active: true } }))).toBe('fup');
  });
});

describe('coaFor', () => {
  it('plan change in the same state → rate CoA', () => {
    expect(coaFor(s(), s({ planId: P2 }))).toEqual({ action: 'update', reason: 'plan_change' });
  });
  it('state changes and network changes → disconnect', () => {
    expect(coaFor(s(), s({ status: 'suspended' }))).toEqual({ action: 'disconnect', reason: 'suspend' });
    expect(coaFor(s({ expiresAt: past }), s())).toEqual({ action: 'disconnect', reason: 'renewal' });
    expect(coaFor(s(), s({ fup: { active: true } }))).toEqual({ action: 'disconnect', reason: 'fup' });
    expect(coaFor(s(), s({ network: { staticIp: '10.0.0.9' } }))).toEqual({
      action: 'disconnect',
      reason: 'network',
    });
    expect(coaFor(s(), s({ status: 'deleted' }))).toEqual({ action: 'disconnect', reason: 'delete' });
  });
  it('nothing for offline-only changes', () => {
    expect(coaFor(s({ status: 'suspended' }), s())).toBeUndefined();
    expect(coaFor(s(), s())).toBeUndefined();
    expect(coaFor(s({ expiresAt: past }), s({ expiresAt: past, planId: P2 }))).toEqual({
      action: 'update',
      reason: 'plan_change',
    });
    expect(coaFor(null, s())).toBeUndefined();
  });
});

describe('searchTokens', () => {
  it('indexes name words, username, phone with and without +91, customer number', () => {
    expect(
      searchTokens({
        name: 'Rahul  Kumar',
        username: 'Rahul01',
        phone: '+919876543210',
        customerNo: 'C000042',
      }),
    ).toEqual(['rahul', 'kumar', 'rahul01', '919876543210', '9876543210', 'c000042']);
  });
});
