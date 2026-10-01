(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = n => '₹' + Math.round(+n || 0).toLocaleString('en-IN');
  const inr2 = n => '₹' + (+n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = n => (+n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const fmtDate = d => d ? new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const short = d => new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { } } };
  let charts = [];

  /* ---------- theme ---------- */
  function applyTheme(t) { if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }
  applyTheme(store.get('theme'));
  const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#themeBtn').onclick = () => { const t = isDark() ? 'light' : 'dark'; applyTheme(t); store.set('theme', t); route(); };

  /* ---------- sidebar collapse ---------- */
  const applyCollapsed = v => $('#shell').classList.toggle('collapsed', v);
  applyCollapsed(store.get('sideCollapsed') === '1');
  $('#collapseBtn').onclick = () => {
    const v = !$('#shell').classList.contains('collapsed');
    applyCollapsed(v);
    store.set('sideCollapsed', v ? '1' : '0');
  };

  /* ---------- ui helpers ---------- */
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2200); }
  function modal(html, wide) { $('#modalCard').className = 'modal-card' + (wide ? ' wide' : ''); $('#modalCard').innerHTML = html; $('#modal').classList.remove('hidden'); }
  function closeModal() { $('#modal').classList.add('hidden'); }
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  const opts = (arr, v, l, sel) => arr.map(x => `<option value="${esc(x[v])}"${String(x[v]) === String(sel) ? ' selected' : ''}>${esc(x[l])}</option>`).join('');
  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  function download(name, rows) {
    const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = name; a.click();
  }
  function paged(rows, page, per) { const pages = Math.max(1, Math.ceil(rows.length / per)); page = Math.min(Math.max(1, page), pages); return { page, pages, slice: rows.slice((page - 1) * per, page * per) }; }
  const pager = (p, total, per) => `<div class="pager"><span>${total ? (p.page - 1) * per + 1 : 0}–${Math.min(total, p.page * per)} of ${total}</span><span><button class="btn sm" data-pg="${p.page - 1}" ${p.page <= 1 ? 'disabled' : ''}>Prev</button> <button class="btn sm" data-pg="${p.page + 1}" ${p.page >= p.pages ? 'disabled' : ''}>Next</button></span></div>`;

  /* ---------- charts ---------- */
  function baseOpts() {
    const ink = cssv('--ink-2'), grid = cssv('--grid');
    return {
      responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: cssv('--ink'), titleColor: cssv('--surface'), bodyColor: cssv('--surface'), padding: 10, cornerRadius: 8 } },
      scales: { x: { grid: { display: false }, border: { color: cssv('--axis') }, ticks: { color: ink, maxRotation: 0, autoSkipPadding: 14 } }, y: { grid: { color: grid }, border: { display: false }, ticks: { color: ink, callback: v => v >= 1e5 ? '₹' + (v / 1e5) + 'L' : v >= 1e3 ? '₹' + (v / 1e3) + 'k' : '₹' + v } } }
    };
  }
  function chart(id, cfg) { const c = new Chart($('#' + id), cfg); charts.push(c); return c; }
  const killCharts = () => { charts.forEach(c => { try { c.destroy(); } catch { } }); charts = []; };
  function redrawChart(id, cfg) {
    const i = charts.findIndex(c => c.canvas && c.canvas.id === id);
    if (i >= 0) { try { charts[i].destroy(); } catch { } charts.splice(i, 1); }
    return chart(id, cfg);
  }
  const compactInr = n => n >= 1e5 ? '₹' + (n / 1e5).toFixed(1) + 'L' : n >= 1e3 ? '₹' + (n / 1e3).toFixed(1) + 'k' : '₹' + Math.round(n);
  const barValueLabels = {
    id: 'barValueLabels',
    afterDatasetsDraw(c) {
      const { ctx } = c;
      c.data.datasets.forEach((ds, di) => {
        c.getDatasetMeta(di).data.forEach((bar, i) => {
          const v = ds.data[i];
          if (!v) return;
          ctx.save();
          ctx.fillStyle = cssv('--ink-2');
          ctx.font = '600 11px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(compactInr(v), bar.x, bar.y - 4);
          ctx.restore();
        });
      });
    }
  };

  /* ---------- pages ---------- */
  const pages = {};

  function vendorActivityPanels(va) {
    const payCash = va.payments.filter(p => p.PaymentMode === 'Cash').reduce((s, p) => s + p.PayAmount, 0);
    const payTotal = va.payments.reduce((s, p) => s + p.PayAmount, 0);
    const payOnline = payTotal - payCash;
    return `
      <div class="tabbar">
        <button data-tab="inv">Invoices added (${va.invoices.length})</button>
        <button class="on" data-tab="pay">Payments made (${va.payments.length})</button>
      </div>
      <div class="hidden" data-panel="inv"><div class="table-wrap"><table><thead><tr><th>Vendor</th><th>Invoice no.</th><th>Time</th><th class="num">Amount</th></tr></thead><tbody>
        ${va.invoices.map(i => `<tr class="click" data-v="${i.SupplierID}"><td class="wrap caps">${esc(i.OrganizationName)}</td><td>${esc(i.InvoiceNo)}</td><td>${esc(i.InvoiceTime)}</td><td class="num neg"><b>${inr2(i.Amount)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No invoices added on this date.</td></tr>'}
      </tbody></table></div></div>
      <div data-panel="pay">
        <div class="chips"><div class="chip"><b>${inr2(payTotal)}</b><span>total payment</span></div><div class="chip"><b>${inr2(payCash)}</b><span>cash payment</span></div><div class="chip"><b>${inr2(payOnline)}</b><span>online payment</span></div></div>
        <div class="table-wrap"><table><thead><tr><th>Vendor</th><th>Time</th><th>Mode</th><th class="num">Amount</th></tr></thead><tbody>
        ${va.payments.map(p => `<tr class="click" data-v="${p.SupplierID}"><td class="wrap caps">${esc(p.OrganizationName)}</td><td>${esc(p.PaymentTime)}</td><td>${esc(p.PaymentMode)}</td><td class="num pos"><b>${inr2(p.PayAmount)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No payments made on this date.</td></tr>'}
        </tbody></table></div>
      </div>`;
  }
  function wireVendorActivityTabs() {
    $$('#vaCard .tabbar button').forEach(b => b.onclick = () => {
      $$('#vaCard .tabbar button').forEach(x => x.classList.toggle('on', x === b));
      $$('#vaCard [data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
    });
    $$('#vaCard tr[data-v]').forEach(tr => tr.onclick = () => location.hash = '#/vendors/' + tr.dataset.v);
  }
  async function loadVendorActivity(date) {
    const va = await Api.vendorActivity(date);
    $('#vaCard').innerHTML = vendorActivityPanels(va);
    wireVendorActivityTabs();
  }

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function drawVendorPaymentsChart(rows) {
    const s1 = cssv('--s1'), o = baseOpts();
    o.scales.y.beginAtZero = true;
    o.scales.y.suggestedMax = Math.max(1, ...rows.map(x => x.total)) * 1.15; // headroom so the value label above each bar isn't clipped
    redrawChart('c2', {
      type: 'bar', data: { labels: MONTH_NAMES, datasets: [{ data: rows.map(x => x.total), backgroundColor: s1, borderRadius: 4, maxBarThickness: 48 }] },
      options: { ...o, plugins: { ...o.plugins, tooltip: { ...o.plugins.tooltip, callbacks: { label: c => ' ' + inr(c.parsed.y) } } } },
      plugins: [barValueLabels]
    });
  }
  async function loadVendorPaymentsMonthly(year) {
    drawVendorPaymentsChart(await Api.vendorPaymentsMonthly(year));
  }

  pages.dashboard = async () => {
    const st = pages.dashboard.st = pages.dashboard.st || { vaDate: Api.TODAY, vpYear: +Api.TODAY.slice(0, 4) };
    const [d, va, vp, allTodos] = await Promise.all([Api.dashboard(), Api.vendorActivity(st.vaDate), Api.vendorPaymentsMonthly(st.vpYear), Api.todos()]);
    const vpYears = Array.from({ length: 5 }, (_, i) => +Api.TODAY.slice(0, 4) - i);
    const openTodos = allTodos.filter(t => !t.IsDone).slice(0, 8);
    const chg = d.prev ? (d.today.TotalSale - d.prev.TotalSale) / d.prev.TotalSale * 100 : 0;
    $('#view').innerHTML = `
      <div class="grid kpis">
        <div class="card kpi accent click" data-nav="sales"><div class="label">Today's sales</div><div class="val">${inr(d.today.TotalSale)}</div><div class="delta ${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}% vs previous day</div></div>
        <div class="card kpi click" data-nav="vendorDue"><div class="label">Vendor dues</div><div class="val neg">${inr(d.vendorDue)}</div><div class="delta">outstanding</div></div>
        <div class="card kpi click" data-nav="mtd"><div class="label">Month to date</div><div class="val">${inr(d.mtdTotal)}</div><div class="delta">${num(d.mtdBills)} bills</div></div>
        <div class="card kpi click" data-nav="expenses"><div class="label">Expenses</div><div class="val">${inr(d.expenseMtd)}</div><div class="delta">this month</div></div>
        <div class="card kpi${d.metroId ? ' click' : ''}" data-nav="metro"><div class="label">Metro Cash &amp; Carry</div><div class="val neg">${inr(d.metroDue)}</div><div class="delta">vendor due</div></div>
      </div>
      ${openTodos.length ? `
      <div class="card">
        <div class="toolbar" style="margin-bottom:0"><div class="grow"><h3>To-do</h3><div class="sub">${openTodos.length} open</div></div><div class="end"><button class="btn sm" id="ntDash">+ Task</button></div></div>
        <div class="table-wrap"><table><thead><tr><th>Task</th><th>Due date</th><th>Notes</th><th class="chk">Done</th></tr></thead><tbody>
        ${openTodos.map(t => `<tr class="click" data-edit="${t.ID}"><td class="wrap">${esc(t.Title)}${dotIfToday(t)}</td><td>${fmtDate(t.DueDate)}</td><td class="wrap sm muted">${esc(t.Notes || '—')}</td><td class="chk"><input type="checkbox" data-dtoggle="${t.ID}"></td></tr>`).join('')}
        </tbody></table></div>
        <a class="back" style="margin:12px 0 0" href="#/todos">View all tasks →</a>
      </div>` : ''}
      <div class="card" style="margin-top:16px">
        <div class="toolbar" style="margin-bottom:0"><div class="grow"><h3>Vendor activity</h3><div class="sub" id="vaDateLabel">${fmtDate(st.vaDate)}</div></div><label style="flex:0 0 auto">Date<input type="date" id="vaDate" value="${st.vaDate}" max="${Api.TODAY}"></label></div>
        <div id="vaCard">${vendorActivityPanels(va)}</div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="toolbar" style="margin-bottom:0"><div class="grow"><h3>Last cheques</h3><div class="sub">Cheque date in the last 5 days or upcoming</div></div></div>
        <div class="table-wrap"><table><thead><tr><th>Vendor</th><th>Cheque no.</th><th>Date</th><th class="num">Amount</th></tr></thead><tbody>
          ${d.recentCheques.map(x => `<tr class="click" data-v="${x.SupplierID}"><td class="wrap caps">${esc(x.OrganizationName)}</td><td>${esc(x.ChequeNo || '—')}</td><td>${fmtDate(x.PaymentDate)}</td><td class="num pos"><b>${inr2(x.PayAmount)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No cheques dated in the last 5 days or upcoming.</td></tr>'}
        </tbody></table></div>
        <a class="back" style="margin:12px 0 0" href="#/cheques">View all cheque details →</a>
      </div>
      <div class="card" style="margin-top:16px"><h3>Daily sales</h3><div class="sub">Last 30 days · one row per bill (duplicates in TB_Sale removed)</div><div class="chart-box tall"><canvas id="c1"></canvas></div></div>
      <div class="card" style="margin-top:16px">
        <div class="toolbar" style="margin-bottom:0"><div class="grow"><h3>Vendor payments by month</h3><div class="sub" id="vpYearLabel">${st.vpYear}</div></div><label style="flex:0 0 auto">Year<select id="vpYear">${vpYears.map(y => `<option value="${y}" ${y === st.vpYear ? 'selected' : ''}>${y}</option>`).join('')}</select></label></div>
        <div class="chart-box tall"><canvas id="c2"></canvas></div>
      </div>`;
    const s1 = cssv('--s1'), o = baseOpts();
    const tip = (fmt) => ({ ...o.plugins, tooltip: { ...o.plugins.tooltip, callbacks: { label: c => ' ' + fmt(c.parsed.y ?? c.parsed.x) } } });
    o.scales.y.beginAtZero = true;
    chart('c1', { type: 'line', data: { labels: d.daily.map(x => short(x.SaleDate)), datasets: [{ data: d.daily.map(x => x.TotalSale), borderColor: s1, backgroundColor: s1 + '22', fill: true, borderWidth: 2, tension: .3, pointRadius: 3, pointBackgroundColor: s1, pointBorderColor: cssv('--surface'), pointBorderWidth: 1, pointHoverRadius: 5, pointHoverBackgroundColor: s1, pointHoverBorderColor: cssv('--surface'), pointHoverBorderWidth: 2 }] }, options: { ...o, plugins: tip(inr) } });
    drawVendorPaymentsChart(vp);
    wireVendorActivityTabs();
    $('#vaDate').onchange = e => {
      st.vaDate = e.target.value || Api.TODAY;
      $('#vaDateLabel').textContent = fmtDate(st.vaDate);
      loadVendorActivity(st.vaDate);
    };
    $('#vpYear').onchange = e => {
      st.vpYear = +e.target.value;
      $('#vpYearLabel').textContent = st.vpYear;
      loadVendorPaymentsMonthly(st.vpYear);
    };
    if ($('#ntDash')) $('#ntDash').onclick = () => todoModal();
    $$('[data-dtoggle]').forEach(cb => cb.onclick = e => {
      e.preventDefault(); e.stopPropagation();
      const t = openTodos.find(x => x.ID === +cb.dataset.dtoggle);
      confirmModal(`Mark "${t.Title}" as done?`, async () => { await Api.toggleTodo(t.ID); pages.dashboard(); });
    });
    $$('#view .card tr[data-edit]').forEach(tr => tr.onclick = () => todoModal(openTodos.find(t => t.ID === +tr.dataset.edit)));
    $$('[data-nav]').forEach(card => card.onclick = () => {
      switch (card.dataset.nav) {
        case 'sales': location.hash = '#/sales'; break;
        case 'mtd': location.hash = '#/trend/' + Api.TODAY.slice(0, 7); break;
        case 'expenses': location.hash = '#/expenses'; break;
        case 'vendorDue': pages.vendors.st = { q: '', only: true, page: 1 }; location.hash = '#/vendors'; break;
        case 'metro': if (d.metroId) location.hash = '#/vendors/' + d.metroId; break;
      }
    });
    $$('tr[data-v]').forEach(tr => tr.onclick = () => location.hash = '#/vendors/' + tr.dataset.v);
  };

  function monthLabel(m) { return new Date(m + '-01').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }); }
  function openMonth(m) { location.hash = '#/trend/' + m; }
  function goToSalesDate(d) { pages.sales.st = { date: d, q: '', page: 1 }; location.hash = '#/sales'; }

  async function trendMonth(m) {
    const d = await Api.salesMonth(m);
    const monthName = new Date(m + '-01T00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const totalSale = d.days.reduce((s, x) => s + x.total, 0), totalBills = d.days.reduce((s, x) => s + x.bills, 0);
    const best = d.days.reduce((b, x) => (!b || x.total > b.total) ? x : b, null);
    $('#view').innerHTML = `
      <a class="back" href="#/trend">← Sales by month</a>
      <div class="toolbar"><div class="grow"><h3 style="font-size:20px">${esc(monthName)}</h3></div></div>
      <div class="chips">
        <div class="chip"><b>${inr(totalSale)}</b><span>total sale</span></div>
        <div class="chip"><b>${num(totalBills)}</b><span>bills</span></div>
        <div class="chip"><b>${inr(d.days.length ? totalSale / d.days.length : 0)}</b><span>avg per day</span></div>
        <div class="chip"><b>${best ? fmtDate(best.d) : '—'}</b><span>best day</span></div>
      </div>
      <div class="card" style="margin-top:16px"><h3>Daily sales</h3><div class="sub">Click a day to see that day's bills</div><div class="chart-box xl"><canvas id="tm1"></canvas></div></div>
      <div class="grid two even" style="margin-top:16px">
        <div class="card"><h3>Top 20 products</h3><div class="sub">${esc(monthName)} · by revenue (POS price)</div><div class="chart-box xl"><canvas id="tm2"></canvas></div></div>
        <div class="card"><h3>Day by day</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Bills</th><th class="num">Total</th></tr></thead><tbody>
          ${[...d.days].reverse().map(x => `<tr class="click" data-d="${x.d}"><td>${fmtDate(x.d)}</td><td class="num">${num(x.bills)}</td><td class="num"><b>${inr(x.total)}</b></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No sales this month.</td></tr>'}
        </tbody></table></div></div>
      </div>`;
    const o = baseOpts(), s1 = cssv('--s1');
    o.scales.y.beginAtZero = true;
    chart('tm1', {
      type: 'line', data: { labels: d.days.map(x => short(x.d)), datasets: [{ data: d.days.map(x => x.total), borderColor: s1, backgroundColor: s1 + '22', fill: true, borderWidth: 2, tension: .3, pointRadius: 3, pointBackgroundColor: s1, pointBorderColor: cssv('--surface'), pointBorderWidth: 1, pointHoverRadius: 6, pointHoverBackgroundColor: s1, pointHoverBorderColor: cssv('--surface'), pointHoverBorderWidth: 2 }] },
      options: {
        ...o, onClick: (_, els) => { if (els.length) goToSalesDate(d.days[els[0].index].d); }, onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        plugins: { ...o.plugins, tooltip: { ...o.plugins.tooltip, callbacks: { label: c => [' ' + inr(c.parsed.y), `${num(d.days[c.dataIndex].bills)} bills`] } } }
      }
    });
    const ho = { ...o, indexAxis: 'y', scales: { x: { ...o.scales.y }, y: { ...o.scales.x, ticks: { color: cssv('--ink-2') } } } };
    const cut = n => n.length > 24 ? n.slice(0, 23) + '…' : n;
    chart('tm2', {
      type: 'bar', data: { labels: d.topProducts.map(p => cut(p.ProductName)), datasets: [{ data: d.topProducts.map(p => p.Revenue), backgroundColor: s1, borderRadius: 3, maxBarThickness: 16 }] },
      options: { ...ho, plugins: { ...ho.plugins, tooltip: { ...ho.plugins.tooltip, callbacks: { label: c => [' ' + inr(c.parsed.x), `${num(d.topProducts[c.dataIndex].Qty)} sold`] } } } }
    });
    $$('tr[data-d]').forEach(tr => tr.onclick = () => goToSalesDate(tr.dataset.d));
  }

  pages.trend = async (m) => {
    if (m) return trendMonth(m);
    const st = pages.trend.st = pages.trend.st || { months: 12 };
    const rows = await Api.salesMonthly(st.months);
    $('#view').innerHTML = `
      <div class="toolbar">
        <label>Range<select id="rng">${[6, 12, 24, 36].map(n => `<option value="${n}" ${st.months === n ? 'selected' : ''}>Last ${n} months</option>`).join('')}</select></label>
        <div class="end"><button class="btn" id="fx">Export CSV</button></div>
      </div>
      <div class="card"><h3>Sales by month</h3><div class="sub">Click a bar or a row to see that month's bills</div><div class="chart-box xl"><canvas id="c1"></canvas></div></div>
      <div class="card" style="margin-top:16px"><div class="table-wrap"><table><thead><tr><th>Month</th><th class="num">Bills</th><th class="num">Total sale</th><th class="num">Avg bill</th><th class="num">vs prev month</th></tr></thead><tbody>
        ${rows.map((x, i) => {
      const prevRow = rows[i - 1];
      const chg = prevRow && prevRow.total ? (x.total - prevRow.total) / prevRow.total * 100 : null;
      return `<tr class="click" data-m="${x.m}"><td><b>${monthLabel(x.m)}</b></td><td class="num">${num(x.bills)}</td><td class="num"><b>${inr(x.total)}</b></td><td class="num">${inr(x.bills ? x.total / x.bills : 0)}</td><td class="num ${chg === null ? 'muted' : chg >= 0 ? 'pos' : 'neg'}">${chg === null ? '—' : `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}%`}</td></tr>`;
    }).reverse().join('') || '<tr><td colspan="5" class="muted">No sales in range.</td></tr>'}
      </tbody></table></div></div>`;
    const s1 = cssv('--s1'), o = baseOpts();
    o.scales.y.beginAtZero = true;
    chart('c1', {
      type: 'bar', data: { labels: rows.map(x => monthLabel(x.m)), datasets: [{ data: rows.map(x => x.total), backgroundColor: s1, borderRadius: 4, maxBarThickness: 48 }] },
      options: {
        ...o, onClick: (_, els) => { if (els.length) openMonth(rows[els[0].index].m); }, onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        plugins: { ...o.plugins, tooltip: { ...o.plugins.tooltip, callbacks: { label: c => [' ' + inr(c.parsed.y), ` ${num(rows[c.dataIndex].bills)} bills`] } } }
      }
    });
    $('#rng').onchange = e => { st.months = +e.target.value; pages.trend(); };
    $('#fx').onclick = () => download('sales-by-month.csv', [['Month', 'Bills', 'TotalSale'], ...rows.map(x => [x.m, x.bills, x.total])]);
    $$('tr[data-m]').forEach(tr => tr.onclick = () => openMonth(tr.dataset.m));
  };

  pages.sales = async () => {
    const st = pages.sales.st = pages.sales.st || { date: Api.TODAY, q: '', page: 1 };
    const per = 15;
    const rows = await Api.sales({ from: st.date, to: st.date, q: st.q });
    const p = paged(rows, st.page, per);
    const totalSale = rows.reduce((s, r) => s + r.TotalSale, 0);
    $('#view').innerHTML = `
      <div class="toolbar">
        <label>Date<input type="date" id="f1" value="${st.date}"></label>
        <label class="grow">Bill no.<input id="f3" placeholder="Search SaleID (searches all dates)" value="${esc(st.q)}"></label>
      </div>
      <div class="chips"><div class="chip"><b>${inr2(totalSale)}</b><span>total sales amount</span></div></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Bill (SaleID)</th><th>Date &amp; time</th><th class="num">Qty</th><th class="num">Discount</th><th class="num">Total</th></tr></thead><tbody>
      ${p.slice.map(r => `<tr class="click${r.PriceMismatch ? ' flag' : ''}" data-id="${r.SaleID}"><td><b>#${r.SaleID}</b></td><td>${fmtDate(r.SaleDate)} · ${esc(r.SaleDateTime.slice(11, 16))}</td><td class="num">${num(r.Quantity)}</td><td class="num">${r.TotalDiscount ? inr2(r.TotalDiscount) : '—'}</td><td class="num"><b>${inr2(r.TotalSale)}</b></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No bills match.</td></tr>'}
      </tbody></table></div>${pager(p, rows.length, per)}</div>`;
    const set = () => { st.date = $('#f1').value; st.q = $('#f3').value; st.page = 1; pages.sales(); };
    $('#f1').onchange = set;
    $('#f3').onkeydown = e => { if (e.key === 'Enter') set(); };
    $$('[data-pg]').forEach(b => b.onclick = () => { st.page = +b.dataset.pg; pages.sales(); });
    $$('tr[data-id]').forEach(tr => tr.onclick = async () => {
      const { sale, items } = await Api.saleDetail(+tr.dataset.id);
      modal(`<h3>Bill #${sale.SaleID}</h3><div class="muted">${fmtDate(sale.SaleDate)} · ${sale.SaleDateTime.slice(11, 16)} · ${items.length} items</div>
        <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">POS price</th><th class="num">Actual price</th><th class="num">Diff</th><th class="num">Diff %</th><th class="num">Line total</th></tr></thead><tbody>
        ${items.map(i => {
      const mismatch = i.POSSalePrice != null && i.ActualSalePrice !== i.POSSalePrice;
      const diff = mismatch ? i.ActualSalePrice - i.POSSalePrice : 0;
      const diffPct = mismatch && i.POSSalePrice ? diff / i.POSSalePrice * 100 : null;
      return `<tr class="${mismatch ? 'flag' : ''}"><td class="wrap">${esc(i.ProductName)}</td><td class="num">${num(i.Quantity)}</td><td class="num">${inr2(i.POSSalePrice)}</td><td class="num">${inr2(i.ActualSalePrice)}</td><td class="num">${mismatch ? inr2(diff) : '—'}</td><td class="num">${diffPct === null ? '—' : diffPct.toFixed(1) + '%'}</td><td class="num">${inr2(i.POSSalePrice * i.Quantity)}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No line items stored for this bill.</td></tr>'}
        </tbody></table></div>
        <div class="chips" style="margin-top:14px"><div class="chip"><b>${inr2(sale.TotalSale)}</b><span>bill total</span></div><div class="chip"><b>${inr2(items.reduce((s, i) => s + (i.POSSalePrice != null ? (i.ActualSalePrice - i.POSSalePrice) * i.Quantity : 0), 0))}</b><span>total difference</span></div></div>
        <div class="modal-actions"><button class="btn" data-close>Close</button></div>`, true);
    });
  };

  pages.cheques = async () => {
    const st = pages.cheques.st = pages.cheques.st || { q: '', only: 'all' };
    const rows = await Api.vendorCheques();
    const todayStr = Api.TODAY;
    const map = {};
    rows.forEach(r => { (map[r.SupplierID] = map[r.SupplierID] || { id: r.SupplierID, name: r.OrganizationName, rows: [] }).rows.push(r); });
    let groups = Object.values(map).map(g => {
      const upcoming = g.rows.filter(r => r.PaymentDate >= todayStr).sort((a, b) => a.PaymentDate.localeCompare(b.PaymentDate));
      return { ...g, total: g.rows.reduce((s, r) => s + r.PayAmount, 0), upcoming, upcomingTotal: upcoming.reduce((s, r) => s + r.PayAmount, 0) };
    });
    if (st.q) groups = groups.filter(g => g.name.toLowerCase().includes(st.q.trim().toLowerCase()));
    if (st.only === 'upcoming') groups = groups.filter(g => g.upcoming.length);
    groups.sort((a, b) => (!!a.upcoming.length !== !!b.upcoming.length) ? b.upcoming.length - a.upcoming.length
      : a.upcoming.length && b.upcoming.length ? a.upcoming[0].PaymentDate.localeCompare(b.upcoming[0].PaymentDate) : b.total - a.total);
    $('#view').innerHTML = `
      <div class="toolbar">
        <label class="grow">Vendor<input id="f1" placeholder="Search vendor" value="${esc(st.q)}"></label>
        <label>Show<select id="f2"><option value="all" ${st.only === 'all' ? 'selected' : ''}>All vendors</option><option value="upcoming" ${st.only === 'upcoming' ? 'selected' : ''}>With upcoming cheques</option></select></label>
        <div class="end"><button class="btn" id="fx">Export CSV</button></div>
      </div>
      ${groups.map(g => `
        <details class="acc" ${g.upcoming.length ? 'open' : ''}>
          <summary>
            <span class="acc-name caps">${esc(g.name)}</span>
            <span class="acc-meta">${g.rows.length} cheque${g.rows.length === 1 ? '' : 's'} · ${inr(g.total)}</span>
            ${g.upcoming.length ? `<span class="pill warn">${g.upcoming.length} upcoming</span>` : ''}
          </summary>
          <div class="table-wrap"><table><thead><tr><th>Cheque no.</th><th>Date</th><th class="num">Amount</th></tr></thead><tbody>
            ${g.rows.map(r => `<tr><td>${esc(r.ChequeNo || '—')}</td><td>${fmtDate(r.PaymentDate)}</td><td class="num">${inr2(r.PayAmount)}</td></tr>`).join('')}
          </tbody></table></div>
        </details>`).join('') || '<div class="card muted">No vendors match.</div>'}`;
    const setFilter = () => { st.q = $('#f1').value; st.only = $('#f2').value; pages.cheques(); };
    $('#f1').onkeydown = e => { if (e.key === 'Enter') setFilter(); };
    $('#f2').onchange = setFilter;
    $('#fx').onclick = () => download('vendor-cheques.csv', [['Vendor', 'ChequeNo', 'Date', 'Amount'], ...rows.map(r => [r.OrganizationName, r.ChequeNo, r.PaymentDate, r.PayAmount])]);
  };

  pages.expenses = async () => {
    const st = pages.expenses.st = pages.expenses.st || { from: '', to: '', q: '', page: 1 }, per = 15;
    const rows = await Api.expenses(st);
    const p = paged(rows, st.page, per);
    const total = rows.reduce((s, r) => s + r.Amount, 0);
    const month = Api.TODAY.slice(0, 7), mtd = rows.filter(r => r.CreatedDate.slice(0, 7) === month).reduce((s, r) => s + r.Amount, 0);
    $('#view').innerHTML = `
      <div class="toolbar">
        <label>From<input type="date" id="f1" value="${st.from}"></label>
        <label>To<input type="date" id="f2" value="${st.to}"></label>
        <label class="grow">Search<input id="f3" placeholder="Search notes" value="${esc(st.q)}"></label>
        <div class="end"><button class="btn" id="ae">+ Add expense</button><button class="btn" id="fx">Export CSV</button></div>
      </div>
      <div class="chips">
        <div class="chip"><b>${inr(total)}</b><span>total expenses</span></div>
        <div class="chip"><b>${rows.length}</b><span>entries</span></div>
        <div class="chip"><b>${inr(rows.length ? total / rows.length : 0)}</b><span>avg per entry</span></div>
        <div class="chip"><b>${inr(mtd)}</b><span>this month</span></div>
      </div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Date</th><th>Notes</th><th>Mode</th><th class="num">Amount</th></tr></thead><tbody>
      ${p.slice.map(r => `<tr><td>${fmtDate(r.CreatedDate.slice(0, 10))} · ${r.CreatedDate.slice(11, 16)}</td><td class="wrap">${esc(r.Notes || '—')}</td><td>${esc(r.PaymentMode)}</td><td class="num neg"><b>${inr2(r.Amount)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No expenses match.</td></tr>'}
      </tbody></table></div>${pager(p, rows.length, per)}</div>`;
    const set = () => { st.from = $('#f1').value; st.to = $('#f2').value; st.q = $('#f3').value; st.page = 1; pages.expenses(); };
    ['f1', 'f2'].forEach(i => $('#' + i).onchange = set);
    $('#f3').onkeydown = e => { if (e.key === 'Enter') set(); };
    $('#fx').onclick = () => download('expenses.csv', [['Date', 'Notes', 'PaymentMode', 'Amount'], ...rows.map(r => [r.CreatedDate, r.Notes, r.PaymentMode, r.Amount])]);
    $$('[data-pg]').forEach(b => b.onclick = () => { st.page = +b.dataset.pg; pages.expenses(); });
    $('#ae').onclick = () => expenseModal();
  };
  function expenseModal() {
    formModal('Add expense', `
      <div class="row2"><label>Amount (₹)<input type="number" id="m_amt" min="1" step="0.01" required></label><label>Payment mode<select id="m_mode"><option>Cash</option><option>UPI</option><option>Cheque</option><option>Card</option></select></label></div>
      <label>Notes<input id="m_notes" placeholder="What was this for?"></label>
      <label>Cheque / Ref no.<input id="m_ref"></label>`,
      () => Api.addExpense({ Amount: +$('#m_amt').value, PaymentMode: $('#m_mode').value, Notes: $('#m_notes').value || null, ChequeNo: $('#m_mode').value === 'Cheque' ? $('#m_ref').value : null, TransactionID: $('#m_mode').value !== 'Cheque' ? $('#m_ref').value : null }));
  }

  // Blinks for an open task that is due today or already overdue.
  const isDueOrOverdue = d => !!d && String(d).slice(0, 10) <= Api.TODAY;
  const dotIfToday = t => !t.IsDone && isDueOrOverdue(t.DueDate) ? `<span class="blink-dot" title="${String(t.DueDate).slice(0, 10) < Api.TODAY ? 'Overdue' : 'Due today'}"></span>` : '';
  function confirmModal(msg, onYes) {
    modal(`<h3>Are you sure?</h3><p class="muted">${esc(msg)}</p><div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="cfYes">Yes</button></div>`);
    $('#cfYes').onclick = async () => { closeModal(); await onYes(); };
  }
  function todoModal(t) {
    formModal(t ? 'Edit task' : 'New task', `
      <label>Title<input id="m_title" value="${esc(t ? t.Title : '')}" required></label>
      <label>Due date<input type="date" id="m_due" value="${t ? t.DueDate : Api.TODAY}" required></label>
      <label>Notes<textarea id="m_notes" rows="3">${esc(t ? t.Notes || '' : '')}</textarea></label>`,
      () => t
        ? Api.updateTodo(t.ID, { Title: $('#m_title').value, Notes: $('#m_notes').value || null, DueDate: $('#m_due').value })
        : Api.addTodo({ Title: $('#m_title').value, Notes: $('#m_notes').value || null, DueDate: $('#m_due').value }));
  }
  pages.todos = async () => {
    const st = pages.todos.st = pages.todos.st || { showDone: false };
    const all = await Api.todos();
    const rows = st.showDone ? all : all.filter(t => !t.IsDone);
    $('#view').innerHTML = `
      <div class="toolbar">
        <label style="flex:0 0 auto;display:flex;gap:6px;align-items:center;padding-bottom:9px"><input type="checkbox" id="showDone" style="width:auto;margin:0" ${st.showDone ? 'checked' : ''}> Show completed</label>
        <div class="end"><button class="btn primary" id="nt">+ Task</button></div>
      </div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Task</th><th>Due date</th><th>Notes</th><th class="chk">Done</th><th></th></tr></thead><tbody>
      ${rows.map(t => `<tr${t.IsDone ? ' class="muted"' : ''}>
        <td class="wrap click" data-edit="${t.ID}">${t.IsDone ? `<s>${esc(t.Title)}</s>` : esc(t.Title)}${dotIfToday(t)}</td>
        <td>${fmtDate(t.DueDate)}</td>
        <td class="wrap sm muted">${esc(t.Notes || '—')}</td>
        <td class="chk"><input type="checkbox" data-toggle="${t.ID}" ${t.IsDone ? 'checked' : ''}></td>
        <td><button class="btn sm" data-edit="${t.ID}">Edit</button> <button class="btn sm" data-del="${t.ID}">Delete</button></td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">No tasks.</td></tr>'}
      </tbody></table></div></div>`;
    $('#showDone').onchange = e => { st.showDone = e.target.checked; pages.todos(); };
    $('#nt').onclick = () => todoModal();
    $$('[data-edit]').forEach(el => el.onclick = () => todoModal(all.find(t => t.ID === +el.dataset.edit)));
    $$('[data-toggle]').forEach(cb => cb.onclick = e => {
      e.preventDefault();
      const t = all.find(x => x.ID === +cb.dataset.toggle);
      confirmModal(`Mark "${t.Title}" as ${t.IsDone ? 'not done' : 'done'}?`, async () => { await Api.toggleTodo(t.ID); pages.todos(); });
    });
    $$('[data-del]').forEach(b => b.onclick = async e => { e.stopPropagation(); if (confirm('Delete this task?')) { await Api.deleteTodo(+b.dataset.del); pages.todos(); } });
  };

  const payFields = (today) => `
    <div class="row2"><label>Amount (₹)<input type="number" id="m_amt" min="1" step="0.01" required></label><label id="m_datewrap">Date<input type="date" id="m_date" value="${today}" required></label></div>
    <div class="row2"><label>Payment mode<select id="m_mode"><option>Cash</option><option>UPI</option><option>Cheque</option><option>Card</option></select></label><label>Cheque / Ref no.<input id="m_ref"></label></div>
    <label>Notes<textarea id="m_notes" rows="2" placeholder="Optional"></textarea></label>`;
  function formModal(title, body, onOk) {
    modal(`<h3>${title}</h3><form id="mf">${body}<div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
    $('#mf').onsubmit = async e => {
      e.preventDefault();
      const btn = $('#mf button.primary'); btn.disabled = true;
      try { await onOk(); closeModal(); toast('Saved'); route(); }
      catch (err) { btn.disabled = false; if (err instanceof Api.AuthError) { closeModal(); return handleErr(err); } toast(err.message); }
    };
  }

  function renderVendors(all, st, per) {
    const rows = all.filter(v => (!st.q || v.OrganizationName.toLowerCase().includes(st.q.toLowerCase())) && (!st.only || v.outstanding > 0)).sort((a, b) => b.outstanding - a.outstanding);
    const p = paged(rows, st.page, per);
    $('#view').innerHTML = `
      <div class="toolbar">
        <label class="grow">Search vendor<input id="q" value="${esc(st.q)}" placeholder="Organization name"></label>
        <label style="flex:0 0 auto;display:flex;gap:6px;align-items:center;padding-bottom:9px"><input type="checkbox" id="only" style="width:auto;margin:0" ${st.only ? 'checked' : ''}> Only with dues</label>
        <div class="end"><button class="btn primary" id="nv">+ Vendor</button></div>
      </div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Vendor</th><th>GST no.</th><th>Phone</th><th class="num">Invoiced</th><th class="num">Paid</th><th class="num">Outstanding</th></tr></thead><tbody>
      ${p.slice.map(v => `<tr class="click" data-v="${v.ID}"><td><b class="caps">${esc(v.OrganizationName)}</b></td><td class="caps">${esc(v.GSTNO)}</td><td>${esc(v.PhoneNo)}</td><td class="num">${inr(v.invoiced)}</td><td class="num">${inr(v.paid)}</td><td class="num neg"><b>${inr(v.outstanding)}</b></td></tr>`).join('')}
      </tbody></table></div>${pager(p, rows.length, per)}</div>`;
    // Filtering/paging below re-renders from the already-fetched `all` list (no re-fetch) so typing can't race a slower/older request.
    $('#q').oninput = e => {
      const pos = e.target.selectionStart;
      st.q = e.target.value; st.page = 1;
      renderVendors(all, st, per);
      const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos);
    };
    $('#only').onchange = e => { st.only = e.target.checked; st.page = 1; renderVendors(all, st, per); };
    $$('[data-pg]').forEach(b => b.onclick = () => { st.page = +b.dataset.pg; renderVendors(all, st, per); });
    $$('tr[data-v]').forEach(tr => tr.onclick = () => location.hash = '#/vendors/' + tr.dataset.v);
    $('#nv').onclick = () => vendorCreateModal();
  }
  pages.vendors = async (id) => {
    if (id) return vendorLedger(+id);
    const st = pages.vendors.st = pages.vendors.st || { q: '', only: false, page: 1 };
    renderVendors(await Api.vendors(), st, 12);
  };
  function invoiceModal(vid) {
    const T = Api.TODAY;
    const vname = (Api.suppliers().find(s => s.ID === vid) || {}).OrganizationName || '';
    formModal('New supplier invoice', `<label>Vendor<input class="caps" value="${esc(vname)}" disabled></label>
      <div class="row2"><label>Invoice no.<input id="m_no" required></label><label>Amount (₹)<input type="number" id="m_amt" min="1" step="0.01" required></label></div>
      <div class="row2"><label>Invoice date<input type="date" id="m_date" value="${T}" required></label><label>Due date<input type="date" id="m_due" value="${new Date(new Date(T).getTime() + 10 * 864e5).toISOString().slice(0, 10)}"></label></div>
      <label>Notes<textarea id="m_notes" rows="2" placeholder="Optional"></textarea></label>`,
      () => Api.addInvoice({ SupplierID: vid, InvoiceNo: $('#m_no').value, Amount: +$('#m_amt').value, InvoiceDate: $('#m_date').value, DueDate: $('#m_due').value || null, Notes: $('#m_notes').value || null }));
  }
  // Vendor payment form: Cash/UPI/Card use one date; Cheque adds a mandatory (initially empty) cheque date next to the entry date.
  const vendorPayFields = (entry, mode, chq, ref, amt, notes) => {
    const opt = m => `<option ${mode === m ? 'selected' : ''}>${m}</option>`;
    return `<div class="row2"><label>Amount (₹)<input type="number" id="m_amt" min="1" step="0.01" value="${amt}" required></label><label>Entry date<input type="date" id="m_entry" value="${entry}" required></label></div>
    <div class="row2"><label>Payment mode<select id="m_mode">${opt('Cash')}${opt('UPI')}${opt('Cheque')}${opt('Card')}</select></label><label>Cheque / Ref no.<input id="m_ref" value="${esc(ref)}"></label></div>
    <label id="m_chqwrap">Cheque date<input type="date" id="m_chq" value="${chq}"></label>
    <label>Notes<textarea id="m_notes" rows="2" placeholder="Optional">${esc(notes)}</textarea></label>`;
  };
  function wireVendorPay() {
    const sync = () => { const c = $('#m_mode').value === 'Cheque'; $('#m_chqwrap').classList.toggle('hidden', !c); $('#m_chq').required = c; };
    $('#m_mode').onchange = sync; sync();
  }
  const vendorPayBody = isCheque => ({
    PayAmount: +$('#m_amt').value, PaymentMode: $('#m_mode').value, EntryDate: $('#m_entry').value,
    PaymentDate: isCheque ? $('#m_chq').value : $('#m_entry').value,
    ChequeNo: isCheque ? $('#m_ref').value : null, Notes: $('#m_notes').value || null
  });
  function vendorPayModal(vid) {
    const vname = (Api.suppliers().find(s => s.ID === vid) || {}).OrganizationName || '';
    formModal('Record vendor payment', `<label>Vendor<input class="caps" value="${esc(vname)}" disabled></label>${vendorPayFields(Api.TODAY, 'Cash', '', '', '', '')}`,
      () => Api.addVendorPayment({ SupplierID: vid, ...vendorPayBody($('#m_mode').value === 'Cheque') }));
    wireVendorPay();
  }
  function vendorCreateModal() {
    formModal('New vendor', `<label>Organization name<input class="caps" id="m_name" required></label>
      <div class="row2"><label>GST no.<input class="caps" id="m_gst"></label><label>Phone<input id="m_phone"></label></div>
      <label>Notes<textarea id="m_notes" rows="3"></textarea></label>`,
      async () => {
        const r = await Api.createVendor({ OrganizationName: $('#m_name').value, GSTNO: $('#m_gst').value || null, PhoneNo: $('#m_phone').value || null, Notes: $('#m_notes').value || null });
        location.hash = '#/vendors/' + r.ID;
      });
  }
  function vendorEditModal(v) {
    formModal('Edit vendor', `<label>Organization name<input class="caps" id="m_name" value="${esc(v.OrganizationName)}" required></label>
      <div class="row2"><label>GST no.<input class="caps" id="m_gst" value="${esc(v.GSTNO || '')}"></label><label>Phone<input id="m_phone" value="${esc(v.PhoneNo || '')}"></label></div>
      <label>Notes<textarea id="m_notes" rows="3">${esc(v.Notes || '')}</textarea></label>`,
      () => Api.updateVendor(v.ID, { OrganizationName: $('#m_name').value, GSTNO: $('#m_gst').value || null, PhoneNo: $('#m_phone').value || null, Notes: $('#m_notes').value || null }));
  }
  function txnInvoiceEditModal(row) {
    formModal('Edit invoice', `
      <div class="row2"><label>Invoice no.<input id="m_no" value="${esc(row.ref)}" required></label><label>Amount (₹)<input type="number" id="m_amt" min="1" step="0.01" value="${row.debit}" required></label></div>
      <div class="row2"><label>Invoice date<input type="date" id="m_date" value="${row.date}" required></label><label>Due date<input type="date" id="m_due" value="${row.due || ''}"></label></div>
      <label>Notes<textarea id="m_notes" rows="2">${esc(row.notes || '')}</textarea></label>`,
      () => Api.updateInvoice(row.id, { InvoiceNo: $('#m_no').value, Amount: +$('#m_amt').value, InvoiceDate: $('#m_date').value, DueDate: $('#m_due').value || null, Notes: $('#m_notes').value || null }));
  }
  function txnPaymentEditModal(row) {
    const cheque = row.mode === 'Cheque';
    formModal('Edit payment', vendorPayFields(row.entryDate || row.date, row.mode, cheque ? row.date : '', row.cheque || '', row.credit, row.notes || ''),
      () => Api.updateVendorPayment(row.id, vendorPayBody($('#m_mode').value === 'Cheque')));
    wireVendorPay();
  }
  async function vendorLedger(id) {
    const d = await Api.vendor(id);
    $('#view').innerHTML = `<a class="back" href="#/vendors">← All vendors</a>
      <div class="toolbar"><div class="grow"><h3 class="caps" style="font-size:20px">${esc(d.vendor.OrganizationName)}</h3><span class="muted">GST <span class="caps">${esc(d.vendor.GSTNO)}</span> · ${esc(d.vendor.PhoneNo)}</span></div><div class="end"><button class="btn" id="ed">Edit</button><button class="btn" id="ai">+ Invoice</button><button class="btn primary" id="ap">+ Payment</button></div></div>
      ${ledgerTable(d.ledger, 'Invoice', { colorize: true, compact: true, editable: true })}`;
    $('#ed').onclick = () => vendorEditModal(d.vendor);
    $('#ai').onclick = () => invoiceModal(id); $('#ap').onclick = () => vendorPayModal(id);
    $$('tr[data-edit]').forEach(tr => tr.onclick = () => {
      const row = d.ledger.find(r => r.id === +tr.dataset.edit && r.type === tr.dataset.type);
      if (row) row.type === 'Invoice' ? txnInvoiceEditModal(row) : txnPaymentEditModal(row);
    });
  }
  function ledgerTable(rows, debitLabel, cfg) {
    cfg = cfg || {};
    const head = cfg.compact
      ? `<th>Date</th><th>Type</th><th>Reference</th><th>Notes</th><th class="num">Amount</th><th class="num">Balance</th>`
      : `<th>Date</th><th>Type</th><th>Reference</th><th>Notes</th><th>Due</th><th class="num">${debitLabel}</th><th class="num">Payment</th><th class="num">Balance</th>`;
    const editAttrs = r => cfg.editable ? `class="click" data-edit="${r.id}" data-type="${r.type}"` : '';
    const notesCell = r => `<td class="wrap sm muted">${r.notes ? esc(r.notes) : ''}</td>`;
    const row = r => cfg.compact
      ? `<tr ${editAttrs(r)}><td>${fmtDate(r.date)} ${esc(r.time)}</td><td><span class="pill ${r.type === 'Payment' ? 'good' : ''}">${r.type}</span></td><td>${esc(r.ref)}</td>${notesCell(r)}<td class="num ${r.debit ? 'neg' : 'pos'}">${inr2(r.debit || r.credit)}</td><td class="num neg"><b>${inr2(r.balance)}</b></td></tr>`
      : `<tr ${editAttrs(r)}><td>${fmtDate(r.date)} ${esc(r.time)}</td><td><span class="pill ${r.type === 'Payment' ? 'good' : ''}">${r.type}</span></td><td>${esc(r.ref)}</td>${notesCell(r)}<td>${r.due ? fmtDate(r.due) : ''}</td><td class="num ${cfg.colorize && r.debit ? 'neg' : ''}">${r.debit ? inr2(r.debit) : ''}</td><td class="num ${cfg.colorize && r.credit ? 'pos' : ''}">${r.credit ? inr2(r.credit) : ''}</td><td class="num ${cfg.colorize ? 'neg' : ''}"><b>${inr2(r.balance)}</b></td></tr>`;
    return `<div class="card">${cfg.editable ? '<div class="sub">Click a row to fix a wrong entry</div>' : ''}<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>
    ${[...rows].reverse().map(row).join('') || `<tr><td colspan="${cfg.compact ? 6 : 8}" class="muted">No transactions.</td></tr>`}
    </tbody></table></div></div>`;
  }

  pages.customers = async (id) => {
    if (id) return customerLedger(+id);
    const rows = (await Api.customers()).sort((a, b) => b.outstanding - a.outstanding);
    const t = k => rows.reduce((s, r) => s + r[k], 0);
    $('#view').innerHTML = `
      <div class="toolbar"><div class="end"><button class="btn" id="ab">+ Credit bill</button><button class="btn primary" id="ap">+ Payment received</button></div></div>
      <div class="grid kpis">
        <div class="card kpi accent"><div class="label">Total outstanding</div><div class="val">${inr(t('outstanding'))}</div><div class="delta">${rows.filter(r => r.outstanding > 0).length} customers owe</div></div>
        <div class="card kpi"><div class="label">0–10 days</div><div class="val">${inr(t('b0'))}</div><div class="delta">within terms</div></div>
        <div class="card kpi"><div class="label">11–30 days</div><div class="val">${inr(t('b1'))}</div><div class="delta">follow up</div></div>
        <div class="card kpi"><div class="label">30+ days</div><div class="val neg">${inr(t('b2'))}</div><div class="delta down">⚠ overdue</div></div>
      </div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Customer</th><th>Phone</th><th class="num">Credit given</th><th class="num">Received</th><th class="num">Outstanding</th><th class="num">0–10d</th><th class="num">11–30d</th><th class="num">30+d</th><th>Share</th></tr></thead><tbody>
      ${rows.map(c => `<tr class="click" data-c="${c.ID}"><td><b>${esc(c.Name)}</b></td><td>${esc(c.Phone)}</td><td class="num">${inr(c.credit)}</td><td class="num">${inr(c.paid)}</td><td class="num"><b>${inr(c.outstanding)}</b></td><td class="num">${c.b0 ? inr(c.b0) : '—'}</td><td class="num">${c.b1 ? inr(c.b1) : '—'}</td><td class="num ${c.b2 ? 'neg' : ''}">${c.b2 ? inr(c.b2) : '—'}</td><td><div class="bar"><i style="width:${t('outstanding') ? Math.max(0, c.outstanding) / t('outstanding') * 100 : 0}%"></i></div></td></tr>`).join('')}
      </tbody></table></div></div>`;
    $$('tr[data-c]').forEach(tr => tr.onclick = () => location.hash = '#/customers/' + tr.dataset.c);
    $('#ab').onclick = () => creditModal(); $('#ap').onclick = () => custPayModal();
  };
  function creditModal(cid) {
    const T = Api.TODAY;
    formModal('New credit bill', `<label>Customer<select id="m_c">${opts(Api.customerList(), 'ID', 'Name', cid)}</select></label>
      <div class="row2"><label>Bill no.<input id="m_no" required></label><label>Amount (₹)<input type="number" id="m_amt" min="1" step="0.01" required></label></div>
      <div class="row2"><label>Bill date<input type="date" id="m_date" value="${T}" required></label><label>Due date<input type="date" id="m_due" value="${new Date(new Date(T).getTime() + 10 * 864e5).toISOString().slice(0, 10)}"></label></div>
      <label>Notes<textarea id="m_notes" rows="2" placeholder="Optional"></textarea></label>`,
      () => Api.addCreditBill({ CustomerID: +$('#m_c').value, BillNo: $('#m_no').value, Amount: +$('#m_amt').value, BillDate: $('#m_date').value, DueDate: $('#m_due').value || null, Notes: $('#m_notes').value || null }));
  }
  function custPayModal(cid) {
    formModal('Payment received', `<label>Customer<select id="m_c">${opts(Api.customerList(), 'ID', 'Name', cid)}</select></label>${payFields(Api.TODAY)}`,
      () => Api.addCustomerPayment({ CustomerID: +$('#m_c').value, PayAmount: +$('#m_amt').value, PaymentMode: $('#m_mode').value, PaymentDate: $('#m_date').value, Notes: $('#m_notes').value || null }));
  }
  async function customerLedger(id) {
    const d = await Api.customer(id);
    $('#view').innerHTML = `<a class="back" href="#/customers">← All customers</a>
      <div class="toolbar"><div class="grow"><h3 style="font-size:20px">${esc(d.customer.Name)}</h3><span class="muted">${esc(d.customer.Phone)} · ${esc(d.customer.Address)}</span></div><div class="end"><button class="btn" id="ab">+ Credit bill</button><button class="btn primary" id="ap">+ Payment received</button></div></div>
      <div class="chips"><div class="chip"><b>${inr(d.credit)}</b><span>credit given</span></div><div class="chip"><b>${inr(d.paid)}</b><span>received</span></div><div class="chip"><b class="${d.credit - d.paid > 0 ? 'neg' : 'pos'}">${inr(d.credit - d.paid)}</b><span>outstanding</span></div></div>
      ${ledgerTable(d.ledger, 'Credit bill')}`;
    $('#ab').onclick = () => creditModal(id); $('#ap').onclick = () => custPayModal(id);
  }

  async function productList() {
    const st = productList.st = productList.st || { q: '', cat: '', stock: '', sort: 'product_sold', page: 1 }, per = 15;
    let rows = await Api.products();
    rows = rows.filter(r => (!st.q || (r.product_name + (r.product_barCode || '')).toLowerCase().includes(st.q.toLowerCase())) && (!st.cat || r.product_categoryId == st.cat) && (!st.stock || r.status === st.stock));
    const dir = st.sort === 'product_name' || st.sort === 'category' ? 1 : -1;
    rows.sort((a, b) => a[st.sort] > b[st.sort] ? dir : a[st.sort] < b[st.sort] ? -dir : 0);
    const p = paged(rows, st.page, per);
    const stockVal = rows.reduce((s, r) => s + Math.max(0, r.product_inventory) * r.product_unitPrice, 0);
    const badge = s => s === 'out' ? '<span class="pill bad">Out</span>' : s === 'low' ? '<span class="pill warn">Low</span>' : '<span class="pill good">In stock</span>';
    $('#view').innerHTML = `
      <a class="back" href="#/products">← Products</a>
      <div class="toolbar">
        <label class="grow">Search<input id="q" value="${esc(st.q)}" placeholder="Name or barcode"></label>
        <label>Category<select id="cat"><option value="">All</option>${opts(Api.categories(), 'Id', 'Name', st.cat)}</select></label>
        <label>Stock<select id="stock"><option value="">All</option><option value="in" ${st.stock === 'in' ? 'selected' : ''}>In stock</option><option value="low" ${st.stock === 'low' ? 'selected' : ''}>Low (≤5)</option><option value="out" ${st.stock === 'out' ? 'selected' : ''}>Out of stock</option></select></label>
        <label>Sort by<select id="sort">${[['product_sold', 'Units sold'], ['margin', 'Margin %'], ['product_inventory', 'Stock'], ['product_salePrice', 'Sale price'], ['product_name', 'Name'], ['category', 'Category']].map(([v, l]) => `<option value="${v}" ${st.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="end"><button class="btn" id="fx">Export CSV</button></div>
      </div>
      <div class="chips"><div class="chip"><b>${rows.length}</b><span>products</span></div><div class="chip"><b>${inr(stockVal)}</b><span>stock value (at cost)</span></div><div class="chip"><b>${rows.filter(r => r.status === 'out').length}</b><span>out of stock</span></div><div class="chip"><b>${rows.filter(r => r.status === 'low').length}</b><span>low stock</span></div></div>
      <div class="card"><div class="table-wrap"><table><thead><tr><th>Product</th><th>Barcode</th><th>Category</th><th class="num">Cost</th><th class="num">Sale</th><th class="num">MRP</th><th class="num">Margin</th><th class="num">Stock</th><th class="num">Sold</th><th>Status</th></tr></thead><tbody>
      ${p.slice.map(r => `<tr><td class="wrap"><b>${esc(r.product_name)}</b></td><td>${esc(r.product_barCode || '—')}</td><td>${esc(r.category)}</td><td class="num">${inr2(r.product_unitPrice)}</td><td class="num">${inr2(r.product_salePrice)}</td><td class="num">${inr2(r.product_MRP)}</td><td class="num ${r.margin < 10 ? 'neg' : ''}">${r.margin.toFixed(1)}%</td><td class="num">${r.product_inventory}</td><td class="num">${num(r.product_sold)}</td><td>${badge(r.status)}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">No products match.</td></tr>'}
      </tbody></table></div>${pager(p, rows.length, per)}</div>`;
    $('#q').onkeydown = e => { if (e.key === 'Enter') { st.q = e.target.value; st.page = 1; productList(); } };
    [['cat', 'cat'], ['stock', 'stock'], ['sort', 'sort']].forEach(([i, k]) => $('#' + i).onchange = e => { st[k] = e.target.value; st.page = 1; productList(); });
    $$('[data-pg]').forEach(b => b.onclick = () => { st.page = +b.dataset.pg; productList(); });
    $('#fx').onclick = () => download('product-report.csv', [['product_Id', 'product_name', 'product_barCode', 'Category', 'product_unitPrice', 'product_salePrice', 'product_MRP', 'Margin%', 'product_inventory', 'product_sold'], ...rows.map(r => [r.product_Id, r.product_name, r.product_barCode, r.category, r.product_unitPrice, r.product_salePrice, r.product_MRP, r.margin.toFixed(1), r.product_inventory, r.product_sold])]);
  }

  async function productInsights() {
    const ins = await Api.productsInsights();
    const s = ins.summary;
    const cut = n => n.length > 26 ? n.slice(0, 25) + '…' : n;
    $('#view').innerHTML = `
      <div class="grid kpis">
        <div class="card kpi accent"><div class="label">Total products</div><div class="val">${num(s.TotalProducts)}</div><div class="delta">${inr(s.StockValue)} stock value (at cost)</div></div>
        <div class="card kpi"><div class="label">Low stock</div><div class="val ${s.LowStockCount ? 'neg' : ''}">${num(s.LowStockCount)}</div><div class="delta">1–5 units left</div></div>
        <div class="card kpi"><div class="label">Out of stock</div><div class="val ${s.OutOfStockCount ? 'neg' : ''}">${num(s.OutOfStockCount)}</div><div class="delta">0 or negative</div></div>
        <div class="card kpi"><div class="label">Slow moving</div><div class="val ${s.SlowMovingCount ? 'neg' : ''}">${num(s.SlowMovingCount)}</div><div class="delta">in stock, no sales in 60 days</div></div>
      </div>
      <div class="card">
        <h3>Top sellers</h3><div class="sub">Last 30 days, by revenue at POS price</div>
        <div class="chart-box tall"><canvas id="pi1"></canvas></div>
      </div>
      <div class="grid two even" style="margin-top:16px">
        <div class="card">
          <h3>Low stock</h3><div class="sub">1–5 units left, restock soon</div>
          <div class="table-wrap"><table><thead><tr><th>Product</th><th>Barcode</th><th class="num">Stock</th><th class="num">Sale price</th></tr></thead><tbody>
          ${ins.lowStock.map(r => `<tr><td class="wrap">${esc(r.product_name)}</td><td>${esc(r.product_barCode || '—')}</td><td class="num"><b class="${r.product_inventory <= 2 ? 'neg' : ''}">${r.product_inventory}</b></td><td class="num">${inr2(r.product_salePrice)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing low on stock 🎉</td></tr>'}
          </tbody></table></div>
        </div>
        <div class="card">
          <h3>Slow moving</h3><div class="sub">In stock, no sales in the last 60 days · biggest ₹ tied up first</div>
          <div class="table-wrap"><table><thead><tr><th>Product</th><th>Barcode</th><th class="num">Stock</th><th class="num">₹ tied up</th></tr></thead><tbody>
          ${ins.slowMoving.map(r => `<tr><td class="wrap">${esc(r.product_name)}</td><td>${esc(r.product_barCode || '—')}</td><td class="num">${r.product_inventory}</td><td class="num neg"><b>${inr(r.StockValue)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing sitting idle 🎉</td></tr>'}
          </tbody></table></div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>Out of stock</h3><div class="sub">Most historically popular items shown first — restock these before the rest</div>
        <div class="table-wrap"><table><thead><tr><th>Product</th><th>Barcode</th><th class="num">All-time units sold</th></tr></thead><tbody>
        ${ins.outOfStock.map(r => `<tr><td class="wrap">${esc(r.product_name)}</td><td>${esc(r.product_barCode || '—')}</td><td class="num">${num(r.product_sold)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing out of stock 🎉</td></tr>'}
        </tbody></table></div>
        <a class="back" style="margin:12px 0 0" href="#/products/all">View full product report →</a>
      </div>`;
    const o = baseOpts(), s1 = cssv('--s1');
    const ho = { ...o, indexAxis: 'y', scales: { x: { ...o.scales.y }, y: { ...o.scales.x, ticks: { color: cssv('--ink-2') } } } };
    chart('pi1', {
      type: 'bar', data: { labels: ins.topSellers.map(p => cut(p.product_name)), datasets: [{ data: ins.topSellers.map(p => p.Revenue), backgroundColor: s1, borderRadius: 3, maxBarThickness: 20 }] },
      options: { ...ho, plugins: { ...ho.plugins, tooltip: { ...ho.plugins.tooltip, callbacks: { label: c => [' ' + inr(c.parsed.x), `${num(ins.topSellers[c.dataIndex].QtySold)} sold`] } } } }
    });
  }

  pages.products = async (sub) => sub === 'all' ? productList() : productInsights();

  pages.profit = async () => {
    const st = pages.profit.st = pages.profit.st || { month: Api.TODAY.slice(0, 7), basis: 'pos' };
    const d = await Api.profit(st.month, st.basis);
    const t = d.totals, pv = d.prevSamePeriod;
    const delta = (a, b) => b ? ((a - b) / Math.abs(b) * 100) : null;
    const dl = (a, b, label) => { const x = delta(a, b); return x === null ? `<div class="delta">${label}</div>` : `<div class="delta ${x >= 0 ? 'up' : 'down'}">${x >= 0 ? '▲' : '▼'} ${Math.abs(x).toFixed(1)}% ${label}</div>`; };
    const monthName = new Date(d.month + '-01T00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const prevName = new Date(d.prevMonth + '-01T00:00').toLocaleDateString('en-IN', { month: 'short' });
    const cmp = d.isCurrent ? `vs ${prevName} 1–${d.daysElapsed}` : `vs ${prevName}`;
    const priceLabel = d.basis === 'pos' ? 'POS sale price' : 'actual price charged';
    const uncovered = Math.max(0, t.billTotal - t.sales);
    $('#view').innerHTML = `
      <div class="toolbar">
        <label>Month<input type="month" id="pm" value="${st.month}" max="${Api.TODAY.slice(0, 7)}"></label>
        <label>Price basis<select id="pb"><option value="pos" ${st.basis === 'pos' ? 'selected' : ''}>POS sale price</option><option value="actual" ${st.basis === 'actual' ? 'selected' : ''}>Actual price charged</option></select></label>
        <div class="end"><button class="btn" id="px">Export daily CSV</button></div>
      </div>
      <div class="grid kpis">
        <div class="card kpi accent"><div class="label">Sales · ${esc(monthName)}</div><div class="val">${inr(t.sales)}</div>${dl(t.sales, pv.sales, cmp)}</div>
        <div class="card kpi"><div class="label">Cost of goods</div><div class="val">${inr(t.cost)}</div><div class="delta">purchase price × qty</div></div>
        <div class="card kpi"><div class="label">Profit</div><div class="val ${t.profit >= 0 ? 'pos' : 'neg'}">${inr(t.profit)}</div>${dl(t.profit, pv.profit, cmp)}</div>
        <div class="card kpi"><div class="label">Margin</div><div class="val">${t.margin.toFixed(1)}%</div><div class="delta">${pv.sales ? `${cmp}: ${pv.margin.toFixed(1)}%` : ''}</div></div>
        <div class="card kpi"><div class="label">Bills</div><div class="val">${num(t.bills)}</div><div class="delta">avg profit ${inr(t.bills ? t.profit / t.bills : 0)} / bill</div></div>
      </div>
      <div class="card" style="margin-bottom:16px;font-size:13px">
        <b>How this is calculated.</b> Sales, cost and profit come from the sale line items at <b>${priceLabel}</b>, counting only lines with quantity above 0.
        Billed total for the month is <b>${inr(t.billTotal)}</b>; line items cover <b>${t.coverage.toFixed(1)}%</b> of it (${inr(uncovered)} has no matching line items: bills without lines, lines saved with quantity 0, or bill totals larger than their lines).
        Profit is therefore for the itemised sales only.${t.coverage > 0 && t.coverage < 100 ? ` At the same ${t.margin.toFixed(1)}% margin, the whole billed amount would be about <b>${inr(t.billTotal * t.margin / 100)}</b> profit.` : ''}
        ${t.noCostLines ? `<span class="muted">${num(t.noCostLines)} line(s) have no purchase price and count as zero cost.</span>` : ''}
      </div>
      <div class="grid two even">
        <div class="card"><h3>Daily sales</h3><div class="sub">${priceLabel}</div><div class="chart-box"><canvas id="p1"></canvas></div></div>
        <div class="card"><h3>Daily profit</h3><div class="sub">Sales minus purchase cost</div><div class="chart-box"><canvas id="p2"></canvas></div></div>
      </div>
      <div class="grid two even">
        <div class="card"><h3>Profit by category</h3><div class="sub">Categories from the Excel sync</div><div class="chart-box tall"><canvas id="p3"></canvas></div></div>
        <div class="card"><h3>Top 10 products by profit</h3><div class="sub">${monthName}</div><div class="chart-box tall"><canvas id="p4"></canvas></div></div>
      </div>
      <div class="grid two even">
        <div class="card"><h3>Category breakdown</h3><div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Sales</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead><tbody>
          ${d.categories.map(c => `<tr><td>${esc(c.name)}</td><td class="num">${inr(c.sales)}</td><td class="num">${inr(c.profit)}</td><td class="num">${c.margin.toFixed(1)}%</td></tr>`).join('')}</tbody></table></div></div>
        <div class="card"><h3>Selling below cost</h3><div class="sub">${d.lossCount} product(s) lost money this month${d.lossCount > d.lossProducts.length ? ' · worst shown' : ''}</div>
          <div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Sales</th><th class="num">Loss</th></tr></thead><tbody>
          ${d.lossProducts.map(p => `<tr><td class="wrap">${esc(p.name)}</td><td class="num">${num(p.qty)}</td><td class="num">${inr(p.sales)}</td><td class="num neg">${inr(p.profit)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None 🎉</td></tr>'}</tbody></table></div></div>
      </div>
      <div class="card"><h3>Day by day</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Bills</th><th class="num">Billed total</th><th class="num">Sales (itemised)</th><th class="num">Cost</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead><tbody>
        ${[...d.days].reverse().map(x => `<tr><td>${fmtDate(x.d)}</td><td class="num">${x.bills}</td><td class="num">${inr(x.billTotal)}</td><td class="num">${inr(x.sales)}</td><td class="num">${inr(x.cost)}</td><td class="num"><b>${inr(x.profit)}</b></td><td class="num">${x.sales ? (x.profit / x.sales * 100).toFixed(1) + '%' : '—'}</td></tr>`).join('')}
        <tr><td><b>Total</b></td><td class="num"><b>${num(t.bills)}</b></td><td class="num"><b>${inr(t.billTotal)}</b></td><td class="num"><b>${inr(t.sales)}</b></td><td class="num"><b>${inr(t.cost)}</b></td><td class="num"><b>${inr(t.profit)}</b></td><td class="num"><b>${t.margin.toFixed(1)}%</b></td></tr>
      </tbody></table></div></div>`;

    $('#pm').onchange = e => { if (e.target.value) { st.month = e.target.value; pages.profit(); } };
    $('#pb').onchange = e => { st.basis = e.target.value; pages.profit(); };
    $('#px').onclick = () => download(`profit-${d.month}-${d.basis}.csv`, [['Date', 'Bills', 'BilledTotal', 'Sales', 'Cost', 'Profit'], ...d.days.map(x => [x.d, x.bills, x.billTotal, x.sales, x.cost, x.profit])]);

    const o = baseOpts(), s1 = cssv('--s1'), s3 = cssv('--s3'), neg = cssv('--crit');
    const tip = fmt => ({ ...o.plugins, tooltip: { ...o.plugins.tooltip, callbacks: { label: c => ' ' + fmt(c.parsed.y ?? c.parsed.x) } } });
    const labels = d.days.map(x => short(x.d));
    chart('p1', { type: 'bar', data: { labels, datasets: [{ data: d.days.map(x => x.sales), backgroundColor: s1, borderRadius: 3, maxBarThickness: 22 }] }, options: { ...o, plugins: tip(inr) } });
    chart('p2', { type: 'bar', data: { labels, datasets: [{ data: d.days.map(x => x.profit), backgroundColor: d.days.map(x => x.profit >= 0 ? s3 : neg), borderRadius: 3, maxBarThickness: 22 }] }, options: { ...o, plugins: tip(inr) } });
    const ho = { ...o, indexAxis: 'y', scales: { x: { ...o.scales.y }, y: { ...o.scales.x, ticks: { color: cssv('--ink-2') } } } };
    const cut = n => n.length > 24 ? n.slice(0, 23) + '…' : n;
    const cats = d.categories.slice(0, 10);
    chart('p3', { type: 'bar', data: { labels: cats.map(c => cut(c.name)), datasets: [{ data: cats.map(c => c.profit), backgroundColor: s3, borderRadius: 3, maxBarThickness: 18 }] }, options: { ...ho, plugins: tip(inr) } });
    chart('p4', { type: 'bar', data: { labels: d.topProducts.map(p => cut(p.name)), datasets: [{ data: d.topProducts.map(p => p.profit), backgroundColor: s3, borderRadius: 3, maxBarThickness: 18 }] }, options: { ...ho, plugins: tip(inr) } });
  };

  pages.sync = async () => {
    const S = pages.sync.st = pages.sync.st || { pv: null, done: null };
    const log = await Api.syncLog().catch(e => { if (e instanceof Api.AuthError) throw e; return []; });
    const chip = (v, l, cls) => `<div class="chip"><b class="${cls || ''}">${num(v)}</b><span>${l}</span></div>`;
    const pv = S.pv;
    $('#view').innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <h3>Sync products from Excel</h3>
        <div class="sub">Upload the products workbook (.xlsx). Nothing is written until you review the preview and press Apply. Rows are matched on <code>product_Id</code>; the <code>category</code> column is mapped to the <code>Category</code> table and stored in <code>product_categoryId</code>.</div>
        <div class="toolbar" style="margin:0"><label class="grow">Workbook<input type="file" id="sf" accept=".xlsx"></label>
          <div class="end"><button class="btn primary" id="sp"><span class="spinner"></span><span class="lbl">Preview changes</span></button></div></div>
        <div class="err" id="serr"></div>
      </div>
      ${S.done ? `<div class="card" style="margin-bottom:16px;border-color:var(--good)"><h3>✓ Sync applied</h3>
        <div class="chips" style="margin:10px 0 0">${chip(S.done.categoriesCreated, 'categories created')}${chip(S.done.categoriesAssigned, 'products categorised')}${chip(S.done.productsInserted, 'products added')}${chip(S.done.detailsUpdated, 'details updated')}${chip(S.done.stockUpdated, 'stock updated')}</div></div>` : ''}
      ${pv ? previewHtml(pv, chip) : ''}
      <div class="card"><h3>Sync history</h3><div class="sub">Last runs (dbo.ProductSyncLog)</div>
        <div class="table-wrap"><table><thead><tr><th>When</th><th>By</th><th>File</th><th class="num">Rows</th><th class="num">Cat. created</th><th class="num">Categorised</th><th class="num">Added</th><th class="num">Details</th><th class="num">Stock</th></tr></thead><tbody>
        ${log.map(l => `<tr><td>${esc(l.RunAt)}</td><td>${esc(l.RunBy)}</td><td class="wrap">${esc(l.FileName)}</td><td class="num">${l.ExcelRows}</td><td class="num">${l.CategoriesCreated}</td><td class="num">${l.CategoriesAssigned}</td><td class="num">${l.ProductsInserted}</td><td class="num">${l.DetailsUpdated}</td><td class="num">${l.StockUpdated}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No syncs yet.</td></tr>'}
        </tbody></table></div></div>`;

    $('#sp').onclick = async () => {
      const f = $('#sf').files[0], btn = $('#sp'), lbl = btn.querySelector('.lbl');
      if (!f) return $('#serr').textContent = 'Choose the products.xlsx file first.';
      $('#serr').textContent = ''; btn.classList.add('loading'); btn.disabled = true; lbl.textContent = 'Reading file…';
      try { S.pv = await Api.syncPreview(f); S.done = null; pages.sync(); }
      catch (e) { btn.classList.remove('loading'); btn.disabled = false; lbl.textContent = 'Preview changes'; if (e instanceof Api.AuthError) return handleErr(e); $('#serr').textContent = e.message; }
    };
    const ap = $('#sa');
    if (ap) ap.onclick = () => {
      const o = { Token: pv.token, Categories: $('#o1').checked, NewProducts: $('#o2').checked, Details: $('#o3').checked, Stock: $('#o4').checked };
      if (!(o.Categories || o.NewProducts || o.Details || o.Stock)) return toast('Tick at least one option.');
      const lines = [o.Categories && `Create/assign categories (${pv.categoryChanges + (o.NewProducts ? pv.newProducts : 0)} products)`, o.NewProducts && `Add ${pv.newProducts} new products`, o.Details && `Update prices/details on ${pv.detailDiffs} products`, o.Stock && `Overwrite stock & sold on ${pv.stockDiffs} products`].filter(Boolean);
      modal(`<h3>Apply to the database?</h3><p class="muted">This writes to <code>bigmartsingur_in_dev</code> in a single transaction:</p><ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>
        <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="sgo"><span class="spinner"></span><span class="lbl">Apply</span></button></div>`);
      $('#sgo').onclick = async () => {
        const b = $('#sgo'); b.classList.add('loading'); b.disabled = true; b.querySelector('.lbl').textContent = 'Applying…';
        try { S.done = await Api.syncApply(o); S.pv = null; closeModal(); toast('Sync applied'); pages.sync(); }
        catch (e) { closeModal(); if (e instanceof Api.AuthError) return handleErr(e); toast(e.message); }
      };
    };
  };
  function previewHtml(p, chip) {
    const opt = (id, on, title, desc, warn) => `<label style="display:flex;gap:10px;align-items:flex-start;margin:0 0 12px;font-size:14px;color:var(--ink)"><input type="checkbox" id="${id}" style="width:auto;margin-top:3px" ${on ? 'checked' : ''}><span><b>${title}</b><br><span class="muted" style="font-size:12px">${desc}</span>${warn ? `<br><span class="neg" style="font-size:12px">⚠ ${warn}</span>` : ''}</span></label>`;
    return `<div class="card" style="margin-bottom:16px"><h3>Preview · ${esc(p.fileName)}</h3><div class="sub">Compared with the current Product table. Nothing has been changed yet.</div>
      <div class="chips" style="margin:0">${chip(p.excelRows, 'rows in file')}${chip(p.matched, 'already in DB')}${chip(p.newProducts, 'new products')}${chip(p.categoryChanges, 'category changes')}${chip(p.newCategories, 'new categories')}${chip(p.uncategorized, 'no category in file')}${chip(p.detailDiffs, 'price/detail differences')}${chip(p.stockDiffs, 'stock differences')}</div>
      ${p.warnings.length ? `<ul class="muted" style="margin:12px 0 0;padding-left:18px">${p.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div>
      <div class="grid two even">
        <div class="card"><h3>What to apply</h3><div class="sub">Tick only what you want to change.</div>
          ${opt('o1', true, 'Categories', `Create ${p.newCategories} new categories and set the category on products (${p.categoryChanges} existing changes). A blank category in the file never clears an existing one.`)}
          ${opt('o2', true, 'Add new products', `Insert ${p.newProducts} products that are in the file but not in the database, keeping their product_Id.`)}
          ${opt('o3', false, 'Update names, barcodes, prices, GST', `Overwrite these fields on ${p.detailDiffs} existing products with the file values.`)}
          ${opt('o4', false, 'Update stock, sold & on-order', `Overwrite quantities on ${p.stockDiffs} existing products.`, 'Stock and sold change with every POS sale. Tick only if the file is fresher than the database.')}
          <button class="btn primary" id="sa">Apply selected…</button></div>
        <div class="card"><h3>Category mapping</h3><div class="sub">${p.categories.length} categories found in the file</div>
          <div class="table-wrap" style="max-height:340px;overflow:auto"><table><thead><tr><th>Category</th><th class="num">Products</th><th></th></tr></thead><tbody>
          ${p.categories.map(c => `<tr><td>${esc(c.name)}</td><td class="num">${c.products}</td><td>${c.isNew ? '<span class="pill warn">new</span>' : '<span class="pill good">exists</span>'}</td></tr>`).join('')}
          </tbody></table></div></div>
      </div>
      <div class="grid two even" style="margin-top:16px">
        <div class="card"><h3>New products (sample)</h3><div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Category</th><th class="num">Sale ₹</th></tr></thead><tbody>
          ${p.newSamples.map(r => `<tr><td>${r.Id}</td><td class="wrap">${esc(r.Name)}</td><td>${esc(r.Category || '—')}</td><td class="num">${inr2(r.SalePrice)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None</td></tr>'}</tbody></table></div></div>
        <div class="card"><h3>Price differences (sample)</h3><div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">DB sale</th><th class="num">File sale</th><th class="num">DB cost</th><th class="num">File cost</th></tr></thead><tbody>
          ${p.detailSamples.map(r => `<tr><td class="wrap">${esc(r.Name)}</td><td class="num">${inr2(r.dbSale)}</td><td class="num">${inr2(r.fileSale)}</td><td class="num">${inr2(r.dbCost)}</td><td class="num">${inr2(r.fileCost)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None</td></tr>'}</tbody></table></div></div>
      </div>
      <div class="card" style="margin:16px 0"><h3>Stock differences (sample)</h3><div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">DB stock</th><th class="num">File stock</th></tr></thead><tbody>
        ${p.stockSamples.map(r => `<tr><td class="wrap">${esc(r.Name)}</td><td class="num">${r.dbStock}</td><td class="num">${r.fileStock}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">None</td></tr>'}</tbody></table></div></div>`;
  }

  /* ---------- router / auth ---------- */
  const titles = { dashboard: 'Dashboard', todos: 'To-do', sales: 'Sales', trend: 'Sales by month', vendors: 'Vendor payments', cheques: 'Cheque details', customers: 'Customer credit', expenses: 'Expenses', products: 'Products', sync: 'Product sync', profit: 'Monthly profit' };
  let navId = 0;
  function route() {
    if (!sessionStorage.getItem('user')) return showLogin();
    const myNav = ++navId;
    const [r, id] = (location.hash.replace(/^#\//, '') || 'dashboard').split('/');
    const name = pages[r] ? r : 'dashboard';
    $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
    $('#userName').textContent = sessionStorage.getItem('user');
    $('#pageTitle').textContent = titles[name];
    $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === name));
    $('#side').classList.remove('open');
    killCharts();
    window.scrollTo(0, 0);
    $('#view').innerHTML = '<div class="muted" style="padding:60px;text-align:center">Loading…</div>';
    document.body.classList.add('nav-busy');
    Api.init()
      .then(() => { if (myNav === navId) return pages[name](id); })
      .catch(handleErr)
      .finally(() => { if (myNav === navId) document.body.classList.remove('nav-busy'); });
  }
  function handleErr(e) {
    if (e instanceof Api.AuthError) { sessionStorage.removeItem('user'); Api.reset(); $('#lerr').textContent = 'Session expired — please sign in again.'; return showLogin(); }
    $('#view').innerHTML = `<div class="card"><h3>Couldn't load data</h3><p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Retry</button></div>`;
  }
  // Route every page render through one error handler (filters re-render pages directly).
  Object.keys(pages).forEach(k => { const f = pages[k]; pages[k] = (...a) => Promise.resolve(f(...a)).catch(handleErr); });
  function showLogin() { $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); }
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#loginBtn'), lbl = btn.querySelector('.lbl');
    if (btn.classList.contains('loading')) return;
    $('#lerr').textContent = ''; btn.classList.add('loading'); btn.disabled = true; lbl.textContent = 'Signing in…';
    const done = () => { btn.classList.remove('loading'); btn.disabled = false; lbl.textContent = 'Sign in'; };
    let u;
    try { u = await Api.login($('#lu').value, $('#lp').value); }
    catch (err) { done(); return $('#lerr').textContent = 'Cannot reach the server. Try again.'; }
    done();
    if (!u) return $('#lerr').textContent = 'Invalid username or password.';
    Api.reset(); $('#lp').value = ''; sessionStorage.setItem('user', u.Name); $('#lerr').textContent = ''; location.hash = '#/dashboard'; route();
  };
  $('#logoutBtn').onclick = async () => { await Api.logout(); sessionStorage.removeItem('user'); showLogin(); };
  $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
  addEventListener('hashchange', route);
  // Clicking a menu item always starts that page fresh, even if it's already the current hash (no hashchange fires then).
  // Also drops that page's remembered filters / page number, so tables return to page 1 with default filters.
  $('#nav').addEventListener('click', e => {
    const a = e.target.closest('a[href^="#/"]');
    if (!a) return;
    const r = a.dataset.r;
    if (pages[r]) delete pages[r].st;
    if (r === 'products') delete productList.st;
    if (location.hash === a.getAttribute('href')) { e.preventDefault(); route(); }
  });
  // Restore the session from the 1-day cookie so a reload / new browser session doesn't ask for login again.
  Api.me().then(u => { if (u) sessionStorage.setItem('user', u.Name); else sessionStorage.removeItem('user'); route(); }).catch(() => route());
})();
