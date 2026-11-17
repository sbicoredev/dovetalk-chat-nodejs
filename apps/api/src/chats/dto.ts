import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsString,
  ValidateIf,
} from "class-validator";

import { type CreateChatInput, GROUP_MEMBERS_MAX, type UpdateChatInput } from "@dovetalk/contracts";
import { must } from "@dovetalk/core";

const sent = (_: unknown, value: unknown) => value !== undefined;

const membersMessage = "Choose the people to add.";
const tooMany = `A group can have at most ${GROUP_MEMBERS_MAX} other people.`;

/**
 * `type` decides which of the other fields are needed. The sizes of the name and the list are
 * checked by ChatsService, which is where the rules live, so the messages come from one place.
 */
export class CreateChatDto {
  @ApiProperty({ enum: ["direct", "group"] })
  @IsIn(["direct", "group"], { message: "Choose a direct chat or a group." })
  type!: "direct" | "group";

  @ApiPropertyOptional({ description: "Direct chats: the contact to talk to." })
  @ValidateIf((dto: CreateChatDto) => dto.type === "direct")
  @IsNotEmpty({ message: "Choose a contact." })
  @IsString({ message: "Choose a contact." })
  contactId?: string;

  @ApiPropertyOptional({ description: "Groups: 1 to 60 characters.", example: "Weekend hikers" })
  @ValidateIf((dto: CreateChatDto) => dto.type === "group")
  @IsString({ message: "Group name can't be empty." })
  name?: string;

  @ApiPropertyOptional({
    type: [String],
    description: "Groups: contact ids. At least two other people.",
  })
  @ValidateIf((dto: CreateChatDto) => dto.type === "group")
  @IsString({ each: true, message: membersMessage })
  @ArrayMaxSize(GROUP_MEMBERS_MAX, { message: tooMany })
  @IsArray({ message: membersMessage })
  memberIds?: string[];

  /** The input the service takes. Fields that do not belong to the chosen type are left out. */
  toInput(): CreateChatInput {
    return this.type === "direct"
      ? { type: "direct", contactId: must(this.contactId, "contactId") }
      : {
          type: "group",
          name: must(this.name, "name"),
          memberIds: must(this.memberIds, "memberIds"),
        };
  }
}

/** Every field is optional and only the ones sent change. */
export class UpdateChatDto implements UpdateChatInput {
  @ApiPropertyOptional()
  @ValidateIf(sent)
  @IsBoolean({ message: "Archived must be true or false." })
  archived?: boolean;

  @ApiPropertyOptional()
  @ValidateIf(sent)
  @IsBoolean({ message: "Pinned must be true or false." })
  pinned?: boolean;

  @ApiPropertyOptional()
  @ValidateIf(sent)
  @IsBoolean({ message: "Muted must be true or false." })
  muted?: boolean;

  @ApiPropertyOptional({ description: "Groups only.", example: "Hikers 2.0" })
  @ValidateIf(sent)
  @IsString({ message: "Group name can't be empty." })
  name?: string;
}

export class AddMembersDto {
  @ApiProperty({ type: [String], description: "Contact ids." })
  @IsString({ each: true, message: membersMessage })
  @ArrayMaxSize(GROUP_MEMBERS_MAX, { message: tooMany })
  @IsArray({ message: membersMessage })
  memberIds!: string[];
}
