# YouTube Research MCP Server on Google Cloud Run

This is the fixed Google Cloud profile for YouTube Research MCP Server 1.1.1. No live deployment was run as part of this refactor.

## Fixed v1 resources

| Resource | Name/default | Region and capacity | Exposure |
| --- | --- | --- | --- |
| Artifact Registry | `mcp/youtube-mcp-aio` | `asia-northeast1` | private |
| Cloud Run ingress | `youtube-mcp-aio` / `mcp` | 1 vCPU, 1 GiB, concurrency 4, timeout 300 s, min 0, max 2 | public ingress; bearer or OAuth required at `/mcp` |
| Cloud Run sidecar | `pot-provider` | 0.25 vCPU, 512 MiB per service instance | localhost-only PO-token minting for `yt-dlp` |
| Firestore | `(default)` / `youtube_quota`, `youtube_response_pages`, `youtube_oauth_codes` | Native mode, `asia-northeast1` | runtime identity only |
| API key | `youtube-mcp-aio-v1` | restricted to `youtube.googleapis.com` | Secret Manager injection only |

The transport is stateless. The short-lived response cache remains process-local. Daily ordinary/search quota counters use Firestore transactions (`YOUTUBE_QUOTA_STORE=firestore`), signed continuation snapshots use `youtube_response_pages`, and one-time OAuth codes use `youtube_oauth_codes`. At most two instances provide modest availability while keeping cache duplication and unofficial provider traffic conservative; Firestore preserves those shared records across instances and restarts.

## Identity and secrets

`youtube-mcp-runner` receives only:

- `roles/datastore.user` for the quota, continuation-page, and OAuth-code collections;
- Secret Accessor on `youtube-mcp-access-token`;
- Secret Accessor on `youtube-mcp-cursor-secret`;
- Secret Accessor on `youtube-mcp-oauth-login-secret`;
- Secret Accessor on `youtube-mcp-oauth-signing-secret`;
- Secret Accessor on `youtube-data-api-key`.

The Cloud Build default identity receives Artifact Registry writer on repository `mcp`, not a project-wide runtime role. Cloud Run secret references always use enabled numeric versions. `:latest` is not used.

The main Cloud Run URL is public because private MCP clients need to reach it; the application rejects `/mcp` without either its fixed bearer or a valid token from the included personal OAuth flow. This remains a private single-operator boundary, not a general multi-user authorization service.

## Image pins

- Node base: `node:24.12.0-bookworm-slim` plus its verified multi-platform index digest.
- `yt-dlp`: `2026.8.19`, installed in an isolated Python virtual environment.
- `bgutil-ytdlp-pot-provider`: Python plugin `1.3.1`; provider sidecar `1.3.1` pinned by its immutable multi-platform digest.
- JavaScript dependencies: `npm ci` from `package-lock.json`; runtime install uses the frozen lock with dev dependencies omitted.

The upstream Debian packages installed by `apt` are not snapshot-pinned. Rebuilding an old commit can therefore receive later Debian security package revisions even though the base index and application dependencies are fixed. This limitation is documented rather than masked by an invented digest.

## Prerequisites

- PowerShell 7, Git, Node.js 24/npm, and a current Google Cloud CLI.
- A billed project and permission to manage service APIs, API keys, IAM, Artifact Registry, Cloud Build, Secret Manager, Firestore, and Cloud Run.
- A clean Git worktree.

## One-time provisioning

```powershell
pwsh -File .\scripts\provision-gcp.ps1 `
  -ProjectId "YOUR_PROJECT_ID" `
  -Region "asia-northeast1"
```

The script enables APIs, creates the regional registry and runtime identity, creates a YouTube Data API key restricted to `youtube.googleapis.com`, initializes its secret only if missing, initializes independent MCP bearer, cursor-signing, OAuth login, and OAuth signing secrets only if missing, grants service-specific secret IAM, and creates/validates Firestore Native mode. Keeping the cursor key independent prevents a bearer rotation from invalidating still-live 24-hour cursors.

If `(default)` Firestore already exists in another location, provisioning stops. Firestore location cannot be casually moved, so choose the project and region deliberately before provisioning this service.

Provisioning does not configure Google account OAuth. No Google account OAuth setup, callback, refresh-token secret, or account-scoped route exists in 1.1.1.

