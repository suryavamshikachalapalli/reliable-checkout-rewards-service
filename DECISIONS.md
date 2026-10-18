# Engineering decisions

This describes the implementation in `src/app.ts`, `src/routes/`, `src/services/`,
`src/http.ts`, `src/db/`, `frontend/src/`, and `tests/`. `app.ts` configures Express,
registers routes, and formats errors. Routes handle HTTP requests; services own
checkout and coupon generation logic. `http.ts` shares the existing API error and
validation helpers. Production changes below are proposals, not implemented features.

## System invariants

| Invariant | Enforcement |
| --- | --- |
| Products have nonnegative integer prices and inventory; item quantities are positive integers | SQLite STRICT tables, NOT NULL/CHECK constraints; API safe-integer checks |
| A cart contains at most one row per product | Composite cart-item primary key; POST adds to the existing quantity |
| Only open carts can be changed or checked out | Status check inside the write transaction |
| A cart produces at most one order | Status/order-existence checks plus UNIQUE `orders.cart_id` |
| A successful checkout has its complete inventory, order, item, coupon, key, and cart changes committed together | One `BEGIN IMMEDIATE` transaction |
| Order item names/prices/quantities and monetary totals describe the purchase | Snapshot columns; no order-edit API |
| Each successful idempotency key refers to one cart/request/order | Key primary key plus cart ID and SHA-256 fingerprint comparison |
| A milestone and a code each identify at most one coupon | Separate UNIQUE constraints on `milestone` and `code` |
| A coupon is available with no order reference, or redeemed with an order reference | Coupon status/reference CHECK and foreign key |
| At most one coupon is redeemed for an order | Unique partial index on non-null `coupons.redeemed_order_id` |
| Order total equals subtotal minus a nonnegative discount no larger than subtotal | CHECK constraints and safe arithmetic |
| Report net equals gross minus discounts | Aggregation of stored orders in one read snapshot |

Foreign keys are enabled on the application connection. SQL inputs are bound
parameters. Foreign keys protect referenced products, carts, and orders from
invalid references; no cascading deletion policy is configured.

Some invariants depend on the application transaction, not SQL alone. The schema
does not prove that order subtotals equal the sum of order items, that a checkout
record's cart matches its referenced order, or that a closed cart has an order.
Tests deliberately exercise damaged data; direct SQL administrators must preserve
these relationships. SQL integers can also exceed JavaScript-safe bounds.

## Checkout transaction flow

1. Validate cart ID, the required nonblank key (maximum 200 characters), and that
   the JSON body is an object. Sort top-level payload keys and hash its JSON.
2. Acquire the write transaction with `BEGIN IMMEDIATE` before database reads.
3. Look up the key **before** checking cart status or coupon availability. An
   identical completed request returns the original order with HTTP 200; a
   mismatching cart or payload returns 409.
4. Validate supported fields and any coupon code. Check that the cart exists,
   is open, and has no order. Check that a supplied coupon exists and is available.
5. Load cart items with current products, require at least one item, and validate
   product existence, positive safe quantities, current prices, and stock.
6. Compute safe line/subtotal values, rounded coupon discount, and nonnegative total.
7. Insert the order. If using a coupon, conditionally change it from available to
   redeemed and attach its order ID; require one changed row.
8. Deduct each product's inventory and insert all order-item snapshots.
9. Save the successful key/cart/hash/order record and mark the cart `checked_out`.
10. Read the completed order, commit, then return HTTP 201.

Failures within the transaction roll it back if it is still active. If BEGIN
itself fails to acquire the lock, no transaction or data changes were started.
Validation failures before BEGIN also have no database effects. No payment call
or other external side effect occurs inside checkout. A committed order is the
demo's payment-success record.

## Idempotency semantics

The key namespace is global, not per cart/user, and keys are compared exactly.
The fingerprint is SHA-256 of JSON with sorted top-level keys. The cart ID is
stored and compared separately. Empty body and `{}` are equivalent. The only
accepted optional field is `coupon_code`; absent and supplied values differ.
Changing a coupon with an already successful key produces 409, even if the new
coupon is invalid, because replay checking comes first.

