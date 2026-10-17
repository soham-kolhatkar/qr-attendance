CREATE TABLE "session_tallies" (
	"session_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"institute_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"present" integer NOT NULL,
	"absent" integer NOT NULL,
	"excused" integer NOT NULL,
	"total" integer NOT NULL,
	CONSTRAINT "session_tallies_session_id_unit_id_pk" PRIMARY KEY("session_id","unit_id")
);
--> statement-breakpoint
CREATE TABLE "student_tallies" (
	"offering_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"institute_id" uuid NOT NULL,
	"present" integer NOT NULL,
	"absent" integer NOT NULL,
	"excused" integer NOT NULL,
	"total" integer NOT NULL,
	CONSTRAINT "student_tallies_offering_id_student_id_pk" PRIMARY KEY("offering_id","student_id")
);
--> statement-breakpoint
ALTER TABLE "offerings" ADD COLUMN "tallies_stale" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "session_tallies" ADD CONSTRAINT "session_tallies_session_id_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tallies" ADD CONSTRAINT "session_tallies_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tallies" ADD CONSTRAINT "session_tallies_offering_id_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tallies" ADD CONSTRAINT "session_tallies_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_tallies" ADD CONSTRAINT "student_tallies_offering_id_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_tallies" ADD CONSTRAINT "student_tallies_student_id_students_user_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_tallies" ADD CONSTRAINT "student_tallies_institute_id_institutes_id_fk" FOREIGN KEY ("institute_id") REFERENCES "public"."institutes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_tallies_offering_idx" ON "session_tallies" USING btree ("offering_id");--> statement-breakpoint
CREATE INDEX "student_tallies_student_idx" ON "student_tallies" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "offerings_tallies_stale_idx" ON "offerings" USING btree ("institute_id") WHERE "offerings"."tallies_stale";