using Dapper;
using System.Security.Claims;

namespace SsPortal.Api;

public static class VendorEndpoints
{
    record Supplier(int ID, string OrganizationName, string? GSTNO, string? PhoneNo, bool IsActive, string? Notes);
    record PaidRow(int PartyID, decimal Paid);
    record InvoiceReq(int SupplierID, string InvoiceNo, decimal Amount, string InvoiceDate, string? DueDate, string? Notes);
    record PaymentReq(int SupplierID, decimal PayAmount, string PaymentMode, string PaymentDate, string? ChequeNo, string? TransactionID, string? Notes, string? EntryDate = null);
    record VendorEditReq(string OrganizationName, string? GSTNO, string? PhoneNo, string? Notes);
    record NewVendorReq(string OrganizationName, string? GSTNO, string? PhoneNo, string? Notes);
    record EditInvoiceReq(string InvoiceNo, decimal Amount, string InvoiceDate, string? DueDate, string? Notes);
    record EditPaymentReq(decimal PayAmount, string PaymentMode, string PaymentDate, string? ChequeNo, string? Notes, string? EntryDate = null);

    // For a Cheque, PaymentDate holds the cheque date (mandatory); EntryDate is when it was recorded (stored in CreatedDate).
    // For any other mode PaymentDate is simply the payment/entry date, as before.
    const string ChequeDateRequired = "Cheque date is required for a cheque payment.";

    const string InvoiceSql = "SELECT ID, SupplierID PartyID, InvoiceNo Ref, InvoiceDate Date, InvoiceTime Time, Amount, DueDate Due, Notes FROM TB_SupplierInvoice";
    const string PaySql = "SELECT ID, SupplierID PartyID, PaymentDate Date, PaymentTime Time, PayAmount Amount, PaymentMode Mode, ChequeNo Cheque, Notes, CONVERT(varchar(10), CreatedDate, 23) EntryDate FROM TB_SupplierInvoicePayment";

    public static async Task<List<object>> LoadStats(Db db)
    {
        await using var c = await db.OpenAsync();
        var suppliers = (await c.QueryAsync<Supplier>("SELECT ID, OrganizationName, GSTNO, PhoneNo, IsActive, Notes FROM TB_Supplier WHERE IsActive=1 ORDER BY OrganizationName")).ToList();
        var bills = (await c.QueryAsync<Bill>(InvoiceSql)).ToLookup(b => b.PartyID);
        var paid = (await c.QueryAsync<PaidRow>("SELECT SupplierID PartyID, SUM(PayAmount) Paid FROM TB_SupplierInvoicePayment GROUP BY SupplierID")).ToDictionary(p => p.PartyID, p => p.Paid);
        return suppliers.Select(s =>
        {
            var b = bills[s.ID].ToList();
            var p = paid.GetValueOrDefault(s.ID);
            var inv = b.Sum(x => x.Amount);
            var open = Party.Open(b, p);
            return (object)new
            {
                s.ID, s.OrganizationName, s.GSTNO, s.PhoneNo, s.IsActive,
                invoiced = inv, paid = p, outstanding = inv - p, overdue = Party.Overdue(open),
                lastInvoice = b.Count == 0 ? "" : b.Max(x => x.Date)
            };
        }).ToList();
    }

