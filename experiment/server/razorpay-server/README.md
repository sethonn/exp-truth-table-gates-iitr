Razorpay Server Example
======================

This minimal Express server demonstrates secure server-side creation of Razorpay orders and verification of payment signatures.

Setup
-----

1. Copy the example env file and add your Razorpay credentials:

   cp .env.example .env
   # then edit .env and fill RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET

2. Install dependencies and run:

   npm install
   npm start

Endpoints
---------

- `POST /create-order` - Create an order on Razorpay.
  - Request JSON: `{ "amount": 50 }` (amount in INR)
  - Response: Razorpay order object. Use `order.id` on the client when opening Checkout.

- `POST /verify` - Verify a completed payment signature.
  - Request JSON: `{ "razorpay_order_id": "...", "razorpay_payment_id": "...", "razorpay_signature": "..." }`
  - Response: `{ ok: true }` when signature matches.

Client flow (recommended)
-------------------------

1. Client calls `POST /create-order` with an amount.
2. Server creates the order and returns the order object.
3. Client opens Razorpay Checkout with the returned order id:

```js
// Example client usage after receiving `order` from server
const options = {
  key: 'YOUR_KEY_ID', // public key
  amount: order.amount,
  currency: order.currency,
  name: 'IITR Virtual Lab',
  description: 'Support the Logic Gates Simulator',
  order_id: order.id,
  handler: function (response) {
    // response contains razorpay_payment_id, order_id and signature
    // Send these to server /verify for verification
    fetch('/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(response)
    }).then(r => r.json()).then(console.log);
  }
};
const rzp = new Razorpay(options);
rzp.open();
```

Security notes
--------------

- Never trust client-side payment responses without server-side verification.
- Use `razorpay_key_id` (public) in client and `razorpay_key_secret` (private) only on server.
- For production, ensure HTTPS and proper storage of secrets.

Admin hint
----------

To enable live payments you must set your Razorpay credentials in a `.env` file.

1. Copy the example file:

  cp .env.example .env

2. Edit `.env` and set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` with values from your Razorpay dashboard.

3. Restart the server:

```bash
npm start
```

After restarting, visit `http://localhost:3000/` — the demo page will show the Donate UI when keys are configured.

Remote log shipping
-------------------

This server can optionally ship logs to a remote HTTP endpoint. Configure the following environment variables in your `.env`:

- `LOG_SHIP_URL` — the remote HTTP endpoint that accepts JSON log payloads (e.g. your LogDNA/Logflare/Logstash ingest URL).
- `LOG_SHIP_API_KEY` — optional bearer token used for the `Authorization: Bearer <key>` header.

Provider-specific (LogDNA)
--------------------------

To ship logs to LogDNA set the following in your `.env`:

```env
LOG_SHIP_PROVIDER=logdna
LOG_SHIP_API_KEY=<YOUR_LOGDNA_INGESTION_KEY>
# optional: override ingest URL
LOG_SHIP_URL=https://logs.logdna.com/logs/ingest?hostname=my-host
```

The server will send LogDNA's expected payload format to the ingest endpoint with basic auth using the ingestion key as username. If you prefer to use a provider other than LogDNA, keep `LOG_SHIP_PROVIDER` empty and set `LOG_SHIP_URL`/`LOG_SHIP_API_KEY` for a generic HTTP shipper.

The server will POST structured JSON payloads to `LOG_SHIP_URL` for each log entry when `LOG_SHIP_URL` is set.

Example (local `.env`):

```env
LOG_SHIP_URL=https://logs.example.com/ingest
LOG_SHIP_API_KEY=your_ingestion_key_here
```

Note: Different providers have different ingestion requirements (headers, query params). If you plan to use LogDNA, obtain the ingestion key from your LogDNA account and consult LogDNA docs for the correct ingest URL and authentication method — you can set `LOG_SHIP_URL` and `LOG_SHIP_API_KEY` accordingly.

Batching and retries
---------------------

The server batches log entries and ships them periodically to reduce network overhead. Configure batching with these env vars:

- `LOG_BATCH_SIZE` — number of log entries per request (default 25)
- `LOG_FLUSH_INTERVAL_MS` — how often to flush when batch not full (default 2000 ms)
- `LOG_MAX_RETRIES` — number of times to retry failed batches before dropping (default 3)

Example:

```env
LOG_BATCH_SIZE=50
LOG_FLUSH_INTERVAL_MS=3000
LOG_MAX_RETRIES=5
```

Metrics endpoint authentication
-------------------------------

The `/metrics` endpoint can be protected with a simple Bearer token. Set `METRICS_TOKEN` in your `.env` to enable authentication. Clients must then send the header:

```
Authorization: Bearer <METRICS_TOKEN>
```

If `METRICS_TOKEN` is not set the server will log a warning and the `/metrics` endpoint will be accessible without authentication (not recommended for production).
