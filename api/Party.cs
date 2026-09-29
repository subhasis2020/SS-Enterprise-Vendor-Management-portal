using System.Globalization;

namespace SsPortal.Api;

// Shared logic for vendors (invoices/payments) and customers (credit bills/payments).
// The DB does not link payments to invoices, so payments are allocated oldest-bill-first (FIFO).
public record Bill(int ID, int PartyID, string Ref, string Date, string Time, decimal Amount, string? Due, string? Notes = null);
public record Pay(int ID, int PartyID, string Date, string Time, decimal Amount, string Mode, string? Cheque);

public static class Party
{
    public static DateTime ParseDate(string? s) =>
        DateTime.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d
        : DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out d) ? d : DateTime.MinValue;

    public static string Now => DateTime.Now.ToString("HH:mm");
    public static string Today => DateTime.Today.ToString("yyyy-MM-dd");

    // Open (unpaid) portion of each bill after allocating `paid` oldest-first.
    public static List<(Bill Bill, decimal Remaining)> Open(IEnumerable<Bill> bills, decimal paid)
    {
        var open = new List<(Bill, decimal)>();
        foreach (var b in bills.OrderBy(b => ParseDate(b.Date)).ThenBy(b => b.Time).ThenBy(b => b.ID))
        {
            var used = Math.Min(Math.Max(paid, 0), b.Amount);
            paid -= used;
            if (b.Amount - used > 0) open.Add((b, b.Amount - used));
        }
        return open;
    }

    public static decimal Overdue(List<(Bill Bill, decimal Remaining)> open) =>
        open.Where(o => !string.IsNullOrEmpty(o.Bill.Due) && string.CompareOrdinal(o.Bill.Due, Today) < 0).Sum(o => o.Remaining);

    public static decimal AgeBucket(List<(Bill Bill, decimal Remaining)> open, int lo, int hi)
    {
        var today = DateTime.Today;
        return open.Where(o => { var age = (today - ParseDate(o.Bill.Date)).Days; return age >= lo && age < hi; }).Sum(o => o.Remaining);
    }

    public static List<object> Ledger(IEnumerable<Bill> bills, IEnumerable<Pay> pays)
    {
        // mode/cheque are the raw fields an edit form needs for a Payment row - ref is a display-only "Mode #Cheque" string.
        var rows = bills.Select(b => new { id = b.ID, date = b.Date, time = b.Time, type = "Invoice", @ref = b.Ref, debit = b.Amount, credit = 0m, due = b.Due, mode = (string?)null, cheque = (string?)null, notes = b.Notes })
            .Concat(pays.Select(p => new { id = p.ID, date = p.Date, time = p.Time, type = "Payment", @ref = p.Mode + (string.IsNullOrEmpty(p.Cheque) ? "" : " #" + p.Cheque), debit = 0m, credit = p.Amount, due = (string?)null, mode = (string?)p.Mode, cheque = p.Cheque, notes = (string?)null }))
            .OrderBy(r => ParseDate(r.date)).ThenBy(r => r.time).ToList();
        decimal bal = 0;
        var result = new List<object>();
        foreach (var r in rows)
        {
            bal += r.debit - r.credit;
            result.Add(new { r.id, r.date, r.time, r.type, r.@ref, r.debit, r.credit, r.due, r.mode, r.cheque, r.notes, balance = bal });
        }
        return result;
    }
}
