import { beforeAll, expect, it } from 'vitest';

const stateModule = import('../frontend/src/checkoutState.js');
const apiModule = import('../frontend/src/api.js');
let state: Awaited<typeof stateModule>;
let money: Awaited<typeof apiModule>['money'];
beforeAll(async () => {
  state = await stateModule;
  ({ money } = await apiModule);
});

it('reuses the checkout key and exact coupon payload for every retry and reload', () => {
  const first = state.checkoutAttempt(7, ' SAVE ', null);
  expect(first.body).toEqual({ coupon_code: 'SAVE' });
  expect(state.checkoutAttempt(7, 'CHANGED', first)).toBe(first);
  const saved = { cartId: 7, orderId: null, attempt: first };
  const restored = state.readSession({ getItem: () => JSON.stringify(saved) });
  const retry = state.checkoutAttempt(7, '', restored.attempt);
  expect(retry).toEqual(first);
  expect(() => state.checkoutAttempt(8, '', first)).toThrow(/pending checkout/);
});

it('creates a new key only when explicitly beginning a new attempt', () => {
  const first = state.checkoutAttempt(1, '', null);
  expect(first.body).toEqual({});
  expect(state.checkoutAttempt(1, '', first).key).toBe(first.key);
  expect(state.checkoutAttempt(1, '', null).key).not.toBe(first.key);
});

it('allows editing only after a confirmed validation failure', () => {
  expect(state.canChangeAttempt(409, 'INSUFFICIENT_STOCK')).toBe(true);
  expect(state.canChangeAttempt(404, 'COUPON_NOT_FOUND')).toBe(true);
  for (const [status, code] of [[500, 'INTERNAL_ERROR'], [503, 'DATABASE_BUSY'], [409, 'IDEMPOTENCY_CONFLICT'], [409, 'CART_CLOSED']] as const) {
    expect(state.canChangeAttempt(status, code)).toBe(false);
  }
});

it('rejects invalid saved attempts rather than creating a replacement key', () => {
  expect(state.readSession({ getItem: () => null })).toEqual(state.emptySession);
  expect(() => state.readSession({ getItem: () => '{' })).toThrow();
  expect(() => state.readSession({ getItem: () => JSON.stringify({ cartId: 1, orderId: null,
    attempt: { cartId: 2, key: 'saved', body: {}, canChange: false } }) })).toThrow();
});

it('formats integer cents exactly, including the largest safe monetary value', () => {
  expect(money(0)).toBe('$0.00');
  expect(money(5)).toBe('$0.05');
  expect(money(599)).toBe('$5.99');
  expect(money(Number.MAX_SAFE_INTEGER)).toBe('$90,071,992,547,409.91');
});
