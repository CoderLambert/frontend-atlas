import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.ts";
import { siteRoleGrants, user, type SiteRole } from "../db/schema.ts";

type Database = BetterSQLite3Database<typeof schema>;

export function isSiteRole(value: unknown): value is SiteRole {
  return value === "reviewer" || value === "operator";
}

export class SiteRoleRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  hasActiveRole(userId: string, role: SiteRole) {
    return Boolean(this.database.select({ id: siteRoleGrants.id }).from(siteRoleGrants).where(and(
      eq(siteRoleGrants.userId, userId),
      eq(siteRoleGrants.role, role),
      isNull(siteRoleGrants.revokedAt),
    )).limit(1).all()[0]);
  }

  list(userId?: string) {
    const query = this.database.select({
      id: siteRoleGrants.id,
      userId: siteRoleGrants.userId,
      role: siteRoleGrants.role,
      createdBy: siteRoleGrants.createdBy,
      createdAt: siteRoleGrants.createdAt,
      revokedBy: siteRoleGrants.revokedBy,
      revokedAt: siteRoleGrants.revokedAt,
    }).from(siteRoleGrants);
    return (userId ? query.where(eq(siteRoleGrants.userId, userId)) : query)
      .orderBy(desc(siteRoleGrants.createdAt)).all();
  }

  grant(userId: string, role: SiteRole, createdBy: string) {
    return this.database.transaction((transaction) => {
      const existingUser = transaction.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1).all()[0];
      if (!existingUser) return { kind: "user-not-found" as const };
      const active = transaction.select().from(siteRoleGrants).where(and(
        eq(siteRoleGrants.userId, userId),
        eq(siteRoleGrants.role, role),
        isNull(siteRoleGrants.revokedAt),
      )).limit(1).all()[0];
      if (active) return { kind: "already-active" as const, value: active };
      const value = transaction.insert(siteRoleGrants).values({
        id: randomUUID(),
        userId,
        role,
        createdBy,
        createdAt: new Date(),
      }).returning().get();
      return { kind: "granted" as const, value };
    }, { behavior: "immediate" });
  }

  revoke(userId: string, role: SiteRole, revokedBy: string) {
    return this.database.transaction((transaction) => {
      const active = transaction.select().from(siteRoleGrants).where(and(
        eq(siteRoleGrants.userId, userId),
        eq(siteRoleGrants.role, role),
        isNull(siteRoleGrants.revokedAt),
      )).limit(1).all()[0];
      if (!active) return { kind: "already-revoked" as const };
      const value = transaction.update(siteRoleGrants).set({
        revokedBy,
        revokedAt: new Date(),
      }).where(and(eq(siteRoleGrants.id, active.id), isNull(siteRoleGrants.revokedAt))).returning().get();
      return value ? { kind: "revoked" as const, value } : { kind: "already-revoked" as const };
    }, { behavior: "immediate" });
  }
}

export function validateAuditActor(value: unknown) {
  if (typeof value !== "string") return null;
  const actor = value.trim();
  return actor && actor.length <= 200 ? actor : null;
}
