-- The app has required a phone number at signup for two years.
ALTER TABLE customers ALTER COLUMN phone SET NOT NULL;
