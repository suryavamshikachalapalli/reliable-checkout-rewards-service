import { db } from './database';

try {
  db.exec(`
    BEGIN IMMEDIATE;

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      inventory INTEGER NOT NULL CHECK (inventory >= 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS carts (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE TABLE IF NOT EXISTS cart_items (
      cart_id INTEGER NOT NULL REFERENCES carts(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      PRIMARY KEY (cart_id, product_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      cart_id INTEGER NOT NULL UNIQUE REFERENCES carts(id),
      subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
      discount_cents INTEGER NOT NULL DEFAULT 0
        CHECK (discount_cents >= 0 AND discount_cents <= subtotal_cents),
      total_cents INTEGER NOT NULL
        CHECK (total_cents >= 0 AND total_cents = subtotal_cents - discount_cents),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE TABLE IF NOT EXISTS order_items (
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      product_name TEXT NOT NULL CHECK (length(trim(product_name)) > 0),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      line_total_cents INTEGER NOT NULL
        CHECK (line_total_cents >= 0 AND line_total_cents = quantity * unit_price_cents),
      PRIMARY KEY (order_id, product_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE CHECK (length(trim(code)) > 0),
      milestone INTEGER NOT NULL UNIQUE CHECK (milestone > 0),
      discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 100),
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'redeemed')),
      redeemed_order_id INTEGER REFERENCES orders(id),
      CHECK (
        (status = 'available' AND redeemed_order_id IS NULL) OR
        (status = 'redeemed' AND redeemed_order_id IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS checkout_requests (
      idempotency_key TEXT NOT NULL PRIMARY KEY CHECK (length(trim(idempotency_key)) > 0),
      cart_id INTEGER NOT NULL REFERENCES carts(id),
      request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0),
      order_id INTEGER REFERENCES orders(id)
    ) STRICT;

    COMMIT;
  `);
  console.log('Database setup complete.');
} finally {
  db.close();
}
