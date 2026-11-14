CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"linked_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"phone_digits" text GENERATED ALWAYS AS (nullif(regexp_replace(phone, '\D', '', 'g'), '')) STORED,
	"about" text,
	"hue" smallint,
	"avatar_url" text,
	"blocked" boolean DEFAULT false NOT NULL,
	"saved" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_hue_range" CHECK ("contacts"."hue" is null or "contacts"."hue" between 0 and 359),
	CONSTRAINT "contacts_not_self" CHECK ("contacts"."owner_id" <> "contacts"."linked_user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_members" (
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"cleared_before_seq" bigint DEFAULT 0 NOT NULL,
	"hidden_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "chat_members_pkey" PRIMARY KEY("chat_id","user_id"),
	CONSTRAINT "chat_members_unread_not_negative" CHECK ("chat_members"."unread_count" >= 0),
	CONSTRAINT "chat_members_cleared_not_negative" CHECK ("chat_members"."cleared_before_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"hue" smallint,
	"direct_key" text,
	"created_by" uuid,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chats_type" CHECK ("chats"."type" in ('direct', 'group')),
	CONSTRAINT "chats_direct_key_matches_type" CHECK (("chats"."type" = 'direct') = ("chats"."direct_key" is not null)),
	CONSTRAINT "chats_group_has_name_and_hue" CHECK ("chats"."type" = 'direct' or ("chats"."name" is not null and char_length(btrim("chats"."name")) between 1 and 60 and "chats"."hue" is not null and "chats"."hue" between 0 and 359)),
	CONSTRAINT "chats_last_seq_not_negative" CHECK ("chats"."last_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"sender_id" uuid,
	"client_id" text,
	"kind" text NOT NULL,
	"text" text,
	"duration" integer,
	"bars" jsonb,
	"attachment_id" uuid,
	"reply_to_id" uuid,
	"forwarded" boolean DEFAULT false NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"event" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_kind" CHECK ("messages"."kind" in ('text', 'voice', 'system', 'image', 'file')),
	CONSTRAINT "messages_system_has_event_and_no_sender" CHECK (("messages"."kind" = 'system') = ("messages"."sender_id" is null) and ("messages"."kind" = 'system') = ("messages"."event" is not null)),
	CONSTRAINT "messages_seq_positive" CHECK ("messages"."seq" > 0)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ghost_owner_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_owner_linked_key" ON "contacts" USING btree ("owner_id","linked_user_id");--> statement-breakpoint
CREATE INDEX "contacts_linked_user_id_idx" ON "contacts" USING btree ("linked_user_id");--> statement-breakpoint
CREATE INDEX "contacts_owner_phone_digits_idx" ON "contacts" USING btree ("owner_id","phone_digits");--> statement-breakpoint
CREATE INDEX "chat_members_user_id_chat_id_idx" ON "chat_members" USING btree ("user_id","chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_direct_key_key" ON "chats" USING btree ("direct_key");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_chat_id_seq_key" ON "messages" USING btree ("chat_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_id_key" ON "messages" USING btree ("chat_id","sender_id","client_id") WHERE "messages"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_reply_to_id_idx" ON "messages" USING btree ("reply_to_id") WHERE "messages"."reply_to_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_sender_id_idx" ON "messages" USING btree ("sender_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_ghost_owner_id_users_id_fk" FOREIGN KEY ("ghost_owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_ghost_owner_id_idx" ON "users" USING btree ("ghost_owner_id") WHERE "users"."ghost_owner_id" is not null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_ghost_is_bot" CHECK ("users"."ghost_owner_id" is null or "users"."is_bot");