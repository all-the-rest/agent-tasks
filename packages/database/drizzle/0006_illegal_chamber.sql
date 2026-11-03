ALTER TABLE "executions" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
UPDATE "executions" SET "read_at" = now() WHERE "status" = 'completed' AND "read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "executions_unread_owner_task_idx" ON "executions" USING btree ("owner_id","task_id") WHERE "executions"."status" = 'completed' and "executions"."read_at" is null;
