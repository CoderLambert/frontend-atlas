import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { coachProviderBindings } from "../../db/schema.ts";
import type * as schema from "../../db/schema.ts";

type Database = BetterSQLite3Database<typeof schema>;

export class ProviderBindingRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  findForOwner(ownerUserId: string) {
    return this.database.select().from(coachProviderBindings)
      .where(eq(coachProviderBindings.ownerUserId, ownerUserId))
      .limit(1)
      .all()[0] ?? null;
  }

  findForProfile(siwcClientId: string) {
    return this.database.select().from(coachProviderBindings)
      .where(eq(coachProviderBindings.siwcClientId, siwcClientId))
      .limit(1)
      .all()[0] ?? null;
  }

  createForOwner(ownerUserId: string, siwcClientId: string) {
    const now = new Date();
    return this.database.insert(coachProviderBindings).values({
      ownerUserId,
      siwcClientId,
      selectedModel: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all()[0];
  }

  updateSelectedModel(ownerUserId: string, expectedVersion: number, selectedModel: string) {
    const now = new Date();
    return this.database.update(coachProviderBindings).set({
      selectedModel,
      version: expectedVersion + 1,
      updatedAt: now,
    }).where(and(
      eq(coachProviderBindings.ownerUserId, ownerUserId),
      eq(coachProviderBindings.version, expectedVersion),
    )).returning().all()[0] ?? null;
  }

  deleteForOwner(ownerUserId: string) {
    return this.database.delete(coachProviderBindings)
      .where(eq(coachProviderBindings.ownerUserId, ownerUserId))
      .returning().all()[0] ?? null;
  }
}
