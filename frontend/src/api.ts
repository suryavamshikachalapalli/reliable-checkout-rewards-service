export type Product = { id: number; name: string; price_cents: number; inventory: number };
export type Item = { product_id: number; product_name: string; quantity: number; unit_price_cents: number; line_total_cents: number };
export type Cart = { id: number; status: 'open' | 'checked_out'; created_at: string; items: Item[]; subtotal_cents: number };
export type Order = { id: number; cart_id: number; created_at: string; items: Item[]; subtotal_cents: number;
  discount_cents: number; total_cents: number; coupon_code: string | null; coupon_discount_percent: number | null };
export type Coupon = { id: number; code: string; milestone: number; discount_percent: number; status: string; redeemed_order_id: number | null };
export type Generation = { successful_orders: number; eligible_milestones: number; already_rewarded_count: number; generated_count: number; coupons: Coupon[] };
export type Report = { total_orders: number; purchased_quantity_by_product: { product_id: number; quantity: number }[];
  gross_revenue_cents: number; total_discounts_cents: number; net_revenue_cents: number;
  coupons: { generated: number; available: number; redeemed: number } };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  // A proxy failure or unreadable response remains uncertain for checkout retries.
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error?.code ?? 'REQUEST_FAILED', data.error?.message ?? 'Request failed.');
  return data as T;
}

export function message(error: unknown): string {
  return error instanceof ApiError ? `${error.message} (${error.code})`
    : 'Could not reach the service or read its response. Check that the backend is running, then retry.';
}

// Format cents exactly, without a floating-point division of the monetary value.
export function money(cents: number): string {
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}$${(absolute / 100n).toLocaleString('en-US')}.${String(absolute % 100n).padStart(2, '0')}`;
}
