CREATE TABLE "refunds" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "refunds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"tickets" integer NOT NULL,
	"gross_cents" bigint NOT NULL,
	"fee_cents" bigint NOT NULL,
	"net_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"seats_released" boolean NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_refund_id" text,
	CONSTRAINT "refunds_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "refunds_tickets_positive" CHECK ("refunds"."tickets" > 0),
	CONSTRAINT "refunds_amounts_add_up" CHECK ("refunds"."gross_cents" >= 0 AND "refunds"."fee_cents" >= 0 AND "refunds"."net_cents" >= 0 AND "refunds"."net_cents" + "refunds"."fee_cents" = "refunds"."gross_cents")
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_created_idx" ON "refunds" USING btree ("created_at_ms");--> statement-breakpoint
-- Hand-written below this line (drizzle-kit generates neither data copies nor triggers).
-- Every refunded order becomes one refund row. The old columns on orders stay
-- for now and are dropped by a later migration.
INSERT INTO "refunds" ("order_id", "tickets", "gross_cents", "fee_cents", "net_cents", "reason", "created_at_ms", "seats_released", "idempotency_key", "provider_refund_id")
SELECT
	"id",
	"quantity",
	coalesce("refund_cents", 0) + coalesce("refund_fee_cents", 0),
	coalesce("refund_fee_cents", 0),
	coalesce("refund_cents", 0),
	coalesce("refund_reason", 'customer'),
	coalesce("refunded_at_ms", "created_at_ms"),
	coalesce("seats_released", false),
	-- the keys the payouts were sent with, so a payout still owed is never paid twice
	CASE WHEN "refund_reason" = 'event_cancelled' THEN 'event-cancel-' || "id" ELSE 'refund-' || "id" END,
	"refund_id"
FROM "orders"
WHERE "status" = 'refunded'
ORDER BY "id";
--> statement-breakpoint
-- An order's refunds never cancel more tickets than it has, and their gross
-- never adds up to more than was paid for the tickets. A CHECK sees one row;
-- this sees them all. It locks the order row first, so two refunds of the
-- same order are checked one after the other, each against the other's total.
CREATE FUNCTION "refunds_within_order"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	o record;
	tickets_before bigint;
	gross_before numeric;
BEGIN
	SELECT "quantity", "tickets_cents" INTO o FROM "orders" WHERE "id" = NEW."order_id" FOR UPDATE;
	SELECT coalesce(sum("tickets"), 0), coalesce(sum("gross_cents"), 0) INTO tickets_before, gross_before
		FROM "refunds" WHERE "order_id" = NEW."order_id" AND "id" <> NEW."id";
	IF tickets_before + NEW."tickets" > o."quantity" THEN
		RAISE EXCEPTION 'refunds of order % cancel % tickets; it has %', NEW."order_id", tickets_before + NEW."tickets", o."quantity"
			USING ERRCODE = 'check_violation', TABLE = 'refunds', CONSTRAINT = 'refunds_tickets_within_order';
	END IF;
	IF gross_before + NEW."gross_cents" > o."tickets_cents" THEN
		RAISE EXCEPTION 'refunds of order % add up to % cents; its tickets cost %', NEW."order_id", gross_before + NEW."gross_cents", o."tickets_cents"
			USING ERRCODE = 'check_violation', TABLE = 'refunds', CONSTRAINT = 'refunds_within_tickets_paid';
	END IF;
	RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "refunds_within_order" BEFORE INSERT OR UPDATE ON "refunds" FOR EACH ROW EXECUTE FUNCTION "refunds_within_order"();
