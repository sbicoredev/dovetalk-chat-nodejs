import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsInt, IsString, ValidateIf } from "class-validator";

import { IMAGE_EDGE_MAX } from "@dovetalk/contracts";

const sent = (_: unknown, value: unknown) => value !== undefined;

/** Form fields are text. An empty one is "not sent", a number is read as a number. */
const fromForm = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const numberFromForm = ({ value }: { value: unknown }) => {
  const text = fromForm({ value });
  return typeof text === "string" ? Number(text) : text;
};

/** The text fields that come with the file. The file itself is read by UploadInterceptor. */
export class UploadFieldsDto {
  @ApiPropertyOptional({
    description: "The name to keep. Defaults to the name the file was sent with.",
    example: "trail-map.pdf",
  })
  @Transform(fromForm)
  @ValidateIf(sent)
  @IsString({ message: "name must be text." })
  name?: string;

  @ApiPropertyOptional({
    description: `Pictures: width in pixels, 1 to ${IMAGE_EDGE_MAX}. Ignored for other files.`,
  })
  @Transform(numberFromForm)
  @ValidateIf(sent)
  @IsInt({ message: `Width must be a whole number from 1 to ${IMAGE_EDGE_MAX}.` })
  width?: number;

  @ApiPropertyOptional({
    description: `Pictures: height in pixels, 1 to ${IMAGE_EDGE_MAX}. Ignored for other files.`,
  })
  @Transform(numberFromForm)
  @ValidateIf(sent)
  @IsInt({ message: `Height must be a whole number from 1 to ${IMAGE_EDGE_MAX}.` })
  height?: number;
}
