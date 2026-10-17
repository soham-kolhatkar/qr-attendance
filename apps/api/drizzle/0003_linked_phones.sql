CREATE TYPE "public"."device_platform" AS ENUM('android', 'ios');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('pending', 'active', 'revoked', 'rejected');--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "device_platform" NOT NULL,
	"status" "device_status" NOT NULL,
	"public_key" text NOT NULL,
	"key_hash" text NOT NULL,
	"phone_hash" text NOT NULL,
	"attestation" jsonb NOT NULL,
	"model" text,
	"os_version" text,
	"app_version" text,
	"activated_at" timestamp with time zone,
	"activated_by" uuid,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_ended_by_users_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "devices_one_active_per_user" ON "devices" USING btree ("user_id") WHERE "devices"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "devices_one_pending_per_user" ON "devices" USING btree ("user_id") WHERE "devices"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "devices_one_user_per_phone" ON "devices" USING btree ("institute_id","phone_hash") WHERE "devices"."status" = 'active';--> statement-breakpoint
CREATE INDEX "devices_institute_status_idx" ON "devices" USING btree ("institute_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "devices_user_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;