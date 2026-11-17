import { Body, Controller, Get, Inject, Patch } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";

import type { MeDto } from "@dovetalk/contracts";

import type { AuthUser } from "../common/auth-user.js";
import { CurrentUser } from "../common/decorators.js";
import { ErrorModel, MeModel } from "../docs/models.js";
import { ProfileService } from "../users/profile.service.js";
import { UpdateMeDto } from "./dto.js";

@ApiTags("me")
@ApiBearerAuth()
@Controller("me")
export class MeController {
  constructor(@Inject(ProfileService) private readonly profiles: ProfileService) {}

  @Get()
  @ApiOperation({ summary: "The signed-in person's profile." })
  @ApiOkResponse({ type: MeModel })
  @ApiResponse({ status: 401, type: ErrorModel, description: "`UNAUTHORIZED`." })
  async get(@CurrentUser() user: AuthUser): Promise<MeDto> {
    return this.profiles.get(user.id);
  }

  @Patch()
  @ApiOperation({
    summary: "Change the profile.",
    description:
      "Only the fields you send change. `preferences` is merged key by key, not replaced.",
  })
  @ApiBody({
    type: UpdateMeDto,
    examples: {
      profile: { value: { name: "Alex R.", about: "Coffee first." } },
      preferences: {
        summary: "Turn sounds off, keep the rest",
        value: { preferences: { sounds: false } },
      },
      removePhone: { value: { phone: null } },
    },
  })
  @ApiOkResponse({ type: MeModel })
  @ApiResponse({ status: 401, type: ErrorModel, description: "`UNAUTHORIZED`." })
  @ApiResponse({ status: 409, type: ErrorModel, description: "`PHONE_TAKEN`." })
  @ApiResponse({ status: 422, type: ErrorModel, description: "`VALIDATION_ERROR`." })
  async update(@CurrentUser() user: AuthUser, @Body() body: UpdateMeDto): Promise<MeDto> {
    return this.profiles.update(user.id, {
      name: body.name,
      about: body.about,
      avatarUrl: body.avatarUrl,
      phone: body.phone,
      preferences: body.preferences,
    });
  }
}
