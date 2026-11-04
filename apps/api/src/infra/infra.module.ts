import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import pg from 'pg';
import { connectMongo, pendingMigrations, type MongoHandle } from '@isp/db-mongo';
import { FieldCrypto } from '@isp/shared';
import { CONFIG, type Config } from '../config.js';

export const MONGO = Symbol('MONGO');
export const RADIUS_DB = Symbol('RADIUS_DB');

@Injectable()
class Shutdown implements OnApplicationShutdown {
  constructor(
    @Inject(MONGO) private readonly mongo: MongoHandle,
    @Inject(RADIUS_DB) private readonly radius: pg.Pool | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.mongo.client.close(), this.radius?.end()]);
  }
}

@Global()
@Module({})
export class InfraModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: InfraModule,
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: MONGO,
          useFactory: async () => {
            const h = await connectMongo(config.MONGO_URL, config.MONGO_POOL_MAX);
            const pending = await pendingMigrations(h.db);
            if (pending.length) {
              await h.client.close();
              throw new Error(
                `MongoDB has pending migrations (${pending.join(', ')}): run "node dist/cli.js migrate"`,
              );
            }
            return h;
          },
        },
        {
          provide: RADIUS_DB,
          useFactory: () =>
            config.RADIUS_DB_URL
              ? new pg.Pool({
                  connectionString: config.RADIUS_DB_URL,
                  max: config.RADIUS_DB_POOL_MAX,
                  idleTimeoutMillis: 30_000,
                  connectionTimeoutMillis: 2000,
                  application_name: 'isp-api',
                })
              : null,
        },
        { provide: FieldCrypto, useFactory: () => new FieldCrypto(config.FIELD_ENCRYPTION_KEY) },
        Shutdown,
      ],
      exports: [CONFIG, MONGO, RADIUS_DB, FieldCrypto],
    };
  }
}
