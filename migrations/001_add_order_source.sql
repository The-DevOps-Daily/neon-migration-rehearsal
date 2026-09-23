-- Record where an order came from. A constant default is metadata-only since Postgres 11.
ALTER TABLE orders ADD COLUMN source text NOT NULL DEFAULT 'web';
