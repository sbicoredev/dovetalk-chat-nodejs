import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  CONTACT_ABOUT_MAX,
  CONTACT_NAME_MAX,
  type ContactDto,
  type CreateContactInput,
  DEFAULT_ABOUT,
  type UpdateContactInput,
} from "@dovetalk/contracts";
import { type Database, type Executor, newId, schema, type Transaction } from "@dovetalk/db";

import { DomainError } from "../errors.js";
import { must } from "../invariant.js";
import { type ParsedPhone, PHONE_MESSAGE, parsePhone } from "../phone.js";
import { PresenceService } from "../realtime/presence.service.js";
import { RealtimeEvents } from "../realtime/realtime-events.service.js";
import { onlineFor } from "../realtime/visibility.js";
import { AttachmentsService } from "../storage/attachments.service.js";
import { DRIZZLE } from "../tokens.js";
import { advisoryLock, directKey, isUuid } from "./ids.js";
import { hideChat } from "./membership.js";
import { Projector } from "./projector.js";

const { contacts, users, chats } = schema;

/** The same person's contact row for the owner: what they think of them. Only `blocked` is read. */
const theirs = alias(contacts, "theirs");

const notFound = () => new DomainError("CONTACT_NOT_FOUND", "This contact no longer exists.");

/** The profile columns a contact needs from the person it points at. Never the password hash. */
const profile = {
  about: users.about,
  hue: users.hue,
  avatarAttachmentId: users.avatarAttachmentId,
  isBot: users.isBot,
  botOnlineDefault: users.botOnlineDefault,
};

/** A random colour for a ghost, 0 to 359. */
const randomHue = () => Math.floor(Math.random() * 360);

function requireName(raw: string): string {
  const name = raw.trim();
  if (!name) {
    throw new DomainError("VALIDATION_ERROR", ["Enter a name."]);
  }
  if (name.length > CONTACT_NAME_MAX) {
    throw new DomainError("VALIDATION_ERROR", [
      `Name can be at most ${CONTACT_NAME_MAX} characters.`,
    ]);
  }
  return name;
}

function requirePhone(raw: string): ParsedPhone {
  const phone = parsePhone(raw);
  if (!phone) {
    throw new DomainError("VALIDATION_ERROR", [PHONE_MESSAGE]);
  }
  return phone;
}

/**
 * One person's address book. Rows are the owner's alone: other people have their own rows for
 * the same person, which is why a contact id means something only to the viewer who has it.
 *
 * A row is "saved" when the owner added it, and "unsaved" when it exists only so the owner can
 * see a name next to somebody's messages (they share a chat but never added them, or they
 * deleted the contact). Unsaved rows are listed, because the web app resolves every sender
 * through the list, but only saved ones can be edited or deleted.
 */
