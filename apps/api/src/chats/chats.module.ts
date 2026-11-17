import { Module } from "@nestjs/common";

import { ChatsController } from "./chats.controller.js";

/** ChatsService comes from the global CoreModule. */
@Module({ controllers: [ChatsController] })
export class ChatsModule {}
