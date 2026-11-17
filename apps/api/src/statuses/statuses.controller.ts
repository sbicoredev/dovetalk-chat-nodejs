import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
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

import type { StatusDto } from "@dovetalk/contracts";
import { StatusesService } from "@dovetalk/core";

import type { AuthUser } from "../common/auth-user.js";
import { CurrentUser } from "../common/decorators.js";
import { ErrorModel, StatusModel } from "../docs/models.js";
import { CreateStatusDto } from "./dto.js";

const unauthorized = { status: 401, type: ErrorModel, description: "`UNAUTHORIZED`." } as const;
const statusNotFound = {
  status: 404,
  type: ErrorModel,
  description:
    "`STATUS_NOT_FOUND`: no such status, it has expired, or you cannot see it. The answer is the same for all three.",
} as const;

@ApiTags("statuses")
@ApiBearerAuth()
@Controller("statuses")
export class StatusesController {
  constructor(@Inject(StatusesService) private readonly statuses: StatusesService) {}

  @Get()
  @ApiOperation({
    summary: "Statuses you can see.",
    description:
      "Your own and those of everybody you have a contact row for, including people you never added and contacts you deleted (so also people you only share a group with). Statuses expire after 24 hours. Oldest first.",
  })
  @ApiOkResponse({ type: StatusModel, isArray: true })
  @ApiResponse(unauthorized)
  list(@CurrentUser() user: AuthUser): Promise<StatusDto[]> {
    return this.statuses.list(user.id);
  }

  @Post()
  @ApiOperation({
    summary: "Post a status.",
    description:
      "The text is trimmed and cut at 120 characters. `color` must be a whole number from 0 to 5. It disappears after 24 hours.",
  })
  @ApiBody({
    type: CreateStatusDto,
    examples: { status: { value: { text: "Pasta night, finally.", color: 3 } } },
  })
  @ApiCreatedResponse({ type: StatusModel })
  @ApiResponse(unauthorized)
  @ApiResponse({
    status: 422,
    type: ErrorModel,
    description: "`VALIDATION_ERROR`: empty text, or a colour that is not 0 to 5.",
  })
  create(@CurrentUser() user: AuthUser, @Body() body: CreateStatusDto): Promise<StatusDto> {
    return this.statuses.create(user.id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete one of your statuses." })
  @ApiNoContentResponse()
  @ApiResponse(unauthorized)
  @ApiResponse({
    status: 403,
    type: ErrorModel,
    description: "`FORBIDDEN`: a status you can see but did not post.",
  })
  @ApiResponse(statusNotFound)
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<void> {
    return this.statuses.remove(user.id, id);
  }

  @Post(":id/seen")
  @HttpCode(204)
  @ApiOperation({
    summary: "Mark a status as seen.",
    description:
      "Repeatable. Marking your own does nothing. A status you cannot see is `404`, where the prototype answered `204` for any id.",
  })
  @ApiNoContentResponse()
  @ApiResponse(unauthorized)
  @ApiResponse(statusNotFound)
  markSeen(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<void> {
    return this.statuses.markSeen(user.id, id);
  }
}
