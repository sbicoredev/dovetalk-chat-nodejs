CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"password_hash" text,
	"name" text NOT NULL,
	"about" text DEFAULT 'Hey there, I am using Dovetalk.' NOT NULL,
	"avatar_url" text,
	"hue" smallint NOT NULL,
	"phone" text,
	"phone_digits" text GENERATED ALWAYS AS (nullif(regexp_replace(phone, '\D', '', 'g'), '')) STORED,
	"preferences" jsonb DEFAULT '{"sounds":true,"previews":true,"enterToSend":true}'::jsonb NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"bot_online_default" boolean DEFAULT false NOT NULL,
	"is_guest" boolean DEFAULT false NOT NULL,
	"guest_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_phone_digits_length" CHECK ("users"."phone_digits" is null or char_length("users"."phone_digits") between 7 and 15),
	CONSTRAINT "users_guest_has_expiry" CHECK ("users"."is_guest" = ("users"."guest_expires_at" is not null)),
	CONSTRAINT "users_hue_range" CHECK ("users"."hue" between 0 and 359),
	CONSTRAINT "users_credentials" CHECK (("users"."is_bot" or "users"."is_guest") or ("users"."email" is not null and "users"."password_hash" is not null)),
	CONSTRAINT "users_not_both_bot_and_guest" CHECK (not ("users"."is_bot" and "users"."is_guest"))
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_digits_key" ON "users" USING btree ("phone_digits");--> statement-breakpoint
CREATE INDEX "users_guest_expires_at_idx" ON "users" USING btree ("guest_expires_at") WHERE "users"."guest_expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" USING btree ("expires_at");