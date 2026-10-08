ALTER TABLE "orders" ADD COLUMN "holder_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_holder_id_user_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_holder_idx" ON "orders" USING btree ("holder_id");