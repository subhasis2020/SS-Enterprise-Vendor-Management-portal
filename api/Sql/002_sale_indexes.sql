-- Indexes for the two big POS tables (both were heaps with no indexes at all). Idempotent: safe to run more than once.
-- Express edition has no ONLINE index builds, so the tables are locked for a few seconds while each one is created -
-- run it when the POS is idle. Nothing in the app's results changes; queries just stop scanning every row.

-- Day / month / range filters on sales (dashboard, Sales page, Profit, Sales by month). INCLUDE makes the
-- per-bill rollups (MAX(TotalSale), MAX(Quantity) ... GROUP BY SaleID) answerable from the index alone.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TB_Sale_SaleDate' AND object_id = OBJECT_ID('dbo.TB_Sale'))
    CREATE NONCLUSTERED INDEX IX_TB_Sale_SaleDate ON dbo.TB_Sale (SaleDate) INCLUDE (SaleID, TotalSale, Quantity);

-- Line items of a bill / joins from TB_Sale (bill detail, price-mismatch flag, product insights, profit).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TB_SaleProduct_SaleID' AND object_id = OBJECT_ID('dbo.TB_SaleProduct'))
    CREATE NONCLUSTERED INDEX IX_TB_SaleProduct_SaleID ON dbo.TB_SaleProduct (SaleID) INCLUDE (ProductID, Quantity, ActualSalePrice, POSSalePrice, purchasePrice);
