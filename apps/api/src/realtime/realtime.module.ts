import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { PresenceKeeper } from "./presence-keeper.js";
import { RealtimeGateway } from "./realtime.gateway.js";

/** The socket.io gateway and this instance's share of presence. The events come from the core module. */
@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, PresenceKeeper],
  exports: [PresenceKeeper],
})
export class RealtimeModule {}
