CREATE TABLE "checkout_claims" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"claimed_at_ms" bigint NOT NULL
);