Only successful requests persist a key. Failed transactions leave no pending or
failed record and can be retried with the same key. Identical successful retries
use stored order snapshots and do not recheck inventory, prices, or coupon status.
A new key for an already ordered cart is rejected, rather than silently replaying
an order associated with a different request.

The fingerprint does not include cart items or product prices. Before success,
a retry sees the latest cart and catalog state. It is not a frozen price quote.
Nested canonicalization is unnecessary for the accepted payload (one optional
string); unsupported fields are rejected on new requests. Keys have no expiry.

The UI persists its key and exact request in tab-scoped `sessionStorage` before
sending. It disables submission while pending and locks editing after uncertain
responses. Explicitly changing details after selected confirmed validation
failures clears the attempt; the next submission creates a new UUID. Closing the
tab loses this context. This client behavior complements database enforcement;
it is not the source of server-side correctness.

## Inventory concurrency

Cart operations never reserve stock. Checkout acquires SQLite's write lock before
reading quantities and inventory, holds it through all deductions, and releases
it only on commit/rollback. Competing writers on the same database file wait,
then read the preceding committed state. Thus the second checkout for the last
unit sees insufficient stock, and a second checkout for the same cart sees it
closed. Nonnegative inventory CHECK constraints provide another guard.

WAL allows readers alongside a writer but still permits only one writer. The
connection's 5-second busy timeout bounds waiting; lock errors become HTTP 503.
`DatabaseSync` blocks its Node thread during SQL and waits, so simultaneous HTTP
requests to one process are not evidence of concurrent SQL execution. Tests use
two child servers/connections, with both requests received while a third
connection holds the write lock, before releasing it.

