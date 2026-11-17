import { Module } from "@nestjs/common";

import { ContactsController } from "./contacts.controller.js";

/** ContactsService comes from the global CoreModule. */
@Module({ controllers: [ContactsController] })
export class ContactsModule {}
