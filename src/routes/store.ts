import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError, id, positiveInteger, safeTotal } from '../http';

export function createStoreRoutes(db: DatabaseSync) {
  const router = Router();

  function cart(cartId: number) {
    const row = db.prepare('SELECT id, status, created_at FROM carts WHERE id = ?').get(cartId);
    if (!row) throw new ApiError(404, 'CART_NOT_FOUND', 'Cart not found.');
    return row;
  }

  function cartDetails(cartId: number) {
    const row = cart(cartId);
    let subtotal = 0;
    const items = db.prepare(`
      SELECT p.id AS product_id, p.name AS product_name, ci.quantity, p.price_cents AS unit_price_cents
      FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = ? ORDER BY p.id
    `).all(cartId).map(item => {
      const lineTotal = safeTotal(Number(item.quantity) * Number(item.unit_price_cents));
      subtotal = safeTotal(subtotal + lineTotal);
      return { ...item, line_total_cents: lineTotal };
    });
    return { ...row, items, subtotal_cents: subtotal };
  }

  // The lock makes checking cart status and changing its items one operation.
  function modify(cartId: number, change: () => void) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (cart(cartId).status !== 'open') {
        throw new ApiError(409, 'CART_CLOSED', 'Only open carts can be modified.');
      }
      change();
      const result = cartDetails(cartId);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function product(productId: number) {
    if (!db.prepare('SELECT id FROM products WHERE id = ?').get(productId)) {
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    }
  }

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', message: 'Checkout & Rewards API is running' });
  });

  router.get('/products', (_req, res) => {
    res.json(db.prepare('SELECT id, name, price_cents, inventory FROM products ORDER BY id').all());
  });

  router.post('/carts', (_req, res) => {
    const result = db.prepare('INSERT INTO carts DEFAULT VALUES').run();
    res.status(201).json(cartDetails(Number(result.lastInsertRowid)));
  });

  router.get('/carts/:id', (req, res) => {
    res.json(cartDetails(id(req.params.id, 'Cart ID')));
  });

  router.post('/carts/:id/items', (req, res) => {
    const cartId = id(req.params.id, 'Cart ID');
    const productId = positiveInteger(req.body?.product_id, 'Product ID');
    const quantity = positiveInteger(req.body?.quantity, 'Quantity');
    res.json(modify(cartId, () => {
      product(productId);
      const existing = db.prepare('SELECT quantity FROM cart_items WHERE cart_id = ? AND product_id = ?')
        .get(cartId, productId);
      const combined = positiveInteger(Number(existing?.quantity ?? 0) + quantity, 'Combined quantity');
      db.prepare(`INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
        ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = excluded.quantity`)
        .run(cartId, productId, combined);
    }));
  });

  router.patch('/carts/:id/items/:productId', (req, res) => {
    const cartId = id(req.params.id, 'Cart ID');
    const productId = id(req.params.productId, 'Product ID');
    const quantity = positiveInteger(req.body?.quantity, 'Quantity');
    res.json(modify(cartId, () => {
      product(productId);
      const result = db.prepare('UPDATE cart_items SET quantity = ? WHERE cart_id = ? AND product_id = ?')
        .run(quantity, cartId, productId);
      if (!result.changes) throw new ApiError(404, 'ITEM_NOT_FOUND', 'Product is not in this cart.');
    }));
  });

  router.delete('/carts/:id/items/:productId', (req, res) => {
    const cartId = id(req.params.id, 'Cart ID');
    const productId = id(req.params.productId, 'Product ID');
    res.json(modify(cartId, () => {
      product(productId);
      const result = db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?')
        .run(cartId, productId);
      if (!result.changes) throw new ApiError(404, 'ITEM_NOT_FOUND', 'Product is not in this cart.');
    }));
  });

  return router;
}
