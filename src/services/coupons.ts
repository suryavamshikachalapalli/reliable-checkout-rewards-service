import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function createCouponService(db: DatabaseSync) {
  function configuration(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
    const raw = process.env[name] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
    }
    return value;
  }
  const everyNOrders = configuration('COUPON_EVERY_N_ORDERS', 5);
  const discountPercent = configuration('COUPON_DISCOUNT_PERCENT', 10, 100);

  function generate() {
    db.exec('BEGIN IMMEDIATE');
    try {
      const count = Number(db.prepare('SELECT count(*) AS count FROM orders').get()!.count);
      const eligible = Math.floor(count / everyNOrders);
      const coupons = [];
      let alreadyRewarded = 0;
      const insert = db.prepare(`INSERT INTO coupons (code, milestone, discount_percent)
        VALUES (?, ?, ?) ON CONFLICT (milestone) DO NOTHING RETURNING *`);
      for (let reward = 1; reward <= eligible; reward++) {
        // Milestones are actual order-count thresholds: N, 2N, 3N, ...
        const coupon = insert.get(randomUUID(), reward * everyNOrders, discountPercent);
        if (coupon) coupons.push(coupon);
        else alreadyRewarded++;
      }
      db.exec('COMMIT');
      return { successful_orders: count, eligible_milestones: eligible,
        already_rewarded_count: alreadyRewarded, generated_count: coupons.length, coupons };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  return { generate };
}
