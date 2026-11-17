import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

import {
  EMAIL_MAX,
  type LoginInput,
  PASSWORD_MAX,
  PASSWORD_MIN,
  PROFILE_NAME_MAX,
  type RegisterInput,
} from "@dovetalk/contracts";

import { IsPhone, Normalize, Trim } from "../common/validation.js";

export class RegisterDto implements RegisterInput {
  @ApiProperty({
    example: "sam@example.com",
    maxLength: EMAIL_MAX,
    description: "Stored in lower case.",
  })
  @Normalize()
  @MaxLength(EMAIL_MAX, { message: "That email address is too long." })
  @IsEmail({}, { message: "Enter a valid email address." })
  email!: string;

  @ApiProperty({
    example: "correct horse battery staple",
    minLength: PASSWORD_MIN,
    maxLength: PASSWORD_MAX,
  })
  @MaxLength(PASSWORD_MAX, { message: `Password can be at most ${PASSWORD_MAX} characters.` })
  @MinLength(PASSWORD_MIN, { message: `Password must be at least ${PASSWORD_MIN} characters.` })
  @IsString({ message: "Enter a password." })
  password!: string;

  @ApiProperty({ example: "Sam Lee", maxLength: PROFILE_NAME_MAX })
  @Trim()
  @MaxLength(PROFILE_NAME_MAX, { message: `Name can be at most ${PROFILE_NAME_MAX} characters.` })
  @IsNotEmpty({ message: "Name can't be empty." })
  @IsString({ message: "Name can't be empty." })
  name!: string;

  @ApiPropertyOptional({
    example: "+1 555 010 0142",
    description: "Lets other people add you by number. 7 to 15 digits.",
  })
  @IsOptional()
  @IsPhone()
  phone?: string;
}

export class LoginDto implements LoginInput {
  @ApiProperty({ example: "demo@dovetalk.app", description: "Not case sensitive." })
  @Normalize()
  @MaxLength(EMAIL_MAX, { message: "Email or password is incorrect." })
  @IsNotEmpty({ message: "Enter your email." })
  @IsString({ message: "Enter your email." })
  email!: string;

  @ApiProperty({ example: "dovetalk123" })
  @MaxLength(PASSWORD_MAX, { message: "Email or password is incorrect." })
  @IsNotEmpty({ message: "Enter your password." })
  @IsString({ message: "Enter your password." })
  password!: string;
}
