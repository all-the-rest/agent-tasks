CREATE TABLE "execution_budget_counters" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	"output_bytes" bigint DEFAULT 0 NOT NULL,
	"max_calls" integer NOT NULL,
	"max_pages" integer NOT NULL,
	"max_searches" integer NOT NULL,
	"max_output_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_budget_counters_non_negative" CHECK ("execution_budget_counters"."calls" >= 0 and "execution_budget_counters"."pages" >= 0 and "execution_budget_counters"."searches" >= 0 and "execution_budget_counters"."output_bytes" >= 0 and "execution_budget_counters"."max_calls" >= 0 and "execution_budget_counters"."max_pages" >= 0 and "execution_budget_counters"."max_searches" >= 0 and ("execution_budget_counters"."max_output_bytes" is null or "execution_budget_counters"."max_output_bytes" >= 0))
);
--> statement-breakpoint
ALTER TABLE "execution_budget_counters" ADD CONSTRAINT "execution_budget_counters_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_budget_counters" ADD CONSTRAINT "execution_budget_counters_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_budget_counters_owner_idx" ON "execution_budget_counters" USING btree ("owner_id");