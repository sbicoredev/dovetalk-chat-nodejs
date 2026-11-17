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
  Put,
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

import type { ContactDto } from "@dovetalk/contracts";
import { ContactsService } from "@dovetalk/core";

import type { AuthUser } from "../common/auth-user.js";
import { CurrentUser } from "../common/decorators.js";
import { ContactModel, ErrorModel } from "../docs/models.js";
import { BlockContactDto, CreateContactDto, UpdateContactDto } from "./dto.js";

const unauthorized = { status: 401, type: ErrorModel, description: "`UNAUTHORIZED`." } as const;
const notFound = { status: 404, type: ErrorModel, description: "`CONTACT_NOT_FOUND`." } as const;
const invalid = { status: 422, type: ErrorModel, description: "`VALIDATION_ERROR`." } as const;

@ApiTags("contacts")
@ApiBearerAuth()
@Controller("contacts")
export class ContactsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService) {}

  @Get()
  @ApiOperation({
    summary: "Your contacts.",
    description:
      "Every contact you have, oldest first. People you share a chat with but never added, and people you deleted, are listed with `saved: false` so their messages can show a name. An address book should hide them.",
  })
  @ApiOkResponse({ type: ContactModel, isArray: true })
  @ApiResponse(unauthorized)
  list(@CurrentUser() user: AuthUser): Promise<ContactDto[]> {
    return this.contacts.list(user.id);
  }

  @Post()
  @ApiOperation({
    summary: "Add a contact by phone number.",
    description:
      "In order: your own number is refused; a number you already have returns that contact (`200`, and a deleted one is saved again under the new name); a registered person with that number is linked; any other number becomes a private bot that answers, so the app behaves like the demo.",
  })
  @ApiBody({
    type: CreateContactDto,
    examples: { contact: { value: { name: "Priya Nair", phone: "+1 555 010 0142" } } },
  })
  @ApiCreatedResponse({ type: ContactModel, description: "A new contact." })
  @ApiOkResponse({ type: ContactModel, description: "You already had this number." })
  @ApiResponse(unauthorized)
  @ApiResponse(invalid)
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateContactDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContactDto> {
    const { contact, created } = await this.contacts.create(user.id, body);
    res.status(created ? 201 : 200);
    return contact;
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Rename a contact, change their number or their note.",
    description: "Only the fields you send change. Contacts you have saved only.",
  })
  @ApiBody({ type: UpdateContactDto, examples: { rename: { value: { name: "Priya N." } } } })
  @ApiOkResponse({ type: ContactModel })
  @ApiResponse(unauthorized)
  @ApiResponse(notFound)
  @ApiResponse({
    status: 409,
    type: ErrorModel,
    description: "`PHONE_TAKEN`: another saved contact has this number.",
  })
  @ApiResponse(invalid)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: UpdateContactDto,
  ): Promise<ContactDto> {
    return this.contacts.update(user.id, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Delete a contact.",
    description:
      "The contact is no longer saved and their direct chat leaves your list. Their messages stay readable in groups, and blocking is kept.",
  })
  @ApiNoContentResponse()
  @ApiResponse(unauthorized)
  @ApiResponse(notFound)
  remove(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<void> {
    return this.contacts.remove(user.id, id);
  }

  @Put(":id/block")
  @ApiOperation({
    summary: "Block or unblock a contact.",
    description: "Idempotent: asking for the state a contact already has changes nothing.",
  })
  @ApiBody({ type: BlockContactDto, examples: { block: { value: { blocked: true } } } })
  @ApiOkResponse({ type: ContactModel })
  @ApiResponse(unauthorized)
  @ApiResponse(notFound)
  @ApiResponse(invalid)
  setBlocked(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: BlockContactDto,
  ): Promise<ContactDto> {
    return this.contacts.setBlocked(user.id, id, body.blocked);
  }
}