@Injectable()
export class ContactsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(Projector) private readonly projector: Projector,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(RealtimeEvents) private readonly events: RealtimeEvents,
  ) {}

  /** Every row the viewer has, saved or not, oldest first. */
  async list(viewerId: string): Promise<ContactDto[]> {
    const rows = await this.db
      .select({ contact: contacts, profile, blockedByThem: theirs.blocked })
      .from(contacts)
      .innerJoin(users, eq(users.id, contacts.linkedUserId))
      .leftJoin(
        theirs,
        and(eq(theirs.ownerId, contacts.linkedUserId), eq(theirs.linkedUserId, contacts.ownerId)),
      )
      .where(eq(contacts.ownerId, viewerId))
      .orderBy(asc(contacts.createdAt), asc(contacts.id));
    return this.project(this.db, rows);
  }

  /**
   * Adds somebody by phone number. In this order:
   * 1. a number the owner already has a contact for returns that contact (and puts it back in
   *    the address book, under the new name, if they had deleted it);
   * 2. a number a registered person signed up with links to that person;
   * 3. any other number gets a "ghost": a bot that belongs to this owner alone, so the app
   *    behaves as it does with the mock (add somebody, chat, get an answer).
   *
   * `created` is true only when a new contact row was made, so the API can answer 201 or 200.
   */
  async create(
    viewerId: string,
    input: CreateContactInput,
  ): Promise<{ contact: ContactDto; created: boolean }> {
    const name = requireName(input.name);
    const phone = requirePhone(input.phone);

    return this.db.transaction(async (tx) => {
      // Two requests adding the same number must not both miss the other's row.
      await advisoryLock(tx, `contacts:${viewerId}`);
      await this.refuseOwnNumber(tx, viewerId, phone);

      const [existing] = await tx
        .select({ id: contacts.id, saved: contacts.saved })
        .from(contacts)
        .where(and(eq(contacts.ownerId, viewerId), eq(contacts.phoneDigits, phone.digits)))
        .orderBy(desc(contacts.saved), asc(contacts.createdAt), asc(contacts.id))
        .limit(1);
      if (existing) {
        if (!existing.saved) {
          await tx.update(contacts).set({ name, saved: true }).where(eq(contacts.id, existing.id));
        }
        return { contact: await this.getOwn(tx, viewerId, existing.id), created: false };
      }

      const [person] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(eq(users.phoneDigits, phone.digits), eq(users.isBot, false), ne(users.id, viewerId)),
        )
        .limit(1);

      if (person) {
        // The conflict clause covers a chat that made an unsaved row for this person a moment ago.
        // A row the owner already saved keeps its name.
        const [row] = await tx
          .insert(contacts)
          .values({ ownerId: viewerId, linkedUserId: person.id, name, phone: phone.display })
          .onConflictDoUpdate({
            target: [contacts.ownerId, contacts.linkedUserId],
            set: {
              name: sql`case when ${contacts.saved} then ${contacts.name} else excluded.name end`,
              saved: true,
            },
          })
          .returning({ id: contacts.id, created: sql<boolean>`(xmax = 0)` });
        const saved = must(row, "the upserted contact");
        return { contact: await this.getOwn(tx, viewerId, saved.id), created: saved.created };
      }

      const ghostId = newId();
      await tx.insert(users).values({
        id: ghostId,
        name,
        about: DEFAULT_ABOUT,
        hue: randomHue(),
        isBot: true,
        ghostOwnerId: viewerId,
      });
      const [row] = await tx
        .insert(contacts)
        .values({ ownerId: viewerId, linkedUserId: ghostId, name, phone: phone.display })
        .returning({ id: contacts.id });
      return {
        contact: await this.getOwn(tx, viewerId, must(row, "the new contact").id),
        created: true,
      };
    });
  }

  /** Changes what the owner calls somebody and the number they have for them. Saved contacts only. */
  async update(
    viewerId: string,
    contactId: string,
    input: UpdateContactInput,
  ): Promise<ContactDto> {
    if (!isUuid(contactId)) {
      throw notFound();
    }
    const set: Partial<typeof contacts.$inferInsert> = {};
    if (input.name !== undefined) {
      set.name = requireName(input.name);
    }
    const phone = input.phone === undefined ? undefined : requirePhone(input.phone);
    if (phone) {
      set.phone = phone.display;
    }
    if (input.about !== undefined) {
      const about = input.about.trim();
      if (about.length > CONTACT_ABOUT_MAX) {
        throw new DomainError("VALIDATION_ERROR", [
          `About can be at most ${CONTACT_ABOUT_MAX} characters.`,
        ]);
      }
      set.about = about;
    }

    return this.db.transaction(async (tx) => {
      await advisoryLock(tx, `contacts:${viewerId}`);
      const [current] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(eq(contacts.id, contactId), eq(contacts.ownerId, viewerId), eq(contacts.saved, true)),
        )
        .limit(1);
      if (!current) {
        throw notFound();
      }

      if (phone) {
        await this.refuseOwnNumber(tx, viewerId, phone);
        // Only saved contacts count: an unsaved row is not in the address book, so the owner
        // cannot see it and must not be told off for it.
        const [taken] = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.ownerId, viewerId),
              eq(contacts.saved, true),
              eq(contacts.phoneDigits, phone.digits),
              ne(contacts.id, contactId),
            ),
          )
          .limit(1);
        if (taken) {
          throw new DomainError("PHONE_TAKEN", "You already have a contact with that number.");
        }
      }

      if (Object.keys(set).length > 0) {
        await tx.update(contacts).set(set).where(eq(contacts.id, contactId));
      }
      return this.getOwn(tx, viewerId, contactId);
    });
  }

  /**
   * Takes somebody out of the address book and off the chat list. The row stays, unsaved, so
   * their old messages in groups still show a name, and `blocked` is kept so deleting a
   * contact is not a way round a block. A group they are in cannot change because of this
   * (docs/edge-cases.md, 7).
   */
  async remove(viewerId: string, contactId: string): Promise<void> {
    if (!isUuid(contactId)) {
      throw notFound();
    }
    const hidden = await this.db.transaction(async (tx) => {
      await advisoryLock(tx, `contacts:${viewerId}`);
      const [contact] = await tx
        .update(contacts)
        .set({ saved: false })
        .where(
          and(eq(contacts.id, contactId), eq(contacts.ownerId, viewerId), eq(contacts.saved, true)),
        )
        .returning({ linkedUserId: contacts.linkedUserId });
      if (!contact) {
        throw notFound();
      }

      const [direct] = await tx
        .select({ id: chats.id })
        .from(chats)
        .where(eq(chats.directKey, directKey(viewerId, contact.linkedUserId)))
        .limit(1);
      return direct && (await hideChat(tx, viewerId, direct.id)) ? direct.id : null;
    });
    // The direct chat left the person's list, on every device of theirs.
    if (hidden) {
      this.events.chatRemoved(viewerId, hidden);
    }
  }

  /**
   * Blocks or unblocks. Works on any of the owner's rows, saved or not: blocking a stranger who
   * messaged first is the main use.
   */
  async setBlocked(viewerId: string, contactId: string, blocked: boolean): Promise<ContactDto> {
    if (!isUuid(contactId)) {
      throw notFound();
    }
    const [row] = await this.db
      .update(contacts)
      .set({ blocked })
      .where(and(eq(contacts.id, contactId), eq(contacts.ownerId, viewerId)))
      .returning({ id: contacts.id, userId: contacts.linkedUserId });
    if (!row) {
      throw notFound();
    }
    // Both people now see each other as offline, or as they really are again.
    this.events.blockChanged(viewerId, row.userId);
    return this.getOwn(this.db, viewerId, row.id);
  }

  /**
   * Makes sure `ownerId` has a contact row for `targetUserId`, so the owner can see a name next to
   * that person's messages. A new row is unsaved and carries the person's own name and number.
   * Bots never own contacts: nobody reads their side of anything.
   */
  async ensureContact(executor: Executor, ownerId: string, targetUserId: string): Promise<void> {
    await executor.execute(sql`
      insert into contacts (id, owner_id, linked_user_id, name, phone, saved)
      select gen_random_uuid(), owner.id, target.id, target.name, target.phone, false
      from users owner, users target
      where owner.id = ${ownerId} and target.id = ${targetUserId}
        and owner.id <> target.id and not owner.is_bot
      on conflict (owner_id, linked_user_id) do nothing
    `);
  }

  /**
   * `ensureContact` for every pair of people in a chat, in one statement. It has to be one
   * statement inside the database: a group of 256 people is about 65,000 rows, more than a
   * query can carry as parameters. Rows are made in a fixed order so two chats being set up at
   * once cannot wait on each other's rows in opposite orders. The ids are random (Postgres 16
   * has no uuidv7), which is fine for rows that are not in the address book.
   */
  async ensureContacts(executor: Executor, chatId: string): Promise<void> {
    await executor.execute(sql`
      insert into contacts (id, owner_id, linked_user_id, name, phone, saved)
      select gen_random_uuid(), owner.user_id, target.user_id, target_user.name, target_user.phone, false
      from chat_members owner
      join users owner_user on owner_user.id = owner.user_id and not owner_user.is_bot
      join chat_members target on target.chat_id = owner.chat_id and target.user_id <> owner.user_id
      join users target_user on target_user.id = target.user_id
      where owner.chat_id = ${chatId} and owner.left_at is null
      order by owner.user_id, target.user_id
      on conflict (owner_id, linked_user_id) do nothing
    `);
  }

  private async refuseOwnNumber(tx: Transaction, viewerId: string, phone: ParsedPhone) {
    const [me] = await tx
      .select({ digits: users.phoneDigits })
      .from(users)
      .where(eq(users.id, viewerId))
      .limit(1);
    if (me?.digits === phone.digits) {
      throw new DomainError("VALIDATION_ERROR", ["That is your own number."]);
    }
  }

  private async getOwn(executor: Executor, viewerId: string, contactId: string) {
    const [row] = await executor
      .select({ contact: contacts, profile, blockedByThem: theirs.blocked })
      .from(contacts)
      .innerJoin(users, eq(users.id, contacts.linkedUserId))
      .leftJoin(
        theirs,
        and(eq(theirs.ownerId, contacts.linkedUserId), eq(theirs.linkedUserId, contacts.ownerId)),
      )
      .where(and(eq(contacts.id, contactId), eq(contacts.ownerId, viewerId)))
      .limit(1);
    if (!row) {
      throw notFound();
    }
    const [dto] = await this.project(executor, [row]);
    return must(dto, "the projected contact");
  }

  /**
   * Contacts as the owner sees them. The photo shown is the owner's own override if they set
   * one, otherwise the linked person's profile photo, signed here: one query for all the files.
   */
  private async project(
    executor: Executor,
    rows: readonly ContactWithProfile[],
  ): Promise<ContactDto[]> {
    const urls = await this.attachments.urls(
      executor,
      rows.flatMap(({ contact, profile: person }) =>
        !contact.avatarUrl && person.avatarAttachmentId ? [person.avatarAttachmentId] : [],
      ),
    );
    // Bots are as available as they were seeded, so only real people are looked up.
    const live = await this.presence.onlineAmong(
      rows.flatMap(({ contact, profile: person }) => (person.isBot ? [] : [contact.linkedUserId])),
    );
    return rows.map(({ contact, profile: person, blockedByThem }) => {
      const { avatarAttachmentId, ...rest } = person;
      return this.projector.toContactDto(contact, {
        ...rest,
        avatarUrl: avatarAttachmentId ? (urls.get(avatarAttachmentId) ?? null) : null,
        online: onlineFor({
          isBot: person.isBot,
          botOnlineDefault: person.botOnlineDefault,
          live: live.has(contact.linkedUserId),
          blockedEitherWay: contact.blocked || blockedByThem === true,
        }),
      });
    });
  }
}

interface ContactWithProfile {
  /** The other person has blocked the owner. `null` when they have no contact row for them. */
  blockedByThem: boolean | null;
  contact: typeof contacts.$inferSelect;
  profile: {
    about: string;
    avatarAttachmentId: string | null;
    botOnlineDefault: boolean;
    hue: number;
    isBot: boolean;
  };
}
