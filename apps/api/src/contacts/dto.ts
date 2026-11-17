import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsNotEmpty, IsString, MaxLength, ValidateIf } from "class-validator";

import {
  CONTACT_ABOUT_MAX,
  CONTACT_NAME_MAX,
  type CreateContactInput,
  type UpdateContactInput,
} from "@dovetalk/contracts";

import { IsPhone, Trim } from "../common/validation.js";

const sent = (_: unknown, value: unknown) => value !== undefined;

export class CreateContactDto implements CreateContactInput {
  @ApiProperty({ example: "Priya Nair", maxLength: CONTACT_NAME_MAX })
  @Trim()
  @MaxLength(CONTACT_NAME_MAX, {
    message: `Name can be at most ${CONTACT_NAME_MAX} characters.`,
  })
  @IsNotEmpty({ message: "Enter a name." })
  @IsString({ message: "Enter a name." })
  name!: string;

  @ApiProperty({
    example: "+1 555 010 0142",
    description:
      "7 to 15 digits. Somebody who has registered with this number is linked, so you can chat for real. Any other number becomes a bot that answers.",
  })
  @IsPhone()
  phone!: string;
}

/** Every field is optional and only the ones sent change. */
export class UpdateContactDto implements UpdateContactInput {
  @ApiPropertyOptional({ example: "Priya N.", maxLength: CONTACT_NAME_MAX })
  @ValidateIf(sent)
  @Trim()
  @MaxLength(CONTACT_NAME_MAX, {
    message: `Name can be at most ${CONTACT_NAME_MAX} characters.`,
  })
  @IsNotEmpty({ message: "Enter a name." })
  @IsString({ message: "Enter a name." })
  name?: string;

  @ApiPropertyOptional({ example: "+1 555 010 0143" })
  @ValidateIf(sent)
  @IsPhone()
  phone?: string;

  @ApiPropertyOptional({ example: "Out of office.", maxLength: CONTACT_ABOUT_MAX })
  @ValidateIf(sent)
  @Trim()
  @MaxLength(CONTACT_ABOUT_MAX, {
    message: `About can be at most ${CONTACT_ABOUT_MAX} characters.`,
  })
  @IsString({ message: "About must be text." })
  about?: string;
}

export class BlockContactDto {
  @ApiProperty({ example: true })
  @IsBoolean({ message: "Blocked must be true or false." })
  blocked!: boolean;
}
