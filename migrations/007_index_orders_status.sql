-- The support dashboard filters orders by status.
CREATE INDEX orders_status_idx ON orders (status);
