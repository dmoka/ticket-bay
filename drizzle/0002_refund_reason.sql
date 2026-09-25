ALTER TABLE "orders" ADD COLUMN "refund_reason" text;--> statement-breakpoint
-- Refunds made before this column existed were all customer cancellations.
UPDATE "orders" SET "refund_reason" = 'customer' WHERE "status" = 'refunded';
