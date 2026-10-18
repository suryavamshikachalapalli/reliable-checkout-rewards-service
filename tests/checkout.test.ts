import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { createApp } from '../src/app';

const directory = mkdtempSync(join(tmpdir(), 'checkout-orders-'));
const databasePath = join(directory, 'test.sqlite');
let db: DatabaseSync;
let app: ReturnType<typeof createApp>;
beforeAll(() => {
  for (const file of ['src/db/setup.ts', 'src/db/seed.ts']) {
    execFileSync(process.execPath, ['--import', 'tsx', file], { env: { ...process.env, DATABASE_PATH: databasePath } });
  }
  db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  app = createApp(db);
});
beforeEach(() => {
  vi.stubEnv('COUPON_EVERY_N_ORDERS', '5');
  vi.stubEnv('COUPON_DISCOUNT_PERCENT', '10');
  app = createApp(db);
  db.exec(`DELETE FROM coupons; DELETE FROM checkout_requests; DELETE FROM order_items; DELETE FROM orders;
    DELETE FROM cart_items; DELETE FROM carts;
    UPDATE products SET inventory=50, price_cents=599, name='Notebook' WHERE id=1;
    UPDATE products SET inventory=1 WHERE id=5;`);
});
afterAll(() => { vi.unstubAllEnvs(); db?.close(); rmSync(directory, { recursive: true, force: true }); });

function cart(productId = 1, quantity = 2) {
  const id = Number(db.prepare('INSERT INTO carts DEFAULT VALUES').run().lastInsertRowid);
  if (quantity) db.prepare('INSERT INTO cart_items VALUES (?, ?, ?)').run(id, productId, quantity);
  return id;
}
function checkout(id: number, key = 'test-key', body: object = {}) {
  return request(app).post(`/carts/${id}/checkout`).set('Idempotency-Key', key).send(body);
}
function state() {
  return ['products', 'carts', 'cart_items', 'orders', 'order_items', 'checkout_requests', 'coupons']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}

it('checks out using current prices, records payment success, and returns immutable order snapshots', async () => {
  const id = cart();
  db.exec("UPDATE products SET price_cents=601, name='New Notebook' WHERE id=1");
  const { body } = await checkout(id).expect(201);
  expect(body).toMatchObject({ cart_id: id, subtotal_cents: 1202, discount_cents: 0, total_cents: 1202 });
  expect(body.items[0]).toMatchObject({ product_id: 1, product_name: 'New Notebook', quantity: 2, unit_price_cents: 601, line_total_cents: 1202 });
  expect(db.prepare('SELECT inventory FROM products WHERE id=1').get()?.inventory).toBe(48);
  expect(db.prepare('SELECT status FROM carts WHERE id=?').get(id)?.status).toBe('checked_out');
  expect(db.prepare('SELECT order_id FROM checkout_requests').get()?.order_id).toBe(body.id);
  db.exec("UPDATE products SET price_cents=999, name='Changed' WHERE id=1");
  expect((await request(app).get(`/orders/${body.id}`).expect(200)).body).toEqual(body);
  const before = state();
  expect((await checkout(id).expect(200)).body).toEqual(body);
  expect((await request(app).post(`/carts/${id}/checkout`).set('Idempotency-Key', 'test-key').expect(200)).body).toEqual(body);
  expect(state()).toEqual(before);
});

it('rejects conflicting carts and payloads, and different keys for a checked-out cart', async () => {
  const id = cart();
  const other = cart();
  await checkout(id).expect(201);
  const before = state();
  for (const operation of [checkout(other), checkout(id, 'test-key', { coupon_code: 'X' }), checkout(id, 'test-key', { extra: true })]) {
    const { body } = await operation.expect(409);
    expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  }
  expect((await checkout(id, 'other-key').expect(409)).body.error.code).toBe('CART_CLOSED');
  expect(state()).toEqual(before);
});

