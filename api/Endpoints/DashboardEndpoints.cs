using Dapper;
using Microsoft.Extensions.Caching.Memory;

namespace SsPortal.Api;

public static class DashboardEndpoints
{
    record DayRow(string SaleDate, int bills, decimal TotalSale, decimal Quantity);
    record TodayInvoice(string OrganizationName, string InvoiceNo, string InvoiceTime, decimal Amount);
    record TodayPayment(string OrganizationName, string PaymentTime, decimal PayAmount, string PaymentMode);
    record RecentCheque(string OrganizationName, decimal PayAmount, string PaymentDate, string? ChequeNo);
    record MonthPay(int m, decimal total);

    public static void Map(RouteGroupBuilder g)
    {
        g.MapGet("/dashboard", async (Db db, IMemoryCache cache) =>
        {
            // Aggregates scan un-indexed sale tables; a short cache keeps the dashboard snappy.
            var result = await cache.GetOrCreateAsync("dashboard", async e =>
            {
                e.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(60);
                return await Build(db);
            });
            return Results.Ok(result);
        });

        g.MapGet("/dashboard/vendor-activity", async (Db db, IMemoryCache cache, string? date) =>
        {
            var d = DateTime.TryParse(date, out var dd) ? dd.ToString("yyyy-MM-dd") : DateTime.Today.ToString("yyyy-MM-dd");
            var result = await cache.GetOrCreateAsync($"dashboard-vendor-activity-{d}", async e =>
            {
                e.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(60);
                await using var c = await db.OpenAsync();
                return await LoadVendorActivity(c, d);
            });
            return Results.Ok(result);
        });

        g.MapGet("/dashboard/vendor-payments-monthly", async (Db db, IMemoryCache cache, int? year) =>
        {
            var y = year is > 2000 and < 3000 ? year.Value : DateTime.Today.Year;
            var result = await cache.GetOrCreateAsync($"dashboard-vendor-payments-{y}", async e =>
            {
                e.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(60);
                await using var c = await db.OpenAsync();
                var rows = (await c.QueryAsync<MonthPay>(@"
                    SELECT MONTH(PaymentDate) m, SUM(PayAmount) total
                    FROM TB_SupplierInvoicePayment
                    WHERE YEAR(PaymentDate) = @y
                    GROUP BY MONTH(PaymentDate)", new { y })).ToDictionary(x => x.m, x => x.total);
                // Zero-fill every month so the chart always has 12 points, even for months with no payments.
                return Enumerable.Range(1, 12).Select(m => new MonthPay(m, rows.GetValueOrDefault(m))).ToList();
            });
            return Results.Ok(result);
        });
    }

    static async Task<object> LoadVendorActivity(System.Data.IDbConnection c, string dateStr)
    {
        var invoices = (await c.QueryAsync<TodayInvoice>(@"
            SELECT s.OrganizationName, i.InvoiceNo, i.InvoiceTime, i.Amount
            FROM TB_SupplierInvoice i JOIN TB_Supplier s ON s.ID = i.SupplierID
            WHERE i.InvoiceDate = @dateStr ORDER BY i.InvoiceTime DESC", new { dateStr })).ToList();

        var payments = (await c.QueryAsync<TodayPayment>(@"
            SELECT s.OrganizationName, p.PaymentTime, p.PayAmount, p.PaymentMode
            FROM TB_SupplierInvoicePayment p JOIN TB_Supplier s ON s.ID = p.SupplierID
            WHERE p.PaymentDate = @dateStr ORDER BY p.PaymentTime DESC", new { dateStr })).ToList();

        return new { invoices, payments };
    }

    static async Task<object> Build(Db db)
    {
        var today = DateTime.Today;
        var todayStr = today.ToString("yyyy-MM-dd");
        var prevMonthStart = new DateTime(today.Year, today.Month, 1).AddMonths(-1); // enough history for prev-day/MTD, whatever the day of month

        await using var c = await db.OpenAsync();
        var daily = (await c.QueryAsync<DayRow>(@"
            SELECT CONVERT(varchar(10), SaleDate, 23) SaleDate, COUNT(*) bills, SUM(t) TotalSale, SUM(q) Quantity
            FROM (SELECT SaleID, MAX(SaleDate) SaleDate, MAX(TotalSale) t, MAX(Quantity) q FROM TB_Sale WHERE SaleDate >= @prevMonthStart GROUP BY SaleID) x
            GROUP BY SaleDate ORDER BY SaleDate", new { prevMonthStart })).ToList();

        var recentCheques = (await c.QueryAsync<RecentCheque>(@"
            SELECT TOP (5) s.OrganizationName, p.PayAmount, p.PaymentDate, p.ChequeNo
            FROM TB_SupplierInvoicePayment p JOIN TB_Supplier s ON s.ID = p.SupplierID
            WHERE p.PaymentMode = 'Cheque'
            ORDER BY p.PaymentDate DESC, p.PaymentTime DESC")).ToList();

        // Sum of positive outstanding only - done as one SQL aggregate instead of via VendorEndpoints/CustomerEndpoints
        // LoadStats, which pulls every invoice/payment ever recorded into memory and FIFO-reconstructs each ledger
        // (needed for those list pages' overdue/ageing columns, but wasted work for a single dashboard total).
        var vendorDue = await c.ExecuteScalarAsync<decimal>(@"
            SELECT ISNULL(SUM(CASE WHEN outstanding > 0 THEN outstanding ELSE 0 END), 0)
            FROM (
                SELECT s.ID, ISNULL(inv.invoiced, 0) - ISNULL(pay.paid, 0) AS outstanding
                FROM TB_Supplier s
                LEFT JOIN (SELECT SupplierID, SUM(Amount) invoiced FROM TB_SupplierInvoice GROUP BY SupplierID) inv ON inv.SupplierID = s.ID
                LEFT JOIN (SELECT SupplierID, SUM(PayAmount) paid FROM TB_SupplierInvoicePayment GROUP BY SupplierID) pay ON pay.SupplierID = s.ID
                WHERE s.IsActive = 1
            ) o");

        var metroDue = await c.ExecuteScalarAsync<decimal?>(@"
            SELECT ISNULL(inv.invoiced, 0) - ISNULL(pay.paid, 0)
            FROM TB_Supplier s
            LEFT JOIN (SELECT SupplierID, SUM(Amount) invoiced FROM TB_SupplierInvoice GROUP BY SupplierID) inv ON inv.SupplierID = s.ID
            LEFT JOIN (SELECT SupplierID, SUM(PayAmount) paid FROM TB_SupplierInvoicePayment GROUP BY SupplierID) pay ON pay.SupplierID = s.ID
            WHERE s.OrganizationName = 'METRO CASH AND CARRY'") ?? 0;

        var monthStart = new DateTime(today.Year, today.Month, 1);
        var expenseMtd = await c.ExecuteScalarAsync<decimal>(
            "SELECT ISNULL(SUM(Amount), 0) FROM TB_DailyExpense WHERE CreatedDate >= @monthStart", new { monthStart });

        var last = daily.LastOrDefault() ?? new DayRow(todayStr, 0, 0, 0);
        var prev = daily.Count > 1 ? daily[^2] : null;
        var month = today.ToString("yyyy-MM");
        var mtd = daily.Where(x => x.SaleDate.StartsWith(month)).ToList();

        return new
        {
            today = last, prev,
            mtdTotal = mtd.Sum(x => x.TotalSale), mtdBills = mtd.Sum(x => x.bills),
            vendorDue, metroDue, expenseMtd,
            daily = daily.Where(x => string.CompareOrdinal(x.SaleDate, monthStart.ToString("yyyy-MM-dd")) >= 0).ToList(),
            recentCheques,
        };
    }
}
