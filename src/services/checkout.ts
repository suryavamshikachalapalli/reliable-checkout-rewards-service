import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ApiError, positiveInteger, safeTotal } from '../http';

export function orderDetails(db: DatabaseSync, orderId: number) {
  const order = db.prepare(`SELECT o.*, c.code AS coupon_code, c.discount_percent AS coupon_discount_percent
    FROM orders o LEFT JOIN coupons c ON c.redeemed_order_id = o.id WHERE o.id = ?`).get(orderId);
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY product_id').all(orderId);
  return { ...order, items };
}

export function checkout(db: DatabaseSync, cartId: number, key: string | undefined, requestBody: any) {
  if (!key || !key.trim() || key.length > 200) {
    throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must contain 1–200 characters and cannot be blank.');
  }
  const body = requestBody ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_INPUT', 'Checkout body must be a JSON object.');
  }
  // Empty body and {} are the same request; top-level field order is irrelevant.
  const payload = Object.fromEntries(Object.keys(body).sort().map(field => [field, body[field]]));
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT * FROM checkout_requests WHERE idempotency_key = ?').get(key);
    if (previous) {
      if (previous.cart_id !== cartId || previous.request_hash !== hash) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used for a different cart or payload.');
      }
      const order = orderDetails(db, Number(previous.order_id));
      db.exec('COMMIT');
      return { status: 200, order };
    }
    if (Object.hasOwn(body, 'coupon_code') &&
        (typeof body.coupon_code !== 'string' || !body.coupon_code.trim() || body.coupon_code.length > 200)) {
      throw new ApiError(400, 'INVALID_INPUT', 'coupon_code must be a nonblank string of at most 200 characters.');
    }
    if (Object.keys(body).some(field => field !== 'coupon_code')) {
      throw new ApiError(400, 'INVALID_INPUT', 'Checkout body contains unsupported fields.');
    }
    const cart = db.prepare('SELECT id, status, created_at FROM carts WHERE id = ?').get(cartId);
    if (!cart) throw new ApiError(404, 'CART_NOT_FOUND', 'Cart not found.');
    if (cart.status !== 'open' || db.prepare('SELECT id FROM orders WHERE cart_id = ?').get(cartId)) {
      throw new ApiError(409, 'CART_CLOSED', 'Cart has already been checked out.');
    }
    const coupon = Object.hasOwn(body, 'coupon_code')
      ? db.prepare('SELECT * FROM coupons WHERE code = ?').get(body.coupon_code) : undefined;
    if (Object.hasOwn(body, 'coupon_code') && !coupon) {
      throw new ApiError(404, 'COUPON_NOT_FOUND', 'Coupon not found.');
    }
    if (coupon && coupon.status !== 'available') {
      throw new ApiError(409, 'COUPON_UNAVAILABLE', 'Coupon has already been redeemed.');
    }
    const query = db.prepare(`
      SELECT ci.product_id, ci.quantity, p.name, p.price_cents, p.inventory
      FROM cart_items ci LEFT JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = ? ORDER BY ci.product_id
    `);
    // Read as bigint so oversized SQLite integers are validated before conversion.
    query.setReadBigInts(true);
    const rows = query.all(cartId);
    if (!rows.length) throw new ApiError(409, 'EMPTY_CART', 'Cannot check out an empty cart.');
    let subtotal = 0;
    const items = rows.map(row => {
      if (row.name === null) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'A cart product no longer exists.');
      const quantity = positiveInteger(Number(row.quantity), 'Quantity');
      const price = safeTotal(Number(row.price_cents));
      if (BigInt(quantity) > BigInt(row.inventory as bigint)) {
        throw new ApiError(409, 'INSUFFICIENT_STOCK', `Insufficient inventory for product ${row.product_id}.`);
      }
      const lineTotal = safeTotal(quantity * price);
      subtotal = safeTotal(subtotal + lineTotal);
      return { productId: row.product_id, name: row.name, quantity, price, lineTotal };
    });
    // BigInt keeps the intermediate percentage multiplication exact, even near MAX_SAFE_INTEGER.
    const discount = coupon
      ? safeTotal(Number((BigInt(subtotal) * BigInt(coupon.discount_percent as number) + 50n) / 100n)) : 0;
    const total = safeTotal(subtotal - discount);
    const result = db.prepare(`INSERT INTO orders (cart_id, subtotal_cents, discount_cents, total_cents)
      VALUES (?, ?, ?, ?)`).run(cartId, subtotal, discount, total);
    const orderId = positiveInteger(Number(result.lastInsertRowid), 'Order ID');
    if (coupon) {
      const redeemed = db.prepare(`UPDATE coupons SET status = 'redeemed', redeemed_order_id = ?
        WHERE id = ? AND status = 'available'`).run(orderId, coupon.id);
      if (!redeemed.changes) throw new ApiError(409, 'COUPON_UNAVAILABLE', 'Coupon has already been redeemed.');
    }
    for (const item of items) {
      db.prepare('UPDATE products SET inventory = inventory - ? WHERE id = ?').run(item.quantity, item.productId);
      db.prepare(`INSERT INTO order_items
        (order_id, product_id, product_name, quantity, unit_price_cents, line_total_cents)
        VALUES (?, ?, ?, ?, ?, ?)`).run(orderId, item.productId, item.name, item.quantity, item.price, item.lineTotal);
    }
    db.prepare(`INSERT INTO checkout_requests (idempotency_key, cart_id, request_hash, order_id)
      VALUES (?, ?, ?, ?)`).run(key, cartId, hash, orderId);
    db.prepare("UPDATE carts SET status = 'checked_out' WHERE id = ?").run(cartId);
    const order = orderDetails(db, orderId);
    db.exec('COMMIT');
    return { status: 201, order };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
