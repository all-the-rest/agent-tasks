CREATE TABLE "task_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_shares" ADD CONSTRAINT "task_shares_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_shares" ADD CONSTRAINT "task_shares_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_shares_token_unique" ON "task_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "task_shares_task_idx" ON "task_shares" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_shares_owner_idx" ON "task_shares" USING btree ("owner_id","created_at");