This design requires the **same local database file**. Independent copies do not
coordinate inventory. WAL is not a distributed shared-storage mechanism; see
[SQLite WAL documentation](https://www.sqlite.org/wal.html).

## Coupons

Every stored order counts as a global success. With interval `N`, eligible
milestones are `N, 2N, ... floor(orderCount/N)*N`. Generation is an explicit admin
operation inside `BEGIN IMMEDIATE`, so its count and inserts are serialized with
checkout and other generators. It attempts every eligible threshold, uses UUID
codes, and ignores milestone conflicts. Code uniqueness is also enforced; a code
collision would fail and roll back rather than create duplicates.

Generation returns new coupon rows and counts of orders, eligible milestones,
already rewarded milestones, and new coupons. Redemption does not make a
milestone eligible again. Configuration is validated at app startup: `N` must be
a positive safe integer and discount a whole percentage from 1 to 100. Each
coupon stores its generation-time rate, independent of later configuration.
Changing `N` can reward additional historical thresholds; no policy-version
migration is implemented.

One supplied code identifies one global single-use coupon. Lookup, availability
check, conditional redemption, order creation, and stock deduction all share the
checkout transaction. Another writer cannot redeem that coupon between the check
and update. Failures, including a late key-insert failure, restore the coupon to
available along with all other changes. An identical replay checks the key first
and returns the completed order instead of rejecting its now-redeemed coupon.

No new order coupon column was necessary: `coupons.redeemed_order_id` already
stores the reference, the coupon stores its rate/code, and `orders.discount_cents`
stores the actual applied amount. Order retrieval joins that reference. The small
migration adds a unique partial index for one coupon per order. Repeated setup
preserves data; pre-existing duplicate references cause failure, not silent repair.
Product snapshots are immutable through the API. Coupon code/rate history depends
on the linked coupon remaining unchanged; no API edits or deletes these fields.

## Money and reports

All prices and amounts are integer cents. Line totals use integer-valued Number
multiplication and subtotal addition, with `Number.isSafeInteger` checks after
each operation. Values outside `0..9,007,199,254,740,991` are rejected. Checkout
reads SQLite integers as BigInt before checked conversion to avoid silently
rounding oversized stored values. No fractional currency units are used in these
operations.

For a nonnegative subtotal `S` and integer percentage `P`, discount is:

```text
discount_cents = (BigInt(S) * BigInt(P) + 50n) / 100n
total_cents = S - discount_cents
```

BigInt division truncates, giving deterministic half-up rounding: 5 cents at 10%
becomes a 1-cent discount; 4 cents becomes 0; 1,198 cents becomes 120. Rounding
occurs once on the order subtotal, not per line. A 100% coupon can yield a zero
total, never a negative one. BigInt prevents percentage multiplication overflow
near the Number bound. The frontend formats cents using BigInt quotient/remainder.

Reports start a read transaction, sum stored order amounts and purchased item
quantities using BigInt, and count coupon states in the same committed snapshot.
This avoids floating-point aggregate errors and SQLite integer SUM overflow.
JSON responses use safe Numbers; oversized aggregates produce 503
`REPORT_OUT_OF_RANGE`. Reports scan all orders/items and load rows into memory,
which is deliberately simple but not appropriate for large reporting workloads.

## Error model

Expected failures throw an HTTP status, stable code, and useful message. Middleware
returns `{ "error": { "code": "...", "message": "..." } }`; the README lists
codes. Invalid input is 400, missing resources 404, state/stock/key conflicts 409,
oversized bodies 413, and lock/report-range failures 503. Unexpected failures are
500 with a generic message. JSON parser failures use the same envelope. Invalid
startup configuration throws before the server starts rather than an HTTP error.

A response lost after commit is uncertain to the client. Retrying the same key
resolves it. There is no claim of exactly-once network delivery or external
payment processing. The application does not currently add structured server
error logging, request tracing, or automatic retry/backoff.

## Decisions and alternatives

| Decision | Alternatives considered | Rationale and tradeoff |
| --- | --- | --- |
| Built-in SQLite with direct parameterized SQL | PostgreSQL from day one; ORM; third-party SQLite driver | No database service or new backend dependency; constraints and transaction boundaries stay visible. Synchronous execution and a single writer limit scale. |
| Acquire `BEGIN IMMEDIATE` before checkout reads | Deferred transaction; process-local mutex; separate read/check/update requests | Database locking protects separate connections/processes and avoids a read-to-write upgrade race. It serializes even unrelated writes. |
| Validate stock at checkout | Reserve inventory when adding to cart | Avoids abandoned-cart reservations and expiry cleanup. An item in a cart is not a stock guarantee. |
| Persist successful idempotency records atomically | In-memory key cache; record key after commit; persist all failures | Survives process restart and closes the order/key commit gap. Failed attempts are not retained and keys have no cleanup policy. |
| Store purchase item snapshots | Join current product names/prices for orders | Historical purchases remain explainable after catalog changes, at the cost of duplicated data. |
| Store cents and use BigInt for percentage rounding | Floating-point currency; decimal library | Exact cent rounding without a dependency. API Numbers still require safe bounds; SQL alone allows larger integers. |
| Explicit admin generation and unique count thresholds | Generate on every checkout; scheduled job; per-user rewards | Keeps checkout focused and makes missed milestones recoverable. Generation is manual and rewards are global. |
| Reuse the existing coupon-to-order reference | Add an order coupon column or redemption table | The current one-coupon/one-order relationship fits existing fields plus a unique index. Stacking, edit history, or complex promotions would justify a redemption ledger. |
| Read-snapshot report from source records | Cached counters; precomputed aggregates | Straightforward reconciliation without drift. Full scans and memory use grow with data. |
| React local state, tab storage, and Vite proxy | Global state/routing libraries; backend CORS changes | Meets three-section local-demo needs with few dependencies. No cross-tab/device recovery or production proxy is provided. |

## Limitations and deferred features

This is a local assignment demo. Authentication, cart/order ownership, admin
access control, rate limiting, real payments, refunds, tax, shipping, reservations,
customer-bound coupons, coupon expiry/listing, multiple currencies, pagination,
and production hosting are deferred. Coupon interval changes have no historical
policy migration. There is no general migration/versioning framework, backup and
restore procedure, monitoring, durable job queue, or idempotency retention policy.

Tests cover application behavior and several overlapping write races, not every
schedule or crash scenario. Frontend tests cover pure state helpers/currency,
not browser DOM flows. The project owner reports manually verifying Store, Cart,
Checkout, generation, redemption, and Admin reports. That report is separate from
Codex's automated checks; no independent automated visual/browser verification
is claimed.

## Evolution to multiple production instances with PostgreSQL

The following is a proposed migration, not current behavior:

1. Move persistent state to one shared PostgreSQL service and use an asynchronous
   client with bounded connection pools. Preserve keys, foreign keys, unique cart
   orders, milestone/code uniqueness, coupon reference uniqueness, and CHECKs.
   Use BIGINT cents with explicit safe serialization or decimal-string API fields;
   preserve IDs, snapshots, discounts, and successful idempotency records during
   a rehearsed, validated data migration.
2. Replace the SQLite-wide write lock with transactional row locks. Lock the cart
   (including on cart mutations), coupon, and product rows in a consistent order;
   use guarded inventory decrements such as `UPDATE ... WHERE inventory >= ...`
   and check affected rows. Different products/carts can then proceed independently.
   See [PostgreSQL row locking](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).
3. Claim each idempotency key transactionally with a unique insert before effects.
   Concurrent attempts must wait for or resolve that claim and compare both cart
   and hash. PostgreSQL uniqueness errors abort a transaction unless handled using
   an appropriate conflict clause/savepoint; do not catch and continue blindly.
   Keep the successful order and claim in the same commit.
4. Coordinate global reward progress using a locked counter/ledger row, or a
   serialized generation job with unique milestone inserts. A PostgreSQL sequence
   is not a successful-order counter: rollbacks can leave gaps. Define policy
   versioning before allowing interval changes. Uniqueness remains the backstop
   when generation runs on multiple instances.
5. Retry complete transactions on deadlock/serialization failures with bounded
   backoff, preserving request keys. Use a repeatable-read report transaction or
   one aggregate query so separate report queries do not see different commits.
   PostgreSQL's default read-committed isolation does not give a single snapshot
   across all statements. See [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).
6. Add authenticated ownership and admin permissions, proper migrations, backups,
   observability, deployment health checks, and production static/API hosting.
   Real payment integration needs a separate payment state machine, provider
   idempotency, webhook reconciliation, and a transactional outbox for external
   effects; holding database locks during a network payment call is unsuitable.

SQL and transaction handling would change materially; swapping the connection
constructor is insufficient. Preserve API semantics where practical, and rerun
multi-process races against a real PostgreSQL service before deployment.

## AI usage and verification history

**ChatGPT helped with planning, prompts, and review. Codex generated implementation
code and tests, and now the documentation.** The implementation is not claimed to
have been manually written. Automated tests are evidence of checked scenarios,
not independent human verification of all generated code.

Supported examples of reviewed or corrected AI work from this project's history:

- The initial implementation exposed an existing TypeScript 7 configuration
  incompatibility (`moduleResolution: Node`). Codex first checked with temporary
  flags; after the owner's request, it updated both module settings to `Node16`
  in `tsconfig.json` and reran the normal typecheck successfully.
- Coupon implementation reviewed the existing schema before adding fields. It
  reused `coupons.redeemed_order_id` and `orders.discount_cents`, adding a unique
  index instead of redundant order coupon columns. Tests exercise that migration
  on existing data and verify one coupon per order.
- Frontend retry handling was checked with generated tests for key reuse after
  reload, exact payload reuse, explicit new attempts, and safe cent formatting.
  This is automated helper coverage, not a browser E2E claim.
- An agent-created proxy smoke test incorrectly reached an already-running
  development backend instead of its temporary backend. It created two test
  carts and one order. Codex identified and removed those specific records and
  restored three inventory units, added port-occupancy checks to the temporary
  harness, then used a read-only proxy check. This was a real test-isolation
  mistake, not a successful isolated mutation test.

The owner subsequently reported manual browser verification of the application
flows. Documentation distinguishes that owner report from agent-run tests and
builds. No invented manual authorship, corrections, independent audits, load
benchmarks, or production-readiness claims are made.
