import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from '../http';
import type { createCouponService } from '../services/coupons';

export function createAdminRoutes(db: DatabaseSync, coupons: ReturnType<typeof createCouponService>) {
  const router = Router();
  router.post('/admin/coupons/generate', (_req, res) => {
    res.json(coupons.generate());
  });

  router.get('/admin/reports/summary', (_req, res) => {
    // A read transaction keeps all report sections on the same committed snapshot.
    db.exec('BEGIN');
    try {
      const orders = db.prepare('SELECT subtotal_cents, discount_cents, total_cents FROM orders');
      orders.setReadBigInts(true);
      let gross = 0n, discounts = 0n, net = 0n, totalOrders = 0;
      for (const order of orders.all()) {
        totalOrders++;
        gross += order.subtotal_cents as bigint;
        discounts += order.discount_cents as bigint;
        net += order.total_cents as bigint;
      }
      const quantities = new Map<bigint, bigint>();
      const items = db.prepare('SELECT product_id, quantity FROM order_items');
      items.setReadBigInts(true);
      for (const item of items.all()) {
        const productId = item.product_id as bigint;
        quantities.set(productId, (quantities.get(productId) ?? 0n) + (item.quantity as bigint));
      }
      function reportInteger(value: bigint) {
        if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ApiError(503, 'REPORT_OUT_OF_RANGE', 'Report totals exceed the safe integer range.');
        }
        return Number(value);
      }
      const couponCounts = db.prepare(`SELECT count(*) AS generated,
        count(CASE WHEN status = 'available' THEN 1 END) AS available,
        count(CASE WHEN status = 'redeemed' THEN 1 END) AS redeemed FROM coupons`).get();
      const result = {
        total_orders: totalOrders,
        purchased_quantity_by_product: [...quantities].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([productId, quantity]) => ({ product_id: reportInteger(productId), quantity: reportInteger(quantity) })),
        gross_revenue_cents: reportInteger(gross), total_discounts_cents: reportInteger(discounts),
        net_revenue_cents: reportInteger(net), coupons: couponCounts,
      };
      db.exec('COMMIT');
      res.json(result);
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  });

  return router;
}
