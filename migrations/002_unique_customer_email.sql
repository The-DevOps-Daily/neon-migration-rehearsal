-- One account per email address, whatever the capitals.
CREATE UNIQUE INDEX customers_email_lower_key ON customers (lower(email));
