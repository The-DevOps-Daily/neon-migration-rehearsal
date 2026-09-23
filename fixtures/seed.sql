-- What a CI test database usually holds: a few rows made by factories, all clean, all new.
INSERT INTO customers (email, phone, created_at)
SELECT 'user' || i || '@example.com', '+1555' || lpad(i::text, 7, '0'), now() - (i || ' minutes')::interval
FROM generate_series(1, 50) AS i;

INSERT INTO orders (customer_id, amount_cents, status, created_at)
SELECT 1 + i % 50, 1000 + i, (ARRAY['paid', 'shipped', 'refunded'])[1 + i % 3], now() - (i || ' minutes')::interval
FROM generate_series(1, 200) AS i;
