import { MongoClient, type Db } from 'mongodb';

export interface MongoHandle {
  client: MongoClient;
  db: Db;
}

/** Database name comes from the URL path (isp, isp_staging, isp_test_*). */
export async function connectMongo(url: string, maxPoolSize = 20): Promise<MongoHandle> {
  const client = new MongoClient(url, {
    maxPoolSize,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 5000,
    retryWrites: true,
    readConcernLevel: 'majority',
    w: 'majority',
    appName: 'isp-api',
  });
  await client.connect();
  return { client, db: client.db() };
}
