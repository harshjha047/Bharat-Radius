import type { Db, Document, IndexDescription } from 'mongodb';

export interface Migration {
  id: string;
  up(db: Db): Promise<void>;
}

/** Creates the collection with a $jsonSchema validator, or replaces the validator if it exists. */
export async function ensureCollection(db: Db, name: string, jsonSchema?: Document): Promise<void> {
  const validator = jsonSchema ? { $jsonSchema: jsonSchema } : undefined;
  const exists = (await db.listCollections({ name }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) {
    await db.createCollection(
      name,
      validator ? { validator, validationLevel: 'strict', validationAction: 'error' } : {},
    );
  } else if (validator) {
    await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
  }
}

/** PPPoE usernames are unique and matched ignoring case (rahul01 = Rahul01). Pass to finds by username. */
export const USERNAME_COLLATION = { locale: 'en', strength: 2 } as const;

export async function ensureIndexes(db: Db, name: string, indexes: IndexDescription[]): Promise<void> {
  if (indexes.length) await db.collection(name).createIndexes(indexes);
}
