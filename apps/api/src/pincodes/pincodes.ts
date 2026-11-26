import { Controller, Get, Header, Param } from '@nestjs/common';
import { z } from 'zod';
import { notFound } from '../errors.js';
import { Endpoint } from '../http/endpoint.js';
import { pincode } from '../http/schemas.js';
import { DISTRICTS, PACKED, STATES } from './data.js';

export interface PincodeInfo {
  pincode: string;
  district: string;
  state: string;
  stateCode: string;
}

let index: Map<string, readonly [number, number]> | undefined;

/** Built on first lookup (~19k PINs, a few ms) and kept for the process lifetime. */
function load() {
  if (index) return index;
  index = new Map();
  for (const e of PACKED.split(';')) {
    const dot = e.indexOf('.');
    index.set(e.slice(0, 6), [parseInt(e.slice(6, dot), 16), parseInt(e.slice(dot + 1), 16)]);
  }
  return index;
}

export function lookupPincode(pin: string): PincodeInfo | null {
  const hit = load().get(pin);
  if (!hit) return null;
  const [name, code] = STATES[hit[1]]!;
  return { pincode: pin, district: DISTRICTS[hit[0]]!, state: name, stateCode: code };
}

const view = z.object({
  pincode: z.string(),
  district: z.string(),
  state: z.string(),
  stateCode: z.string(),
});

@Controller('pincodes')
export class PincodesController {
  @Get(':pincode')
  @Header('cache-control', 'private, max-age=86400')
  @Endpoint({
    summary: 'District and state for an Indian PIN code (India Post directory)',
    tags: ['reference'],
    params: z.object({ pincode }),
    response: view,
  })
  get(@Param() p: { pincode: string }) {
    const info = lookupPincode(p.pincode);
    if (!info) throw notFound('PIN code');
    return info;
  }
}
