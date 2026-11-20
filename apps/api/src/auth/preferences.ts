import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { z } from 'zod';
import type { MongoHandle, UserDoc } from '@isp/db-mongo';
import { MONGO } from '../infra/infra.module.js';
import { Ctx, Endpoint } from '../http/endpoint.js';
import type { AuthContext } from './context.js';

const widgetId = z.string().regex(/^[a-z0-9-]{1,40}$/);
const prefsView = z.object({
  /** Dashboard sections and cards this user switched off (ids from the panel). */
  dashboardHidden: z.array(widgetId).max(50),
  /** Dashboard sections in the order this user arranged them; empty = the panel's default order. */
  dashboardOrder: z.array(widgetId).max(50),
});
/** Saving: leave `dashboardOrder` out to keep the saved order (older panels only send `dashboardHidden`). */
const prefsBody = prefsView.extend({ dashboardOrder: z.array(widgetId).max(50).optional() });
type Prefs = z.output<typeof prefsView>;

/** Per-user panel preferences (dashboard configuration). Personal: no permission beyond being signed in. */
@Controller('auth')
export class PreferencesController {
  constructor(@Inject(MONGO) private readonly mongo: MongoHandle) {}

  private users() {
    return this.mongo.db.collection<UserDoc>('users');
  }

  @Get('preferences')
  @Endpoint({ summary: 'My panel preferences', tags: ['auth'], response: prefsView })
  async get(@Ctx() ctx: AuthContext): Promise<Prefs> {
    const u = await this.users().findOne({ _id: ctx.userId }, { projection: { prefs: 1 } });
    return {
      dashboardHidden: u?.prefs?.dashboardHidden ?? [],
      dashboardOrder: u?.prefs?.dashboardOrder ?? [],
    };
  }

  @Put('preferences')
  @Endpoint({
    summary: 'Save my panel preferences',
    tags: ['auth'],
    audit: 'auth.preferences',
    body: prefsBody,
    response: prefsView,
  })
  async put(@Ctx() ctx: AuthContext, @Body() b: z.output<typeof prefsBody>): Promise<Prefs> {
    const hidden = [...new Set(b.dashboardHidden)];
    const order = b.dashboardOrder ? [...new Set(b.dashboardOrder)] : undefined;
    const u = await this.users().findOneAndUpdate(
      { _id: ctx.userId },
      {
        $set: {
          'prefs.dashboardHidden': hidden,
          ...(order ? { 'prefs.dashboardOrder': order } : {}),
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after', projection: { prefs: 1 }, includeResultMetadata: false },
    );
    return { dashboardHidden: hidden, dashboardOrder: u?.prefs?.dashboardOrder ?? order ?? [] };
  }
}