it('requires bounded nonblank keys and validates coupons and rejects unsupported fields without writes', async () => {
  const id = cart();
  const before = state();
  await request(app).post(`/carts/${id}/checkout`).send({}).expect(400);
  for (const key of ['', '   ', 'x'.repeat(201)]) {
    expect((await checkout(id, key).expect(400)).body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  }
  expect((await checkout(id, 'unused', { coupon_code: 'SAVE' }).expect(404)).body.error.code).toBe('COUPON_NOT_FOUND');
  for (const coupon_code of ['', null]) {
    expect((await checkout(id, 'unused', { coupon_code }).expect(400)).body.error.code).toBe('INVALID_INPUT');
  }
  await checkout(id, 'unused', { extra: true }).expect(400);
  expect(state()).toEqual(before);
  await checkout(id, 'unused').expect(201);
});

it('rejects empty, missing and closed carts without writes', async () => {
  const empty = cart(1, 0);
  const closed = cart();
  db.prepare("UPDATE carts SET status='checked_out' WHERE id=?").run(closed);
  const before = state();
  expect((await checkout(empty).expect(409)).body.error.code).toBe('EMPTY_CART');
  expect((await checkout(999).expect(404)).body.error.code).toBe('CART_NOT_FOUND');
  expect((await checkout(closed).expect(409)).body.error.code).toBe('CART_CLOSED');
  await request(app).get('/orders/999').expect(404);
  await request(app).get('/orders/nope').expect(400);
  expect(state()).toEqual(before);
});

it('rejects insufficient inventory atomically and allows retry after replenishment', async () => {
  const id = cart();
  db.prepare('INSERT INTO cart_items VALUES (?, 5, 2)').run(id);
  const before = state();
  expect((await checkout(id).expect(409)).body.error.code).toBe('INSUFFICIENT_STOCK');
  expect(state()).toEqual(before);
  db.exec('UPDATE products SET inventory=2 WHERE id=5');
  await checkout(id).expect(201);
});

it('detects missing products even in a damaged database', async () => {
  const id = cart();
  db.exec('PRAGMA foreign_keys=OFF; DELETE FROM products WHERE id=1; PRAGMA foreign_keys=ON');
  const before = state();
  expect((await checkout(id).expect(404)).body.error.code).toBe('PRODUCT_NOT_FOUND');
  expect(state()).toEqual(before);
  // Restore the fixture for later tests.
  db.exec("INSERT INTO products VALUES (1, 'Notebook', 599, 50)");
});

it('rejects unsafe line totals, subtotal sums, and SQLite integers without writes', async () => {
  const id = cart();
  db.prepare('UPDATE products SET price_cents=? WHERE id=1').run(Number.MAX_SAFE_INTEGER);
  let before = state();
  expect((await checkout(id).expect(400)).body.error.code).toBe('TOTAL_OUT_OF_RANGE');
  expect(state()).toEqual(before);
  db.prepare('UPDATE cart_items SET quantity=1 WHERE cart_id=?').run(id);
  db.prepare('INSERT INTO cart_items VALUES (?, 5, 1)').run(id);
  before = state();
  expect((await checkout(id).expect(400)).body.error.code).toBe('TOTAL_OUT_OF_RANGE');
  expect(state()).toEqual(before);
  db.exec('UPDATE products SET price_cents=9007199254740992 WHERE id=1');
  expect((await checkout(id).expect(400)).body.error.code).toBe('TOTAL_OUT_OF_RANGE');
  expect(db.prepare('SELECT count(*) AS n FROM orders').get()?.n).toBe(0);
});

it('rolls back inventory, order and snapshots when a late database write fails', async () => {
  const id = cart();
  db.exec("CREATE TRIGGER fail_checkout BEFORE INSERT ON checkout_requests BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const before = state();
  try {
    expect((await checkout(id).expect(500)).body.error.code).toBe('INTERNAL_ERROR');
    expect(state()).toEqual(before);
  } finally { db.exec('DROP TRIGGER fail_checkout'); }
  await checkout(id).expect(201);
});

it('returns a retryable error when the write lock times out, without leaving a transaction open', async () => {
  const id = cart();
  const competing = new DatabaseSync(databasePath);
  competing.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1');
  const otherApp = createApp(competing);
  const before = state();
  db.exec('BEGIN IMMEDIATE');
  try {
    const { body } = await request(otherApp).post(`/carts/${id}/checkout`)
      .set('Idempotency-Key', 'busy-key').send({}).expect(503);
    expect(body.error.code).toBe('DATABASE_BUSY');
    expect(competing.isTransaction).toBe(false);
  } finally {
    db.exec('ROLLBACK');
    competing.close();
  }
  expect(state()).toEqual(before);
  await checkout(id, 'busy-key').expect(201);
});

function message(child: ChildProcess, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, 5000);
    const receive = (value: any) => { if (value.type === type) { cleanup(); resolve(value); } };
    const exit = () => { cleanup(); reject(new Error('Test server exited unexpectedly')); };
    function cleanup() { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); }
    child.on('message', receive); child.on('exit', exit);
  });
}

