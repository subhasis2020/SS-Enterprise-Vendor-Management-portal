using Dapper;
using System.Security.Claims;

namespace SsPortal.Api;

public static class CustomerEndpoints
{
    record Customer(int ID, string Name, string? Address, string? Phone, bool IsActive);
    record PaidRow(int PartyID, decimal Paid);
    record CreditReq(int CustomerID, string BillNo, decimal Amount, string BillDate, string? DueDate, string? Notes);
    record PaymentReq(int CustomerID, decimal PayAmount, string PaymentMode, string PaymentDate, string? ChequeNo, string? TransactionID, string? Notes);

    const string BillSql = "SELECT ID, CustomerID PartyID, BillNo Ref, BillDate Date, BillTime Time, Amount, DueDate Due, Notes FROM TB_CustomerCredit";
    const string PaySql = "SELECT ID, CustomerID PartyID, PaymentDate Date, PaymentTime Time, PayAmount Amount, PaymentMode Mode, ChequeNo Cheque, Notes, CONVERT(varchar(10), CreatedDate, 23) EntryDate FROM TB_CustomerCreditPayment";

    public static async Task<List<object>> LoadStats(Db db)
    {
        await using var c = await db.OpenAsync();
        var customers = (await c.QueryAsync<Customer>("SELECT ID, Name, Address, Phone, IsActive FROM TB_Customer WHERE IsActive=1 ORDER BY Name")).ToList();
        var bills = (await c.QueryAsync<Bill>(BillSql)).ToLookup(b => b.PartyID);
        var paid = (await c.QueryAsync<PaidRow>("SELECT CustomerID PartyID, SUM(PayAmount) Paid FROM TB_CustomerCreditPayment GROUP BY CustomerID")).ToDictionary(p => p.PartyID, p => p.Paid);
        return customers.Select(cu =>
        {
            var b = bills[cu.ID].ToList();
            var p = paid.GetValueOrDefault(cu.ID);
            var credit = b.Sum(x => x.Amount);
            var open = Party.Open(b, p);
            return (object)new
            {
                cu.ID, cu.Name, cu.Address, cu.Phone, cu.IsActive,
                credit, paid = p, outstanding = credit - p,
                b0 = Party.AgeBucket(open, 0, 11), b1 = Party.AgeBucket(open, 11, 31), b2 = Party.AgeBucket(open, 31, int.MaxValue)
            };
        }).ToList();
    }

    public static void Map(RouteGroupBuilder g)
    {
        g.MapGet("/customer-list", async (Db db) =>
        {
            await using var c = await db.OpenAsync();
            return Results.Ok(await c.QueryAsync("SELECT ID, Name FROM TB_Customer WHERE IsActive=1 ORDER BY Name"));
        });

        g.MapGet("/customers", async (Db db) => Results.Ok(await LoadStats(db)));

        g.MapGet("/customers/{id:int}", async (int id, Db db) =>
        {
            await using var c = await db.OpenAsync();
            var cu = await c.QueryFirstOrDefaultAsync<Customer>("SELECT ID, Name, Address, Phone, IsActive FROM TB_Customer WHERE ID=@id", new { id });
            if (cu is null) return Results.NotFound();
            var bills = (await c.QueryAsync<Bill>(BillSql + " WHERE CustomerID=@id", new { id })).ToList();
            var pays = (await c.QueryAsync<Pay>(PaySql + " WHERE CustomerID=@id", new { id })).ToList();
            return Results.Ok(new { customer = cu, ledger = Party.Ledger(bills, pays), credit = bills.Sum(b => b.Amount), paid = pays.Sum(p => p.Amount) });
        });

        g.MapPost("/customers/credits", async (CreditReq r, Db db, ClaimsPrincipal u) =>
        {
            if (r.Amount <= 0 || string.IsNullOrWhiteSpace(r.BillNo) || Party.ParseDate(r.BillDate) == DateTime.MinValue) return Results.BadRequest(new { error = "Bill no., amount and date are required." });
            await using var c = await db.OpenAsync();
            var by = u.Identity?.Name ?? "portal";
            await c.ExecuteAsync(@"INSERT INTO TB_CustomerCredit (CustomerID, BillNo, BillDate, BillTime, Amount, DueDate, Notes, CreatedDate, CreatedBy, UpdatedDate, UpdatedBy)
                VALUES (@CustomerID, @BillNo, @BillDate, @t, @Amount, @DueDate, @Notes, GETDATE(), @by, GETDATE(), @by)",
                new { r.CustomerID, BillNo = r.BillNo.Trim(), r.BillDate, t = Party.Now, r.Amount, DueDate = string.IsNullOrWhiteSpace(r.DueDate) ? null : r.DueDate, r.Notes, by });
            return Results.Ok();
        });

        g.MapPost("/customers/payments", async (PaymentReq r, Db db, ClaimsPrincipal u) =>
        {
            if (r.PayAmount <= 0 || Party.ParseDate(r.PaymentDate) == DateTime.MinValue || string.IsNullOrWhiteSpace(r.PaymentMode)) return Results.BadRequest(new { error = "Amount, mode and date are required." });
            await using var c = await db.OpenAsync();
            var by = u.Identity?.Name ?? "portal";
            await c.ExecuteAsync(@"INSERT INTO TB_CustomerCreditPayment (CustomerID, PayAmount, PaymentMode, TransactionID, ChequeNo, PaymentDate, PaymentTime, Notes, CreatedDate, CreatedBy, UpdatedDate, UpdatedBy)
                VALUES (@CustomerID, @PayAmount, @PaymentMode, @TransactionID, @ChequeNo, @PaymentDate, @t, @Notes, GETDATE(), @by, GETDATE(), @by)",
                new { r.CustomerID, r.PayAmount, r.PaymentMode, r.TransactionID, r.ChequeNo, r.PaymentDate, t = Party.Now, r.Notes, by });
            return Results.Ok();
        });
    }
}
