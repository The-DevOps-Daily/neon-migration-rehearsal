import pg from 'pg';

// Neon connection strings carry sslmode=require; pg treats that as verify-full today and warns
// that it will not in its next major. Ask for verify-full explicitly.
export function connect(uri, options = {}) {
  const url = new URL(uri);
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.delete('channel_binding');
  const client = new pg.Client({ connectionString: url.toString(), ...options });
  return client.connect().then(() => client);
}
