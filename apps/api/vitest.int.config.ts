import { defineConfig } from 'vitest/config';

/** Needs a MongoDB replica set: MONGO_URL=mongodb://127.0.0.1:27017/?replicaSet=rs0 (CI service container). */
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
