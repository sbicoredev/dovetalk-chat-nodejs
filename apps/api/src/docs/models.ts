import { ApiProperty } from "@nestjs/swagger";

import type {
  AttachmentDto,
  AuthResult,
  ChatDto,
  ContactDto,
  MeDto,
  MessageDto,
  MessageKind,
  MessagePage,
  Preferences,
  ReplyPreview,
  StatusDto,
} from "@dovetalk/contracts";

/**
 * Classes that exist only to describe responses in the OpenAPI document. The real objects are
 * plain JSON typed by @dovetalk/contracts, so the compiler checks the shapes match.
 */
export class PreferencesModel implements Preferences {
  @ApiProperty({ example: true }) sounds!: boolean;
  @ApiProperty({ example: true }) previews!: boolean;
  @ApiProperty({ example: true }) enterToSend!: boolean;
}

export class MeModel implements MeDto {
  @ApiProperty({
    example: "0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c",
    description: "Opaque id. Also the id other people see you by in this app's own data.",
  })
  id!: string;
  @ApiProperty({ example: "demo@dovetalk.app" }) email!: string;
  @ApiProperty({ example: "Alex Rivera" }) name!: string;
  @ApiProperty({ example: "Hey there, I am using Dovetalk." }) about!: string;
  @ApiProperty({ type: String, nullable: true, example: null }) avatarUrl!: string | null;
  @ApiProperty({
    example: 40,
    minimum: 0,
    maximum: 359,
    description: "Colour used for the avatar when there is no photo.",
  })
  hue!: number;
  @ApiProperty({ type: String, nullable: true, example: "+1 555 010 0142" }) phone!: string | null;
  @ApiProperty({ type: PreferencesModel }) preferences!: PreferencesModel;
}

export class ContactModel implements ContactDto {
  @ApiProperty({
    example: "0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c",
    description:
      "Opaque id. It means something only to you: other people have their own contact ids for the same person.",
  })
  id!: string;
  @ApiProperty({ example: "Priya Nair", description: "What you call them." }) name!: string;
  @ApiProperty({ example: "+1 555 010 0142" }) phone!: string;
  @ApiProperty({ example: "Hey there, I am using Dovetalk." }) about!: string;
  @ApiProperty({ example: 200, minimum: 0, maximum: 359 }) hue!: number;
  @ApiProperty({ example: false }) online!: boolean;
  @ApiProperty({ example: false }) blocked!: boolean;
  @ApiProperty({ type: String, nullable: true, example: null }) avatarUrl!: string | null;
  @ApiProperty({
    example: true,
    description: "`false` for people you never added, or whose contact you deleted.",
  })
  saved!: boolean;
}

const MESSAGE_KINDS = ["text", "voice", "system", "image", "file"] as const satisfies MessageKind[];

export class AttachmentModel implements AttachmentDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: "A link the browser can load. It expires, so ask again later." })
  url!: string;
  @ApiProperty({ example: "trail-map.pdf" }) name!: string;
  @ApiProperty({ example: 48_213 }) size!: number;
  @ApiProperty({ example: "application/pdf" }) mime!: string;
  @ApiProperty({ type: Number, nullable: true, example: null }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: null }) height!: number | null;
}

export class ReplyPreviewModel implements ReplyPreview {
  @ApiProperty() id!: string;
  @ApiProperty({ description: "A contact id, your own id, or `system`." }) senderId!: string;
  @ApiProperty({ enum: MESSAGE_KINDS }) kind!: MessageKind;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "`null` once the original is deleted.",
  })
  text!: string | null;
  @ApiProperty() deleted!: boolean;
}

