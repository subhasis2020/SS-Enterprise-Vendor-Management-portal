using Dapper;
using Microsoft.Extensions.Caching.Memory;

namespace SsPortal.Api;

public static class SalesEndpoints
{
    // TB_Sale holds duplicate rows per SaleID (up to 8x), so every query collapses to one row per SaleID.
    const string BillCols = @"SaleID, MAX(Quantity) Quantity, MAX(TotalDiscount) TotalDiscount, MAX(TotalSale) TotalSale,
        MAX(SaleAmountBeforeTax) SaleAmountBeforeTax, MAX(DiscountPercent) DiscountPercent,
        CONVERT(varchar(10), MAX(SaleDate), 23) SaleDate, CONVERT(varchar(19), MAX(SaleDateTime), 120) SaleDateTime";

    record MonthRow(string m, int bills, decimal total);

    public static void Map(RouteGroupBuilder g)
    {
        g.MapGet("/sales/monthly", async (Db db, IMemoryCache cache, int? months) =>
        {
            var n = Math.Clamp(months ?? 12, 1, 36);
            var result = await cache.GetOrCreateAsync($"sales-monthly-{n}", async e =>
            {
                e.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(60);
                var from = new DateTime(DateTime.Today.Year, DateTime.Today.Month, 1).AddMonths(-(n - 1));
                await using var c = await db.OpenAsync();
                // Grouped by month in SQL - cheap even over a long range, since it never pulls day-level rows.
                return await c.QueryAsync<MonthRow>(@"
                    SELECT LEFT(CONVERT(varchar(10), SaleDate, 23), 7) m, COUNT(*) bills, SUM(t) total
                    FROM (SELECT SaleID, MAX(SaleDate) SaleDate, MAX(TotalSale) t FROM TB_Sale WHERE SaleDate >= @from GROUP BY SaleID) x
                    GROUP BY LEFT(CONVERT(varchar(10), SaleDate, 23), 7) ORDER BY m", new { from });
            });
            return Results.Ok(result);
        });

        g.MapGet("/sales", async (Db db, string? from, string? to, string? q) =>
        {
            DateTime? f = DateTime.TryParse(from, out var fd) ? fd : null;
            DateTime? t = DateTime.TryParse(to, out var td) ? td : null;
            var qq = string.IsNullOrWhiteSpace(q) ? null : new string(q.Where(char.IsDigit).ToArray());
            // A Sale ID search looks across the whole table regardless of the date range selected; only
            // fall back to a date-bounded scan when there's no search term, to avoid scanning all 750k rows.
            if (!string.IsNullOrEmpty(qq)) { f = null; t = null; }
            else if (f is null && t is null) f = DateTime.Today.AddDays(-30);
            await using var c = await db.OpenAsync();
            // PriceMismatch: flags a bill where at least one line item's actual charged price differs from
            // its POS-listed price (POSSalePrice is what's actually charged to the customer). Joined once as
            // a derived table (not a per-row correlated subquery) since TB_SaleProduct has no index on SaleID
            // and would be scanned repeatedly otherwise.
            var rows = await c.QueryAsync($@"SELECT TOP (5000) {BillCols}, MAX(ISNULL(u.PriceMismatch, 0)) PriceMismatch FROM TB_Sale
                LEFT JOIN (SELECT SaleID AS USaleID, MAX(CASE WHEN ActualSalePrice <> POSSalePrice THEN 1 ELSE 0 END) PriceMismatch FROM TB_SaleProduct GROUP BY SaleID) u ON u.USaleID = TB_Sale.SaleID
                WHERE (@f IS NULL OR SaleDate >= @f) AND (@t IS NULL OR SaleDate <= @t)
                  AND (@q IS NULL OR CAST(SaleID AS varchar(20)) LIKE @q + '%')
                GROUP BY SaleID ORDER BY SaleID DESC", new { f, t, q = string.IsNullOrEmpty(qq) ? null : qq });
            return Results.Ok(rows);
        });

        g.MapGet("/sales/month/{m}", async (string m, Db db, IMemoryCache cache) =>
        {
            if (!DateTime.TryParseExact(m + "-01", "yyyy-MM-dd", null, System.Globalization.DateTimeStyles.None, out var from))
                return Results.BadRequest(new { error = "Month must be yyyy-MM." });
            var to = from.AddMonths(1);
            var result = await cache.GetOrCreateAsync($"sales-month-{m}", async e =>
            {
                e.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(60);
                await using var c = await db.OpenAsync();
                var days = await c.QueryAsync(@"
                    SELECT CONVERT(varchar(10), SaleDate, 23) d, COUNT(*) bills, SUM(t) total
                    FROM (SELECT SaleID, MAX(SaleDate) SaleDate, MAX(TotalSale) t FROM TB_Sale WHERE SaleDate >= @from AND SaleDate < @to GROUP BY SaleID) x
                    GROUP BY CONVERT(varchar(10), SaleDate, 23) ORDER BY d", new { from, to });
                // POSSalePrice, not ActualSalePrice, is what's actually charged to the customer (see PriceMismatch note above).
                var topProducts = await c.QueryAsync(@"
                    SELECT TOP 20 sp.ProductName, SUM(sp.Quantity) Qty, SUM(sp.POSSalePrice * sp.Quantity) Revenue
                    FROM TB_SaleProduct sp JOIN TB_Sale s ON s.SaleID = sp.SaleID
                    WHERE s.SaleDate >= @from AND s.SaleDate < @to
                    GROUP BY sp.ProductName ORDER BY Revenue DESC", new { from, to });
                return new { days, topProducts };
            });
            return Results.Ok(result);
        });

        g.MapGet("/sales/{id:int}", async (int id, Db db) =>
        {
            await using var c = await db.OpenAsync();
            var sale = await c.QueryFirstOrDefaultAsync($"SELECT {BillCols} FROM TB_Sale WHERE SaleID=@id GROUP BY SaleID", new { id });
            if (sale is null) return Results.NotFound();
            var items = await c.QueryAsync(@"SELECT ProductID, SaleID, ProductName, Quantity, ActualSalePrice, POSSalePrice, purchasePrice
                FROM TB_SaleProduct WHERE SaleID=@id ORDER BY ID", new { id });
            return Results.Ok(new { sale, items });
        });
    }
}
