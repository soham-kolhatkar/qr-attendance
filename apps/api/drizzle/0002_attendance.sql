CREATE TYPE "public"."attendance_status" AS ENUM('present', 'absent', 'excused');--> statement-breakpoint
CREATE TYPE "public"."mark_method" AS ENUM('qr', 'manual');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('open', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"session_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"institute_id" uuid NOT NULL,
	"status" "attendance_status" DEFAULT 'absent' NOT NULL,
	"method" "mark_method",
	"marked_at" timestamp with time zone,
	"marked_by" uuid,
	"reason" text,
	"qr_step" bigint,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_records_session_id_student_id_pk" PRIMARY KEY("session_id","student_id")
);
--> statement-breakpoint
CREATE TABLE "attendance_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institute_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"kind" text DEFAULT 'lecture' NOT NULL,
	"topic" text,
	"audience" jsonb,
	"status" "session_status" DEFAULT 'open' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"cancel_reason" text,
	"qr_secret" text NOT NULL,
	"qr_rotation_seconds" integer NOT NULL,
	"qr_grace_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_session_id_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_student_id_students_user_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_offering_id_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_records_student_idx" ON "attendance_records" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "attendance_records_institute_student_idx" ON "attendance_records" USING btree ("institute_id","student_id");--> statement-breakpoint
CREATE INDEX "attendance_sessions_institute_started_idx" ON "attendance_sessions" USING btree ("institute_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attendance_sessions_offering_started_idx" ON "attendance_sessions" USING btree ("offering_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attendance_sessions_open_closes_idx" ON "attendance_sessions" USING btree ("closes_at") WHERE "attendance_sessions"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sessions_one_open_per_creator" ON "attendance_sessions" USING btree ("created_by") WHERE "attendance_sessions"."status" = 'open';