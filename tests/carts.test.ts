import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/app';

const directory = mkdtempSync(join(tmpdir(), 'checkout-api-'));
const databasePath = join(directory, 'test.sqlite');
let db: DatabaseSync;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  for (const file of ['src/db/setup.ts', 'src/db/seed.ts']) {
    execFileSync(process.execPath, ['--import', 'tsx', file], {
      env: { ...process.env, DATABASE_PATH: databasePath },
    });
  }
  db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  app = createApp(db);
});
beforeEach(() => {
  db.exec('DELETE FROM cart_items; DELETE FROM carts; UPDATE products SET price_cents=599 WHERE id=1;');
});
afterAll(() => {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

async function newCart() {
  const result = await request(app).post('/carts').expect(201);
  expect(result.body).toMatchObject({ status: 'open', items: [], subtotal_cents: 0 });
  return result.body.id as number;
}

function expectError(body: any, code: string) {
  expect(body).toEqual({ error: { code, message: expect.any(String) } });
}

describe('products and carts', () => {
  it('lists prices and available inventory', async () => {
    const { body } = await request(app).get('/products').expect(200);
    expect(body).toHaveLength(5);
    expect(body[4]).toMatchObject({ id: 5, price_cents: 2499, inventory: 1 });
  });

  it('adds, increments, sets exact quantity, and removes without reserving stock', async () => {
    const id = await newCart();
    await request(app).post(`/carts/${id}/items`).send({ product_id: 5, quantity: 2 }).expect(200);
    const added = await request(app).post(`/carts/${id}/items`).send({ product_id: 5, quantity: 3 }).expect(200);
    expect(added.body.items[0]).toMatchObject({ product_id: 5, quantity: 5, unit_price_cents: 2499, line_total_cents: 12495 });
    expect(added.body.subtotal_cents).toBe(12495);
    const patched = await request(app).patch(`/carts/${id}/items/5`).send({ quantity: 1 }).expect(200);
    expect(patched.body.items[0].quantity).toBe(1);
    expect(db.prepare('SELECT inventory FROM products WHERE id=5').get()?.inventory).toBe(1);
    const removed = await request(app).delete(`/carts/${id}/items/5`).expect(200);
    expect(removed.body).toMatchObject({ items: [], subtotal_cents: 0 });
    await request(app).get(`/carts/${id}`).expect(200);
  });

  it('uses current prices and sums multiple lines', async () => {
    const id = await newCart();
    await request(app).post(`/carts/${id}/items`).send({ product_id: 1, quantity: 3 }).expect(200);
    await request(app).post(`/carts/${id}/items`).send({ product_id: 2, quantity: 2 }).expect(200);
    db.prepare('UPDATE products SET price_cents=? WHERE id=1').run(601);
    const { body } = await request(app).get(`/carts/${id}`).expect(200);
    expect(body.subtotal_cents).toBe(3 * 601 + 2 * 899);
  });

  it.each([0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid quantity %s for add and patch', async quantity => {
    const id = await newCart();
    for (const method of ['post', 'patch'] as const) {
      const path = `/carts/${id}/items${method === 'patch' ? '/1' : ''}`;
      const result = await request(app)[method](path).send({ product_id: 1, quantity }).expect(400);
      expectError(result.body, 'INVALID_INPUT');
    }
  });

  it('rejects missing quantity, invalid IDs and malformed JSON', async () => {
    const id = await newCart();
    for (const product_id of [0, -1, 1.2, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
      const result = await request(app).post(`/carts/${id}/items`).send({ product_id, quantity: 1 }).expect(400);
      expectError(result.body, 'INVALID_INPUT');
    }
    await request(app).post(`/carts/${id}/items`).send({ product_id: 1 }).expect(400);
    for (const value of ['abc', '1.5', '-1', '9007199254740992', '1%20OR%201=1']) {
      await request(app).get(`/carts/${value}`).expect(400);
      await request(app).delete(`/carts/${id}/items/${value}`).expect(400);
    }
    const malformed = await request(app).post(`/carts/${id}/items`).set('Content-Type', 'application/json').send('{').expect(400);
    expectError(malformed.body, 'INVALID_JSON');
  });

  it('returns useful errors for missing carts, products and cart items', async () => {
    const id = await newCart();
    const missing = await request(app).get('/carts/999').expect(404);
    expectError(missing.body, 'CART_NOT_FOUND');
    for (const method of ['post', 'patch', 'delete'] as const) {
      const suffix = method === 'post' ? '' : '/1';
      const result = await request(app)[method](`/carts/999/items${suffix}`).send({ product_id: 1, quantity: 1 }).expect(404);
      expectError(result.body, 'CART_NOT_FOUND');
      const unknown = await request(app)[method](`/carts/${id}/items${method === 'post' ? '' : '/999'}`).send({ product_id: 999, quantity: 1 }).expect(404);
      expectError(unknown.body, 'PRODUCT_NOT_FOUND');
    }
    for (const method of ['patch', 'delete'] as const) {
      const result = await request(app)[method](`/carts/${id}/items/1`).send({ quantity: 1 }).expect(404);
      expectError(result.body, 'ITEM_NOT_FOUND');
    }
  });

  it('rejects all changes to closed carts and still allows reading', async () => {
    const id = await newCart();
    await request(app).post(`/carts/${id}/items`).send({ product_id: 1, quantity: 1 }).expect(200);
    db.prepare("UPDATE carts SET status='checked_out' WHERE id=?").run(id);
    for (const method of ['post', 'patch', 'delete'] as const) {
      const result = await request(app)[method](`/carts/${id}/items${method === 'post' ? '' : '/1'}`).send({ product_id: 1, quantity: 2 }).expect(409);
      expectError(result.body, 'CART_CLOSED');
    }
    const { body } = await request(app).get(`/carts/${id}`).expect(200);
    expect(body.status).toBe('checked_out');
    expect(body.items[0].quantity).toBe(1);
  });

  it('rejects line and subtotal overflow and rolls back changes', async () => {
    const id = await newCart();
    db.prepare('UPDATE products SET price_cents=? WHERE id=1').run(Number.MAX_SAFE_INTEGER);
    await request(app).post(`/carts/${id}/items`).send({ product_id: 1, quantity: 1 }).expect(200);
    for (const operation of [
      () => request(app).post(`/carts/${id}/items`).send({ product_id: 1, quantity: 1 }),
      () => request(app).patch(`/carts/${id}/items/1`).send({ quantity: 2 }),
      () => request(app).post(`/carts/${id}/items`).send({ product_id: 2, quantity: 1 }),
    ]) {
      const result = await operation().expect(400);
      expectError(result.body, 'TOTAL_OUT_OF_RANGE');
    }
    const { body } = await request(app).get(`/carts/${id}`).expect(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].quantity).toBe(1);
    expect(body.subtotal_cents).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects combined quantity overflow without changing the item', async () => {
    const id = await newCart();
    db.exec('UPDATE products SET price_cents=0 WHERE id=1');
    await request(app).post(`/carts/${id}/items`).send({ product_id: 1, quantity: Number.MAX_SAFE_INTEGER }).expect(200);
    const result = await request(app).post(`/carts/${id}/items`).send({ product_id: 1, quantity: 1 }).expect(400);
    expectError(result.body, 'INVALID_INPUT');
    expect(db.prepare('SELECT quantity FROM cart_items WHERE cart_id=?').get(id)?.quantity).toBe(Number.MAX_SAFE_INTEGER);
  });
});
