Second-version results, superseded. These runs connected with the string that Neon's
`connection_uri` API returns when `pooled` is not given, which is the pooled (PgBouncer,
transaction mode) one. So the migrations ran through the pooler, and the lock sampler, which
matched app sessions by backend PID, recorded nothing: the pooler moves a client between
backends. The current harness runs migrations on the direct string and the app on the pooled
one, and every result in `data/` was measured again with it.
