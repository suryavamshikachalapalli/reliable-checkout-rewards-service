import express from 'express';
import { db } from '../../src/db/database';
import { createApp } from '../../src/app';

const app = express();
app.use((req, _res, next) => {
  if (req.path.endsWith('/checkout') || req.path === '/admin/coupons/generate') process.send?.({ type: 'arrived' });
  next();
});
app.use(createApp(db));
const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ type: 'ready', port: address.port });
});
