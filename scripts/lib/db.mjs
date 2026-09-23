import pg from 'pg';

// Neon connection strings carry sslmode=require; pg treats that as verify-full today and warns
// that it will not in its next major. Ask for verify-full explicitly.
export function connect(uri, options = {}) {
  const url = new URL(uri);
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.delete('channel_binding');
  // query_timeout is a client-side deadline for every query; callers can shorten it.
  const client = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 30_000,
    query_timeout: 15 * 60_000,
    ...options,
  });
  // A dropped connection also fails the query in flight. Without a listener, the 'error' event
  // would end the process before any cleanup or restore could run.
  client.on('error', () => {});
  return client.connect().then(() => client);
}
