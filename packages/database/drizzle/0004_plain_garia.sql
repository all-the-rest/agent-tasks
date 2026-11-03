CREATE TABLE "execution_opencode_sessions" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"prompt_dispatched" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_opencode_sessions" ADD CONSTRAINT "execution_opencode_sessions_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;