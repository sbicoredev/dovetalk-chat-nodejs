import { and, asc, eq, isNull } from "drizzle-orm";

import { type Executor, schema } from "@dovetalk/db";

const { chatMembers, contacts, users } = schema;

export interface BotCandidate {
  id: string;
  name: string;
}

/**
 * The bots that may answer something `senderId` wrote in a chat, in a stable order (by id).
 *
 * - Only a person sets a bot going. A message from a bot never does, which is what stops bots
 *   in a group from answering each other for ever (docs/edge-cases.md, #24).
 * - The sender must be on the chat, with the chat on their list: a chat they deleted while
 *   the bot was "typing" is not brought back by the reply, as in the mock.
 * - A bot the sender blocked stays quiet.
 * - A direct chat has one other member, so the answer is that bot or nobody. A group answers
 *   with one of its bots.
 *
 * Used when the message is sent, to decide whether to schedule anything, and again when the
 * job runs, because blocks and memberships change in between.
 */
export async function findBotCandidates(
  executor: Executor,
  chatId: string,
  senderId: string,
): Promise<BotCandidate[]> {
  // One query for the chat's members, with what both questions need: whether the sender is a
  // bot or has left or hidden the chat, and which members are bots the sender has not blocked.
  // This runs after every message anybody sends, so two round trips here were a tenth of the
  // SQL of a send (measured in docs/scaling.md).
  const rows = await executor
    .select({
      id: users.id,
      name: users.name,
      isBot: users.isBot,
      blocked: contacts.blocked,
      hiddenAt: chatMembers.hiddenAt,
    })
    .from(chatMembers)
    .innerJoin(users, eq(users.id, chatMembers.userId))
    .leftJoin(contacts, and(eq(contacts.ownerId, senderId), eq(contacts.linkedUserId, users.id)))
    .where(and(eq(chatMembers.chatId, chatId), isNull(chatMembers.leftAt)))
    .orderBy(asc(users.id));
  const self = rows.find((row) => row.id === senderId);
  if (!self || self.isBot || self.hiddenAt) {
    return [];
  }
  return rows.filter((row) => row.isBot && !row.blocked).map(({ id, name }) => ({ id, name }));
}
