import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config);

// Exit hard so Docker's restart policy recovers; a half-dead process only turns "unhealthy", which Docker ignores.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    logger.fatal({ err }, event);
    process.exit(1);
  });
}

try {
  const app = await createApp(config, logger);
  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  await app.listen(config.API_PORT, config.API_HOST);
  logger.info({ port: config.API_PORT }, 'api listening');
} catch (err) {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
}
