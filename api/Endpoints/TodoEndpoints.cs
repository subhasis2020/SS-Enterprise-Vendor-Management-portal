using Dapper;
using System.Security.Claims;

namespace SsPortal.Api;

public static class TodoEndpoints
{
    record Todo(int ID, string Title, string? Notes, string DueDate, bool IsDone, string? CreatedBy);
    record NewTodoReq(string Title, string? Notes, string DueDate);
    record EditTodoReq(string Title, string? Notes, string DueDate);

    public static void Map(RouteGroupBuilder g)
    {
        g.MapGet("/todos", async (Db db) =>
        {
            await using var c = await db.OpenAsync();
            var rows = await c.QueryAsync<Todo>(@"
                SELECT ID, Title, Notes, CONVERT(varchar(10), DueDate, 23) DueDate, IsDone, CreatedBy
                FROM TB_Todo ORDER BY IsDone, DueDate, ID");
            return Results.Ok(rows);
        });

        g.MapPost("/todos", async (NewTodoReq r, Db db, ClaimsPrincipal u) =>
        {
            if (string.IsNullOrWhiteSpace(r.Title) || string.IsNullOrWhiteSpace(r.DueDate)) return Results.BadRequest(new { error = "Title and due date are required." });
            await using var c = await db.OpenAsync();
            var by = u.Identity?.Name ?? "portal";
            await c.ExecuteAsync(@"INSERT INTO TB_Todo (Title, Notes, DueDate, IsDone, CreatedDate, CreatedBy)
                VALUES (@Title, @Notes, @DueDate, 0, GETDATE(), @by)",
                new { Title = r.Title.Trim(), r.Notes, r.DueDate, by });
            return Results.Ok();
        });

        // POST, not PUT/DELETE: the shared host's IIS blocks those verbs outright (see VendorEndpoints for the same fix).
        g.MapPost("/todos/{id:int}/edit", async (int id, EditTodoReq r, Db db) =>
        {
            if (string.IsNullOrWhiteSpace(r.Title) || string.IsNullOrWhiteSpace(r.DueDate)) return Results.BadRequest(new { error = "Title and due date are required." });
            await using var c = await db.OpenAsync();
            var n = await c.ExecuteAsync("UPDATE TB_Todo SET Title=@Title, Notes=@Notes, DueDate=@DueDate WHERE ID=@id",
                new { id, Title = r.Title.Trim(), r.Notes, r.DueDate });
            return n == 0 ? Results.NotFound() : Results.Ok();
        });

        g.MapPost("/todos/{id:int}/toggle", async (int id, Db db) =>
        {
            await using var c = await db.OpenAsync();
            var n = await c.ExecuteAsync(@"UPDATE TB_Todo SET IsDone = CASE WHEN IsDone = 1 THEN 0 ELSE 1 END,
                CompletedDate = CASE WHEN IsDone = 1 THEN NULL ELSE GETDATE() END WHERE ID=@id", new { id });
            return n == 0 ? Results.NotFound() : Results.Ok();
        });

        g.MapPost("/todos/{id:int}/delete", async (int id, Db db) =>
        {
            await using var c = await db.OpenAsync();
            var n = await c.ExecuteAsync("DELETE FROM TB_Todo WHERE ID=@id", new { id });
            return n == 0 ? Results.NotFound() : Results.Ok();
        });
    }
}
