import { Body, Controller, Inject, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import { type AttachmentDto, UPLOAD_LIMIT_BYTES } from "@dovetalk/contracts";
import { DomainError, UploadsService } from "@dovetalk/core";

import type { AuthUser } from "../common/auth-user.js";
import { CurrentUser } from "../common/decorators.js";
import { AttachmentModel, ErrorModel } from "../docs/models.js";
import { UploadFieldsDto } from "./dto.js";
import { UPLOAD_FIELD, UploadInterceptor } from "./upload.interceptor.js";

@ApiTags("uploads")
@ApiBearerAuth()
@Controller("uploads")
export class UploadsController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService) {}

  @Post()
  @UseInterceptors(UploadInterceptor)
  @ApiOperation({
    summary: "Upload a file.",
    description: `Send \`multipart/form-data\` with one file in the field \`${UPLOAD_FIELD}\`, up to ${UPLOAD_LIMIT_BYTES / 1_000_000} MB. The kind of file is read from its bytes, not from what the client says. Use the returned \`id\` as \`attachmentId\` in \`POST /chats/{chatId}/messages\` (once) or as the avatar of \`PATCH /me\`. Files that are never used are cleaned up later. The returned \`url\` is signed and expires, so ask for the message again rather than keeping it.`,
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: [UPLOAD_FIELD],
      properties: {
        [UPLOAD_FIELD]: { type: "string", format: "binary" },
        name: { type: "string", example: "trail-map.pdf" },
        width: { type: "integer", example: 1200 },
        height: { type: "integer", example: 800 },
      },
    },
  })
  @ApiCreatedResponse({ type: AttachmentModel })
  @ApiResponse({ status: 401, type: ErrorModel, description: "`UNAUTHORIZED`." })
  @ApiResponse({
    status: 413,
    type: ErrorModel,
    description: `\`FILE_TOO_LARGE\`: over ${UPLOAD_LIMIT_BYTES / 1_000_000} MB.`,
  })
  @ApiResponse({
    status: 422,
    type: ErrorModel,
    description:
      "`VALIDATION_ERROR`: no file, an empty file, a bad `width` or `height`, or a request that is not a valid upload.",
  })
  create(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadFieldsDto,
  ): Promise<AttachmentDto> {
    if (!file) {
      throw new DomainError("VALIDATION_ERROR", ["Choose a file to upload."]);
    }
    return this.uploads.create(user.id, {
      bytes: file.buffer,
      declaredMime: file.mimetype,
      name: body.name ?? file.originalname,
      width: body.width,
      height: body.height,
    });
  }
}
