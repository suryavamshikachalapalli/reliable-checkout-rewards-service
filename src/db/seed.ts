import { db } from './database';

// Stable IDs let reruns preserve existing prices and remaining inventory.
const products = [
  { id: 1, name: 'Notebook', price_cents: 599, inventory: 50 },
  { id: 2, name: 'Pen Set', price_cents: 899, inventory: 30 },
  { id: 3, name: 'Coffee Mug', price_cents: 1299, inventory: 20 },
  { id: 4, name: 'Tote Bag', price_cents: 1599, inventory: 10 },
  { id: 5, name: 'Limited Edition Print', price_cents: 2499, inventory: 1 },
];

try {
  db.exec('BEGIN IMMEDIATE');
  const insert = db.prepare(`
    INSERT INTO products (id, name, price_cents, inventory)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `);

  for (const product of products) {
    insert.run(product.id, product.name, product.price_cents, product.inventory);
  }

  db.exec('COMMIT');
  console.log('Product seeding complete.');
} finally {
  db.close();
}
