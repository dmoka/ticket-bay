CREATE TABLE "discount_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"percent" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at_ms" bigint,
	"created_at_ms" bigint NOT NULL,
	CONSTRAINT "discount_codes_percent_range" CHECK ("discount_codes"."percent" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"venue" text NOT NULL,
	"city" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"starts_at_ms" bigint NOT NULL,
	"total_seats" integer NOT NULL,
	"seats_sold" integer DEFAULT 0 NOT NULL,
	"price_cents" bigint NOT NULL,
	"created_at_ms" bigint NOT NULL,
	CONSTRAINT "events_seats_in_range" CHECK ("events"."seats_sold" >= 0 AND "events"."seats_sold" <= "events"."total_seats"),
	CONSTRAINT "events_price_non_negative" CHECK ("events"."price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"event_id" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"discount_percent" integer NOT NULL,
	"group_percent" integer DEFAULT 0 NOT NULL,
	"early_bird_percent" integer DEFAULT 0 NOT NULL,
	"code_percent" integer DEFAULT 0 NOT NULL,
	"discount_code" text,
	"discount_cents" bigint NOT NULL,
	"tickets_cents" bigint NOT NULL,
	"fee_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"vat_cents" bigint NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"payment_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"refunded_at_ms" bigint,
	"refund_cents" bigint,
	"refund_fee_cents" bigint,
	"seats_released" boolean,
	"refund_id" text,
	CONSTRAINT "orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "orders_quantity_positive" CHECK ("orders"."quantity" > 0),
	CONSTRAINT "orders_money_non_negative" CHECK ("orders"."tickets_cents" >= 0 AND "orders"."total_cents" >= 0),
	CONSTRAINT "orders_refund_not_above_paid" CHECK ("orders"."refund_cents" IS NULL OR "orders"."refund_cents" <= "orders"."tickets_cents")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_code_discount_codes_code_fk" FOREIGN KEY ("discount_code") REFERENCES "public"."discount_codes"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_event_idx" ON "orders" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "orders_email_idx" ON "orders" USING btree ("customer_email");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at_ms");