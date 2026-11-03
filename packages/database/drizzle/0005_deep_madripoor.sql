ALTER TABLE "tasks" ADD COLUMN "end_condition" jsonb DEFAULT '{"type":"never"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "scheduled_run_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "tasks" AS task
SET "scheduled_run_count" = (
  SELECT count(*)::integer
  FROM "executions" AS execution
  WHERE execution.task_id = task.id
    AND execution.owner_id = task.owner_id
    AND execution.trigger = 'schedule'
);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "tasks" AS task
SET enabled = false,
    completed_at = (
      SELECT min(execution.created_at)
      FROM "executions" AS execution
      WHERE execution.task_id = task.id
        AND execution.owner_id = task.owner_id
        AND execution.trigger = 'schedule'
        AND execution.scheduled_for = (task.schedule->>'runAt')::timestamptz
    )
WHERE task.completed_at IS NULL
  AND task.schedule->>'preset' = 'once'
  AND task.schedule->>'runAt' IS NOT NULL
  AND task.next_run_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM "executions" AS execution
    WHERE execution.task_id = task.id
      AND execution.owner_id = task.owner_id
      AND execution.trigger = 'schedule'
      AND execution.scheduled_for = (task.schedule->>'runAt')::timestamptz
  );
