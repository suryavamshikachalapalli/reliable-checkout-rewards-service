export type Attempt = { cartId: number; key: string; body: { coupon_code?: string }; canChange: boolean };
export type Session = { cartId: number | null; orderId: number | null; attempt: Attempt | null };
export const storageKey = 'counter-demo-session-v1';
export const emptySession: Session = { cartId: null, orderId: null, attempt: null };

export function readSession(storage: Pick<Storage, 'getItem'>): Session {
  const raw = storage.getItem(storageKey);
  if (!raw) return emptySession;
  const value = JSON.parse(raw) as Session;
  const validId = (id: unknown) => id === null || (typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
  if (!validId(value.cartId) || !validId(value.orderId)) throw new Error('Invalid saved session.');
  if (value.attempt && (value.attempt.cartId !== value.cartId || typeof value.attempt.key !== 'string' ||
      !value.attempt.key || value.attempt.key.length > 200 || !value.attempt.body ||
      Object.keys(value.attempt.body).some(key => key !== 'coupon_code') ||
      (value.attempt.body.coupon_code !== undefined && typeof value.attempt.body.coupon_code !== 'string') ||
      typeof value.attempt.canChange !== 'boolean')) throw new Error('Invalid saved checkout attempt.');
  return value;
}

export function checkoutAttempt(cartId: number, coupon: string, previous: Attempt | null): Attempt {
  if (previous) {
    if (previous.cartId !== cartId) throw new Error('Resolve the pending checkout before switching carts.');
    return previous;
  }
  return { cartId, key: crypto.randomUUID(), body: coupon.trim() ? { coupon_code: coupon.trim() } : {}, canChange: false };
}

// Only confirmed validation failures let the shopper edit the cart or coupon and begin a new attempt.
export function canChangeAttempt(status: number, code: string): boolean {
  return status >= 400 && status < 500 && [
    'INVALID_INPUT', 'INVALID_IDEMPOTENCY_KEY', 'COUPON_NOT_FOUND', 'COUPON_UNAVAILABLE',
    'INSUFFICIENT_STOCK', 'EMPTY_CART', 'TOTAL_OUT_OF_RANGE', 'PRODUCT_NOT_FOUND',
  ].includes(code);
}
