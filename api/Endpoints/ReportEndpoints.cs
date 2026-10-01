using Dapper;
using System.Security.Claims;

namespace SsPortal.Api;

// Reports are private to one login (see IsOwner) - enforced here on the server, not just by hiding the menu item.
public static class ReportEndpoints
{
    public const string Policy = "Reports";
    const string Owner = "subhasis";
    public static bool IsOwner(ClaimsPrincipal u) => string.Equals(u.Identity?.Name, Owner, StringComparison.OrdinalIgnoreCase);

    static (string From, string To, DateTime FromD, DateTime ToD) Range(string? from, string? to)
    {
        var t = Party.ParseDate(to) is var td && td != DateTime.MinValue ? td.Date : DateTime.Today;
        var f = Party.ParseDate(from) is var fd && fd != DateTime.MinValue ? fd.Date : t.AddDays(-29);
        return (f.ToString("yyyy-MM-dd"), t.ToString("yyyy-MM-dd"), f, t);
    }

    public static void Map(RouteGroupBuilder g)
    {
        var r = g.MapGroup("/reports").RequireAuthorization(Policy);

        // Outstanding per vendor split by age of the (oldest-first allocated) unpaid invoices.
        r.MapGet("/vendor-ageing", async (Db db) =>
        {
            await using var c = await db.OpenAsync();
            var suppliers = (await c.QueryAsync<(int ID, string OrganizationName)>("SELECT ID, OrganizationName FROM TB_Supplier WHERE IsActive=1")).ToList();
            var bills = (await c.QueryAsync<Bill>("SELECT ID, SupplierID PartyID, InvoiceNo Ref, InvoiceDate Date, InvoiceTime Time, Amount, DueDate Due, Notes FROM TB_SupplierInvoice")).ToLookup(b => b.PartyID);
            var paid = (await c.QueryAsync<(int PartyID, decimal Paid)>("SELECT SupplierID PartyID, SUM(PayAmount) Paid FROM TB_SupplierInvoicePayment GROUP BY SupplierID")).ToDictionary(p => p.PartyID, p => p.Paid);
            var rows = suppliers.Select(s =>
            {
                var open = Party.Open(bills[s.ID], paid.GetValueOrDefault(s.ID));
                return new
                {
                    Vendor = s.OrganizationName,
                    D0_30 = Party.AgeBucket(open, 0, 30), D30_60 = Party.AgeBucket(open, 30, 60), D60_90 = Party.AgeBucket(open, 60, 90), D90 = Party.AgeBucket(open, 90, int.MaxValue),
                    Total = open.Sum(o => o.Remaining), Overdue = Party.Overdue(open)
                };
            }).Where(x => x.Total > 0).OrderByDescending(x => x.Total).ToList();
            return Results.Ok(rows);
        });

        // Payments per vendor in a date range (for cheques PaymentDate is the cheque date).
        r.MapGet("/vendor-payments", async (Db db, string? from, string? to) =>
        {
            var d = Range(from, to);
            await using var c = await db.OpenAsync();
            return Results.Ok(await c.QueryAsync(@"
                SELECT s.OrganizationName Vendor, COUNT(*) Payments, SUM(p.PayAmount) Total,
                       SUM(CASE WHEN p.PaymentMode='Cash' THEN p.PayAmount ELSE 0 END) Cash,
                       SUM(CASE WHEN p.PaymentMode='Cheque' THEN p.PayAmount ELSE 0 END) Cheque,
                       SUM(CASE WHEN p.PaymentMode NOT IN ('Cash','Cheque') THEN p.PayAmount ELSE 0 END) Other
                FROM TB_SupplierInvoicePayment p JOIN TB_Supplier s ON s.ID = p.SupplierID
                WHERE p.PaymentDate >= @f AND p.PaymentDate <= @t
                GROUP BY s.OrganizationName ORDER BY SUM(p.PayAmount) DESC", new { f = d.From, t = d.To }));
        });

        // Every cheque with its cheque date in the range and whether it is still to come.
        r.MapGet("/cheque-register", async (Db db, string? from, string? to) =>
        {
            var d = Range(from, to);
            await using var c = await db.OpenAsync();
            return Results.Ok(await c.QueryAsync(@"
                SELECT p.PaymentDate ChequeDate, s.OrganizationName Vendor, p.ChequeNo, p.PayAmount Amount, CONVERT(varchar(10), p.CreatedDate, 23) EntryDate,
                       CASE WHEN p.PaymentDate > @today THEN 'Upcoming' WHEN p.PaymentDate = @today THEN 'Due today' ELSE 'Past' END Status
                FROM TB_SupplierInvoicePayment p JOIN TB_Supplier s ON s.ID = p.SupplierID
                WHERE p.PaymentMode = 'Cheque' AND p.PaymentDate >= @f AND p.PaymentDate <= @t
                ORDER BY p.PaymentDate DESC, p.ID DESC", new { f = d.From, t = d.To, today = Party.Today }));
        });

        // Bills where a line was charged at a price different from the POS price.
        r.MapGet("/price-mismatch", async (Db db, string? from, string? to) =>
        {
            var d = Range(from, to);
            await using var c = await db.OpenAsync();
            return Results.Ok(await c.QueryAsync(@"
                SELECT s.SaleID, CONVERT(varchar(10), s.SaleDate, 23) SaleDate, COUNT(*) Lines,
                       SUM((sp.ActualSalePrice - sp.POSSalePrice) * sp.Quantity) Difference
                FROM (SELECT SaleID, MAX(SaleDate) SaleDate FROM TB_Sale WHERE SaleDate >= @f AND SaleDate <= @t GROUP BY SaleID) s
                JOIN TB_SaleProduct sp ON sp.SaleID = s.SaleID
                WHERE sp.ActualSalePrice <> sp.POSSalePrice
                GROUP BY s.SaleID, s.SaleDate ORDER BY s.SaleID DESC", new { f = d.FromD, t = d.ToD }));
        });
        // Profit reports: same basis as the Monthly profit page (POS price x qty, minus purchase price x qty, lines with Quantity > 0).
        const string ProfitCols = @"SUM(sp.Quantity) Qty, SUM(sp.POSSalePrice * sp.Quantity) Sales, SUM(ISNULL(sp.purchasePrice, 0) * sp.Quantity) Cost,
                       SUM((sp.POSSalePrice - ISNULL(sp.purchasePrice, 0)) * sp.Quantity) Profit,
                       CASE WHEN SUM(sp.POSSalePrice * sp.Quantity) > 0 THEN SUM((sp.POSSalePrice - ISNULL(sp.purchasePrice, 0)) * sp.Quantity) / SUM(sp.POSSalePrice * sp.Quantity) * 100 ELSE 0 END Margin";
        const string BillsCte = "WITH b AS (SELECT SaleID, MAX(SaleDate) d FROM TB_Sale WHERE SaleDate >= @f AND SaleDate <= @t GROUP BY SaleID)";

        r.MapGet("/profit-by-bill", async (Db db, string? from, string? to) =>
        {
            var d = Range(from, to);
            await using var c = await db.OpenAsync();
            return Results.Ok(await c.QueryAsync($@"{BillsCte}
                SELECT TOP (5000) b.SaleID, CONVERT(varchar(10), b.d, 23) SaleDate, {ProfitCols}
                FROM b JOIN TB_SaleProduct sp ON sp.SaleID = b.SaleID WHERE sp.Quantity > 0
                GROUP BY b.SaleID, b.d ORDER BY b.SaleID DESC", new { f = d.FromD, t = d.ToD }));
        });

        r.MapGet("/profit-daily", async (Db db, string? from, string? to) =>
        {
            var d = Range(from, to);
            await using var c = await db.OpenAsync();
            return Results.Ok(await c.QueryAsync($@"{BillsCte}
                SELECT CONVERT(varchar(10), b.d, 23) Day, COUNT(DISTINCT b.SaleID) Bills, {ProfitCols}
                FROM b JOIN TB_SaleProduct sp ON sp.SaleID = b.SaleID WHERE sp.Quantity > 0
                GROUP BY b.d ORDER BY b.d DESC", new { f = d.FromD, t = d.ToD }));
        });

        r.MapGet("/profit-monthly", async (Db db, string? from, string? to) =>
        {
            var d = Range(from, to);
            await using var c = await db.OpenAsync();
            return Results.Ok(await c.QueryAsync($@"{BillsCte}
                SELECT CONVERT(varchar(7), b.d, 23) Month, COUNT(DISTINCT b.SaleID) Bills, {ProfitCols}
                FROM b JOIN TB_SaleProduct sp ON sp.SaleID = b.SaleID WHERE sp.Quantity > 0
                GROUP BY CONVERT(varchar(7), b.d, 23) ORDER BY CONVERT(varchar(7), b.d, 23) DESC", new { f = d.FromD, t = d.ToD }));
        });
    }
}
