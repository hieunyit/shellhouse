# TLS test fixtures

Throw-away certificates for the TCP + TLS tests. They protect nothing: the CA, server and client
keys are public in this repository and valid for 100 years so tests never expire.

- `ca.pem` — test CA; `server.pem` / `server-key.pem` — server (SAN `localhost`, `127.0.0.1`);
  `client.pem` / `client-key.pem` — client (mTLS, RSA 2048).
- `other-ca.pem` — an unrelated CA (wrong-CA test); `other-key.pem` — a key that matches no
  certificate here; `encrypted-key.pem` — a passphrase-protected key (passphrase `secret`).

Regenerate with `openssl` (EC P-256 / RSA 2048, `-days 36500`) if you ever need to.
