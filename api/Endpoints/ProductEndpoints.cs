using Dapper;
using Microsoft.Extensions.Caching.Memory;

namespace SsPortal.Api;

public static class ProductEndpoints
{
    record InsightsSummary(int TotalProducts, int LowStockCount, int OutOfStockCount, int SlowMovingCount, decimal StockValue);
    record LowStockRow(int product_Id, string product_name, string? product_barCode, int product_inventory, decimal product_salePrice);
    record OutOfStockRow(int product_Id, string product_name, string? product_barCode, int product_sold);
    record TopSellerRow(int product_Id, string product_name, decimal QtySold, decimal Revenue);
    record SlowMoverRow(int product_Id, string product_name, string? product_barCode, int product_inventory, decimal StockValue);

    // Slow moving = has stock but hasn't sold in 60 days. Top sellers = last 30 days (not all-time product_sold,
    // which has no time window). Temp tables (not CTEs) so #recent30/#recent60 can be reused across all 5 result
    // sets in one round trip instead of recomputing the TB_SaleProduct join per query.
    const string InsightsSql = @"
        DECLARE @from30 date = DATEADD(day,-30, CAST(GETDATE() AS date));
        DECLARE @from60 date = DATEADD(day,-60, CAST(GETDATE() AS date));

        SELECT sp.ProductID, SUM(sp.Quantity) QtySold, SUM(sp.POSSalePrice * sp.Quantity) Revenue
        INTO #recent30
        FROM TB_SaleProduct sp JOIN TB_Sale s ON s.SaleID = sp.SaleID
        WHERE s.SaleDate >= @from30 GROUP BY sp.ProductID;

        SELECT sp.ProductID, SUM(sp.Quantity) QtySold60
        INTO #recent60
        FROM TB_SaleProduct sp JOIN TB_Sale s ON s.SaleID = sp.SaleID
        WHERE s.SaleDate >= @from60 GROUP BY sp.ProductID;

        SELECT
          COUNT(*) TotalProducts,
          SUM(CASE WHEN ISNULL(product_inventory,0) > 0 AND ISNULL(product_inventory,0) <= 5 THEN 1 ELSE 0 END) LowStockCount,
          SUM(CASE WHEN ISNULL(product_inventory,0) <= 0 THEN 1 ELSE 0 END) OutOfStockCount,
          SUM(CASE WHEN ISNULL(p.product_inventory,0) > 0 AND ISNULL(r.QtySold60,0) = 0 THEN 1 ELSE 0 END) SlowMovingCount,
          SUM(CASE WHEN ISNULL(product_inventory,0) > 0 THEN ISNULL(product_inventory,0) * ISNULL(product_unitPrice,0) ELSE 0 END) StockValue
        FROM Product p LEFT JOIN #recent60 r ON r.ProductID = p.product_Id;

        SELECT TOP 20 product_Id, product_name, product_barCode, ISNULL(product_inventory,0) product_inventory, ISNULL(product_salePrice,0) product_salePrice
        FROM Product WHERE ISNULL(product_inventory,0) > 0 AND ISNULL(product_inventory,0) <= 5
        ORDER BY product_inventory ASC, product_sold DESC;

        SELECT TOP 20 product_Id, product_name, product_barCode, ISNULL(product_sold,0) product_sold
        FROM Product WHERE ISNULL(product_inventory,0) <= 0
        ORDER BY product_sold DESC;

        SELECT TOP 15 p.product_Id, p.product_name, r.QtySold, r.Revenue
        FROM Product p JOIN #recent30 r ON r.ProductID = p.product_Id
        ORDER BY r.QtySold DESC;

        SELECT TOP 20 p.product_Id, p.product_name, p.product_barCode, ISNULL(p.product_inventory,0) product_inventory,
            ISNULL(p.product_inventory,0) * ISNULL(p.product_unitPrice,0) StockValue
        FROM Product p LEFT JOIN #recent60 r ON r.ProductID = p.product_Id
        WHERE ISNULL(p.product_inventory,0) > 0 AND ISNULL(r.QtySold60,0) = 0
        ORDER BY StockValue DESC;

        DROP TABLE #recent30;
        DROP TABLE #recent60;";

    public static void Map(RouteGroupBuilder g)
    {
        g.MapGet("/products/insights", async (Db db, IMemoryCache cache) =>
        {
            var result = await cache.GetOrCreateAsync("products-insights", async e =>
            {
                e.AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(120);
                await using var c = await db.OpenAsync();
                using var multi = await c.QueryMultipleAsync(InsightsSql);
                var summary = await multi.ReadFirstAsync<InsightsSummary>();
                var lowStock = (await multi.ReadAsync<LowStockRow>()).ToList();
                var outOfStock = (await multi.ReadAsync<OutOfStockRow>()).ToList();
                var topSellers = (await multi.ReadAsync<TopSellerRow>()).ToList();
                var slowMoving = (await multi.ReadAsync<SlowMoverRow>()).ToList();
                return new { summary, lowStock, outOfStock, topSellers, slowMoving };
            });
            return Results.Ok(result);
        });

        // product_image (varbinary) is deliberately not selected.
        g.MapGet("/products", async (Db db) =>
        {
            await using var c = await db.OpenAsync();
            var rows = await c.QueryAsync(@"SELECT product_Id, product_name, product_barCode, ISNULL(product_categoryId,0) product_categoryId,
                    ISNULL(product_unitPrice,0) product_unitPrice, ISNULL(product_salePrice,0) product_salePrice, ISNULL(product_MRP,0) product_MRP,
                    ISNULL(product_inventory,0) product_inventory, ISNULL(product_sold,0) product_sold
                FROM Product ORDER BY product_sold DESC");
            return Results.Ok(rows);
        });

        // dbo.Category is filled by the Excel sync. Id 0 = Uncategorized (the legacy default on Product.product_categoryId).
        g.MapGet("/categories", async (Db db) =>
        {
            await using var c = await db.OpenAsync();
            var rows = (await c.QueryAsync<(int Id, string Name, int Products)>(@"
                SELECT ISNULL(c.Id, 0) Id, ISNULL(c.Name, 'Uncategorized') Name, COUNT(*) Products
                FROM Product p LEFT JOIN dbo.Category c ON c.Id = p.product_categoryId
                GROUP BY ISNULL(c.Id, 0), ISNULL(c.Name, 'Uncategorized')")).ToList();
            var all = await c.QueryAsync<(int Id, string Name)>("SELECT Id, Name FROM dbo.Category WHERE IsActive = 1");
            foreach (var a in all) if (rows.All(r => r.Id != a.Id)) rows.Add((a.Id, a.Name, 0));
            return Results.Ok(rows.OrderBy(r => r.Id == 0 ? 1 : 0).ThenBy(r => r.Name).Select(r => new { r.Id, r.Name, r.Products }));
        });
    }
}