    public static void Map(RouteGroupBuilder g)
    {
        g.MapGet("/suppliers", async (Db db) =>
        {
            await using var c = await db.OpenAsync();
            return Results.Ok(await c.QueryAsync("SELECT ID, OrganizationName FROM TB_Supplier WHERE IsActive=1 ORDER BY OrganizationName"));
        });

        g.MapGet("/vendors", async (Db db) => Results.Ok(await LoadStats(db)));

        g.MapGet("/vendors/cheques", async (Db db) =>
        {
            await using var c = await db.OpenAsync();
            var rows = await c.QueryAsync(@"
                SELECT p.SupplierID, s.OrganizationName, p.PayAmount, p.PaymentDate, p.PaymentTime, p.ChequeNo
                FROM TB_SupplierInvoicePayment p JOIN TB_Supplier s ON s.ID = p.SupplierID
                WHERE p.PaymentMode = 'Cheque'
                ORDER BY p.PaymentDate DESC, p.PaymentTime DESC");
            return Results.Ok(rows);
        });

        g.MapGet("/vendors/{id:int}", async (int id, Db db) =>
        {
            await using var c = await db.OpenAsync();
            var v = await c.QueryFirstOrDefaultAsync<Supplier>("SELECT ID, OrganizationName, GSTNO, PhoneNo, IsActive, Notes FROM TB_Supplier WHERE ID=@id", new { id });
            if (v is null) return Results.NotFound();
            var bills = (await c.QueryAsync<Bill>(InvoiceSql + " WHERE SupplierID=@id", new { id })).ToList();
            var pays = (await c.QueryAsync<Pay>(PaySql + " WHERE SupplierID=@id", new { id })).ToList();
            return Results.Ok(new { vendor = v, ledger = Party.Ledger(bills, pays), invoiced = bills.Sum(b => b.Amount), paid = pays.Sum(p => p.Amount) });
        });

        g.MapPost("/vendors", async (NewVendorReq r, Db db) =>
        {
            if (string.IsNullOrWhiteSpace(r.OrganizationName)) return Results.BadRequest(new { error = "Organization name is required." });
            await using var c = await db.OpenAsync();
            var id = await c.QuerySingleAsync<int>(@"INSERT INTO TB_Supplier (OrganizationName, GSTNO, PhoneNo, Notes, IsActive, CreatedDate, UpdatedDate)
                OUTPUT INSERTED.ID VALUES (@OrganizationName, @GSTNO, @PhoneNo, @Notes, 1, GETDATE(), GETDATE())",
                new { OrganizationName = r.OrganizationName.Trim(), r.GSTNO, r.PhoneNo, r.Notes });
            return Results.Ok(new { ID = id });
        });

        // POST, not PUT: the shared host's IIS blocks the PUT verb outright (403 before the request reaches the app).
        g.MapPost("/vendors/{id:int}/edit", async (int id, VendorEditReq r, Db db) =>
        {
            if (string.IsNullOrWhiteSpace(r.OrganizationName)) return Results.BadRequest(new { error = "Organization name is required." });
            await using var c = await db.OpenAsync();
            var n = await c.ExecuteAsync(@"UPDATE TB_Supplier SET OrganizationName=@OrganizationName, GSTNO=@GSTNO, PhoneNo=@PhoneNo, Notes=@Notes, UpdatedDate=GETDATE() WHERE ID=@id",
                new { id, OrganizationName = r.OrganizationName.Trim(), r.GSTNO, r.PhoneNo, r.Notes });
            return n == 0 ? Results.NotFound() : Results.Ok();
        });

        g.MapPost("/vendors/invoices", async (InvoiceReq r, Db db, ClaimsPrincipal u) =>
        {
            if (r.Amount <= 0 || string.IsNullOrWhiteSpace(r.InvoiceNo) || Party.ParseDate(r.InvoiceDate) == DateTime.MinValue) return Results.BadRequest(new { error = "Invoice no., amount and date are required." });
            await using var c = await db.OpenAsync();
            var by = u.Identity?.Name ?? "portal";
            await c.ExecuteAsync(@"INSERT INTO TB_SupplierInvoice (SupplierID, InvoiceNo, InvoiceDate, InvoiceTime, Amount, Notes, DueDate, CreatedDate, CreatedBy, UpdatedDate, UpdatedBy)
                VALUES (@SupplierID, @InvoiceNo, @InvoiceDate, @t, @Amount, @Notes, @DueDate, GETDATE(), @by, GETDATE(), @by)",
                new { r.SupplierID, InvoiceNo = r.InvoiceNo.Trim(), r.InvoiceDate, t = Party.Now, r.Amount, r.Notes, DueDate = string.IsNullOrWhiteSpace(r.DueDate) ? null : r.DueDate, by });
            DashboardEndpoints.Bust();
            return Results.Ok();
        });

        // Edits a wrongly-entered invoice/payment in place. Notes is now editable too - the frontend pre-fills the
        // form with the current note, so leaving it unchanged just round-trips the same value instead of blanking it.
        g.MapPost("/vendors/invoices/{id:int}/edit", async (int id, EditInvoiceReq r, Db db, ClaimsPrincipal u) =>
        {
            if (r.Amount <= 0 || string.IsNullOrWhiteSpace(r.InvoiceNo) || Party.ParseDate(r.InvoiceDate) == DateTime.MinValue) return Results.BadRequest(new { error = "Invoice no., amount and date are required." });
            await using var c = await db.OpenAsync();
            var by = u.Identity?.Name ?? "portal";
            var n = await c.ExecuteAsync(@"UPDATE TB_SupplierInvoice SET InvoiceNo=@InvoiceNo, Amount=@Amount, InvoiceDate=@InvoiceDate, DueDate=@DueDate, Notes=@Notes, UpdatedDate=GETDATE(), UpdatedBy=@by WHERE ID=@id",
                new { id, InvoiceNo = r.InvoiceNo.Trim(), r.Amount, r.InvoiceDate, DueDate = string.IsNullOrWhiteSpace(r.DueDate) ? null : r.DueDate, r.Notes, by });
            DashboardEndpoints.Bust();
            return n == 0 ? Results.NotFound() : Results.Ok();
        });

        g.MapPost("/vendors/payments", async (PaymentReq r, Db db, ClaimsPrincipal u) =>
        {
            if (r.PayAmount <= 0 || Party.ParseDate(r.PaymentDate) == DateTime.MinValue || string.IsNullOrWhiteSpace(r.PaymentMode)) return Results.BadRequest(new { error = "Amount, mode and date are required." });
            if (r.PaymentMode == "Cheque" && string.IsNullOrWhiteSpace(r.PaymentDate)) return Results.BadRequest(new { error = ChequeDateRequired });
            await using var c = await db.OpenAsync();
            var by = u.Identity?.Name ?? "portal";
            var entry = Party.ParseDate(r.EntryDate) is var e && e != DateTime.MinValue ? e.Date + DateTime.Now.TimeOfDay : DateTime.Now;
            await c.ExecuteAsync(@"INSERT INTO TB_SupplierInvoicePayment (SupplierID, PayAmount, PaymentMode, TransactionID, ChequeNo, PaymentDate, PaymentTime, Notes, CreatedDate, CreatedBy, UpdatedDate, UpdatedBy)
                VALUES (@SupplierID, @PayAmount, @PaymentMode, @TransactionID, @ChequeNo, @PaymentDate, @t, @Notes, @entry, @by, GETDATE(), @by)",
                new { r.SupplierID, r.PayAmount, r.PaymentMode, r.TransactionID, r.ChequeNo, r.PaymentDate, t = Party.Now, r.Notes, entry, by });
            DashboardEndpoints.Bust();
            return Results.Ok();
        });

        g.MapPost("/vendors/payments/{id:int}/edit", async (int id, EditPaymentReq r, Db db, ClaimsPrincipal u) =>
        {
            if (r.PaymentMode == "Cheque" && string.IsNullOrWhiteSpace(r.PaymentDate)) return Results.BadRequest(new { error = ChequeDateRequired });
            if (r.PayAmount <= 0 || Party.ParseDate(r.PaymentDate) == DateTime.MinValue || string.IsNullOrWhiteSpace(r.PaymentMode)) return Results.BadRequest(new { error = "Amount, mode and date are required." });
            await using var c = await db.OpenAsync();
            var by = u.Identity?.Name ?? "portal";
            // Move CreatedDate to the chosen entry date but keep its time of day; no EntryDate sent = leave it alone.
            DateTime? entry = Party.ParseDate(r.EntryDate) is var e && e != DateTime.MinValue ? e.Date : null;
            var n = await c.ExecuteAsync(@"UPDATE TB_SupplierInvoicePayment SET PayAmount=@PayAmount, PaymentMode=@PaymentMode, ChequeNo=@ChequeNo, PaymentDate=@PaymentDate, Notes=@Notes,
                CreatedDate = CASE WHEN @entry IS NULL THEN CreatedDate ELSE DATEADD(day, DATEDIFF(day, CAST(CreatedDate AS date), @entry), CreatedDate) END,
                UpdatedDate=GETDATE(), UpdatedBy=@by WHERE ID=@id",
                new { id, r.PayAmount, r.PaymentMode, ChequeNo = r.PaymentMode == "Cheque" ? r.ChequeNo : null, r.PaymentDate, r.Notes, entry, by });
            DashboardEndpoints.Bust();
            return n == 0 ? Results.NotFound() : Results.Ok();
        });
    }
}
