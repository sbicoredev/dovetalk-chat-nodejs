import type { MeDto } from "@dovetalk/contracts";
import { DEFAULT_PREFERENCES, type UserRow } from "@dovetalk/db";

/**
 * The signed-in person's own profile. Never includes the password hash. The photo is stored as
 * an attachment id and signed when it is read, so the caller passes the signed link
 * (`ProfileService.toMe` does that).
 */
export const toMeDto = (user: UserRow, avatarUrl: string | null): MeDto => ({
  id: user.id,
  email: user.email ?? "",
  name: user.name,
  about: user.about,
  avatarUrl,
  hue: user.hue,
  phone: user.phone,
  // Keys added to Preferences later fall back to their defaults for older rows.
  preferences: { ...DEFAULT_PREFERENCES, ...user.preferences },
});
