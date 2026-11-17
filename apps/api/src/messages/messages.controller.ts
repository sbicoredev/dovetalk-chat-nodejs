import { Body, Controller, Get, Inject, Param, Post, Query, Res } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";

import type { MessageDto, MessagePage } from "@dovetalk/contracts";
import { MessagesService } from "@dovetalk/core";

import type { AuthUser } from "../common/auth-user.js";
import { CurrentUser } from "../common/decorators.js";
import { ErrorModel, MessageModel, MessagePageModel } from "../docs/models.js";
import { MessagesQueryDto, SendMessageDto } from "./dto.js";

@ApiTags("messages")
@ApiBearerAuth()
@Controller("chats/:chatId/messages")
export class MessagesController {
  constructor(@Inject(MessagesService) private readonly messages: MessagesService) {}

  @Get()
  @ApiOperation({
    summary: "A page of a chat's history.",
    description:
      "Without `before` this is the newest page. `items` are oldest first. Pass `nextCursor` back as `before` for older ones, until it is `null`. History starts where you last cleared the chat or joined it.",
  })
  @ApiOkResponse({ type: MessagePageModel })
  @ApiResponse({ status: 400, type: ErrorModel, description: "`INVALID_CURSOR`." })
  @ApiResponse({ status: 401, type: ErrorModel, description: "`UNAUTHORIZED`." })
  @ApiResponse({ status: 404, type: ErrorModel, description: "`CHAT_NOT_FOUND`." })
  @ApiResponse({ status: 422, type: ErrorModel, description: "`VALIDATION_ERROR`." })
  page(
    @CurrentUser() user: AuthUser,
    @Param("chatId") chatId: string,
    @Query() query: MessagesQueryDto,
  ): Promise<MessagePage> {
    return this.messages.page(user.id, chatId, query);
  }

  @Post()
  @ApiOperation({
    summary: "Send a message.",
    description:
      "`clientId` makes a retry safe: the same id again returns the stored message with `200` and sends nothing new. A picture or file needs an `attachmentId` from `POST /uploads`, which can be used once. Sending to someone you blocked is `403 CONTACT_BLOCKED`. If the other person blocked you the message is stored but never shown to them.",
  })
  @ApiBody({
    type: SendMessageDto,
    examples: {
      text: {
        summary: "A text message",
        value: {
          clientId: "5f0b0d1e-6f0e-4f5e-9a55-0c9f3b6d9e11",
          kind: "text",
          text: "See you at 8.",
        },
      },
      reply: {
        summary: "A reply",
        value: {
          clientId: "7b1d3c52-1b0a-4d84-8a7e-7a63f5b8c9a2",
          kind: "text",
          text: "Sounds good.",
          replyToId: "0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c",
        },
      },
      picture: {
        summary: "A picture with a caption",
        value: {
          clientId: "0c2b7a3e-5d4f-4a21-b6c8-2f1e9d0a7b34",
          kind: "image",
          attachmentId: "0192f1c0-7000-7a52-9d1b-3c1d4f5a6b7d",
          text: "The summit",
        },
      },
      voice: {
        summary: "A voice message",
        value: {
          clientId: "9d8e7f60-3a2b-4c1d-8e5f-6a7b8c9d0e1f",
          kind: "voice",
          duration: 14,
          bars: [12, 40, 66, 30, 80, 55],
        },
      },
    },
  })
  @ApiCreatedResponse({ type: MessageModel, description: "A new message." })
  @ApiOkResponse({
    type: MessageModel,
    description: "The message that was already stored for this `clientId`.",
  })
  @ApiResponse({ status: 401, type: ErrorModel, description: "`UNAUTHORIZED`." })
  @ApiResponse({
    status: 403,
    type: ErrorModel,
    description: "`CONTACT_BLOCKED`: you blocked this contact.",
  })
  @ApiResponse({ status: 404, type: ErrorModel, description: "`CHAT_NOT_FOUND`." })
  @ApiResponse({
    status: 422,
    type: ErrorModel,
    description:
      "`VALIDATION_ERROR` (empty or long text, bad `clientId`, a picture that is not an image, a reply to a message that is not here) or `ATTACHMENT_NOT_FOUND`.",
  })
  async send(
    @CurrentUser() user: AuthUser,
    @Param("chatId") chatId: string,
    @Body() body: SendMessageDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const { message, created } = await this.messages.send(user.id, chatId, body);
    res.status(created ? 201 : 200);
    return message;
  }
}
