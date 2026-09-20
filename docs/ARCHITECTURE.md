# Architecture

YouTube Research MCP Server 1.1.1 optimizes for a small, coherent MCP surface and bounded evidence rather than endpoint coverage.

```text
Local client --stdio--------------------.
                                         v
Remote client --HTTPS + bearer--> HTTP boundary --> five MCP tools
                                         |              |
                                         |              v
                                         |        YouTubeService
                                         |          |       |
                                         |          |       +-> yt-dlp / YouTube.js transcripts
                                         |          |             |
                                         |          |             +-> localhost PO-token sidecar (Cloud only)
                                         |          +-> YouTube Data API v3
                                         |
                                         +-> /health (Cloud Run; /healthz locally)

Local state: bounded LRU TTL cache + memory quota store
Cloud state: bounded per-instance cache + transactional Firestore quota store
```

## Boundaries

- `src/server.ts` owns the five public tool names, schemas, annotations, cursors, and result shaping.
- `src/output-schemas.ts` declares each tool's success `outputSchema`: the required envelope and typed core fields for its views/scopes. Provider- and selection-dependent fields are optional, and extra provider fields remain intact. Synchronous tools keep `job` empty; errors retain their separate `isError` envelope and are exempt from success-schema validation.
- `src/youtube-service.ts` resolves references, chooses providers, applies cache/quota controls, and returns provider-neutral data.
- `src/providers` isolates official and unofficial upstream behavior.
- `src/quota/quota-store.ts` supplies memory and Firestore adapters behind one contract.
- `src/http` owns bearer, Host/Origin checks, 2 MiB request limits, `/mcp`, and the configured health path.

## Compact contract

`youtube_video_get` uses a `view`; `youtube_search` uses a `scope`. This carries metadata, transcripts, comments, global/channel/transcript search, and trending through two predictable shapes. Channel and playlist lookup remain separate because their identities and pagination differ materially.

Tool responses contain:

- a stable `kind` and normalized `data`/`items`;
- `page.next_cursor`, signed against the operation and filters;
- canonical URI and provider provenance;
- freshness and quota cost;
- warnings and untrusted text-field paths;
- a bounded structured error with a schema URI.

Default results are limited to 12,288 bytes and hard-limited to 32,768 bytes. Comment replies are disabled by default; when enabled, `reply_limit` and a text-aware cap preserve IDs, authors, and timestamps instead of blanking structural fields. Video transcript/comment and playlist/search collections use opaque continuation cursors instead of returning unbounded arrays. Resource templates expose schemas and individual entities without adding more tool schemas.

The protocol tests cap `tools/list` at 18,000 bytes total and 6,000 bytes per tool, including output schemas (16,658 bytes total when introduced). They validate all view/scope fixtures against the advertised schemas and require malformed structured outputs to be rejected. Tool names, inputs, response data, and error envelopes are unchanged.

## State

The LRU TTL cache is intentionally ephemeral. It coalesces in-flight duplicate loads and limits memory, but correctness does not depend on persistence.

Quota stores are adapters:

- `memory` for local stdio and tests;
- `firestore` for Cloud Run, using the `youtube_quota` collection and transactions so restarts do not reset guards.

Quota guards are conservative application limits, not Google Cloud billing truth. They do not observe unrelated applications using the same project.

## Trust and authentication

There are two credentials only:

```text
MCP_ACCESS_TOKEN    private client -> /mcp
YOUTUBE_API_KEY     server -> public YouTube Data API
```

Google account OAuth and write/account tools are deliberately absent. A future account product should be a separately reviewed trust surface with per-user OAuth, scopes, revocation, audit, and deletion—not hidden inside these public-data tools.

HTTP mode is stateless and fail-closed: bearer authentication, exact Host allowlisting, explicit browser Origin allowlisting, request byte/time limits, and graceful Cloud Run shutdown. The bearer is a private single-operator mechanism, not a standards-based shared authorization server.

## Provider and content policy

Official and unofficial results keep provider names and warnings. Comments, titles, descriptions, and transcript text are untrusted content. Cloud Run uses a pinned proof-of-origin helper to satisfy YouTube player attestation where available; it does not import browser/account cookies, download media, mutate accounts, or silently send evidence to another model provider.
