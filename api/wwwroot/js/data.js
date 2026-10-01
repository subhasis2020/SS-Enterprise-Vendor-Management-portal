/* Data service backed by the real API (/api/*). Same surface as data.mock.js so the UI is unchanged. */
(function () {
  class AuthError extends Error { }
  async function req(method, url, body) {
    return handle(await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }));
  }
  async function handle(r) {
    if (r.status === 401) throw new AuthError('Session expired');
    if (r.status === 403) throw new Error('This action needs an admin account.');
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { }
    if (!r.ok) throw new Error((data && data.error) || 'Request failed (' + r.status + ')');
    return data;
  }
  const get = url => req('GET', url);
  const post = (url, b) => req('POST', url, b);
  const qs = o => { const p = new URLSearchParams(); Object.entries(o || {}).forEach(([k, v]) => v && p.set(k, v)); const s = p.toString(); return s ? '?' + s : ''; };

  let ready = null, suppliers = [], customerList = [], categories = [];

  const A = window.Api = {
    AuthError, TODAY: new Date().toISOString().slice(0, 10), cats: {},
    init() {
      return ready || (ready = Promise.all([get('/api/meta'), get('/api/suppliers'), get('/api/customer-list'), get('/api/categories')])
        .then(([m, s, c, k]) => { A.TODAY = m.today; suppliers = s; customerList = c; categories = k; A.cats = Object.fromEntries(k.map(x => [x.Id, x])); })
        .catch(e => { ready = null; throw e; }));
    },
    reset() { ready = null; },
    async login(u, p) {
      const r = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: u, Password: p }) });
      if (r.status === 401) return null;
      if (!r.ok) throw new Error('Login failed (' + r.status + ')');
      return r.json();
    },
    async me() {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (r.status === 401) return null;
      if (!r.ok) throw new Error('me failed');
      return r.json();
    },
    logout: () => post('/api/logout').catch(() => { }).finally(() => A.reset()),

    dashboard: () => get('/api/dashboard'),
    vendorActivity: date => get('/api/dashboard/vendor-activity' + qs({ date })),
    vendorPaymentsMonthly: year => get('/api/dashboard/vendor-payments-monthly' + qs({ year })),
    sales: f => get('/api/sales' + qs({ from: f.from, to: f.to, q: f.q })),
    saleDetail: id => get('/api/sales/' + id),
    salesMonthly: months => get('/api/sales/monthly' + qs({ months })),
    salesMonth: m => get('/api/sales/month/' + m),

    vendors: () => get('/api/vendors'),
    vendor: id => get('/api/vendors/' + id),
    report: (name, from, to) => get('/api/reports/' + name + qs({ from, to })),
    vendorCheques: () => get('/api/vendors/cheques'),
    createVendor: o => post('/api/vendors', o),
    updateVendor: (id, o) => post('/api/vendors/' + id + '/edit', o),
    addInvoice: o => post('/api/vendors/invoices', o),
    addVendorPayment: o => post('/api/vendors/payments', o),
    updateInvoice: (id, o) => post('/api/vendors/invoices/' + id + '/edit', o),
    updateVendorPayment: (id, o) => post('/api/vendors/payments/' + id + '/edit', o),

    customers: () => get('/api/customers'),
    customer: id => get('/api/customers/' + id),
    addCreditBill: o => post('/api/customers/credits', o),
    addCustomerPayment: o => post('/api/customers/payments', o),

    expenses: f => get('/api/expenses' + qs({ from: f.from, to: f.to, q: f.q })),
    addExpense: o => post('/api/expenses', o),

    todos: () => get('/api/todos'),
    addTodo: o => post('/api/todos', o),
    updateTodo: (id, o) => post('/api/todos/' + id + '/edit', o),
    toggleTodo: id => post('/api/todos/' + id + '/toggle'),
    deleteTodo: id => post('/api/todos/' + id + '/delete'),

    async products() {
      await A.init();
      return (await get('/api/products')).map(p => ({
        ...p, category: (A.cats[p.product_categoryId] || { Name: 'Uncategorized' }).Name,
        margin: p.product_salePrice ? (p.product_salePrice - p.product_unitPrice) / p.product_salePrice * 100 : 0,
        status: p.product_inventory <= 0 ? 'out' : p.product_inventory <= 5 ? 'low' : 'in'
      }));
    },
    productsInsights: () => get('/api/products/insights'),
    syncPreview(file) { const fd = new FormData(); fd.append('file', file); return fetch('/api/products/sync/preview', { method: 'POST', credentials: 'same-origin', body: fd }).then(handle); },
    syncApply: o => post('/api/products/sync/apply', o).then(r => { A.reset(); return r; }),
    syncLog: () => get('/api/products/sync/log'),
    profit: (month, basis) => get('/api/profit' + qs({ month, basis })),
    categories: () => categories,
    suppliers: () => suppliers,
    customerList: () => customerList,
  };
})();
