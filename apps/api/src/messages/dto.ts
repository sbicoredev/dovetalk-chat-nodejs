import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  ValidateIf,
} from "class-validator";

import {
  type DeleteScope,
  FORWARD_CHATS_MAX,
  MAX_MESSAGE_TEXT,
  MESSAGE_PAGE_MAX,
  MESSAGE_PAGE_SIZE,
  type MessagesQuery,
  type SendMessageInput,
  VOICE_BARS_MAX,
} from "@dovetalk/contracts";

const sent = (_: unknown, value: unknown) => value !== undefined;

/** A field sent as `null` counts as left out, so clients need not tell the two apart. */
const nullIsAbsent = ({ value }: { value: unknown }) => (value === null ? undefined : value);

/** An empty `limit=` is "not sent". Anything that is not a plain number stays as it is, to be refused. */
const toNumber = ({ value }: { value: unknown }) => {
  if (typeof value === "string" && value.trim() !== "") {
    return Number(value);
  }
  return value === "" ? undefined : value;
};

export class MessagesQueryDto implements MessagesQuery {
  @ApiPropertyOptional({
    description:
      "The `nextCursor` of the previous page: the id of its oldest message. Leave out for the newest page.",
  })
  @Transform(({ value }: { value: unknown }) => (value === "" ? undefined : value))
  @ValidateIf(sent)
  @IsString({ message: "The cursor must be a message id." })
  before?: string;

  @ApiPropertyOptional({
    description: `How many messages. Default ${MESSAGE_PAGE_SIZE}. Values outside 1 to ${MESSAGE_PAGE_MAX} are brought inside.`,
    example: MESSAGE_PAGE_SIZE,
  })
  @Transform(toNumber)
  @ValidateIf(sent)
  @IsInt({ message: "The limit must be a whole number." })
  limit?: number;
}

const SEND_KINDS = ["text", "voice", "image", "file"] as const;

/**
 * What `kind` needs is checked by MessagesService, which is where the rules live: a text message
 * needs text, a voice message a length, a picture or file an attachment. This class only checks
 * that each field has the right type.
 */
export class SendMessageDto implements SendMessageInput {
  @ApiProperty({
    description: "Made by the client (a UUID). Sending it twice returns the first message.",
    example: "5f0b0d1e-6f0e-4f5e-9a55-0c9f3b6d9e11",
  })
  @IsString({ message: "clientId must be 1 to 100 characters." })
  clientId!: string;

  @ApiProperty({ enum: SEND_KINDS })
  @IsIn(SEND_KINDS, { message: "Unknown message kind." })
  kind!: (typeof SEND_KINDS)[number];

  @ApiPropertyOptional({
    description: `Text messages: required, up to ${MAX_MESSAGE_TEXT} characters. Pictures and files: an optional caption.`,
    example: "See you at 8.",
  })
  @Transform(nullIsAbsent)
  @ValidateIf(sent)
  @IsString({ message: "Message text must be text." })
  text?: string;

  @ApiPropertyOptional({
    description: "Pictures and files: the id from `POST /uploads`. Each upload can be used once.",
  })
  @Transform(nullIsAbsent)
  @ValidateIf(sent)
  @IsString({ message: "attachmentId must be an id." })
  attachmentId?: string;

  @ApiPropertyOptional({
    description: "Voice messages: length in seconds, at least 1.",
    example: 14,
  })
  @Transform(nullIsAbsent)
  @ValidateIf(sent)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { message: "duration must be a number." })
  duration?: number;

  @ApiPropertyOptional({
    type: [Number],
    description: `Voice messages: waveform bars, up to ${VOICE_BARS_MAX}, each from 0 to 100.`,
  })
  @Transform(nullIsAbsent)
  @ValidateIf(sent)
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { each: true, message: "bars must be numbers." },
  )
  @IsArray({ message: "bars must be a list of numbers." })
  bars?: number[];

  @ApiPropertyOptional({ description: "The id of a message in this chat that this one answers." })
  @Transform(nullIsAbsent)
  @ValidateIf(sent)
  @IsString({ message: "replyToId must be an id." })
  replyToId?: string;
}

export class EditMessageDto {
  @ApiProperty({
    description:
      "The new text. Text messages need some. For a picture or file it is the caption, and may be empty to remove it.",
    example: "See you at 8:30.",
  })
  @IsString({ message: "Message can't be empty." })
  text!: string;
}

export class DeleteMessageQueryDto {
  @ApiProperty({
    enum: ["me", "everyone"],
    description:
      "`me` hides it from you. `everyone` leaves a tombstone for all, and only the sender may. There is no default.",
  })
  @IsIn(["me", "everyone"], { message: 'scope must be "me" or "everyone".' })
  scope!: DeleteScope;
}

export class ReactionDto {
  @ApiProperty({
    description:
      "One emoji. The same one again takes your reaction back, a different one replaces it.",
    example: "👍",
  })
  @IsString({ message: "That isn't an emoji." })
  emoji!: string;
}

export class ForwardDto {
  @ApiProperty({
    type: [String],
    description: `Up to ${FORWARD_CHATS_MAX} of your chats. Duplicates are dropped.`,
  })
  @IsString({ each: true, message: "chatIds must be a list of chat ids." })
  @ArrayMaxSize(FORWARD_CHATS_MAX, {
    message: `You can forward to at most ${FORWARD_CHATS_MAX} chats at once.`,
  })
  @IsArray({ message: "chatIds must be a list of chat ids." })
  chatIds!: string[];
}
