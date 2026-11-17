import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import type { MessageDto } from "@dovetalk/contracts";
import { MessagesService } from "@dovetalk/core";

import type { AuthUser } from "../common/auth-user.js";
import { CurrentUser } from "../common/decorators.js";
import { ErrorModel, MessageModel } from "../docs/models.js";
import { DeleteMessageQueryDto, EditMessageDto, ForwardDto, ReactionDto } from "./dto.js";

const unauthorized = { status: 401, type: ErrorModel, description: "`UNAUTHORIZED`." } as const;
const invalid = { status: 422, type: ErrorModel, description: "`VALIDATION_ERROR`." } as const;
const messageNotFound = {
  status: 404,
  type: ErrorModel,
  description:
    "`MESSAGE_NOT_FOUND`: no such message, or you cannot see it. The answer is the same for both.",
} as const;

/** Actions on one message, wherever it is: the id says which chat. */
@ApiTags("messages")
@ApiBearerAuth()
@Controller("messages")
export class MessageActionsController {
  constructor(@Inject(MessagesService) private readonly messages: MessagesService) {}

  @Patch(":id")
  @ApiOperation({
    summary: "Edit one of your messages.",
    description:
      "Text messages and the captions of pictures and files only. Voice messages, deleted messages and other people's messages cannot be edited.",
  })
  @ApiBody({ type: EditMessageDto, examples: { edit: { value: { text: "See you at 8:30." } } } })
  @ApiOkResponse({ type: MessageModel, description: "The message with `edited: true`." })
  @ApiResponse(unauthorized)
  @ApiResponse({
    status: 403,
    type: ErrorModel,
    description: "`FORBIDDEN`: not your message (a system note is nobody's).",
  })
  @ApiResponse(messageNotFound)
  @ApiResponse({
    status: 422,
    type: ErrorModel,
    description: "`VALIDATION_ERROR`: empty or long text, or a message that cannot be edited.",
  })
  edit(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: EditMessageDto,
  ): Promise<MessageDto> {
    return this.messages.edit(user.id, id, body.text);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Delete a message.",
    description:
      "`scope=me` hides it from you only. `scope=everyone` leaves a tombstone (`deleted: true`) for all members and only the sender may do it. Repeating it is fine. `scope` is required: leaving it out is a `422`, so the wider delete is never the default.",
  })
  @ApiQuery({ name: "scope", enum: ["me", "everyone"], required: true, example: "me" })
  @ApiNoContentResponse()
  @ApiResponse(unauthorized)
  @ApiResponse({
    status: 403,
    type: ErrorModel,
    description: "`FORBIDDEN`: `everyone` on somebody else's message.",
  })
  @ApiResponse(messageNotFound)
  @ApiResponse({ ...invalid, description: "`VALIDATION_ERROR`: `scope` missing or unknown." })
  remove(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query() query: DeleteMessageQueryDto,
  ): Promise<void> {
    return this.messages.remove(user.id, id, query.scope);
  }

  @Put(":id/reaction")
  @ApiOperation({
    summary: "React to a message, or take the reaction back.",
    description:
      "One reaction per person. The same emoji again removes it, a different one replaces it. Deleted and system messages cannot be reacted to.",
  })
  @ApiBody({ type: ReactionDto, examples: { thumbsUp: { value: { emoji: "👍" } } } })
  @ApiOkResponse({ type: MessageModel })
  @ApiResponse(unauthorized)
  @ApiResponse(messageNotFound)
  @ApiResponse({
    ...invalid,
    description: "`VALIDATION_ERROR`: not an emoji, or a message that cannot be reacted to.",
  })
  react(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: ReactionDto,
  ): Promise<MessageDto> {
    return this.messages.toggleReaction(user.id, id, body.emoji);
  }

  @Post(":id/forward")
  @ApiOperation({
    summary: "Forward a message to other chats.",
    description:
      "Returns the copies, in the order of `chatIds`. A direct chat with someone you blocked is skipped, so the list can be shorter. If any chat is not yours the whole call is `404` and nothing is sent. All or nothing, unlike the prototype.",
  })
  @ApiBody({
    type: ForwardDto,
    examples: {
      two: {
        value: {
          chatIds: ["0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c", "0192f1c0-7000-7a52-9d1b-3c1d4f5a6b7d"],
        },
      },
    },
  })
  @ApiCreatedResponse({ type: MessageModel, isArray: true })
  @ApiResponse(unauthorized)
  @ApiResponse({
    status: 404,
    type: ErrorModel,
    description: "`MESSAGE_NOT_FOUND`, or `CHAT_NOT_FOUND` for any chat in `chatIds`.",
  })
  @ApiResponse({
    ...invalid,
    description:
      "`VALIDATION_ERROR`: a bad list, more than 20 chats, or a deleted or system message.",
  })
  forward(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: ForwardDto,
  ): Promise<MessageDto[]> {
    return this.messages.forward(user.id, id, body.chatIds);
  }
}