## Candidate deployment

```powershell
pwsh -File .\scripts\deploy-cloud-run.ps1 `
  -ProjectId "YOUR_PROJECT_ID" `
  -Region "asia-northeast1"
```

The script:

1. refuses a dirty worktree;
2. builds `youtube-mcp-aio:GIT_SHA` with Cloud Build;
3. resolves the Artifact Registry `sha256` digest;
4. deploys `IMAGE@DIGEST` as tag `candidate` with `--no-traffic`;
5. pins exact stable and candidate Host allowlists;
6. checks candidate `/health`, OAuth authorization/resource discovery, and unauthenticated `401`, then uses the pinned MCP client to require the exact five-tool list, pass at least two of three transcript probes including one research/TED video, verify structurally intact bounded comments/replies, and verify `ko-KR` trending-region inference;
7. leaves the candidate at 0% unless `-Promote` is supplied.

To smoke and promote to 100% in one approved run:

```powershell
pwsh -File .\scripts\deploy-cloud-run.ps1 `
  -ProjectId "YOUR_PROJECT_ID" `
  -Promote
```

On the first deployment there is no older revision to retain traffic. Cloud Run must create one zero-traffic bootstrap revision to discover stable/tag URLs. The script therefore requires `-Promote`, keeps bearer protection enabled, immediately replaces the bootstrap with a hardened zero-traffic candidate from the same digest, smokes it, and promotes it within the same run.

## Bearer rotation

Existing deployments reuse the enabled bearer version. Rotation is never implicit:

```powershell
pwsh -File .\scripts\deploy-cloud-run.ps1 `
  -ProjectId "YOUR_PROJECT_ID" `
  -RotateAccessToken `
  -Promote
```

The new numeric version is pinned to the candidate. The Windows user variable `YOUTUBE_MCP_ACCESS_TOKEN` is updated only after `-Promote`, so an unpromoted candidate cannot replace the credential for the still-serving revision. Keep the prior version enabled until rollback risk has passed.

## Verification

```powershell
$baseUrl = "https://YOUR_YOUTUBE_SERVICE.run.app"
Invoke-RestMethod "$baseUrl/health"

$headers = @{
  Authorization = "Bearer $env:YOUTUBE_MCP_ACCESS_TOKEN"
  Accept = "application/json, text/event-stream"
  "MCP-Protocol-Version" = "2026-07-28"
}
$body = '{"jsonrpc":"2.0","id":"verify","method":"tools/list","params":{}}'
Invoke-WebRequest "$baseUrl/mcp" -Method Post -Headers $headers -ContentType application/json -Body $body
```

The HTTP request limit is 2 MiB. Tool results default to 12 KiB and cannot exceed 32 KiB.

For ChatGPT developer-mode registration, use the production `/mcp` URL and choose OAuth. The authorization page asks for the personal key. Copy it without printing it:

```powershell
pwsh -File .\scripts\copy-chatgpt-oauth-key.ps1 -ProjectId "YOUR_PROJECT_ID"
```

## Rollback

```powershell
gcloud run revisions list `
  --service youtube-mcp-aio `
  --region asia-northeast1 `
  --project YOUR_PROJECT_ID

pwsh -File .\scripts\rollback-cloud-run.ps1 `
  -ProjectId "YOUR_PROJECT_ID" `
  -Revision "KNOWN_GOOD_REVISION"
```

The rollback changes traffic without rebuilding. A revision retains its digest and numeric secret mappings, so selecting the revision also selects the exact deployed credentials/configuration.

## Operations and cost

- Cloud Run scales to zero, but Firestore operations/storage, Artifact Registry retention, Cloud Build, logging, and outbound requests can still cost money.
- Alert on 5xx, latency, instance saturation, Firestore transaction errors, quota exhaustion, Data API errors, and transcript-provider failure rates.
- Keep the YouTube API restriction, Firestore delete protection, exact Host allowlist, and service-specific secret IAM under drift review.
- Do not log API keys, bearer headers, signed cursors, or raw comments/transcripts at request level.
- `yt-dlp`, its PO-token provider, and YouTube.js depend on unofficial public interfaces and can still fail because of upstream changes, IP reputation, region, or video restrictions. Provider failures remain explicit and classify detected bot challenges in `details.attempts`.
