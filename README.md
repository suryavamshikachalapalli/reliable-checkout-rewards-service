# Checkout & Rewards

A local ecommerce demo with a React storefront and an Express API. It supports
product browsing, editable carts, atomic checkout, retry-safe order creation,
global milestone coupons, and reconciled admin reports. Successful checkout
represents payment success; no real payment is collected.

The database is **SQLite**, accessed through Node.js built-in `node:sqlite`
`DatabaseSync`. PostgreSQL is a future scaling option, not a runtime requirement.
See [DECISIONS.md](DECISIONS.md) for invariants, tradeoffs, AI usage, and the
proposed production architecture.

## Stack and requirements

- Node.js **22.13+ on the 22.x line, 24.x, or 26+**, and npm. The installed Vitest
  version supports those Node major lines; development checks used Node 26.7.0.
- Backend: Express 5, TypeScript 7, `tsx`, SQLite; `dotenv` loads backend `.env`.
- Frontend: React 19, Vite 8, TypeScript, plain CSS. No component, routing, or
  state-management libraries.
- Tests: Vitest and Supertest, with child-process concurrency checks.
- A modern browser with `sessionStorage`, `crypto.randomUUID`, and
  `AbortSignal.timeout`. No external database or separate SQLite executable needed.

## Install and initialize

Run from the repository root:

```sh
npm ci
npm --prefix frontend ci
npm run db:setup
npm run db:seed
```

`db:setup` creates seven STRICT tables and applies the rerunnable unique index
that permits at most one redeemed coupon per order. `db:seed` also runs setup,
then inserts five products using stable IDs:

| ID | Product | Price (cents) | Initial inventory |
| --- | --- | ---: | ---: |
| 1 | Notebook | 599 | 50 |
| 2 | Pen Set | 899 | 30 |
| 3 | Coffee Mug | 1299 | 20 |
| 4 | Tote Bag | 1599 | 10 |
| 5 | Limited Edition Print | 2499 | 1 |

Both commands are safe to rerun: existing products, prices, remaining inventory,
orders, and coupons are preserved. Seeding does not restock sold products.
Setup does not migrate arbitrary changes to existing table definitions or repair
invalid legacy data; an index conflict fails rather than deleting records.

The default file is `data/checkout.sqlite` (ignored by Git). Connections enable
foreign keys, a 5,000 ms busy timeout, and WAL mode. Use `DATABASE_PATH` to choose
another file. Relative overrides resolve from the process working directory.
Pass this environment variable to setup, seed, and server consistently. Database
scripts do not load `.env`; the server does. For example:

```sh
DATABASE_PATH=./data/demo.sqlite npm run db:seed
DATABASE_PATH=./data/demo.sqlite npm run dev
```

## Run locally

Use two terminals in the repository root:

```sh
# Terminal 1: Express, port 3000 by default
npm run dev
```

```sh
# Terminal 2: Vite, port 5173
npm run dev:frontend
```

Open **http://127.0.0.1:5173**. Leave backend `PORT` unset or set it to `3000`.
Vite requires port 5173 and proxies `/api/*` to `http://127.0.0.1:3000`, stripping
`/api`. Backend URLs below have no `/api` prefix. No CORS changes are needed.
`npm start` runs the backend without watch mode.

Create a cart, add products, update quantities, and check out with an optional
coupon. Cart prices are current and inventory is not reserved. Completed orders
show stored product and price snapshots. The UI displays integer cents as USD.

Before checkout, the UI saves the key and exact coupon payload in
`sessionStorage`. Retries and reloads in the same tab reuse them. An uncertain
response locks cart/coupon editing until retry confirms the result. After a
confirmed validation failure, **Change checkout details** explicitly allows a
new attempt. Keep the tab open while resolving an uncertain checkout.

Admin controls are labeled **demo-only**: the endpoints are unauthenticated.
The generation panel retains codes generated during that page session; the API
does not list old coupons, so a page reload cannot recover older codes.

## Configuration

Backend configuration can be exported or placed in a root `.env` for the server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Express port; keep 3000 for the supplied Vite proxy |
| `DATABASE_PATH` | `data/checkout.sqlite` | Database file; see script/.env distinction above |
| `COUPON_EVERY_N_ORDERS` | `5` | Positive safe integer order interval |
| `COUPON_DISCOUNT_PERCENT` | `10` | Integer percentage from 1 through 100 |

Invalid coupon configuration stops app creation. Configuration is read at app
startup; restart to change it. Milestones are order-count thresholds `N, 2N,
3N, ...`. Generation is explicit through the admin endpoint, not automatic at
checkout. Existing coupons retain their stored discount rate. Keep `N` stable:
changing it reinterprets historical eligibility and can unlock extra thresholds.

