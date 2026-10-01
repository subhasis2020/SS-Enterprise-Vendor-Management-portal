/* Data service. Every method is async and shaped like a future REST endpoint, so the
   real API (Dapper over bigmartsingur_in_dev) can replace the bodies later without touching the UI.
   All field names are the real DB column names (see mockdata.js). */
(function () {
  const M = window.MOCK;
  const sum = (a, f) => a.reduce((s, x) => s + (+f(x) || 0), 0);
  const byId = (arr, k) => Object.fromEntries(arr.map(x => [x[k], x]));
  const TODAY = M.daily[M.daily.length - 1].SaleDate; // latest day present in the data
  const tick = v => new Promise(r => setTimeout(() => r(v), 60));
  const nextId = arr => (arr.reduce((m, x) => Math.max(m, x.ID || 0), 0) + 1);
  const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);
  const cats = byId(M.Category, 'Id');

  // Sales: real DB has duplicate rows per SaleID in TB_Sale; the API dedupes by SaleID (mock already deduped).
  const lines = M.TB_SaleProduct;

  let mockTodos = [
    { ID: 1, Title: 'Call METRO Cash & Carry about pending invoice', Notes: null, DueDate: TODAY, IsDone: false, CreatedBy: 'mock' },
    { ID: 2, Title: 'Reconcile cash drawer', Notes: 'End of week check', DueDate: TODAY, IsDone: false, CreatedBy: 'mock' },
    { ID: 3, Title: 'Renew store insurance', Notes: null, DueDate: new Date(new Date(TODAY).getTime() + 5 * 864e5).toISOString().slice(0, 10), IsDone: false, CreatedBy: 'mock' },
  ];

  function partyLedger(bills, pays, dateKey, amtKey, payDate) {
    const rows = [
      ...bills.map(b => ({ id: b.ID, date: b[dateKey], time: b.InvoiceTime || b.BillTime || '', type: 'Invoice', ref: b.InvoiceNo || b.BillNo, debit: b[amtKey], credit: 0, due: b.DueDate, mode: null, cheque: null, notes: b.Notes || null })),
      ...pays.map(p => ({ id: p.ID, date: p[payDate], time: p.PaymentTime || '', type: 'Payment', ref: p.PaymentMode + (p.ChequeNo ? ' #' + p.ChequeNo : ''), debit: 0, credit: p.PayAmount, mode: p.PaymentMode, cheque: p.ChequeNo || null, notes: p.Notes || null }))
    ].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    let bal = 0;
    rows.forEach(r => { bal += r.debit - r.credit; r.balance = bal; });
    return rows;
  }

  // Payments are not linked to invoices in the DB, so allocate oldest-first (FIFO).
  function ageing(bills, totalPaid, dateKey, amtKey) {
    let left = totalPaid;
    const open = [];
    [...bills].sort((a, b) => a[dateKey].localeCompare(b[dateKey])).forEach(b => {
      const used = Math.min(left, b[amtKey]); left -= used;
      const rem = b[amtKey] - used;
      if (rem > 0) open.push({ ...b, remaining: rem, age: dayDiff(TODAY, b[dateKey]), overdue: b.DueDate && b.DueDate < TODAY });
    });
    return open;
  }

  const vendorStats = () => M.TB_Supplier.map(s => {
    const inv = M.TB_SupplierInvoice.filter(i => i.SupplierID === s.ID);
    const pay = M.TB_SupplierInvoicePayment.filter(p => p.SupplierID === s.ID);
    const invoiced = sum(inv, i => i.Amount), paid = sum(pay, p => p.PayAmount);
    const open = ageing(inv, paid, 'InvoiceDate', 'Amount');
    return { ...s, invoiced, paid, outstanding: invoiced - paid, overdue: sum(open.filter(o => o.overdue), o => o.remaining), lastInvoice: inv.map(i => i.InvoiceDate).sort().pop() || '' };
  });

  const customerStats = () => M.TB_Customer.map(c => {
    const bills = M.TB_CustomerCredit.filter(b => b.CustomerID === c.ID);
    const pays = M.TB_CustomerCreditPayment.filter(p => p.CustomerID === c.ID);
    const credit = sum(bills, b => b.Amount), paid = sum(pays, p => p.PayAmount);
    const open = ageing(bills, paid, 'BillDate', 'Amount');
    const bucket = (lo, hi) => sum(open.filter(o => o.age >= lo && o.age < hi), o => o.remaining);
    return { ...c, credit, paid, outstanding: credit - paid, b0: bucket(0, 11), b1: bucket(11, 31), b2: bucket(31, 1e9) };
  });

  window.Api = {
    AuthError: class extends Error { }, init: () => Promise.resolve(), me: () => Promise.resolve(sessionStorage.getItem('user') ? { Name: sessionStorage.getItem('user') } : null), reset() { }, logout: () => Promise.resolve(),
    TODAY, cats,
    login: (u, p) => tick(M.TB_User.find(x => x.IsActive && x.UserName === u.trim().toLowerCase() && p === 'admin') || null),

    dashboard() {
      const d = M.daily, last = d[d.length - 1], prev = d[d.length - 2];
      const month = TODAY.slice(0, 7);
      const mtd = d.filter(x => x.SaleDate.startsWith(month));
      const v = vendorStats();
      const supplierName = byId(M.TB_Supplier, 'ID');
      const recentCheques = M.TB_SupplierInvoicePayment.filter(p => p.PaymentMode === 'Cheque')
        .map(p => ({ SupplierID: p.SupplierID, OrganizationName: (supplierName[p.SupplierID] || {}).OrganizationName || '', PayAmount: p.PayAmount, PaymentDate: p.PaymentDate, ChequeNo: p.ChequeNo, PaymentTime: p.PaymentTime }))
        .sort((a, b) => (b.PaymentDate + b.PaymentTime).localeCompare(a.PaymentDate + a.PaymentTime)).slice(0, 5);
      const expenseMtd = sum(M.TB_DailyExpense.filter(e => e.CreatedDate.startsWith(month)), e => e.Amount);
      const metro = v.find(x => (x.OrganizationName || '').toUpperCase() === 'METRO CASH AND CARRY');
      return tick({
        today: last, prev, mtdTotal: sum(mtd, x => x.TotalSale), mtdBills: sum(mtd, x => x.bills),
        vendorDue: sum(v, x => Math.max(0, x.outstanding)),
        metroDue: metro ? metro.outstanding : 0,
        metroId: metro ? metro.ID : null,
        expenseMtd,
        daily: d.filter(x => x.SaleDate.startsWith(month)),
        recentCheques,
      });
    },
    vendorActivity(date) {
      const d = date || TODAY;
      const supplierName = byId(M.TB_Supplier, 'ID');
      const invoices = M.TB_SupplierInvoice.filter(i => i.InvoiceDate === d)
        .map(i => ({ SupplierID: i.SupplierID, OrganizationName: (supplierName[i.SupplierID] || {}).OrganizationName || '', InvoiceNo: i.InvoiceNo, InvoiceTime: i.InvoiceTime, Amount: i.Amount }))
        .sort((a, b) => b.InvoiceTime.localeCompare(a.InvoiceTime));
      const payments = M.TB_SupplierInvoicePayment.filter(p => p.PaymentDate === d)
        .map(p => ({ SupplierID: p.SupplierID, OrganizationName: (supplierName[p.SupplierID] || {}).OrganizationName || '', PaymentTime: p.PaymentTime, PayAmount: p.PayAmount, PaymentMode: p.PaymentMode }))
        .sort((a, b) => b.PaymentTime.localeCompare(a.PaymentTime));
      return tick({ invoices, payments });
    },
    vendorPaymentsMonthly(year) {
      const y = String(year || TODAY.slice(0, 4));
      const totals = Array(12).fill(0);
      M.TB_SupplierInvoicePayment.forEach(p => { if (p.PaymentDate.slice(0, 4) === y) totals[+p.PaymentDate.slice(5, 7) - 1] += p.PayAmount; });
      return tick(totals.map((total, i) => ({ m: i + 1, total })));
    },
    salesMonthly(months) {
      const n = Math.min(Math.max(+months || 12, 1), 36);
      const monthly = {};
      M.daily.forEach(x => { const m = x.SaleDate.slice(0, 7); (monthly[m] = monthly[m] || { m, total: 0, bills: 0 }); monthly[m].total += x.TotalSale; monthly[m].bills += x.bills; });
      return tick(Object.values(monthly).sort((a, b) => a.m.localeCompare(b.m)).slice(-n));
    },
    salesMonth(m) {
      const days = M.daily.filter(x => x.SaleDate.startsWith(m)).map(x => ({ d: x.SaleDate, bills: x.bills, total: x.TotalSale }));
      const saleIds = new Set(M.TB_Sale.filter(s => s.SaleDate.startsWith(m)).map(s => s.SaleID));
      const byProduct = {};
      lines.filter(l => saleIds.has(l.SaleID)).forEach(l => {
        const p = byProduct[l.ProductName] = byProduct[l.ProductName] || { ProductName: l.ProductName, Qty: 0, Revenue: 0 };
        p.Qty += l.Quantity; p.Revenue += (l.POSSalePrice || 0) * l.Quantity;
      });
      const topProducts = Object.values(byProduct).sort((a, b) => b.Revenue - a.Revenue).slice(0, 20);
      return tick({ days, topProducts });
    },

    sales({ from = '', to = '', q = '' } = {}) {
      let r = M.TB_Sale.filter(s => (!from || s.SaleDate >= from) && (!to || s.SaleDate <= to) && (!q || String(s.SaleID).includes(q.trim())));
      r = r.map(s => ({ ...s, PriceMismatch: lines.some(l => l.SaleID === s.SaleID && l.POSSalePrice != null && l.ActualSalePrice !== l.POSSalePrice) ? 1 : 0 }));
      return tick(r);
    },
    saleDetail(id) {
      const s = M.TB_Sale.find(x => x.SaleID === id);
      return tick({ sale: s, items: lines.filter(l => l.SaleID === id) });
    },

    report: () => Promise.reject(new Error('Reports need the real API')),
    vendors: () => tick(vendorStats()),
    vendorCheques() {
      const supplierName = byId(M.TB_Supplier, 'ID');
      const rows = M.TB_SupplierInvoicePayment.filter(p => p.PaymentMode === 'Cheque')
        .map(p => ({ SupplierID: p.SupplierID, OrganizationName: (supplierName[p.SupplierID] || {}).OrganizationName || '', PayAmount: p.PayAmount, PaymentDate: p.PaymentDate, PaymentTime: p.PaymentTime, ChequeNo: p.ChequeNo }))
        .sort((a, b) => (b.PaymentDate + b.PaymentTime).localeCompare(a.PaymentDate + a.PaymentTime));
      return tick(rows);
    },
    createVendor(o) {
      const s = { ID: nextId(M.TB_Supplier), IsActive: true, GSTNO: null, PhoneNo: null, Notes: null, ...o };
      M.TB_Supplier.unshift(s);
      return tick({ ID: s.ID });
    },
    updateVendor(id, o) {
      const s = M.TB_Supplier.find(x => x.ID === id);
      if (!s) return Promise.reject(new Error('Vendor not found'));
      Object.assign(s, o);
      return tick(true);
    },
    vendor(id) {
      const s = M.TB_Supplier.find(x => x.ID === id);
      const inv = M.TB_SupplierInvoice.filter(i => i.SupplierID === id), pay = M.TB_SupplierInvoicePayment.filter(p => p.SupplierID === id);
      return tick({ vendor: s, ledger: partyLedger(inv, pay, 'InvoiceDate', 'Amount', 'PaymentDate'), invoiced: sum(inv, i => i.Amount), paid: sum(pay, p => p.PayAmount) });
    },
    addInvoice(o) { M.TB_SupplierInvoice.unshift({ ID: nextId(M.TB_SupplierInvoice), InvoiceTime: '12:00', ...o }); return tick(true); },
    addVendorPayment(o) { M.TB_SupplierInvoicePayment.unshift({ ID: nextId(M.TB_SupplierInvoicePayment), PaymentTime: '12:00', ChequeNo: null, ...o }); return tick(true); },
    updateInvoice(id, o) {
      const b = M.TB_SupplierInvoice.find(x => x.ID === id);
      if (!b) return Promise.reject(new Error('Invoice not found'));
      Object.assign(b, o); return tick(true);
    },
    updateVendorPayment(id, o) {
      const p = M.TB_SupplierInvoicePayment.find(x => x.ID === id);
      if (!p) return Promise.reject(new Error('Payment not found'));
      Object.assign(p, o); return tick(true);
    },

    customers: () => tick(customerStats()),
    customer(id) {
      const c = M.TB_Customer.find(x => x.ID === id);
      const b = M.TB_CustomerCredit.filter(x => x.CustomerID === id), p = M.TB_CustomerCreditPayment.filter(x => x.CustomerID === id);
      return tick({ customer: c, ledger: partyLedger(b, p, 'BillDate', 'Amount', 'PaymentDate'), credit: sum(b, x => x.Amount), paid: sum(p, x => x.PayAmount) });
    },
    addCreditBill(o) { M.TB_CustomerCredit.unshift({ ID: nextId(M.TB_CustomerCredit), BillTime: '12:00', Notes: null, ...o }); return tick(true); },
    addCustomerPayment(o) { M.TB_CustomerCreditPayment.unshift({ ID: nextId(M.TB_CustomerCreditPayment), PaymentTime: '12:00', Notes: null, ...o }); return tick(true); },

    expenses({ from = '', to = '', q = '' } = {}) {
      const r = M.TB_DailyExpense
        .filter(e => (!from || e.CreatedDate >= from) && (!to || e.CreatedDate <= to) && (!q || (e.Notes || '').toLowerCase().includes(q.trim().toLowerCase())))
        .map((e, i) => ({ ID: i + 1, Amount: e.Amount, Notes: e.Notes, PaymentMode: e.PaymentMode, TransactionID: null, ChequeNo: null, CreatedDate: e.CreatedDate + 'T12:00:00', CreatedBy: 'mock' }))
        .sort((a, b) => b.CreatedDate.localeCompare(a.CreatedDate));
      return tick(r);
    },
    addExpense(o) { M.TB_DailyExpense.unshift({ Amount: o.Amount, Notes: o.Notes, PaymentMode: o.PaymentMode, CreatedDate: TODAY }); return tick(true); },

    todos() { return tick([...mockTodos].sort((a, b) => (a.IsDone - b.IsDone) || a.DueDate.localeCompare(b.DueDate) || a.ID - b.ID)); },
    addTodo(o) { mockTodos.push({ ID: nextId(mockTodos), Title: o.Title, Notes: o.Notes || null, DueDate: o.DueDate, IsDone: false, CreatedBy: 'mock' }); return tick(true); },
    updateTodo(id, o) {
      const t = mockTodos.find(x => x.ID === id);
      if (!t) return Promise.reject(new Error('Todo not found'));
      t.Title = o.Title; t.Notes = o.Notes || null; t.DueDate = o.DueDate; return tick(true);
    },
    toggleTodo(id) { const t = mockTodos.find(x => x.ID === id); if (t) t.IsDone = !t.IsDone; return tick(true); },
    deleteTodo(id) { mockTodos = mockTodos.filter(x => x.ID !== id); return tick(true); },

    products() {
      return tick(M.Product.map(p => ({
        ...p, category: cats[p.product_categoryId].Name,
        margin: p.product_salePrice ? (p.product_salePrice - p.product_unitPrice) / p.product_salePrice * 100 : 0,
        status: p.product_inventory <= 0 ? 'out' : p.product_inventory <= 5 ? 'low' : 'in'
      })));
    },
    productsInsights() {
      const shiftedDate = days => { const d = new Date(TODAY); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); };
      const from30 = shiftedDate(30), from60 = shiftedDate(60);
      const saleDateById = {}; M.TB_Sale.forEach(s => saleDateById[s.SaleID] = s.SaleDate);
      const qty60 = {}, qty30 = {}, rev30 = {};
      lines.forEach(l => {
        const d = saleDateById[l.SaleID]; if (!d) return;
        if (d >= from60) qty60[l.ProductID] = (qty60[l.ProductID] || 0) + l.Quantity;
        if (d >= from30) { qty30[l.ProductID] = (qty30[l.ProductID] || 0) + l.Quantity; rev30[l.ProductID] = (rev30[l.ProductID] || 0) + (l.POSSalePrice || 0) * l.Quantity; }
      });
      const inStock = p => (p.product_inventory || 0) > 0;
      const lowStock = M.Product.filter(p => (p.product_inventory || 0) > 0 && p.product_inventory <= 5)
        .sort((a, b) => a.product_inventory - b.product_inventory || (b.product_sold || 0) - (a.product_sold || 0)).slice(0, 20);
      const outOfStock = M.Product.filter(p => (p.product_inventory || 0) <= 0)
        .sort((a, b) => (b.product_sold || 0) - (a.product_sold || 0)).slice(0, 20);
      const slowMoving = M.Product.filter(p => inStock(p) && !qty60[p.product_Id])
        .map(p => ({ ...p, StockValue: (p.product_inventory || 0) * (p.product_unitPrice || 0) }))
        .sort((a, b) => b.StockValue - a.StockValue).slice(0, 20);
      const topSellers = Object.keys(qty30).map(id => {
        const p = M.Product.find(x => x.product_Id == id);
        return p ? { product_Id: p.product_Id, product_name: p.product_name, QtySold: qty30[id], Revenue: rev30[id] } : null;
      }).filter(Boolean).sort((a, b) => b.QtySold - a.QtySold).slice(0, 15);
      const summary = {
        TotalProducts: M.Product.length,
        LowStockCount: M.Product.filter(p => (p.product_inventory || 0) > 0 && p.product_inventory <= 5).length,
        OutOfStockCount: M.Product.filter(p => (p.product_inventory || 0) <= 0).length,
        SlowMovingCount: M.Product.filter(p => inStock(p) && !qty60[p.product_Id]).length,
        StockValue: M.Product.reduce((s, p) => s + (inStock(p) ? p.product_inventory * (p.product_unitPrice || 0) : 0), 0),
      };
      return tick({ summary, lowStock, outOfStock, topSellers, slowMoving });
    },
    syncPreview: () => Promise.reject(new Error('Product sync needs the live API (not available in ?mock=1).')),
    syncApply: () => Promise.reject(new Error('Product sync needs the live API.')),
    syncLog: () => Promise.resolve([]),
    profit: () => Promise.reject(new Error('The profit report needs the live API (not available in ?mock=1).')),
    categories: () => M.Category,
    suppliers: () => M.TB_Supplier,
    customerList: () => M.TB_Customer,
  };
})();
