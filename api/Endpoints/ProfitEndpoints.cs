using Dapper;
using Microsoft.Extensions.Caching.Memory;
using System.Globalization;
using System.Text.RegularExpressions;

namespace SsPortal.Api;

/// <summary>
/// Monthly sales &amp; profit from sale line items (TB_SaleProduct).
///   sales  = price x quantity, where price is POSSalePrice (default) or ActualSalePrice (what the customer really paid)
///   cost   = purchasePrice x quantity          profit = sales - cost
/// Only lines with Quantity > 0 count. Bill totals (TB_Sale, one row per SaleID) are returned alongside so the UI can show how much
/// of the billed amount the line items cover: some bills have no lines and some lines are saved with quantity 0.
/// </summary>
public static class ProfitEndpoints
{
    record DayRow(string d, int bills, decimal billTotal, decimal sales, decimal cost, decimal qty, int noCost);
    record ProdRow(int ProductID, string name, decimal qty, decimal sales, decimal cost, int cat);

    public static void Map(RouteGroupBuilder g)
    {
        g.MapGet("/profit", async (Db db, IMemoryCache cache, string? month, string? basis) =>
        {
            var today = DateTime.Today;
            var start = month is not null && Regex.IsMatch(month, @"^\d{4}-\d{2}$") && DateTime.TryParseExact(month + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var m)
                ? m : new DateTime(today.Year, today.Month, 1);
            var col = string.Equals(basis, "actual", StringComparison.OrdinalIgnoreCase) ? "ActualSalePrice" : "POSSalePrice"; // whitelisted -> safe to inline
            var key = $"profit|{start:yyyy-MM}|{col}";
            var result = await cache.GetOrCreateAsync(key, async e =>
            {
                e.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(60);
                return await Build(db, start, col, today);
            });
            return Results.Ok(result);
        });
    }

    static async Task<object> Build(Db db, DateTime start, string col, DateTime today)
    {
        var prevStart = start.AddMonths(-1);
        var next = start.AddMonths(1);
        await using var c = await db.OpenAsync();

        // One pass over the current + previous month; split by month in memory.
        var days = (await c.QueryAsync<DayRow>($@"
            WITH b AS (SELECT SaleID, MAX(SaleDate) d, MAX(TotalSale) hdr FROM TB_Sale WHERE SaleDate >= @prevStart AND SaleDate < @next GROUP BY SaleID),
                 l AS (SELECT sp.SaleID, SUM(sp.{col} * sp.Quantity) sales, SUM(ISNULL(sp.purchasePrice, 0) * sp.Quantity) cost, SUM(sp.Quantity) qty,
                              SUM(CASE WHEN ISNULL(sp.purchasePrice, 0) = 0 THEN 1 ELSE 0 END) noCost
                       FROM TB_SaleProduct sp WHERE sp.Quantity > 0 AND sp.SaleID IN (SELECT SaleID FROM b) GROUP BY sp.SaleID)
            SELECT CONVERT(varchar(10), b.d, 23) d, COUNT(*) bills, SUM(b.hdr) billTotal, SUM(ISNULL(l.sales, 0)) sales, SUM(ISNULL(l.cost, 0)) cost,
                   SUM(ISNULL(l.qty, 0)) qty, SUM(ISNULL(l.noCost, 0)) noCost
            FROM b LEFT JOIN l ON l.SaleID = b.SaleID GROUP BY b.d ORDER BY b.d", new { prevStart, next })).ToList();

        var prods = (await c.QueryAsync<ProdRow>($@"
            WITH b AS (SELECT SaleID FROM TB_Sale WHERE SaleDate >= @start AND SaleDate < @next GROUP BY SaleID)
            SELECT sp.ProductID, MAX(sp.ProductName) name, SUM(sp.Quantity) qty, SUM(sp.{col} * sp.Quantity) sales,
                   SUM(ISNULL(sp.purchasePrice, 0) * sp.Quantity) cost, ISNULL(MAX(p.product_categoryId), 0) cat
            FROM TB_SaleProduct sp JOIN b ON b.SaleID = sp.SaleID LEFT JOIN Product p ON p.product_Id = sp.ProductID
            WHERE sp.Quantity > 0 GROUP BY sp.ProductID", new { start, next })).ToList();
        var catNames = (await c.QueryAsync<(int Id, string Name)>("SELECT Id, Name FROM dbo.Category")).ToDictionary(x => x.Id, x => x.Name);

        var ms = start.ToString("yyyy-MM"); var ps = prevStart.ToString("yyyy-MM");
        var cur = days.Where(x => x.d.StartsWith(ms)).ToList();
        var isCurrent = start.Year == today.Year && start.Month == today.Month;
        var elapsed = isCurrent ? today.Day : DateTime.DaysInMonth(start.Year, start.Month);
        var prevSame = days.Where(x => x.d.StartsWith(ps) && int.Parse(x.d[8..]) <= elapsed).ToList();

        static object Sum(List<DayRow> r)
        {
            var sales = r.Sum(x => x.sales); var cost = r.Sum(x => x.cost); var bill = r.Sum(x => x.billTotal);
            return new
            {
                bills = r.Sum(x => x.bills), billTotal = bill, sales, cost, profit = sales - cost,
                margin = sales > 0 ? (sales - cost) / sales * 100 : 0, qty = r.Sum(x => x.qty), noCostLines = r.Sum(x => x.noCost),
                coverage = bill > 0 ? sales / bill * 100 : 0
            };
        }

        return new
        {
            month = ms, basis = col == "POSSalePrice" ? "pos" : "actual", daysElapsed = elapsed, isCurrent,
            totals = Sum(cur), prevSamePeriod = Sum(prevSame), prevMonth = ps,
            days = cur.Select(x => new { x.d, x.bills, x.billTotal, x.sales, x.cost, profit = x.sales - x.cost }).ToList(),
            topProducts = prods.OrderByDescending(p => p.sales - p.cost).Take(10)
                .Select(p => new { p.name, p.qty, p.sales, profit = p.sales - p.cost, margin = p.sales > 0 ? (p.sales - p.cost) / p.sales * 100 : 0 }).ToList(),
            lossProducts = prods.Where(p => p.sales - p.cost < 0).OrderBy(p => p.sales - p.cost).Take(8)
                .Select(p => new { p.name, p.qty, p.sales, profit = p.sales - p.cost }).ToList(),
            lossCount = prods.Count(p => p.sales - p.cost < 0),
            categories = prods.GroupBy(p => p.cat).Select(k =>
            {
                var s = k.Sum(p => p.sales); var co = k.Sum(p => p.cost);
                return new { name = catNames.GetValueOrDefault(k.Key, "Uncategorized"), sales = s, profit = s - co, margin = s > 0 ? (s - co) / s * 100 : 0 };
            }).OrderByDescending(x => x.profit).ToList(),
        };
    }
}
