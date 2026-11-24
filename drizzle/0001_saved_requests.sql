CREATE TABLE "saved_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"folder" text,
	"method" text DEFAULT 'GET' NOT NULL,
	"path" text DEFAULT '/' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_requests" ADD CONSTRAINT "saved_requests_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_requests_collection_idx" ON "saved_requests" USING btree ("collection_id");