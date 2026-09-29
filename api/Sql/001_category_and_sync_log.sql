-- Category master + product sync audit log. Idempotent: safe to run more than once.
-- Product.product_categoryId (already exists, was 0 everywhere) now points at dbo.Category.Id. 0 = Uncategorized.

IF OBJECT_ID('dbo.Category', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Category (
        Id          int IDENTITY(1,1) NOT NULL CONSTRAINT PK_Category PRIMARY KEY,
        Name        nvarchar(100)     NOT NULL,
        IsActive    bit               NOT NULL CONSTRAINT DF_Category_IsActive DEFAULT (1),
        CreatedDate datetime          NOT NULL CONSTRAINT DF_Category_Created DEFAULT (GETDATE()),
        CONSTRAINT UQ_Category_Name UNIQUE (Name)
    );
END;

IF OBJECT_ID('dbo.ProductSyncLog', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ProductSyncLog (
        Id                 int IDENTITY(1,1) NOT NULL CONSTRAINT PK_ProductSyncLog PRIMARY KEY,
        RunAt              datetime      NOT NULL CONSTRAINT DF_PSL_RunAt DEFAULT (GETDATE()),
        RunBy              nvarchar(50)  NOT NULL,
        FileName           nvarchar(260) NULL,
        ExcelRows          int           NOT NULL,
        CategoriesCreated  int           NOT NULL,
        CategoriesAssigned int           NOT NULL,
        ProductsInserted   int           NOT NULL,
        DetailsUpdated     int           NOT NULL,
        StockUpdated       int           NOT NULL,
        Options            nvarchar(200) NULL
    );
END;

-- Helps the product report / category filter.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Product_categoryId' AND object_id = OBJECT_ID('dbo.Product'))
    CREATE INDEX IX_Product_categoryId ON dbo.Product (product_categoryId);
