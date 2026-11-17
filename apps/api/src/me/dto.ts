import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

import {
  PROFILE_ABOUT_MAX,
  PROFILE_NAME_MAX,
  type Preferences,
  type UpdateMeInput,
} from "@dovetalk/contracts";

import { IsPhone, Trim } from "../common/validation.js";

const AVATAR_LINK_MAX = 2048;
const AVATAR_MESSAGE = "That image can't be used as a profile photo.";

const sent = (_: unknown, value: unknown) => value !== undefined;
const sentAndNotNull = (_: unknown, value: unknown) => value !== undefined && value !== null;

export class PreferencesDto implements Partial<Preferences> {
  @ApiPropertyOptional()
  @ValidateIf(sent)
  @IsBoolean({ message: "Sounds must be on or off." })
  sounds?: boolean;
  @ApiPropertyOptional()
  @ValidateIf(sent)
  @IsBoolean({ message: "Previews must be on or off." })
  previews?: boolean;
  @ApiPropertyOptional()
  @ValidateIf(sent)
  @IsBoolean({ message: "Enter to send must be on or off." })
  enterToSend?: boolean;
}

/**
 * Every field is optional and only the ones sent change. `null` is meaningful for `phone` and
 * `avatarUrl` (remove it) and an error for the rest.
 */
export class UpdateMeDto implements UpdateMeInput {
  @ApiPropertyOptional({ example: "Alex Rivera", maxLength: PROFILE_NAME_MAX })
  @ValidateIf(sent)
  @Trim()
  @MaxLength(PROFILE_NAME_MAX, { message: `Name can be at most ${PROFILE_NAME_MAX} characters.` })
  @IsNotEmpty({ message: "Name can't be empty." })
  @IsString({ message: "Name can't be empty." })
  name?: string;

  @ApiPropertyOptional({ example: "Coffee first.", maxLength: PROFILE_ABOUT_MAX })
  @ValidateIf(sent)
  @Trim()
  @MaxLength(PROFILE_ABOUT_MAX, {
    message: `About can be at most ${PROFILE_ABOUT_MAX} characters.`,
  })
  @IsString({ message: "About must be text." })
  about?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      "`null` removes the photo. Otherwise the `url` of one of your own picture uploads (`POST /uploads`). Any other address is a 422.",
  })
  @ValidateIf(sentAndNotNull)
  @MaxLength(AVATAR_LINK_MAX, { message: AVATAR_MESSAGE })
  @IsString({ message: AVATAR_MESSAGE })
  avatarUrl?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: "+1 555 010 0142",
    description: "`null` removes the number.",
  })
  @ValidateIf(sentAndNotNull)
  @IsPhone()
  phone?: string | null;

  @ApiPropertyOptional({
    type: PreferencesDto,
    description: "Merged with what is stored. Keys you leave out keep their value.",
  })
  @ValidateIf(sent)
  @IsObject({ message: "Preferences must be an object." })
  @ValidateNested()
  @Type(() => PreferencesDto)
  preferences?: PreferencesDto;
}
