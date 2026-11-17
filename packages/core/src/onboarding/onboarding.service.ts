import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { type Database, schema, type Transaction } from "@dovetalk/db";

import { advisoryLock } from "../conversations/ids.js";
import { DRIZZLE } from "../tokens.js";
import { seedBotRows } from "./bots.js";
import { planOnboarding } from "./plan.js";

const { users, contacts, chats, chatMembers, messages, messageReactions, statuses, statusViews } =
  schema;

/**
 * Gives a new account its starting data: the 14 shared bots as saved contacts, nine direct chats
 * and two groups with relative timestamps, three reactions and six statuses (`planOnboarding`).
 *
 * The bots are shared rows that exist once per database. Callers must `await ensureBots()`
 * BEFORE they open a transaction. The first call needs a pool connection of its own: made inside
 * a transaction while other transactions hold every connection, it would wait for one that
 * nobody gives back.
 */
@Injectable()
export class OnboardingService {
  private bots: Promise<void> | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Makes sure the shared bot users exist. Safe to call from any number of places at once and
   * as often as you like: the rows are inserted `ON CONFLICT DO NOTHING`, and after the first
   * success this instance does not ask the database again. A failure is not remembered, so the
   * next call tries again.
   */
  ensureBots(): Promise<void> {
    if (!this.bots) {
      const attempt = this.db
        .insert(users)
        .values(seedBotRows())
        .onConflictDoNothing({ target: users.id })
        .then(() => undefined);
      this.bots = attempt;
      attempt.catch(() => {
        if (this.bots === attempt) {
          this.bots = null;
        }
      });
    }
    return this.bots;
  }

  /**
   * Writes the starting data for `userId` inside the caller's transaction, so it stands or
   * falls with whatever else the transaction does (making the account, for example). Eight
   * statements however much data there is. Does not check whether the account already has
   * data: use `onboardIfEmpty` for that.
   */
  async onboard(tx: Transaction, userId: string, now: number = Date.now()): Promise<void> {
    // Free once the bots are known to exist. Callers should already have awaited it.
    await this.ensureBots();
    const plan = planOnboarding({ userId, now });
    await tx.insert(contacts).values(plan.contacts);
    await tx.insert(chats).values(plan.chats);
    await tx.insert(chatMembers).values(plan.members);
    // One statement for every message: a reply points at an earlier row of the same statement,
    // which Postgres allows because it checks foreign keys when the statement ends.
    await tx.insert(messages).values(plan.messages);
    // Drizzle refuses an empty `values()`, so each of these is guarded.
    if (plan.reactions.length > 0) {
      await tx.insert(messageReactions).values(plan.reactions);
    }
    if (plan.statuses.length > 0) {
      await tx.insert(statuses).values(plan.statuses);
    }
    if (plan.statusViews.length > 0) {
      await tx.insert(statusViews).values(plan.statusViews);
    }
  }

  /**
   * Onboards an existing account that has no contacts yet (a demo account made before contacts existed, say). Returns
   * `false`, and changes nothing, when it already has some. Two callers at once onboard it once.
   */
  async onboardIfEmpty(userId: string, now: number = Date.now()): Promise<boolean> {
    await this.ensureBots();
    return this.db.transaction(async (tx) => {
      await advisoryLock(tx, `onboarding:${userId}`);
      const [existing] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.ownerId, userId))
        .limit(1);
      if (existing) {
        return false;
      }
      await this.onboard(tx, userId, now);
      return true;
    });
  }
}
