using ClosedXML.Excel;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Data.SqlClient;
using Microsoft.Extensions.Caching.Memory;
using System.Data;
using System.Globalization;
using System.Security.Claims;

namespace SsPortal.Api;

/// <summary>
/// Excel -> Product sync. Two steps so nothing is written blindly:
///   1. POST /products/sync/preview  (upload .xlsx)  -> parsed, diffed against the DB, nothing written
///   2. POST /products/sync/apply    (token+options) -> one transaction; only ticked options are applied
/// Rows are matched on product_Id (barcodes are not unique in the data).
/// </summary>
public static class ProductSyncEndpoints
{
    public class PRow
    {
        public int RowNo; public int Id; public string Name = ""; public string? Category;
        public int? LocationId; public string? Barcode, SerialNo; public int UnitOnOrder, Sold, Inventory;
        public decimal UnitPrice, SalePrice, Discount, DiscountPct, CGST, SGST, IGST, MRP;
        public string? Description, HSN; public int? SubCatgId, StockId, UnitId, MerchantId;
        public DateTime? DateCreated, UploadDate; public bool? IsActiveOnServer;
    }
    record Parsed(string FileName, List<PRow> Rows, List<string> Invalid);
    record ApplyReq(string Token, bool Categories, bool NewProducts, bool Details, bool Stock);
    record DbRow(int product_Id, string? product_name, string? product_barCode, decimal? product_unitPrice, decimal? product_salePrice, decimal? product_MRP,
        decimal? product_discount, decimal? product_CGST, decimal? product_SGST, decimal? product_IGST, string? product_HSN,
        int? product_inventory, int? product_sold, int? product_unitOnOrder, int product_categoryId);

    static readonly string[] DateFormats = {
        "dd-MM-yyyy HH:mm:ss", "dd-MM-yyyy HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "dd-MM-yyyy", "yyyy-MM-dd",
        "d-M-yyyy H:mm:ss", "d-M-yyyy H:mm", "dd/MM/yyyy HH:mm:ss", "dd/MM/yyyy" };

    public static void Map(RouteGroupBuilder g)
    {
        var admin = new AuthorizeAttribute { Roles = "Admin" };

        // multipart upload: antiforgery is disabled because auth is a SameSite=Lax cookie + admin role and there is no HTML form post.
        g.MapPost("/products/sync/preview", async (IFormFile file, Db db, IMemoryCache cache) =>
        {
            if (file is null || file.Length == 0) return Results.BadRequest(new { error = "Choose an .xlsx file." });
            if (!file.FileName.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase)) return Results.BadRequest(new { error = "Only .xlsx files are supported." });
            if (file.Length > 25_000_000) return Results.BadRequest(new { error = "File is larger than 25 MB." });

            Parsed parsed;
            try { await using var s = file.OpenReadStream(); parsed = Parse(s, file.FileName); }
            catch (InvalidDataException ex) { return Results.BadRequest(new { error = ex.Message }); }
            catch (Exception) { return Results.BadRequest(new { error = "Could not read the workbook. Is it a valid .xlsx file?" }); }

            var token = Guid.NewGuid().ToString("N");
            cache.Set(token, parsed, TimeSpan.FromMinutes(30));
            return Results.Ok(await Preview(db, parsed, token));
        }).DisableAntiforgery().RequireAuthorization(admin);

        g.MapPost("/products/sync/apply", async (ApplyReq r, Db db, IMemoryCache cache, ClaimsPrincipal u) =>
        {
            if (!cache.TryGetValue(r.Token ?? "", out Parsed? parsed) || parsed is null)
                return Results.BadRequest(new { error = "Preview expired. Upload the file again." });
            if (!r.Categories && !r.NewProducts && !r.Details && !r.Stock) return Results.BadRequest(new { error = "Tick at least one option to apply." });
            var result = await Apply(db, parsed, r, u.Identity?.Name ?? "portal");
            cache.Remove(r.Token!);
            return Results.Ok(result);
        }).RequireAuthorization(admin);

