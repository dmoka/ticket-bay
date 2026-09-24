CREATE TABLE `discount_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`percent` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`max_uses` integer,
	`uses` integer DEFAULT 0 NOT NULL,
	`expires_at_ms` integer,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT "discount_codes_percent_range" CHECK("discount_codes"."percent" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`venue` text NOT NULL,
	`city` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`starts_at_ms` integer NOT NULL,
	`total_seats` integer NOT NULL,
	`seats_sold` integer DEFAULT 0 NOT NULL,
	`price_cents` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT "events_seats_in_range" CHECK("events"."seats_sold" >= 0 AND "events"."seats_sold" <= "events"."total_seats"),
	CONSTRAINT "events_price_non_negative" CHECK("events"."price_cents" >= 0),
	CONSTRAINT "events_integer_money" CHECK(typeof("events"."price_cents") = 'integer' AND typeof("events"."starts_at_ms") = 'integer')
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`customer_email` text NOT NULL,
	`customer_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`subtotal_cents` integer NOT NULL,
	`discount_percent` integer NOT NULL,
	`group_percent` integer DEFAULT 0 NOT NULL,
	`early_bird_percent` integer DEFAULT 0 NOT NULL,
	`code_percent` integer DEFAULT 0 NOT NULL,
	`discount_code` text,
	`discount_cents` integer NOT NULL,
	`tickets_cents` integer NOT NULL,
	`fee_cents` integer NOT NULL,
	`total_cents` integer NOT NULL,
	`vat_cents` integer NOT NULL,
	`status` text DEFAULT 'paid' NOT NULL,
	`payment_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`refunded_at_ms` integer,
	`refund_cents` integer,
	`refund_fee_cents` integer,
	`seats_released` integer,
	`refund_id` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`discount_code`) REFERENCES `discount_codes`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_quantity_positive" CHECK("orders"."quantity" > 0),
	CONSTRAINT "orders_money_non_negative" CHECK("orders"."tickets_cents" >= 0 AND "orders"."total_cents" >= 0),
	CONSTRAINT "orders_integer_money" CHECK(typeof("orders"."subtotal_cents") = 'integer' AND typeof("orders"."discount_cents") = 'integer' AND typeof("orders"."tickets_cents") = 'integer' AND typeof("orders"."fee_cents") = 'integer' AND typeof("orders"."total_cents") = 'integer' AND typeof("orders"."vat_cents") = 'integer' AND ("orders"."refund_cents" IS NULL OR typeof("orders"."refund_cents") = 'integer')),
	CONSTRAINT "orders_refund_not_above_paid" CHECK("orders"."refund_cents" IS NULL OR "orders"."refund_cents" <= "orders"."tickets_cents")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_idempotency_key_unique` ON `orders` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `orders_event_idx` ON `orders` (`event_id`);--> statement-breakpoint
CREATE INDEX `orders_email_idx` ON `orders` (`customer_email`);--> statement-breakpoint
CREATE INDEX `orders_created_idx` ON `orders` (`created_at_ms`);