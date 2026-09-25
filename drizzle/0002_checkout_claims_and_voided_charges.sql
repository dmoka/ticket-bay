CREATE TABLE "checkout_claims" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"claimed_at_ms" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voided_charges" (
	"charge_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"voided_at_ms" bigint NOT NULL
);
