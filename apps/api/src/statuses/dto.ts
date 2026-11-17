import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsString } from "class-validator";

import { type CreateStatusInput, STATUS_COLOR_COUNT, STATUS_TEXT_MAX } from "@dovetalk/contracts";

/** Trimming, the cut at 120 characters and the empty check are StatusesService's. */
export class CreateStatusDto implements CreateStatusInput {
  @ApiProperty({
    description: `Up to ${STATUS_TEXT_MAX} characters. A longer text is cut, not refused.`,
    example: "Pasta night, finally.",
  })
  @IsString({ message: "Status can't be empty." })
  text!: string;

  @ApiProperty({
    minimum: 0,
    maximum: STATUS_COLOR_COUNT - 1,
    example: 3,
    description: "An index into the app's palette.",
  })
  @IsInt({ message: `Color must be a whole number from 0 to ${STATUS_COLOR_COUNT - 1}.` })
  color!: number;
}
