# YouTube Research MCP Server — Transcripts, Search, Comments & Playlists

YouTube Research MCP Server 1.1.1 is an unofficial, read-only [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for evidence-oriented YouTube research. It gives AI agents structured access to video metadata, timestamped transcripts, comments and bounded replies, search, channel profiles, playlists, and regional trending videos.

The server exposes four task-oriented tools, reports which provider supplied each result, tracks estimated YouTube Data API quota usage, and marks creator- or viewer-authored text as untrusted. Public transcript retrieval can work without a YouTube API key; official search, comment, channel, playlist, and trending data requires a Data API v3 key.

## Quick start from source

Node.js 24 or newer is required. The package identifier `youtube-mcp-server-aio` and command `youtube-mcp-aio` are retained for compatibility; this repository currently documents a source install rather than promising an npm release.

```powershell
git clone https://github.com/BK927/youtube-research-mcp.git
cd youtube-research-mcp
npm ci
npm run build
npm start
```

Generic local MCP configuration:

```json
{
  "mcpServers": {
    "youtube-research": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:/absolute/path/youtube-research-mcp/dist/index.js",
        "--stdio"
      ],
      "env": {
        "YOUTUBE_API_KEY": "OPTIONAL_RESTRICTED_DATA_API_KEY"
      }
    }
  }
}
```

Use an absolute path. `yt-dlp` is optional for local use; when it is unavailable, the default hybrid provider chain can still try YouTube.js for public transcripts.

The tracked [.mcp.json](.mcp.json) is a sanitized remote-profile template that uses the reserved `example.com` domain; it is not a live public service. Replace its URL with your own HTTPS endpoint before using the cloud plugin profile.

## What you can ask

- “Summarize this video and include timestamped transcript evidence.”
- “Find every mention of ‘Cloud Run’ in this video's captions and show nearby context.”
- “Search this channel for recent MCP tutorials and compare their coverage.”
- “Read the newest comments and a bounded number of replies without losing author or date fields.”
- “List this playlist page by page and explain which topics it covers.”
- “Show currently trending public videos for Korea using compact metadata.”

## Capabilities and credentials

| Capability | Credential | Provider and limits |
| --- | --- | --- |
| Timestamped public transcripts | None | `yt-dlp` then YouTube.js by default; availability and bot checks vary by video and network. |
| Search within one retrieved transcript | None | Searches bounded transcript segments and returns timestamp context. |
| Limited public video identity/metadata fallback | None | Unofficial/oEmbed paths are narrower than the Data API. |
| Full video metadata and global/channel search | `YOUTUBE_API_KEY` | Official YouTube Data API v3. |
| Comments and bounded replies | `YOUTUBE_API_KEY` | Official public comment data only. |
| Channel profiles, uploads, playlists, and trending | `YOUTUBE_API_KEY` | Official public Data API operations. |
| Remote MCP access | `MCP_ACCESS_TOKEN` or personal OAuth | Use a random secret of at least 32 characters and HTTPS. |

Restrict `YOUTUBE_API_KEY` to the YouTube Data API in Google Cloud. The local quota guards estimate only calls made by this process; they are not a replacement for Google Cloud quota and billing controls.

## Public tools

| Tool | Views or scopes |
| --- | --- |
| `youtube_video_get` | One video's `metadata`, paged `transcript`, or paged `comments`; replies are opt-in and bounded |
| `youtube_search` | `global`, `channel`, `transcript`, or `trending` search |
| `youtube_channel_get` | Profile, statistics, branding, and uploads-playlist selections |
| `youtube_playlist_get` | Playlist metadata and signed pages of public items |

All four tools are read-only and idempotent. The server does not upload or download media, use account cookies, change watch history, or perform account writes.

## Providers

- The YouTube Data API v3 supplies official public video, search, channel, playlist, comment, and trending data when `YOUTUBE_API_KEY` is configured.
- `yt-dlp` and YouTube.js form the public transcript fallback chain. No Google or YouTube account cookies are used.
- The Cloud Run profile adds a pinned localhost-only proof-of-origin token sidecar for `yt-dlp`.
- There is no Google account OAuth bootstrap or account-scoped write route in 1.1.1. The optional MCP OAuth flow authenticates a private MCP client to this server; it does not sign a user into YouTube.

Provider modes:

- `hybrid` (default): official public data plus transcript fallbacks;
- `official`: Data API only;
- `unofficial`: no-key transcript and limited metadata paths only.

## Deployment options

| Target | Status | Best fit and constraints |
| --- | --- | --- |
| Local `stdio` | Supported | Simplest desktop MCP setup; cache and quota counters live in the process. |
| Docker on a workstation, VPS, or home server | Supported | Streamable HTTP at `/mcp`; add a bearer and HTTPS before remote exposure. |
| Raspberry Pi / ARM64 home server | Supported through Docker/source | No dedicated Pi deployment script is shipped. Transcript success still depends on YouTube and network conditions. |
| Google Cloud Run | Supported | Includes Firestore-backed quota/cursor state, a pinned `yt-dlp` proof-of-origin sidecar, candidate smoke checks, promotion, and rollback. |
| Cloudflare Workers | Not supported directly | The current server uses Node HTTP listeners, `node:child_process`, Python `yt-dlp`, and a localhost sidecar; it is not a Worker-native request handler. |
| Cloudflare Tunnel | Usable as an ingress | A Tunnel can front a home/VPS instance. It does not host the server in Workers; YouTube requests still leave from the origin machine. |

### Docker on a workstation, VPS, or home server

Create `.env` from [.env.example](.env.example), set `MCP_TRANSPORT=http`, and
put a newly generated random secret of at least 32 characters in
`MCP_ACCESS_TOKEN` (for example, use the output of `openssl rand -hex 32`). Leave
`YOUTUBE_API_KEY` empty if you only need no-key transcript fallbacks. Do not
commit this file.

```bash
cp .env.example .env
# Edit .env before continuing, then restrict it to the current user.
chmod 600 .env
docker build -t youtube-mcp-server-aio .
docker run -d \
  --name youtube-mcp-server-aio \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  --env-file .env \
  youtube-mcp-server-aio
```

The local endpoints are `http://127.0.0.1:8080/mcp` and `http://127.0.0.1:8080/healthz`. Keep the port on loopback and use Caddy, nginx, Tailscale Funnel, or Cloudflare Tunnel for HTTPS. For a public hostname, set `PUBLIC_BASE_URL=https://youtube-mcp.example.com`; the server adds that hostname and origin to its exact allowlists.

Home-server deployments normally use the in-memory quota store and continuation cache. A restart resets local counters and can invalidate cursors; multiple replicas do not share them. Firestore mode is available when durable cross-instance state and Google credentials are configured.

**Test-hardware note:** this home-server path was tested on a Raspberry Pi 4 Model B with 2 GB RAM. That is only the hardware used for testing; it is **not** a recommendation, a minimum requirement, or a performance guarantee.

Unofficial transcript providers can fail because of caption availability, parser changes, proof-of-origin requirements, IP reputation, geography, or YouTube bot challenges. A residential connection may behave differently from a cloud IP, but neither environment is guaranteed.

### Google Cloud Run

The Cloud Run profile deploys one public MCP ingress container plus a private localhost-only proof-of-origin sidecar. Firestore coordinates daily quota guards, signed-page snapshots, and one-time MCP OAuth codes across restarts and up to two instances.

```powershell
pwsh -File .\scripts\provision-gcp.ps1 -ProjectId "YOUR_PROJECT_ID"
pwsh -File .\scripts\deploy-cloud-run.ps1 -ProjectId "YOUR_PROJECT_ID" -Promote
```

Deployment requires a clean Git worktree. It builds a full Git SHA image, resolves the Artifact Registry digest, creates a zero-traffic candidate, verifies health/authentication/the four-tool contract and representative transcript/comment/locale behavior, and promotes only with `-Promote`. The scripts and contract tests support this profile, but [the operations document](docs/CLOUD_RUN.md) explicitly records that no live deployment was performed as part of the refactor itself.

### Cloudflare Workers and Tunnel

Direct Cloudflare Workers deployment is not currently supported. Even an official-API-only subset would need a separate Worker-native `fetch` entrypoint and storage/auth review. The transcript path additionally relies on process features that Workers do not provide, and cloud egress can be challenged by YouTube.

Cloudflare Tunnel is a different product and can expose a server that keeps running on your home machine or VPS. Keep the MCP bearer enabled even when a tunnel or access layer is present.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | empty | Enables official public Data API operations |
| `YOUTUBE_PROVIDER_MODE` | `hybrid` | `hybrid`, `official`, or `unofficial` |
| `YOUTUBE_TRANSCRIPT_PROVIDERS` | `yt-dlp,youtubejs` | Transcript fallback order |
| `YT_DLP_PATH` | `yt-dlp` | Local executable; the image uses `/opt/yt-dlp/bin/yt-dlp` |
| `YT_DLP_POT_PROVIDER_ENABLED` | `false` | Uses a compatible localhost proof-of-origin provider; Cloud Run enables its pinned sidecar |
| `YOUTUBE_DEFAULT_REGION` | `US` | Default trending region when no explicit region is supplied |
| `YOUTUBE_DEFAULT_LANGUAGE` | `en` | Preferred transcript/result language |
| `YOUTUBE_CACHE_TTL_SECONDS` | `900` | Process-local cache freshness |
| `YOUTUBE_API_DAILY_BUDGET` | `9000` | Conservative ordinary Data API guard |
| `YOUTUBE_SEARCH_DAILY_BUDGET` | `90` | Conservative search-call guard |
| `YOUTUBE_QUOTA_STORE` | `memory` | Cloud Run sets `firestore` |
| `YOUTUBE_CURSOR_TTL_SECONDS` | `86400` | Signed cursor validity |
| `YOUTUBE_MAX_RESULT_BYTES` | `12288` | Default result budget; hard maximum 32,768 bytes |
| `MCP_TRANSPORT` | automatic | `stdio` locally and `http` when Cloud Run sets `K_SERVICE`; CLI flag wins |
| `MCP_PATH` | `/mcp` | Streamable HTTP path |
| `HEALTH_PATH` | `/healthz` | Cloud Run sets `/health` |
| `MCP_ACCESS_TOKEN` | empty | Required in HTTP mode unless unauthenticated mode is explicitly enabled |
| `PUBLIC_BASE_URL` | empty | Stable HTTPS URL used for Host validation and MCP OAuth |
| `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` | empty | Additional exact HTTP allowlist entries |
| `MCP_OAUTH_ENABLED` | `false` | Enables the private-operator MCP OAuth 2.1 flow |

See [.env.example](.env.example) for the complete template. Its `KR`/`ko` values are an example Korean-first preset; removing those overrides restores the code defaults shown above.

<details>
<summary><strong>Protocol, pagination, and result-integrity details</strong></summary>

Responses share a bounded envelope with provider provenance, estimated quota cost, freshness, warnings, untrusted-field markers, declared output schemas, and opaque signed cursors. The default result budget is 12,288 bytes, the hard maximum is 32,768 bytes, and cursors expire after 86,400 seconds by default.

Items that exceed a page's byte budget remain available through `page.next_cursor`, including on the last upstream page. Follow it with the same filters and options; `limit` may change. Each retained snapshot is limited to 512 KiB and 64 process-local entries. Firestore mode also stores snapshots in `youtube_response_pages` for cross-instance continuation. Local eviction or restart returns an explicit cursor error instead of silently skipping items. If one item cannot fit safely, the operation returns a structured error.

Transcript pages return only `availableLanguageCount` by default. Set `options.include_available_languages=true` to include the full language list on page one without repeating it on cursor pages.

For video metadata, `captionAvailable` mirrors the Data API's `contentDetails.caption` flag. `captionAvailability` identifies that source, and a missing flag remains `reportedAvailable=null`. Metadata does not probe transcript providers, so `transcriptRetrievability=unknown`; a false API flag does not prevent a direct transcript attempt, including automatic captions.

`max_chars` limits descriptions while preserving IDs, titles, channel references, dates, duration, statistics, provider, and completeness. Trending uses a compact projection; call `youtube_video_get` for full details. Exact handles or usernames that resolve to no channel return `NOT_FOUND` rather than substituting an approximate search result.

Comments, titles, descriptions, channel-controlled names, and transcript text are untrusted external content. They are research material, never instructions for the client or agent.

### Statistics alongside search results

Global and channel searches accept an optional boolean `filters.include_statistics` (default `false`):

```json
{"scope":"global","query":"indie roguelike review","limit":20,"filters":{"include_statistics":true}}
```

Call `youtube_search` with these arguments to append public `statistics.viewCount`, `likeCount`, `commentCount` and `durationSeconds`. Channel uploads use the actual `videoId`, retain the original playlist-item identity, and are enriched after any local text filter. Search order and signed pagination remain unchanged; repeat the same filters on subsequent pages.

Cache misses are deduplicated and batched in groups of at most 50 through `videos.list` (one data unit per attempted request, including retries). The existing bounded 256-entry metadata cache is reused, including full metadata for later `youtube_video_get` calls. `meta.quota_cost.data` includes enrichment attempts, with zero additional cost on metadata-cache hits; buffered continuation pages make no upstream requests. Base search/channel quota costs remain estimates. No polling, database or history archive is added.

Each enriched row has `statisticsAvailability` (`available`, `partial`, or `unavailable`); missing metrics are not invented or replaced with zero. Inaccessible videos or a failed/quota-blocked enrichment retain the original search row with an unavailable reason and warning. Limited cached oEmbed metadata may remain unavailable until its TTL expires. Trending already includes statistics and does not perform this enrichment; the new flag is accepted only for global/channel search.

For additional competitor and trend analytics, connect the [official vidIQ MCP](https://support.vidiq.com/en/articles/15082430-vidiq-mcp) separately in your client. This server does not proxy vidIQ, copy its credentials, or require a vidIQ account. Its advertised free access is subject to launch-period and credit conditions; it is not an unlimited dependency of these features.

</details>

## FAQ

### What is a YouTube MCP server?

It is a service that exposes YouTube retrieval tasks as structured tools for an MCP-compatible AI client. This server retrieves public data and timestamped evidence; it does not send prompts to another model or generate the final summary itself.

### Do transcripts require a YouTube API key?

No, public transcripts can be attempted through `yt-dlp` and YouTube.js. A key is required for the official Data API features such as global search, comments, channels, playlists, and trending. Transcript availability is never guaranteed.

### Can I self-host it?

Yes. Use local `stdio`, Docker on a workstation/VPS/home server, or the Google Cloud Run profile. Protect any remote `/mcp` endpoint with HTTPS and a strong bearer or the personal MCP OAuth flow.

### Can it run directly on Cloudflare Workers?

No, not with the current Node process, `yt-dlp`, and sidecar architecture. Cloudflare Tunnel can front a separately running origin, but that is not Worker hosting.

### Does the MCP OAuth flow grant access to a YouTube account?

No. It authenticates a private MCP client to this server. The project has no Google account sign-in, account-scoped YouTube tools, upload route, or write capability.

## Security and development

- Browser Origin and Host values are exact-allowlisted in HTTP mode.
- API keys, bearer values, and signing secrets should be injected through the host's secret mechanism and never committed.
- The fixed bearer and optional MCP OAuth flow are intended for a private operator, not a shared multi-user service.
- The server never uses browser/account cookies or performs YouTube account writes.

Run all local checks:

```powershell
npm ci
npm run check
python scripts/validate-release-contract.py
```

Additional documents:

- [Cloud Run operations](docs/CLOUD_RUN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Migration milestones](docs/ROADMAP.md)
- [Ecosystem research](docs/RESEARCH.md)

## License and affiliation

MIT. See [LICENSE](LICENSE).

This is an unofficial community project. It is not affiliated with, endorsed by, or sponsored by YouTube LLC or Google LLC. YouTube is a trademark of Google LLC.
