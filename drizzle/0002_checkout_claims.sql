CREATE TABLE "checkout_claims" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"claimed_at_ms" bigint NOT NULL
);
