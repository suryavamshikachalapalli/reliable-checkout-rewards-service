import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { id } from '../http';
import { checkout, orderDetails } from '../services/checkout';

export function createCheckoutRoutes(db: DatabaseSync) {
  const router = Router();
  router.get('/orders/:id', (req, res) => {
    res.json(orderDetails(db, id(req.params.id, 'Order ID')));
  });
  router.post('/carts/:id/checkout', (req, res) => {
    const cartId = id(req.params.id, 'Cart ID');
    const result = checkout(db, cartId, req.get('Idempotency-Key'), req.body);
    res.status(result.status).json(result.order);
  });
  return router;
}
