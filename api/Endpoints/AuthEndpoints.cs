using Dapper;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using System.Security.Claims;

namespace SsPortal.Api;

public static class AuthEndpoints
{
    record LoginReq(string? Username, string? Password);
    record UserRow(int ID, string UserName, string Name, bool? IsAdmin, string Password);

    public static void Map(RouteGroupBuilder g)
    {
        g.MapPost("/login", async (LoginReq req, Db db, HttpContext ctx) =>
        {
            if (string.IsNullOrWhiteSpace(req.Username) || string.IsNullOrEmpty(req.Password)) return Results.Unauthorized();
            await using var c = await db.OpenAsync();
            var u = await c.QueryFirstOrDefaultAsync<UserRow>(
                "SELECT ID, UserName, Name, IsAdmin, Password FROM TB_User WHERE UserName=@u AND IsActive=1", new { u = req.Username.Trim() });
            // NOTE: TB_User.Password is plaintext today (legacy). Constant-time compare; migrate to hashes before go-live.
            if (u is null || !System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
                    System.Text.Encoding.UTF8.GetBytes(u.Password), System.Text.Encoding.UTF8.GetBytes(req.Password)))
                return Results.Unauthorized();

            var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, u.ID.ToString()), new(ClaimTypes.Name, u.UserName), new("display", u.Name) };
            if (u.IsAdmin == true) claims.Add(new Claim(ClaimTypes.Role, "Admin"));
            await ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme,
                new ClaimsPrincipal(new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme)),
                new AuthenticationProperties { IsPersistent = true, ExpiresUtc = DateTimeOffset.UtcNow.AddDays(1) });
            return Results.Ok(new { ID = u.ID, UserName = u.UserName, Name = u.Name, IsAdmin = u.IsAdmin == true });
        });

        g.MapPost("/logout", async (HttpContext ctx) =>
        {
            await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return Results.Ok();
        });

        g.MapGet("/me", (ClaimsPrincipal p) => p.Identity?.IsAuthenticated == true
            ? Results.Ok(new { UserName = p.Identity.Name, Name = p.FindFirstValue("display") })
            : Results.Unauthorized());
    }
}