        g.MapGet("/products/sync/log", async (Db db) =>
        {
            await using var c = await db.OpenAsync();
            return Results.Ok(await c.QueryAsync("SELECT TOP 15 Id, CONVERT(varchar(16), RunAt, 120) RunAt, RunBy, FileName, ExcelRows, CategoriesCreated, CategoriesAssigned, ProductsInserted, DetailsUpdated, StockUpdated, Options FROM dbo.ProductSyncLog ORDER BY Id DESC"));
        }).RequireAuthorization(admin);
    }

    // ---------------------------------------------------------------- parsing
    static string? Str(IXLCell c, int max)
    {
        if (c.IsEmpty()) return null;
        var s = c.DataType == XLDataType.Number ? c.GetDouble().ToString("0.############", CultureInfo.InvariantCulture) : c.GetString();
        s = string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)); // trim + collapse spaces
        if (s.Length == 0) return null;
        return s.Length > max ? s[..max] : s;
    }
    static double? Num(IXLCell c)
    {
        if (c.IsEmpty()) return null;
        if (c.DataType == XLDataType.Number) return c.GetDouble();
        return double.TryParse(c.GetString().Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : null;
    }
    static DateTime? Date(IXLCell c)
    {
        if (c.IsEmpty()) return null;
        if (c.DataType == XLDataType.DateTime) return c.GetDateTime();
        return DateTime.TryParseExact(c.GetString().Trim(), DateFormats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;
    }

    static Parsed Parse(Stream stream, string fileName)
    {
        using var wb = new XLWorkbook(stream);
        var ws = wb.Worksheets.FirstOrDefault(w => w.Name.Equals("Products", StringComparison.OrdinalIgnoreCase)) ?? wb.Worksheet(1);
        var col = ws.Row(1).CellsUsed().GroupBy(c => c.GetString().Trim().ToLowerInvariant()).ToDictionary(g => g.Key, g => g.First().Address.ColumnNumber);
        foreach (var need in new[] { "product_id", "product_name" })
            if (!col.ContainsKey(need)) throw new InvalidDataException($"Column '{need}' not found in the first row of sheet '{ws.Name}'.");

        IXLCell Cell(IXLRow r, string name) => col.TryGetValue(name, out var n) ? r.Cell(n) : r.Cell(16384);
        int I(IXLRow r, string n) => (int)(Num(Cell(r, n)) ?? 0);
        int? IN(IXLRow r, string n) => Num(Cell(r, n)) is { } d ? (int)d : null;
        decimal D(IXLRow r, string n, int scale = 2) => Math.Round((decimal)(Num(Cell(r, n)) ?? 0), scale);

        var rows = new List<PRow>(); var invalid = new List<string>(); var seen = new HashSet<int>();
        var last = ws.LastRowUsed()?.RowNumber() ?? 1;
        for (var n = 2; n <= last; n++)
        {
            var r = ws.Row(n);
            if (r.IsEmpty()) continue;
            var id = Num(Cell(r, "product_id"));
            var name = Str(Cell(r, "product_name"), 255);
            if (id is null || id <= 0 || id != Math.Floor(id.Value)) { invalid.Add($"Row {n}: missing or invalid product_Id"); continue; }
            if (name is null) { invalid.Add($"Row {n} (id {id}): product_name is empty"); continue; }
            if (!seen.Add((int)id.Value)) { invalid.Add($"Row {n}: duplicate product_Id {id}"); continue; }
            rows.Add(new PRow
            {
                RowNo = n, Id = (int)id.Value, Name = name, Category = Str(Cell(r, "category"), 100),
                LocationId = IN(r, "product_locationid"), Barcode = Str(Cell(r, "product_barcode"), 100), SerialNo = Str(Cell(r, "product_serialno"), 100),
                UnitOnOrder = I(r, "product_unitonorder"), Sold = I(r, "product_sold"), Inventory = I(r, "product_inventory"),
                UnitPrice = D(r, "product_unitprice"), SalePrice = D(r, "product_saleprice"), Discount = D(r, "product_discount"),
                DiscountPct = D(r, "product_discount_percentage"), CGST = D(r, "product_cgst"), SGST = D(r, "product_sgst"), IGST = D(r, "product_igst"), MRP = D(r, "product_mrp"),
                Description = Str(Cell(r, "product_description"), 4000), HSN = Str(Cell(r, "product_hsn"), 50),
                SubCatgId = IN(r, "product_subcatgid"), StockId = IN(r, "stock_id"), UnitId = IN(r, "unit_id"), MerchantId = IN(r, "merchantid"),
                DateCreated = Date(Cell(r, "product_datecreated")), UploadDate = Date(Cell(r, "uploaddate")),
                IsActiveOnServer = Num(Cell(r, "isactiveonserver")) is { } b ? b != 0 : null,
            });
        }
        if (rows.Count == 0) throw new InvalidDataException("No valid product rows found.");
        return new Parsed(fileName, rows, invalid);
    }

    // ---------------------------------------------------------------- diff semantics (mirrors the SQL in Apply)
    static string S(string? s) => (s ?? "").Trim();
    static bool SameS(string? a, string? b) => string.Equals(S(a), S(b), StringComparison.OrdinalIgnoreCase);
    static bool SameD(decimal? a, decimal? b) => Math.Round(a ?? 0, 2) == Math.Round(b ?? 0, 2);
    static bool DetailsDiffer(PRow x, DbRow d) =>
        !SameS(x.Name, d.product_name) || !SameS(x.Barcode, d.product_barCode) || !SameS(x.HSN, d.product_HSN) ||
        !SameD(x.UnitPrice, d.product_unitPrice) || !SameD(x.SalePrice, d.product_salePrice) || !SameD(x.MRP, d.product_MRP) || !SameD(x.Discount, d.product_discount) ||
        !SameD(x.CGST, d.product_CGST) || !SameD(x.SGST, d.product_SGST) || !SameD(x.IGST, d.product_IGST);
    static bool StockDiffers(PRow x, DbRow d) =>
        x.Inventory != (d.product_inventory ?? 0) || x.Sold != (d.product_sold ?? 0) || x.UnitOnOrder != (d.product_unitOnOrder ?? 0);

    // ---------------------------------------------------------------- preview
    static async Task<object> Preview(Db db, Parsed p, string token)
    {
        await using var c = await db.OpenAsync();
        var dbRows = (await c.QueryAsync<DbRow>(@"SELECT product_Id, product_name, product_barCode, product_unitPrice, product_salePrice, product_MRP, product_discount,
            product_CGST, product_SGST, product_IGST, product_HSN, product_inventory, product_sold, product_unitOnOrder, ISNULL(product_categoryId,0) product_categoryId FROM Product"))
            .ToDictionary(r => r.product_Id);
        var cats = (await c.QueryAsync<(int Id, string Name)>("SELECT Id, Name FROM dbo.Category")).ToDictionary(x => x.Name, x => x.Id, StringComparer.OrdinalIgnoreCase);

        var matched = p.Rows.Where(r => dbRows.ContainsKey(r.Id)).ToList();
        var fresh = p.Rows.Where(r => !dbRows.ContainsKey(r.Id)).ToList();
        var categoryChanges = matched.Count(r => r.Category != null && (!cats.TryGetValue(r.Category, out var id) || id != dbRows[r.Id].product_categoryId));
        var catSummary = p.Rows.Where(r => r.Category != null).GroupBy(r => r.Category!, StringComparer.OrdinalIgnoreCase)
            .Select(g => new { name = g.Key, products = g.Count(), isNew = !cats.ContainsKey(g.Key) }).OrderByDescending(x => x.products).ToList();
        var dupBarcodes = p.Rows.Where(r => r.Barcode != null).GroupBy(r => r.Barcode!).Count(g => g.Count() > 1);

        var warnings = new List<string>();
        if (p.Invalid.Count > 0) warnings.Add($"{p.Invalid.Count} row(s) skipped as invalid.");
        var noCat = p.Rows.Count(r => r.Category == null);
        if (noCat > 0) warnings.Add($"{noCat} product(s) have no category in the file and will stay Uncategorized.");
        if (dupBarcodes > 0) warnings.Add($"{dupBarcodes} barcode(s) are used by more than one product (rows are matched on product_Id, so this is harmless).");
        var missingInFile = dbRows.Count - matched.Count;
        if (missingInFile > 0) warnings.Add($"{missingInFile} product(s) in the database are not in the file. They are left untouched.");

        return new
        {
            token, fileName = p.FileName, excelRows = p.Rows.Count, matched = matched.Count, newProducts = fresh.Count,
            categoryChanges, newCategories = catSummary.Count(x => x.isNew), uncategorized = noCat,
            detailDiffs = matched.Count(r => DetailsDiffer(r, dbRows[r.Id])), stockDiffs = matched.Count(r => StockDiffers(r, dbRows[r.Id])),
            categories = catSummary,
            newSamples = fresh.Take(8).Select(r => new { r.Id, r.Name, r.Category, r.SalePrice }).ToList(),
            detailSamples = matched.Where(r => DetailsDiffer(r, dbRows[r.Id])).Take(6).Select(r => new
            {
                r.Id, r.Name, dbSale = dbRows[r.Id].product_salePrice ?? 0, fileSale = r.SalePrice, dbCost = dbRows[r.Id].product_unitPrice ?? 0, fileCost = r.UnitPrice
            }).ToList(),
            stockSamples = matched.Where(r => StockDiffers(r, dbRows[r.Id])).Take(6).Select(r => new
            {
                r.Id, r.Name, dbStock = dbRows[r.Id].product_inventory ?? 0, fileStock = r.Inventory
            }).ToList(),
            warnings, invalid = p.Invalid.Take(10).ToList()
        };
    }

    // ---------------------------------------------------------------- apply
    static DataTable Stage(List<PRow> rows)
    {
        var t = new DataTable();
        (string, Type)[] cols = {
            ("product_Id", typeof(int)), ("product_name", typeof(string)), ("category", typeof(string)), ("product_locationId", typeof(int)),
            ("product_barCode", typeof(string)), ("product_serialNo", typeof(string)), ("product_unitOnOrder", typeof(int)), ("product_sold", typeof(int)),
            ("product_inventory", typeof(int)), ("product_unitPrice", typeof(decimal)), ("product_salePrice", typeof(decimal)), ("product_discount", typeof(decimal)),
            ("product_discount_percentage", typeof(decimal)), ("product_description", typeof(string)), ("product_CGST", typeof(decimal)), ("product_SGST", typeof(decimal)),
            ("product_IGST", typeof(decimal)), ("product_subCatgId", typeof(int)), ("product_dateCreated", typeof(DateTime)), ("product_HSN", typeof(string)),
            ("product_MRP", typeof(decimal)), ("stock_id", typeof(int)), ("unit_Id", typeof(int)), ("merchantId", typeof(int)), ("isActiveOnServer", typeof(bool)), ("uploadDate", typeof(DateTime)) };
        foreach (var (n, ty) in cols) t.Columns.Add(n, ty);
        object V(object? o) => o ?? DBNull.Value;
        foreach (var r in rows)
            t.Rows.Add(r.Id, r.Name, V(r.Category), V(r.LocationId), V(r.Barcode), V(r.SerialNo), r.UnitOnOrder, r.Sold, r.Inventory, r.UnitPrice, r.SalePrice, r.Discount,
                r.DiscountPct, V(r.Description), r.CGST, r.SGST, r.IGST, V(r.SubCatgId), V(r.DateCreated), V(r.HSN), r.MRP, V(r.StockId), V(r.UnitId), V(r.MerchantId),
                V(r.IsActiveOnServer), V(r.UploadDate));
        return t;
    }

    const string StageDdl = @"CREATE TABLE #s (product_Id int NOT NULL PRIMARY KEY, product_name nvarchar(255), category nvarchar(100), product_locationId int,
        product_barCode nvarchar(100), product_serialNo nvarchar(100), product_unitOnOrder int, product_sold int, product_inventory int,
        product_unitPrice decimal(18,2), product_salePrice decimal(18,2), product_discount decimal(18,2), product_discount_percentage decimal(5,2),
        product_description nvarchar(max), product_CGST decimal(5,2), product_SGST decimal(5,2), product_IGST decimal(5,2), product_subCatgId int,
        product_dateCreated datetime, product_HSN nvarchar(50), product_MRP decimal(18,2), stock_id int, unit_Id int, merchantId int,
        isActiveOnServer bit, uploadDate datetime)";

    static async Task<object> Apply(Db db, Parsed p, ApplyReq o, string by)
    {
        await using var c = await db.OpenAsync();
        await using var tx = (SqlTransaction)await c.BeginTransactionAsync();
        try
        {
            await c.ExecuteAsync(StageDdl, transaction: tx);
            using (var bulk = new SqlBulkCopy(c, SqlBulkCopyOptions.Default, tx) { DestinationTableName = "#s", BulkCopyTimeout = 120 })
            {
                var dt = Stage(p.Rows);
                foreach (DataColumn col in dt.Columns) bulk.ColumnMappings.Add(col.ColumnName, col.ColumnName);
                await bulk.WriteToServerAsync(dt);
            }
            async Task<int> Exec(string sql) => await c.ExecuteAsync(sql, transaction: tx, commandTimeout: 120);

            int catsCreated = 0, catsAssigned = 0, inserted = 0, details = 0, stock = 0;
            if (o.Categories)
            {
                catsCreated = await Exec(@"INSERT INTO dbo.Category (Name) SELECT DISTINCT s.category FROM #s s
                    WHERE s.category IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.Category c WHERE c.Name = s.category)");
                // Only sets a category when the file has one; a blank in the file never clears an existing category.
                catsAssigned = await Exec(@"UPDATE p SET product_categoryId = c.Id FROM Product p
                    JOIN #s s ON s.product_Id = p.product_Id JOIN dbo.Category c ON c.Name = s.category
                    WHERE ISNULL(p.product_categoryId, 0) <> c.Id");
            }
            if (o.NewProducts)
            {
                inserted = await Exec($@"INSERT INTO Product (product_Id, product_name, product_categoryId, product_locationId, product_barCode, product_serialNo, product_unitOnOrder,
                        product_sold, product_inventory, product_unitPrice, product_salePrice, product_discount, product_discount_percentage, product_description, product_CGST,
                        product_SGST, product_IGST, product_subCatgId, product_dateCreated, product_HSN, product_MRP, stock_id, unit_Id, merchantId, isActiveOnServer, uploadDate)
                    SELECT s.product_Id, s.product_name, {(o.Categories ? "ISNULL(c.Id, 0)" : "0")}, s.product_locationId, s.product_barCode, s.product_serialNo, s.product_unitOnOrder,
                        s.product_sold, s.product_inventory, s.product_unitPrice, s.product_salePrice, s.product_discount, s.product_discount_percentage, s.product_description, s.product_CGST,
                        s.product_SGST, s.product_IGST, s.product_subCatgId, s.product_dateCreated, s.product_HSN, s.product_MRP, s.stock_id, s.unit_Id, s.merchantId, s.isActiveOnServer, s.uploadDate
                    FROM #s s LEFT JOIN dbo.Category c ON c.Name = s.category
                    WHERE NOT EXISTS (SELECT 1 FROM Product p WHERE p.product_Id = s.product_Id)");
            }
            if (o.Details)
            {
                details = await Exec(@"UPDATE p SET product_name = s.product_name, product_barCode = s.product_barCode, product_HSN = s.product_HSN,
                        product_unitPrice = s.product_unitPrice, product_salePrice = s.product_salePrice, product_MRP = s.product_MRP, product_discount = s.product_discount,
                        product_CGST = s.product_CGST, product_SGST = s.product_SGST, product_IGST = s.product_IGST
                    FROM Product p JOIN #s s ON s.product_Id = p.product_Id
                    WHERE EXISTS (SELECT ISNULL(s.product_name,''), ISNULL(s.product_barCode,''), ISNULL(s.product_HSN,''), s.product_unitPrice, s.product_salePrice, s.product_MRP, s.product_discount, s.product_CGST, s.product_SGST, s.product_IGST
                        EXCEPT SELECT ISNULL(p.product_name,''), ISNULL(p.product_barCode,''), ISNULL(p.product_HSN,''), ISNULL(p.product_unitPrice,0), ISNULL(p.product_salePrice,0), ISNULL(p.product_MRP,0), ISNULL(p.product_discount,0), ISNULL(p.product_CGST,0), ISNULL(p.product_SGST,0), ISNULL(p.product_IGST,0))");
            }
            if (o.Stock)
            {
                stock = await Exec(@"UPDATE p SET product_inventory = s.product_inventory, product_sold = s.product_sold, product_unitOnOrder = s.product_unitOnOrder
                    FROM Product p JOIN #s s ON s.product_Id = p.product_Id
                    WHERE EXISTS (SELECT s.product_inventory, s.product_sold, s.product_unitOnOrder
                        EXCEPT SELECT ISNULL(p.product_inventory,0), ISNULL(p.product_sold,0), ISNULL(p.product_unitOnOrder,0))");
            }

            var opts = string.Join(", ", new[] { o.Categories ? "categories" : null, o.NewProducts ? "new products" : null, o.Details ? "details/prices" : null, o.Stock ? "stock" : null }.Where(x => x != null));
            await c.ExecuteAsync(@"INSERT INTO dbo.ProductSyncLog (RunBy, FileName, ExcelRows, CategoriesCreated, CategoriesAssigned, ProductsInserted, DetailsUpdated, StockUpdated, Options)
                VALUES (@by, @f, @n, @cc, @ca, @ins, @d, @st, @opts)",
                new { by, f = p.FileName, n = p.Rows.Count, cc = catsCreated, ca = catsAssigned, ins = inserted, d = details, st = stock, opts }, tx);
            await tx.CommitAsync();
            return new { categoriesCreated = catsCreated, categoriesAssigned = catsAssigned, productsInserted = inserted, detailsUpdated = details, stockUpdated = stock };
        }
        catch { await tx.RollbackAsync(); throw; }
    }
}
