import express, { type ErrorRequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from './http';
import { createStoreRoutes } from './routes/store';
import { createCheckoutRoutes } from './routes/checkout';
import { createAdminRoutes } from './routes/admin';
import { createCouponService } from './services/coupons';

// Inject the connection so API tests can use a separate database.
export function createApp(db: DatabaseSync) {
  const coupons = createCouponService(db);
  const app = express();
  app.use(express.json());
  app.use(createCheckoutRoutes(db));
  app.use(createAdminRoutes(db, coupons));
  app.use(createStoreRoutes(db));

  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found.')));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
    } else if (error.errcode === 5 || error.errcode === 6) {
      res.status(503).json({ error: { code: 'DATABASE_BUSY', message: 'Database is busy. Retry with the same Idempotency-Key.' } });
    } else if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
    } else if (error.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body is too large.' } });
    } else {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
    }
  };
  app.use(errors);
  return app;
}
