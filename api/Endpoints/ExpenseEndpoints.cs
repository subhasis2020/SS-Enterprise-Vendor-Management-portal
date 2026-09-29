using Dapper;
using System.Security.Claims;

namespace SsPortal.Api;

public static class ExpenseEndpoints
{
    record Expense(int ID, decimal Amount, string? Notes, string PaymentMode, string? TransactionID, string? ChequeNo, DateTime CreatedDate, string? CreatedBy);
    record ExpenseReq(decimal Amount, string? Notes, string PaymentMode, string? TransactionID, string? ChequeNo);

    public static void Map(RouteGroupBuilder g)
    {
        g.MapGet("/expenses", async (Db db, string? from, string? to, string? q) =>
        {
            DateTime? f = DateTime.TryParse(from, out var fd) ? fd : null;
            DateTime? t = DateTime.TryParse(to, out var td) ? td.AddDays(1) : null; // inclusive of the whole "to" day
            await using var c = await db.OpenAsync();
            var rows = await c.QueryAsync<Expense>(@"
                SELECT ID, Amount, Notes, PaymentMode, TransactionID, ChequeNo, CreatedDate, CreatedBy
                FROM TB_DailyExpense
                WHERE (@f IS NULL OR CreatedDate >= @f) AND (@t IS NULL OR CreatedDate < @t)
                  AND (@q IS NULL OR Notes LIKE '%' + @q + '%')
                ORDER BY CreatedDate DESC", new { f, t, q = string.IsNullOrWhiteSpace(q) ? null : q.Trim() });
            return Results.Ok(rows);
        });

        g.MapPost("/expenses", async (ExpenseReq r, Db db, ClaimsPrincipal u) =>
        {
            if (r.Amount <= 0 || string.IsNullOrWhiteSpace(r.PaymentMode)) return Results.BadRequest(new { error = "Amount and payment mode are required." });
            await using var c = await db.OpenAsync();
            var by = u.Identity?.Name ?? "portal";
            await c.ExecuteAsync(@"INSERT INTO TB_DailyExpense (Amount, Notes, PaymentMode, TransactionID, ChequeNo, CreatedDate, CreatedBy, UpdatedDate, UpdatedBy)
                VALUES (@Amount, @Notes, @PaymentMode, @TransactionID, @ChequeNo, GETDATE(), @by, GETDATE(), @by)",
                new { r.Amount, r.Notes, r.PaymentMode, TransactionID = r.PaymentMode == "Cheque" ? null : r.TransactionID, ChequeNo = r.PaymentMode == "Cheque" ? r.ChequeNo : null, by });
            return Results.Ok();
        });
    }
}
