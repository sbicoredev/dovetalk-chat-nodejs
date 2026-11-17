/**
 * The socket.io room every connection of one person joins. All events go to a person's room and
 * never to a chat's: each viewer gets their own projection of an event (docs/adr/0003), so there
 * is no one payload to broadcast to a chat.
 */
export const userRoom = (userId: string): string => `user:${userId}`;
