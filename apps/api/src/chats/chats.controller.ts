import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Res,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";

import type { ChatDto } from "@dovetalk/contracts";
import { ChatsService } from "@dovetalk/core";

import type { AuthUser } from "../common/auth-user.js";
import { CurrentUser } from "../common/decorators.js";
import { ChatModel, ErrorModel } from "../docs/models.js";
import { AddMembersDto, CreateChatDto, UpdateChatDto } from "./dto.js";

const unauthorized = { status: 401, type: ErrorModel, description: "`UNAUTHORIZED`." } as const;
const invalid = { status: 422, type: ErrorModel, description: "`VALIDATION_ERROR`." } as const;
const chatNotFound = {
  status: 404,
  type: ErrorModel,
  description: "`CHAT_NOT_FOUND`: no such chat, or it is not yours.",
} as const;

@ApiTags("chats")
@ApiBearerAuth()
@Controller("chats")
export class ChatsController {
  constructor(@Inject(ChatsService) private readonly chats: ChatsService) {}

  @Get()
  @ApiOperation({
    summary: "Your chats.",
    description:
      "Newest chat first. The client orders the list by activity. Each chat carries its last visible message and your unread count. The server runs the same three queries however many chats you have.",
  })
  @ApiOkResponse({ type: ChatModel, isArray: true })
  @ApiResponse(unauthorized)
  list(@CurrentUser() user: AuthUser): Promise<ChatDto[]> {
    return this.chats.list(user.id);
  }

  @Post()
  @ApiOperation({
    summary: "Open a direct chat or create a group.",
    description:
      "A direct chat that already exists is returned as it is (`200`), and one you deleted comes back empty (`200`). A group is always new (`201`) and starts with a note saying you created it.",
  })
  @ApiBody({
    type: CreateChatDto,
    examples: {
      direct: { value: { type: "direct", contactId: "0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c" } },
      group: {
        value: {
          type: "group",
          name: "Weekend hikers",
          memberIds: [
            "0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c",
            "0192f1c0-7000-7a52-9d1b-3c1d4f5a6b7d",
          ],
        },
      },
    },
  })
  @ApiCreatedResponse({ type: ChatModel, description: "A new chat." })
  @ApiOkResponse({ type: ChatModel, description: "The direct chat that was already there." })
  @ApiResponse(unauthorized)
  @ApiResponse({ status: 404, type: ErrorModel, description: "`CONTACT_NOT_FOUND`." })
  @ApiResponse(invalid)
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateChatDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChatDto> {
    const { chat, created } = await this.chats.create(user.id, body.toInput());
    res.status(created ? 201 : 200);
    return chat;
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Archive, pin or mute a chat, or rename a group.",
    description:
      "Archive, pin and mute are yours alone. You can pin 3 chats. A rename is seen by everybody and leaves a note in the group.",
  })
  @ApiBody({ type: UpdateChatDto, examples: { pin: { value: { pinned: true } } } })
  @ApiOkResponse({ type: ChatModel })
  @ApiResponse(unauthorized)
  @ApiResponse(chatNotFound)
  @ApiResponse({ status: 409, type: ErrorModel, description: "`PIN_LIMIT`." })
  @ApiResponse(invalid)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: UpdateChatDto,
  ): Promise<ChatDto> {
    return this.chats.update(user.id, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Remove a chat from your list.",
    description:
      "Ends your history there and nobody else is affected. A new message from the other person brings the chat back, empty.",
  })
  @ApiNoContentResponse()
  @ApiResponse(unauthorized)
  @ApiResponse(chatNotFound)
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<void> {
    return this.chats.remove(user.id, id);
  }

  @Post(":id/read")
  @HttpCode(204)
  @ApiOperation({ summary: "Mark a chat as read.", description: "Sets your unread count to 0." })
  @ApiNoContentResponse()
  @ApiResponse(unauthorized)
  @ApiResponse(chatNotFound)
  markRead(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<void> {
    return this.chats.markRead(user.id, id);
  }

  @Post(":id/clear")
  @HttpCode(204)
  @ApiOperation({
    summary: "Clear a chat's messages for you.",
    description:
      "The chat stays on your list, pinned and archived as it was. Nobody else is affected.",
  })
  @ApiNoContentResponse()
  @ApiResponse(unauthorized)
  @ApiResponse(chatNotFound)
  clear(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<void> {
    return this.chats.clear(user.id, id);
  }

  @Post(":id/members")
  @HttpCode(200)
  @ApiOperation({
    summary: "Add people to a group.",
    description:
      "Any member can. New people see the chat from the moment they are added. People who are already in it, and ids that are not your contacts, are ignored.",
  })
  @ApiBody({
    type: AddMembersDto,
    examples: {
      two: {
        summary: "Add two contacts",
        value: {
          memberIds: [
            "0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c",
            "0192f1c0-7000-7a52-9d1b-3c1d4f5a6b7d",
          ],
        },
      },
    },
  })
  @ApiOkResponse({ type: ChatModel })
  @ApiResponse(unauthorized)
  @ApiResponse(chatNotFound)
  @ApiResponse(invalid)
  addMembers(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: AddMembersDto,
  ): Promise<ChatDto> {
    return this.chats.addMembers(user.id, id, body.memberIds);
  }

  @Delete(":id/members/:contactId")
  @ApiOperation({
    summary: "Remove somebody from a group.",
    description:
      "Only the person who created the group can. A group keeps at least two other members.",
  })
  @ApiOkResponse({ type: ChatModel })
  @ApiResponse(unauthorized)
  @ApiResponse(chatNotFound)
  @ApiResponse({ status: 403, type: ErrorModel, description: "`FORBIDDEN`: not the creator." })
  @ApiResponse({ status: 404, type: ErrorModel, description: "`MEMBER_NOT_FOUND`." })
  @ApiResponse(invalid)
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("contactId") contactId: string,
  ): Promise<ChatDto> {
    return this.chats.removeMember(user.id, id, contactId);
  }
}