export class MessageModel implements MessageDto {
  @ApiProperty() id!: string;
  @ApiProperty() chatId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Only the sender sees it, so a client can match its own optimistic copy.",
  })
  clientId!: string | null;
  @ApiProperty({
    description:
      "Your own id, or the id of one of YOUR contacts, or `system`. Other people see the same message under their own ids.",
  })
  senderId!: string;
  @ApiProperty({ enum: MESSAGE_KINDS }) kind!: MessageKind;
  @ApiProperty({ type: String, nullable: true, example: "See you at 8." }) text!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: "Voice messages: seconds." })
  duration!: number | null;
  @ApiProperty({ type: [Number], nullable: true, description: "Voice messages: bars, 0 to 100." })
  bars!: number[] | null;
  @ApiProperty({ type: AttachmentModel, nullable: true }) attachment!: AttachmentModel | null;
  @ApiProperty({ example: 1_761_300_000_000, description: "Epoch milliseconds." })
  createdAt!: number;
  @ApiProperty({ type: ReplyPreviewModel, nullable: true }) replyTo!: ReplyPreviewModel | null;
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "array", items: { type: "string" } },
    example: { "👍": ["0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c"] },
    description: "Emoji to the ids of the people who reacted.",
  })
  reactions!: Record<string, string[]>;
  @ApiProperty() edited!: boolean;
  @ApiProperty() deleted!: boolean;
  @ApiProperty() forwarded!: boolean;
}

export class MessagePageModel implements MessagePage {
  @ApiProperty({ type: [MessageModel], description: "Oldest first." }) items!: MessageModel[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Pass as `before` for the page of older messages. `null` when there are none.",
  })
  nextCursor!: string | null;
}

export class ChatModel implements ChatDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ["direct", "group"] }) type!: "direct" | "group";
  @ApiProperty({ type: String, nullable: true, description: "`null` for direct chats." })
  name!: string | null;
  @ApiProperty({ minimum: 0, maximum: 359 }) hue!: number;
  @ApiProperty({
    type: [String],
    description: "YOUR contact ids for the other members. Never includes you.",
  })
  memberIds!: string[];
  @ApiProperty({ example: 0 }) unread!: number;
  @ApiProperty() archived!: boolean;
  @ApiProperty() pinned!: boolean;
  @ApiProperty() muted!: boolean;
  @ApiProperty({ example: 1_761_300_000_000, description: "Epoch milliseconds." })
  createdAt!: number;
  @ApiProperty({ type: MessageModel, nullable: true }) lastMessage!: MessageModel | null;
}

export class StatusModel implements StatusDto {
  @ApiProperty({ example: "0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c" }) id!: string;
  @ApiProperty({
    description:
      "Your own id for your statuses, otherwise the id of YOUR contact for the author (it may be an unsaved contact).",
  })
  ownerId!: string;
  @ApiProperty({ example: "Pasta night, finally." }) text!: string;
  @ApiProperty({ example: 3, minimum: 0, maximum: 5, description: "An index into the palette." })
  color!: number;
  @ApiProperty({ example: 1_761_300_000_000, description: "Epoch milliseconds." })
  createdAt!: number;
  @ApiProperty({ description: "Always `true` for your own." }) seen!: boolean;
}

export class AuthResultModel implements AuthResult {
  @ApiProperty({
    description:
      "A JWT valid for 15 minutes. Keep it in memory and send it as `Authorization: Bearer`.",
    example:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6ImF0K2p3dCJ9.eyJzdWIiOiIwMTkyZjFjMC02ZjNlLTdhNTIifQ.c2lnbmF0dXJl",
  })
  accessToken!: string;
  @ApiProperty({ type: MeModel }) user!: MeModel;
}

export class ErrorModel {
  @ApiProperty({ example: 422 }) statusCode!: number;
  @ApiProperty({
    example: "VALIDATION_ERROR",
    description: "Stable code. See docs/API.md for the list.",
  })
  code!: string;
  @ApiProperty({
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    example: ["Password must be at least 8 characters."],
    description: "Text for a person. A list when several fields are wrong.",
  })
  message!: string | string[];
}

export const COOKIE_NOTE =
  "Sets the `dt_refresh` cookie: an opaque refresh token, `HttpOnly`, scoped to the auth routes. The web app never reads it.";