## API reference

Base URL: `http://127.0.0.1:3000`. Send `Content-Type: application/json` for JSON
bodies. Examples are illustrative response snapshots; IDs, times, codes, and
inventory depend on stored data. `created_at` uses SQLite UTC timestamp text.
IDs and quantities must be positive safe integers; body IDs must be JSON numbers.

### GET /health

Request: `GET /health` (no body). **200**:

```json
{"status":"ok","message":"Checkout & Rewards API is running"}
```

### GET /products

Request: `GET /products` (no body). **200**, seeded catalog before purchases:

```json
[
  {"id":1,"name":"Notebook","price_cents":599,"inventory":50},
  {"id":2,"name":"Pen Set","price_cents":899,"inventory":30},
  {"id":3,"name":"Coffee Mug","price_cents":1299,"inventory":20},
  {"id":4,"name":"Tote Bag","price_cents":1599,"inventory":10},
  {"id":5,"name":"Limited Edition Print","price_cents":2499,"inventory":1}
]
```

### POST /carts

Request: `POST /carts` (no body required). **201**:

```json
{"id":6,"status":"open","created_at":"2026-10-18 09:00:00","items":[],"subtotal_cents":0}
```

### GET /carts/:id

Request: `GET /carts/6` (no body). **200**, after adding two notebooks:

```json
{
  "id":6,"status":"open","created_at":"2026-10-18 09:00:00",
  "items":[{"product_id":1,"product_name":"Notebook","quantity":2,"unit_price_cents":599,"line_total_cents":1198}],
  "subtotal_cents":1198
}
```

Status is `open` or `checked_out`. Cart totals always use current product prices.

### POST /carts/:id/items

Request: `POST /carts/6/items`:

```json
{"product_id":1,"quantity":2}
```

**200** returns the complete cart, with exactly the fields shown under
`GET /carts/:id`. For an initially empty cart, the response is that two-notebook
example. Adding an existing product increments its quantity. Stock is not
checked or deducted here.

### PATCH /carts/:id/items/:productId

Request: `PATCH /carts/6/items/1`:

```json
{"quantity":3}
```

**200**, sets the exact quantity:

```json
{
  "id":6,"status":"open","created_at":"2026-10-18 09:00:00",
  "items":[{"product_id":1,"product_name":"Notebook","quantity":3,"unit_price_cents":599,"line_total_cents":1797}],
  "subtotal_cents":1797
}
```

Zero is invalid; use DELETE to remove an item.

### DELETE /carts/:id/items/:productId

Request: `DELETE /carts/6/items/1` (no body). **200**, if it was the only item:

```json
{"id":6,"status":"open","created_at":"2026-10-18 09:00:00","items":[],"subtotal_cents":0}
```

PATCH/DELETE return `404 ITEM_NOT_FOUND` if a known product is not in the cart.
All item mutations require an open cart.

### POST /carts/:id/checkout

Required header: `Idempotency-Key`, a nonblank string of at most 200 characters.
Request without coupon:

```http
POST /carts/6/checkout
Content-Type: application/json
Idempotency-Key: demo-cart-6-attempt-1

{}
```

Request with a generated, available coupon (use the actual returned code):

```json
{"coupon_code":"550e8400-e29b-41d4-a716-446655440000"}
```

`coupon_code`, if supplied, must be a nonblank string of at most 200 characters.
The API matches it exactly and case-sensitively. The UI trims entered codes.
Unknown body fields are rejected. Omitted body and `{}` are equivalent.

**201** for a new order, illustrated with two notebooks and a 10% coupon:

```json
{
  "id":6,"cart_id":6,"subtotal_cents":1198,"discount_cents":120,"total_cents":1078,
  "created_at":"2026-10-18 09:01:00",
  "coupon_code":"550e8400-e29b-41d4-a716-446655440000","coupon_discount_percent":10,
  "items":[{"order_id":6,"product_id":1,"product_name":"Notebook","quantity":2,"unit_price_cents":599,"line_total_cents":1198}]
}
```

Without a coupon, `discount_cents` is zero, `total_cents` equals subtotal, and
both coupon fields are `null`. An identical successful retry returns **200**
with the original order, without another inventory deduction or redemption.
Reusing a key for another cart or payload returns **409 IDEMPOTENCY_CONFLICT**.
A different key cannot create a second order for a checked-out cart.
Failed transactions do not save a key; retry them with the same key/payload.

### GET /orders/:id

Request: `GET /orders/6` (no body). **200** returns the complete order JSON shown
above. Item names/prices are stored snapshots; later product changes do not
alter them. The stored order discount and linked coupon explain the total.

### POST /admin/coupons/generate

Request: `POST /admin/coupons/generate` (no body). **200**, after the fifth
successful order with default configuration:

