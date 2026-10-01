using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.SqlClient;
using System.Security.Claims;
using SsPortal.Api;

var builder = WebApplication.CreateBuilder(args);

// Connection string lives in user-secrets (dev) or env var ConnectionStrings__bigmartconn (prod) - never in source.
var cs = builder.Configuration.GetConnectionString("bigmartconn")
    ?? throw new InvalidOperationException("Missing connection string 'bigmartconn'. Run: dotnet user-secrets set \"ConnectionStrings:bigmartconn\" \"...\"");
builder.Services.AddSingleton(new Db(cs));
builder.Services.AddMemoryCache();

// Keep DB column casing (SaleID, OrganizationName ...) in the JSON.
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = null);

// Persist Data Protection keys to disk (survives app restarts/deploys) - without this, every restart generates
// a fresh key, silently invalidating every existing login cookie even though it hasn't actually expired yet.
// This is a sibling of wwwroot, not inside it, and the deploy routine never touches unlisted folders, so it
// survives every future publish/upload untouched.
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(builder.Environment.ContentRootPath, "keys")))
    .SetApplicationName("SsPortal");

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.Cookie.Name = "ss.auth";
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Lax;
        o.ExpireTimeSpan = TimeSpan.FromDays(1);   // stay signed in for 1 day
        o.SlidingExpiration = false;               // fixed 1-day window from sign-in
        o.Cookie.MaxAge = TimeSpan.FromDays(1);    // persistent cookie: survives closing the browser
        o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        o.Events.OnRedirectToLogin = c => { c.Response.StatusCode = 401; return Task.CompletedTask; };
        o.Events.OnRedirectToAccessDenied = c => { c.Response.StatusCode = 403; return Task.CompletedTask; };
    });
builder.Services.AddAuthorizationBuilder()
    .AddPolicy(ReportEndpoints.Policy, p => p.RequireAuthenticatedUser().RequireAssertion(ctx => ReportEndpoints.IsOwner(ctx.User)));

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseAuthentication();
app.UseAuthorization();

// Unhandled DB/other errors -> JSON 500 (no stack traces to the browser).
app.UseExceptionHandler(e => e.Run(async ctx =>
{
    ctx.Response.StatusCode = 500;
    await ctx.Response.WriteAsJsonAsync(new { error = "Server error. Please try again." });
}));

var api = app.MapGroup("/api");
api.MapGet("/health", async (Db db) =>
{
    try { await using var c = await db.OpenAsync(); return Results.Ok(new { status = "ok", db = "connected" }); }
    catch (SqlException) { return Results.Json(new { status = "degraded", db = "unreachable" }, statusCode: 503); }
});

AuthEndpoints.Map(api);

var secured = api.MapGroup("").RequireAuthorization();
secured.MapGet("/meta", () => new { today = DateTime.Today.ToString("yyyy-MM-dd") });
DashboardEndpoints.Map(secured);
SalesEndpoints.Map(secured);
ProfitEndpoints.Map(secured);
VendorEndpoints.Map(secured);
CustomerEndpoints.Map(secured);
ProductEndpoints.Map(secured);
ProductSyncEndpoints.Map(secured);
ExpenseEndpoints.Map(secured);
TodoEndpoints.Map(secured);
ReportEndpoints.Map(secured);

app.Run();
