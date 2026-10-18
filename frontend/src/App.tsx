import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, message, money, type Cart, type Coupon, type Generation, type Item, type Order, type Product, type Report } from './api';
import { canChangeAttempt, checkoutAttempt, emptySession, readSession, storageKey, type Session } from './checkoutState';

function ItemList({ items }: { items: Item[] }) {
  return <ul className="receipt-items">{items.map(item => <li key={item.product_id}>
    <div><strong>{item.product_name}</strong><small>{item.quantity} × {money(item.unit_price_cents)}</small></div>
    <span>{money(item.line_total_cents)}</span>
  </li>)}</ul>;
}

export default function App() {
  const [session, setSession] = useState<Session>(emptySession);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Cart | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [couponCode, setCouponCode] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [generationNote, setGenerationNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [storeBusy, setStoreBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [adminBusy, setAdminBusy] = useState(false);
  const [storeError, setStoreError] = useState('');
  const [checkoutError, setCheckoutError] = useState('');
  const [adminError, setAdminError] = useState('');

  function save(next: Session) {
    // Persist before sending a checkout; a storage failure must not lose its key.
    sessionStorage.setItem(storageKey, JSON.stringify(next));
    setSession(next);
  }

  async function loadStore() {
    setLoading(true);
    setStoreError('');
    try {
      const saved = readSession(sessionStorage);
      setSession(saved);
      if (saved.attempt) setCouponCode(saved.attempt.body.coupon_code ?? '');
      const catalog = await api<Product[]>('/products');
      setProducts(catalog);
      if (saved.cartId) setCart(await api<Cart>(`/carts/${saved.cartId}`));
      if (saved.orderId) setOrder(await api<Order>(`/orders/${saved.orderId}`));
    } catch (error) { setStoreError(message(error)); }
    finally { setLoading(false); }
  }

  async function loadReport() {
    setAdminBusy(true);
    setAdminError('');
    try { setReport(await api<Report>('/admin/reports/summary')); }
    catch (error) { setAdminError(message(error)); }
    finally { setAdminBusy(false); }
  }

  useEffect(() => { void loadStore(); void loadReport(); }, []);

  async function newCart() {
    setStoreBusy(true);
    setStoreError('');
    try {
      const created = await api<Cart>('/carts', 'POST');
      save({ cartId: created.id, orderId: null, attempt: null });
      setCart(created);
      setOrder(null);
      setCouponCode('');
      setCheckoutError('');
    } catch (error) { setStoreError(message(error)); }
    finally { setStoreBusy(false); }
  }

  async function changeItem(productId: number, method: 'POST' | 'PATCH' | 'DELETE', quantity?: number) {
    if (!cart) return;
    if (quantity !== undefined && (!Number.isSafeInteger(quantity) || quantity < 1)) {
      setStoreError('Quantity must be a positive safe integer.');
      return;
    }
    setStoreBusy(true);
    setStoreError('');
    try {
      const path = `/carts/${cart.id}/items${method === 'POST' ? '' : `/${productId}`}`;
      setCart(await api<Cart>(path, method, method === 'DELETE' ? undefined : { product_id: productId, quantity }));
    } catch (error) { setStoreError(message(error)); }
    finally { setStoreBusy(false); }
  }

  async function checkout(event: FormEvent) {
    event.preventDefault();
    if (!cart || checkoutBusy) return;
    setCheckoutBusy(true);
    setCheckoutError('');
    let attempt = session.attempt;
    try {
      attempt = checkoutAttempt(cart.id, couponCode, attempt);
      // A retry can itself become uncertain, even if the preceding failure was definitive.
      attempt = { ...attempt, canChange: false };
      save({ ...session, attempt });
      const completed = await api<Order>(`/carts/${attempt.cartId}/checkout`, 'POST', attempt.body, attempt.key);
      save({ cartId: cart.id, orderId: completed.id, attempt: null });
      setOrder(completed);
      setCart({ ...cart, status: 'checked_out' });
      void loadReport();
      try { setProducts(await api<Product[]>('/products')); }
      catch (error) { setStoreError(message(error)); }
    } catch (error) {
      setCheckoutError(message(error));
      if (attempt && error instanceof ApiError && canChangeAttempt(error.status, error.code)) {
        try { save({ ...session, attempt: { ...attempt, canChange: true } }); }
        catch { setCheckoutError('Could not save checkout state. Keep this tab open and retry with the existing attempt.'); }
      }
    } finally { setCheckoutBusy(false); }
  }

  function changeCheckoutDetails() {
    if (!session.attempt?.canChange) return;
    try { save({ ...session, attempt: null }); setCheckoutError(''); }
    catch (error) { setCheckoutError(message(error)); }
  }

  async function generateCoupons() {
    setAdminBusy(true);
    setAdminError('');
    setGenerationNote('');
    try {
      const result = await api<Generation>('/admin/coupons/generate', 'POST');
      // Keep codes generated earlier in this tab when a later generation returns none.
      setCoupons(previous => [...previous, ...result.coupons.filter(coupon => !previous.some(existing => existing.id === coupon.id))]);
      setGenerationNote(`${result.generated_count} new coupons · ${result.eligible_milestones} eligible milestones · ${result.already_rewarded_count} previously rewarded · ${result.successful_orders} successful orders`);
      setReport(await api<Report>('/admin/reports/summary'));
    } catch (error) { setAdminError(message(error)); }
    finally { setAdminBusy(false); }
  }

  const locked = !!session.attempt || checkoutBusy;
  const editable = !!cart && cart.status === 'open' && !storeBusy && !loading && !locked;
  return <>
    <header className="site-header"><a className="brand" href="#store"><span className="brand-mark">c.</span> counter<span className="brand-note">CHECKOUT & REWARDS</span></a>
      <nav aria-label="Sections"><a href="#store">Store</a><a href="#checkout">Checkout</a><a href="#admin">Admin demo</a></nav>
    </header>
    <main>
      <div className="intro"><p className="eyebrow">THE LITTLE THINGS, WELL MADE</p><h1>A small store.<br />A complete checkout.</h1><p>Pick a few everyday essentials. Try a reward. See every order add up.</p><span className="demo-tag"><span /> Local demo · No real payments</span></div>
      <div className="shopping-layout">
        <section id="store" aria-labelledby="store-title">
          <div className="section-heading"><div><p className="eyebrow">01 / STORE</p><h2 id="store-title">Everyday essentials</h2></div><button className="text-button" disabled={loading || storeBusy || checkoutBusy} onClick={() => void loadStore()}>Refresh store</button></div>
          {storeError && <p className="error" role="alert">{storeError}</p>}
          {loading ? <p role="status" className="empty">Loading the store…</p> : products.length === 0 ? <p className="empty">No products yet. Run the database seed script, then refresh the store.</p> : <div className="product-grid">{products.map((product, index) => <article className="product" key={product.id}>
            <div className={`product-art art-${index % 5}`} aria-hidden="true"><span>{['▤', '╱╱', '◡', '▱', '▧'][index % 5]}</span><small>COUNTER / {String(product.id).padStart(2, '0')}</small></div>
            <div className="product-body"><div className="product-title"><h3>{product.name}</h3><strong>{money(product.price_cents)}</strong></div><p className={product.inventory === 1 ? 'low-stock' : ''}>{product.inventory === 0 ? 'Out of stock' : `${product.inventory} available`}</p>
              <button className="secondary full" disabled={!editable || product.inventory === 0} onClick={() => void changeItem(product.id, 'POST', 1)}>Add to cart <span aria-hidden="true">+</span></button></div>
          </article>)}</div>}
          {!cart && !loading && <p className="hint">Create a cart to start adding products.</p>}
        </section>
        <aside className="cart-panel" aria-labelledby="cart-title">
          <div className="section-heading"><div><p className="eyebrow">YOUR SELECTION</p><h2 id="cart-title">Shopping cart</h2></div><span className="count">{cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0}</span></div>
          {cart ? <><p className="cart-meta">Cart #{cart.id} <span className="pill">{cart.status === 'open' ? 'Open' : 'Checked out'}</span></p>
            {cart.items.length === 0 ? <p className="empty">Your cart is waiting for something good.</p> : <ul className="cart-items">{cart.items.map(item => <li key={item.product_id}><div className="cart-item-top"><div><strong>{item.product_name}</strong><small>{money(item.unit_price_cents)} each</small></div><span>{money(item.line_total_cents)}</span></div>
              <div className="cart-item-actions"><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void changeItem(item.product_id, 'PATCH', Number(data.get('quantity'))); }}>
                <label className="sr-only" htmlFor={`qty-${item.product_id}`}>Quantity for {item.product_name}</label><input key={`${item.product_id}-${item.quantity}`} id={`qty-${item.product_id}`} name="quantity" type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" required defaultValue={item.quantity} disabled={!editable} /><button className="text-button" disabled={!editable}>Update</button></form>
                <button className="text-button remove" disabled={!editable} onClick={() => void changeItem(item.product_id, 'DELETE')}>Remove</button></div>
            </li>)}</ul>}
            <div className="total-row"><span>Subtotal</span><strong>{money(cart.subtotal_cents)}</strong></div><p className="hint">Prices are current. Stock is checked at checkout; cart items don’t reserve inventory.</p>
          </> : <p className="empty">A fresh cart is a good place to start.</p>}
          <button className="secondary full" disabled={storeBusy || loading || locked} onClick={() => void newCart()}>{storeBusy ? 'Updating cart…' : cart ? 'Create a new cart' : 'Create cart'}</button>
          {locked && <p className="hint">Resolve this checkout attempt before changing the cart.</p>}
        </aside>
      </div>

      <section id="checkout" className="checkout-section" aria-labelledby="checkout-title">
        <div className="checkout-intro"><p className="eyebrow">02 / CHECKOUT</p><h2 id="checkout-title">Make it yours.</h2><p>Have a milestone reward? Add it here.</p><p className="hint">Successful checkout counts as payment success in this demo.</p></div>
        <div className="checkout-card">
          {order ? <div><p className="success" role="status">✓ Checkout complete</p><h3>Order #{order.id}</h3><p className="hint">Saved item and price snapshots</p><ItemList items={order.items} />
            <div className="receipt-totals"><div><span>Subtotal</span><span>{money(order.subtotal_cents)}</span></div><div><span>Discount{order.coupon_code ? ` (${order.coupon_discount_percent}%)` : ''}</span><span>−{money(order.discount_cents)}</span></div><div className="grand-total"><strong>Total</strong><strong>{money(order.total_cents)}</strong></div></div>
            {order.coupon_code && <p className="hint">Redeemed coupon: <code>{order.coupon_code}</code></p>}<p className="hint">Create a new cart above to place another order.</p>
          </div> : <form onSubmit={event => void checkout(event)}><label htmlFor="coupon">Coupon code <span className="optional">optional</span></label><input id="coupon" value={couponCode} maxLength={200} placeholder="Enter your reward code" disabled={locked} onChange={event => setCouponCode(event.target.value)} autoComplete="off" />
            <div className="total-row"><span>Cart subtotal</span><strong>{money(cart?.subtotal_cents ?? 0)}</strong></div><p className="hint">Any coupon discount is calculated by the service at checkout.</p>
            {checkoutError && <p className="error" role="alert">{checkoutError}</p>}
            {session.attempt && <p className="retry-note" role="status">Your checkout attempt is saved in this tab. Retry uses the same request and key. {session.attempt.canChange ? 'To edit your cart or coupon, choose “Change checkout details”.' : 'An uncertain response may already have created your order; retry to confirm it.'}</p>}
            <button className="primary full" disabled={checkoutBusy || storeBusy || loading || !cart || (!session.attempt && (cart.status !== 'open' || cart.items.length === 0))}>
              {checkoutBusy ? 'Checking out…' : session.attempt ? 'Retry checkout' : 'Complete checkout'} <span aria-hidden="true">→</span></button>
            {session.attempt?.canChange && <button className="text-button full" type="button" disabled={checkoutBusy} onClick={changeCheckoutDetails}>Change checkout details</button>}
            {!cart && <p className="hint">Create a cart and add an item to check out.</p>}
          </form>}
        </div>
      </section>

      <section id="admin" className="admin-section" aria-labelledby="admin-title"><div className="section-heading"><div><p className="eyebrow">03 / ADMIN</p><h2 id="admin-title">Behind the counter</h2></div><span className="demo-tag">Demo-only controls</span></div>
        <p className="admin-notice">Admin endpoints are unprotected. These controls are for local demos only.</p>
        <div className="admin-actions"><button className="primary" disabled={adminBusy} onClick={() => void generateCoupons()}>{adminBusy ? 'Loading…' : 'Generate eligible coupons'}</button><button className="secondary" disabled={adminBusy} onClick={() => void loadReport()}>Refresh report</button></div>
        {adminError && <p className="error" role="alert">{adminError}</p>}{generationNote && <p role="status" className="hint">{generationNote}</p>}
        <div className="admin-layout"><div><h3>Rewards generated in this tab</h3>{coupons.length ? <ul className="coupon-list">{coupons.map(coupon => <li key={coupon.id}><div><strong>{coupon.discount_percent}% off</strong><small>Milestone: {coupon.milestone} orders · Single use</small></div><code>{coupon.code}</code></li>)}</ul> : <p className="empty">No new codes in this tab yet. Generate rewards after eligible orders. Previously generated codes aren’t listed by the API.</p>}</div>
          <div><h3>Service summary</h3>{report ? <><dl className="metrics"><div><dt>Successful orders</dt><dd>{report.total_orders}</dd></div><div><dt>Gross revenue</dt><dd>{money(report.gross_revenue_cents)}</dd></div><div><dt>Discounts</dt><dd>{money(report.total_discounts_cents)}</dd></div><div><dt>Net revenue</dt><dd>{money(report.net_revenue_cents)}</dd></div></dl><div className="coupon-counts"><span>Generated <strong>{report.coupons.generated}</strong></span><span>Available <strong>{report.coupons.available}</strong></span><span>Redeemed <strong>{report.coupons.redeemed}</strong></span></div>
            <h4>Purchased quantity by product</h4>{report.purchased_quantity_by_product.length ? <ul className="quantities">{report.purchased_quantity_by_product.map(item => <li key={item.product_id}><span>{products.find(product => product.id === item.product_id)?.name ?? `Product #${item.product_id}`}</span><strong>{item.quantity}</strong></li>)}</ul> : <p className="hint">No purchased items yet.</p>}
          </> : <p className="empty">{adminBusy ? 'Loading report…' : 'Report unavailable. Refresh to try again.'}</p>}</div></div>
      </section>
      <footer>counter <span>A local checkout & rewards demo. All prices shown in USD.</span></footer>
    </main>
  </>;
}
