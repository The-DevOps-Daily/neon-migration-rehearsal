-- integer tops out at $21.4 million in cents; the B2B plan will pass that.
ALTER TABLE orders ALTER COLUMN amount_cents TYPE bigint;
