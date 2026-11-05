ALTER TABLE "executions" ADD COLUMN "input_snapshot" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "executions" AS execution SET "input_snapshot" = task."prompt" FROM "tasks" AS task WHERE execution."task_id" = task."id" AND execution."input_snapshot" = '';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "conversation_mode" text DEFAULT 'standalone' NOT NULL;