```json
{
  "successful_orders":5,"eligible_milestones":1,"already_rewarded_count":0,"generated_count":1,
  "coupons":[{"id":1,"code":"550e8400-e29b-41d4-a716-446655440000","milestone":5,
    "discount_percent":10,"status":"available","redeemed_order_id":null}]
}
```

Before the first eligible milestone, `generated_count` is zero and `coupons`
is empty. Repeating the example without new orders returns:

```json
{"successful_orders":5,"eligible_milestones":1,"already_rewarded_count":1,"generated_count":0,"coupons":[]}
```

Generation fills every eligible missing threshold, including historical ones.
Counts of eligible/already rewarded milestones refer to the current `N`.

### GET /admin/reports/summary

Request: `GET /admin/reports/summary` (no body). **200**, example with six orders
of two notebooks each, one using a 120-cent discount:

```json
{
  "total_orders":6,
  "purchased_quantity_by_product":[{"product_id":1,"quantity":12}],
  "gross_revenue_cents":7188,"total_discounts_cents":120,"net_revenue_cents":7068,
  "coupons":{"generated":1,"available":0,"redeemed":1}
}
```

All stored orders count as successful. The report is read-only and uses one
committed database snapshot. Gross minus discounts equals net. Purchased
quantities come from order items, not current carts or product inventory.
An empty database returns zero totals/counts and an empty product-quantity list.

### Errors

Errors use the same envelope:

```json
{"error":{"code":"INSUFFICIENT_STOCK","message":"Insufficient inventory for product 5."}}
```

| HTTP | Codes / conditions |
| --- | --- |
| 400 | `INVALID_INPUT`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_JSON`, `TOTAL_OUT_OF_RANGE` |
| 404 | `CART_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ITEM_NOT_FOUND`, `ORDER_NOT_FOUND`, `COUPON_NOT_FOUND`, `NOT_FOUND` |
| 409 | `CART_CLOSED`, `EMPTY_CART`, `INSUFFICIENT_STOCK`, `COUPON_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT` |
| 413 | `BODY_TOO_LARGE` |
| 503 | `DATABASE_BUSY` (lock timeout), `REPORT_OUT_OF_RANGE` (unsafe aggregate integer) |
| 500 | `INTERNAL_ERROR` (unexpected failure; details are not returned) |

On timeout, network failure, unreadable response, or 5xx, preserve the checkout
key and payload when retrying: the client may not know whether commit succeeded.

## Tests and build

```sh
npm test                     # backend API/concurrency and frontend state tests
npm run typecheck            # backend and tests
npm run typecheck:frontend   # React/Vite TypeScript
npm run build:frontend       # frontend typecheck + production build
```

The suite has 46 tests covering carts, validation, totals, checkout snapshots,
idempotency, stock, coupons, rollback, reports, and frontend retry state/currency.
API tests create temporary databases and pass an explicit `DATABASE_PATH` to
setup/seed and child servers. Competition tests use separate processes sharing
a test file; both requests arrive while a third connection holds the write lock.
They cover the last inventory unit, one cart, one key, one coupon, and generation.
Local socket permissions are required. Tests do not use the development database.

The project owner reports manual browser verification of Store, Cart, Checkout,
coupon generation/redemption, and Admin reporting. There is no automated browser
E2E or visual regression suite; frontend unit tests cover state helpers, not DOM
interactions. See the AI usage history in [DECISIONS.md](DECISIONS.md).

## Known limitations

- All endpoints, including admin and order retrieval, lack authentication,
  authorization, and rate limiting. Use this as a local demo.
- `DatabaseSync` blocks the event loop, including during lock waits. SQLite has
  one writer per database; large generation/report scans limit throughput.
- Cart totals can change before checkout; there are no reservations, expirations,
  taxes, shipping, refunds, real payment processing, or multiple currencies.
- Coupons are globally unlocked, transferable, single-use, and have no customer
  association or expiry. Old coupon codes have no listing endpoint.
- Successful idempotency records have no expiry/cleanup. Cart contents are not
  part of the request fingerprint; a failed checkout can see later cart changes.
- JavaScript-safe integer bounds apply to API money/quantities; reports fail
  explicitly if aggregates exceed them. SQL constraints do not impose that same
  upper bound on writes made outside the API.
- Schema setup is a small rerunnable initializer, not a general migration system.
  Direct SQL changes can bypass application-level cross-table invariants.
- Browser state is per tab; closing it loses the retry context. No cross-device
  recovery or general order-history screen exists.
- `frontend/dist/` is a static build. The Vite proxy is development-only;
  production needs static hosting plus a same-origin `/api/*` reverse proxy.
  No production deployment, backups, monitoring, or recovery workflow is configured.
