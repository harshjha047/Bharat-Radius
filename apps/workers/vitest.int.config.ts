import { defineConfig } from 'vitest/config';

/** Needs MONGO_URL (replica set) and RADIUS_DB_URL (radius schema, app role). */
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
