---
name: deploy-workflow
description: "User wants every code change auto-published and copied to Desktop/bigmart, ready for Plesk upload"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8d088217-bc46-4c6e-bad7-96403704dba6
  modified: 2026-09-29T14:45:15.375Z
---

Whenever a change is made to this project (C# in `api/`, or wwwroot js/css/html), immediately after the edit, without waiting to be asked:
1. `dotnet publish api/api.csproj -c Release -o "$TEMP/bm_pub"` from the project root (publish to a temp dir so the running dev `api.exe`'s file lock never blocks it).
2. Copy the refreshed output into `C:\Users\subha\Desktop\bigmart\` — **but do NOT overwrite `web.config`** in that folder; it has been manually edited to add: the `ConnectionStrings__bigmartconn` environment variable (live DB password), `stdoutLogEnabled="true"`, and a `<remove name="WebDAVModule"/>` / `<remove name="WebDAV"/>` + request-filtering-verbs fix. `dotnet publish` regenerates a vanilla `web.config` from scratch every time with none of this, so it would silently reintroduce the DB-crash bug if copied over. Copy `api.dll`, `api.pdb`, `api.deps.json`, `api.runtimeconfig.json`, `api.staticwebassets.endpoints.json`, and `wwwroot\` explicitly instead of the whole folder.
3. If any wwwroot js/css file changed, bump `ASSET_V` in `api/wwwroot/index.html` first (see [[ss-portal-overview]] cache-busting note) so the copied build reflects it.

**PUT is dead on this host — always use POST.** The shared host's IIS returns a hard 403 (plain IIS error page, before the request reaches the app) for the `PUT` verb, regardless of the WebDAV/request-filtering `web.config` tweaks above — those didn't fix it. The real fix was routing every "edit" action through `POST` instead: `VendorEndpoints.cs` now exposes `POST /api/vendors/{id}/edit`, `POST /api/vendors/invoices/{id}/edit`, `POST /api/vendors/payments/{id}/edit` (not `MapPut`), matched by `data.js`'s `updateVendor`/`updateInvoice`/`updateVendorPayment`. **Any new "edit"/"update" endpoint added to this project must be `MapPost` with a `/edit` (or similar) suffix path, never `MapPut` or `MapDelete`** — those verbs will 403 in production even though they work fine on local dev (`api.exe`), which is what made this confusing to diagnose the first time.

**Why**: [[ss-portal-overview]] project is being deployed to bigmartsingur.in via Plesk shared hosting (no SSH/direct server access from this session) — the user manually re-uploads `Desktop\bigmart`'s contents via Plesk File Manager/FTP after each change, so that folder must always reflect the latest build, not be something they have to remember to ask for each time.

**Never delete/wipe a `keys` folder on the server, next to `web.config`/`wwwroot`.** Every app restart (which every deploy this session has required) used to silently log everyone out, because ASP.NET Core's cookie-auth Data Protection keys defaulted to an in-memory/ephemeral location — a fresh key every restart makes every existing login cookie undecryptable even though it hasn't expired. Fixed in `Program.cs` by persisting keys to `<site root>/keys` via `AddDataProtection().PersistKeysToFileSystem(...)`. That folder isn't in the list of things the publish routine copies (step 2 above), so it survives deploys untouched — which is exactly why the fix works. If frequent/unexplained logouts ever reappear, check whether that folder still exists on the server before assuming it's a cookie-expiry bug.

**How to apply**: Do this proactively at the end of any turn where project files changed — don't wait for the user to ask "please publish" again. Only skip it if the change was purely investigative/read-only (e.g. checking DB schema, reading logs).
