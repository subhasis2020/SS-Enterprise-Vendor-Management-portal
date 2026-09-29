using Microsoft.Data.SqlClient;

namespace SsPortal.Api;

public sealed class Db(string connectionString)
{
    public async Task<SqlConnection> OpenAsync()
    {
        var c = new SqlConnection(connectionString);
        await c.OpenAsync();
        return c;
    }
}
