import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import type { MongoHandle } from '@isp/db-mongo';
import { CONFIG, type Config } from '../config.js';
import { MONGO, RADIUS_DB } from '../infra/infra.module.js';
import { createHealth, type CheckFn } from '../health.js';

@Controller()
export class HealthController {
  private readonly health: ReturnType<typeof createHealth>;

  constructor(
    @Inject(CONFIG) config: Config,
    @Inject(MONGO) mongo: MongoHandle,
    @Inject(RADIUS_DB) radius: pg.Pool | null,
  ) {
    const checks: Record<string, CheckFn> = {
      mongo: async () => {
        const hello = await mongo.db.admin().command({ hello: 1 });
        return { setName: hello.setName, isWritablePrimary: hello.isWritablePrimary };
      },
    };
    if (radius) {
      checks.radiusDb = async () => {
        const { rows } = await radius.query<{ ssl: boolean; nas: string }>(
          'SELECT coalesce((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS ssl, (SELECT count(*) FROM nas)::text AS nas',
        );
        return { ssl: rows[0]?.ssl, routers: Number(rows[0]?.nas) };
      };
    }
    this.health = createHealth(checks, config.APP_VERSION);
  }

  @Get(['healthz', 'api/healthz'])
  @Header('cache-control', 'no-store')
  async healthz(@Res({ passthrough: true }) reply: FastifyReply) {
    const report = await this.health();
    void reply.status(report.status === 'ok' ? 200 : 503);
    return report;
  }

  @Get('livez')
  @Header('cache-control', 'no-store')
  livez() {
    return 'ok';
  }
}
