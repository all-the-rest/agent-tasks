CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid,
	"scope" text NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"semantic_key" text,
	"origin" text NOT NULL,
	"origin_ref" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"user_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_scope_shape" CHECK (("memories"."scope" = 'global' and "memories"."task_id" is null) or ("memories"."scope" = 'task' and "memories"."task_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "memory_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid,
	"memory_id" uuid,
	"execution_id" uuid,
	"suggestion_id" uuid,
	"action" text NOT NULL,
	"scope" text NOT NULL,
	"before_content" text,
	"after_content" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	"category" text NOT NULL,
	"semantic_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"changed_by" text NOT NULL,
	"execution_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"execution_id" uuid,
	"target_memory_id" uuid,
	"operation" text DEFAULT 'upsert' NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"semantic_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_tombstones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid,
	"scope" text NOT NULL,
	"semantic_key" text,
	"content_hash" text NOT NULL,
	"changed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"execution_id" uuid,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"semantic_key" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source_url" text,
	"status" text DEFAULT 'discovered' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_execution_id" uuid,
	"last_execution_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "memory_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_suggestion_id_memory_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."memory_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_target_memory_id_memories_id_fk" FOREIGN KEY ("target_memory_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_tombstones" ADD CONSTRAINT "memory_tombstones_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_tombstones" ADD CONSTRAINT "memory_tombstones_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_first_execution_id_executions_id_fk" FOREIGN KEY ("first_execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_last_execution_id_executions_id_fk" FOREIGN KEY ("last_execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_owner_scope_idx" ON "memories" USING btree ("owner_id","scope","updated_at");--> statement-breakpoint
CREATE INDEX "memories_task_idx" ON "memories" USING btree ("task_id","updated_at");--> statement-breakpoint
CREATE INDEX "memories_search_idx" ON "memories" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE UNIQUE INDEX "memories_global_semantic_unique" ON "memories" USING btree ("owner_id","semantic_key") WHERE "memories"."scope" = 'global' and "memories"."semantic_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memories_task_semantic_unique" ON "memories" USING btree ("task_id","semantic_key") WHERE "memories"."scope" = 'task' and "memories"."semantic_key" is not null;--> statement-breakpoint
CREATE INDEX "memory_changes_owner_idx" ON "memory_changes" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_changes_task_idx" ON "memory_changes" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_changes_execution_idx" ON "memory_changes" USING btree ("execution_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_revisions_unique" ON "memory_revisions" USING btree ("memory_id","revision");--> statement-breakpoint
CREATE INDEX "memory_suggestions_task_idx" ON "memory_suggestions" USING btree ("task_id","status","created_at");--> statement-breakpoint
CREATE INDEX "memory_suggestions_owner_idx" ON "memory_suggestions" USING btree ("owner_id","status","created_at");--> statement-breakpoint
CREATE INDEX "memory_tombstones_owner_idx" ON "memory_tombstones" USING btree ("owner_id","scope","created_at");--> statement-breakpoint
CREATE INDEX "memory_tombstones_task_idx" ON "memory_tombstones" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "recommendation_events_recommendation_idx" ON "recommendation_events" USING btree ("recommendation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_task_key_unique" ON "recommendations" USING btree ("task_id","semantic_key");--> statement-breakpoint
CREATE INDEX "recommendations_task_status_idx" ON "recommendations" USING btree ("task_id","status","last_observed_at");