it.each(['last-product', 'same-cart', 'same-key', 'same-coupon', 'generation'])('serializes genuinely overlapping checkout requests: %s', async scenario => {
  if (scenario === 'generation') await successfulOrders(5);
  const first = cart(5, 1);
  const second = scenario === 'last-product' || scenario === 'same-coupon' ? cart(5, 1) : first;
  if (scenario === 'same-coupon') {
    db.exec("UPDATE products SET inventory=2 WHERE id=5; INSERT INTO coupons (code,milestone,discount_percent) VALUES ('RACE',5,10)");
  }
  const children = [0, 1].map(() => fork('tests/helpers/checkout-server.ts', [], {
    execArgv: ['--import', 'tsx'], env: { ...process.env, DATABASE_PATH: databasePath }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  }));
  try {
    const ready = await Promise.all(children.map(child => message(child, 'ready')));
    // Hold the write lock until both independent servers have received their requests.
    db.exec('BEGIN IMMEDIATE');
    const arrived = children.map(child => message(child, 'arrived'));
    const pending = ready.map(({ port }, index) => fetch(`http://127.0.0.1:${port}${scenario === 'generation' ? '/admin/coupons/generate' : `/carts/${index ? second : first}/checkout`}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': scenario === 'same-key' ? 'shared' : `race-${index}` }, body: scenario === 'same-coupon' ? JSON.stringify({ coupon_code: 'RACE' }) : '{}',
    }));
    await Promise.all(arrived);
    db.exec('COMMIT');
    const responses = await Promise.all(pending);
    expect(responses.map(r => r.status).sort()).toEqual(scenario === 'generation' ? [200, 200] : scenario === 'same-key' ? [200, 201] : [201, 409]);
    const bodies = await Promise.all(responses.map(r => r.json()));
    if (scenario === 'generation') {
      expect(bodies.map(body => body.generated_count).sort()).toEqual([0, 1]);
      expect(db.prepare('SELECT count(*) AS n FROM coupons').get()?.n).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM orders').get()?.n).toBe(5);
      return;
    }
    if (scenario === 'same-key') expect(bodies[0]).toEqual(bodies[1]);
    else expect(bodies.find(body => body.error)?.error.code).toBe(scenario === 'last-product' ? 'INSUFFICIENT_STOCK' : scenario === 'same-coupon' ? 'COUPON_UNAVAILABLE' : 'CART_CLOSED');
    expect(db.prepare('SELECT inventory FROM products WHERE id=5').get()?.inventory).toBe(scenario === 'same-coupon' ? 1 : 0);
    if (scenario === 'same-coupon') {
      expect(db.prepare("SELECT count(*) AS n FROM coupons WHERE status='redeemed'").get()?.n).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM carts WHERE status='open'").get()?.n).toBe(1);
    }
    expect(db.prepare('SELECT count(*) AS n FROM orders').get()?.n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM checkout_requests').get()?.n).toBe(1);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve()); child.kill();
    })));
  }
}, 15000);

async function successfulOrders(count: number) {
  for (let index = 0; index < count; index++) {
    const id = cart(1, 1);
    await checkout(id, `order-${id}`).expect(201);
  }
}

function coupon(code = 'SAVE', percent = 10, milestone = 5) {
  db.prepare('INSERT INTO coupons (code, milestone, discount_percent) VALUES (?, ?, ?)').run(code, milestone, percent);
}

it('unlocks coupons at N, 2N, ... and generates all missing milestones without duplicates', async () => {
  let result = await request(app).post('/admin/coupons/generate').expect(200);
  expect(result.body).toMatchObject({ successful_orders: 0, eligible_milestones: 0, generated_count: 0, coupons: [] });
  await successfulOrders(4);
  result = await request(app).post('/admin/coupons/generate').expect(200);
  expect(result.body.generated_count).toBe(0);
  await successfulOrders(1);
  result = await request(app).post('/admin/coupons/generate').expect(200);
  expect(result.body).toMatchObject({ successful_orders: 5, eligible_milestones: 1, already_rewarded_count: 0, generated_count: 1 });
  expect(result.body.coupons[0]).toMatchObject({ milestone: 5, discount_percent: 10, status: 'available', redeemed_order_id: null });
  expect(result.body.coupons[0].code).toEqual(expect.any(String));
  await successfulOrders(10);
  result = await request(app).post('/admin/coupons/generate').expect(200);
  expect(result.body.generated_count).toBe(2);
  expect(result.body.coupons.map((c: any) => c.milestone)).toEqual([10, 15]);
  const before = state();
  result = await request(app).post('/admin/coupons/generate').expect(200);
  expect(result.body).toMatchObject({ generated_count: 0, already_rewarded_count: 3, coupons: [] });
  expect(state()).toEqual(before);
});

it('validates configuration at startup and keeps each generated coupon rate when config changes', async () => {
  for (const [name, values] of [
    ['COUPON_EVERY_N_ORDERS', ['0', '-1', '1.5', 'abc', '', '9007199254740992']],
    ['COUPON_DISCOUNT_PERCENT', ['0', '101', '1.5', 'abc', '']],
  ] as const) {
    const original = process.env[name];
    for (const value of values) {
      vi.stubEnv(name, value);
      expect(() => createApp(db)).toThrow(name);
    }
    vi.stubEnv(name, original);
  }
  vi.stubEnv('COUPON_EVERY_N_ORDERS', '2');
  vi.stubEnv('COUPON_DISCOUNT_PERCENT', '25');
  app = createApp(db);
  await successfulOrders(2);
  const { body } = await request(app).post('/admin/coupons/generate').expect(200);
  expect(body.coupons[0]).toMatchObject({ milestone: 2, discount_percent: 25 });
  vi.stubEnv('COUPON_DISCOUNT_PERCENT', '100');
  app = createApp(db);
  const id = cart(1, 1);
  const order = await checkout(id, 'configured', { coupon_code: body.coupons[0].code }).expect(201);
  expect(order.body.discount_cents).toBe(150); // 599 * 25% = 149.75 cents.
});

it.each([
  [4, 10, 0], [5, 10, 1], [15, 10, 2], [99, 100, 99],
  [Number.MAX_SAFE_INTEGER, 10, 900719925474099],
])('rounds %i cents at %i percent to %i cents and preserves coupon retries', async (price, percent, expected) => {
  coupon('SAVE', percent);
  db.prepare('UPDATE products SET price_cents=? WHERE id=1').run(price);
  const id = cart(1, 1);
  const { body } = await checkout(id, 'discount-key', { coupon_code: 'SAVE' }).expect(201);
  expect(body).toMatchObject({ subtotal_cents: price, discount_cents: expected, total_cents: price - expected,
    coupon_code: 'SAVE', coupon_discount_percent: percent });
  expect(db.prepare('SELECT status, redeemed_order_id FROM coupons WHERE code=?').get('SAVE'))
    .toEqual({ status: 'redeemed', redeemed_order_id: body.id });
  const before = state();
  expect((await checkout(id, 'discount-key', { coupon_code: 'SAVE' }).expect(200)).body).toEqual(body);
  for (const payload of [{}, { coupon_code: 'OTHER' }, { coupon_code: null }]) {
    expect((await checkout(id, 'discount-key', payload).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  }
  expect((await request(app).get(`/orders/${body.id}`).expect(200)).body).toEqual(body);
  expect(state()).toEqual(before);
});

it('rejects invalid, unknown and redeemed coupons without writes', async () => {
  coupon();
  const id = cart(1, 1);
  for (const coupon_code of ['', null, 42, ['SAVE'], 'x'.repeat(201)]) {
    await checkout(id, 'invalid', { coupon_code }).expect(400);
  }
  expect((await checkout(id, 'unknown', { coupon_code: 'UNKNOWN' }).expect(404)).body.error.code).toBe('COUPON_NOT_FOUND');
  await checkout(id, 'redeem', { coupon_code: 'SAVE' }).expect(201);
  const other = cart(1, 1);
  const before = state();
  expect((await checkout(other, 'used', { coupon_code: 'SAVE' }).expect(409)).body.error.code).toBe('COUPON_UNAVAILABLE');
  expect(state()).toEqual(before);
});

it('keeps coupons available after insufficient stock and rolls back redemption on late failures', async () => {
  coupon();
  const id = cart(5, 2);
  let before = state();
  await checkout(id, 'rollback', { coupon_code: 'SAVE' }).expect(409);
  expect(state()).toEqual(before);
  db.exec('UPDATE products SET inventory=2 WHERE id=5');
  db.exec("CREATE TRIGGER fail_coupon_checkout BEFORE INSERT ON checkout_requests BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  before = state();
  try {
    await checkout(id, 'rollback', { coupon_code: 'SAVE' }).expect(500);
    expect(state()).toEqual(before);
  } finally { db.exec('DROP TRIGGER fail_coupon_checkout'); }
  await checkout(id, 'rollback', { coupon_code: 'SAVE' }).expect(201);
});

it('reports stored order revenue, discounts, product quantities and coupon counts without writes', async () => {
  const empty = await request(app).get('/admin/reports/summary').expect(200);
  expect(empty.body).toEqual({ total_orders: 0, purchased_quantity_by_product: [], gross_revenue_cents: 0,
    total_discounts_cents: 0, net_revenue_cents: 0, coupons: { generated: 0, available: 0, redeemed: 0 } });
  coupon('SAVE', 10, 5); coupon('NEXT', 20, 10);
  const first = cart(1, 2);
  db.prepare('INSERT INTO cart_items VALUES (?, 2, 3)').run(first);
  await checkout(first, 'report-1', { coupon_code: 'SAVE' }).expect(201);
  await checkout(cart(1, 1), 'report-2').expect(201);
  db.exec("UPDATE products SET price_cents=777, name='Changed' WHERE id=1");
  const before = state();
  const { body } = await request(app).get('/admin/reports/summary').expect(200);
  const expected = db.prepare(`SELECT count(*) AS count, sum(subtotal_cents) AS gross,
    sum(discount_cents) AS discounts, sum(total_cents) AS net FROM orders`).get()!;
  expect(body).toEqual({ total_orders: expected.count, purchased_quantity_by_product: [
    { product_id: 1, quantity: 3 }, { product_id: 2, quantity: 3 },
  ], gross_revenue_cents: expected.gross, total_discounts_cents: expected.discounts,
  net_revenue_cents: expected.net, coupons: { generated: 2, available: 1, redeemed: 1 } });
  expect(body.gross_revenue_cents - body.total_discounts_cents).toBe(body.net_revenue_cents);
  expect(state()).toEqual(before);
});

it('rejects reports exceeding safe JSON integer bounds instead of returning rounded totals', async () => {
  db.prepare('UPDATE products SET price_cents=? WHERE id=1').run(Number.MAX_SAFE_INTEGER);
  await checkout(cart(1, 1), 'large-1').expect(201);
  await checkout(cart(1, 1), 'large-2').expect(201);
  const before = state();
  expect((await request(app).get('/admin/reports/summary').expect(503)).body.error.code).toBe('REPORT_OUT_OF_RANGE');
  expect(state()).toEqual(before);
});

it('reruns the index migration without changing existing data and enforces one coupon per order', async () => {
  coupon('SAVE', 10, 5); coupon('NEXT', 10, 10);
  const { body } = await checkout(cart(1, 1), 'migration', { coupon_code: 'SAVE' }).expect(201);
  const before = state();
  db.exec('DROP INDEX coupons_redeemed_order_unique');
  for (let i = 0; i < 2; i++) {
    execFileSync(process.execPath, ['--import', 'tsx', 'src/db/setup.ts'], { env: { ...process.env, DATABASE_PATH: databasePath } });
  }
  expect(state()).toEqual(before);
  expect(() => db.prepare("UPDATE coupons SET status='redeemed', redeemed_order_id=? WHERE code='NEXT'").run(body.id)).toThrow(/UNIQUE/);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('uses the default interval of five orders and discount of ten percent', async () => {
  vi.stubEnv('COUPON_EVERY_N_ORDERS', undefined);
  vi.stubEnv('COUPON_DISCOUNT_PERCENT', undefined);
  app = createApp(db);
  await successfulOrders(5);
  const { body } = await request(app).post('/admin/coupons/generate').expect(200);
  expect(body.coupons).toHaveLength(1);
  expect(body.coupons[0]).toMatchObject({ milestone: 5, discount_percent: 10 });
});
