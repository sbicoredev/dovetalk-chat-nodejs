import { Module } from "@nestjs/common";

import { MessageActionsController } from "./message-actions.controller.js";
import { MessagesController } from "./messages.controller.js";

/** MessagesService comes from the global CoreModule. */
@Module({ controllers: [MessagesController, MessageActionsController] })
export class MessagesModule {}
