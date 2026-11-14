CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"name" text NOT NULL,
	"size" integer NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_size_positive" CHECK ("attachments"."size" > 0),
	CONSTRAINT "attachments_dimensions_positive" CHECK (("attachments"."width" is null or "attachments"."width" > 0) and ("attachments"."height" is null or "attachments"."height" > 0))
);
--> statement-breakpoint
CREATE TABLE "message_hidden" (
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_hidden_pkey" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_pkey" PRIMARY KEY("message_id","user_id"),
	CONSTRAINT "message_reactions_emoji_length" CHECK (char_length("message_reactions"."emoji") between 1 and 32)
);
--> statement-breakpoint
CREATE TABLE "status_views" (
	"status_id" uuid NOT NULL,
	"viewer_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_views_pkey" PRIMARY KEY("status_id","viewer_id")
);
--> statement-breakpoint
CREATE TABLE "statuses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"audience_id" uuid,
	"text" text NOT NULL,
	"color" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "statuses_color_range" CHECK ("statuses"."color" between 0 and 5),
	CONSTRAINT "statuses_text_length" CHECK (char_length("statuses"."text") between 1 and 120),
	CONSTRAINT "statuses_expires_after_created" CHECK ("statuses"."expires_at" > "statuses"."created_at")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_hidden" ADD CONSTRAINT "message_hidden_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_hidden" ADD CONSTRAINT "message_hidden_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_views" ADD CONSTRAINT "status_views_status_id_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."statuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_views" ADD CONSTRAINT "status_views_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_audience_id_users_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "attachments_owner_id_idx" ON "attachments" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "attachments_created_at_idx" ON "attachments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "message_hidden_message_id_idx" ON "message_hidden" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_reactions_user_id_idx" ON "message_reactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "status_views_viewer_id_idx" ON "status_views" USING btree ("viewer_id");--> statement-breakpoint
CREATE INDEX "statuses_owner_id_created_at_idx" ON "statuses" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "statuses_expires_at_idx" ON "statuses" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "statuses_audience_id_idx" ON "statuses" USING btree ("audience_id") WHERE "statuses"."audience_id" is not null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_attachment_id_attachments_id_fk" FOREIGN KEY ("avatar_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_avatar_attachment_id_idx" ON "users" USING btree ("avatar_attachment_id") WHERE "users"."avatar_attachment_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_attachment_id_idx" ON "messages" USING btree ("attachment_id") WHERE "messages"."attachment_id" is not null;