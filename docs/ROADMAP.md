# Migration milestones

This file records the two compatibility-breaking compact-surface milestones. It is not a promise to add more public MCP tools.

## 1.1.0 — Cloud state and bounded contracts

- Firestore quota adapter for Cloud Run (`YOUTUBE_QUOTA_STORE=firestore`).
- Signed 24-hour opaque cursors bound to each operation and filter set.
- Common bounded response/error envelope: 12 KiB default, 32 KiB hard maximum.
- Google Cloud deployment split into idempotent provisioning, SHA-tag/digest deployment, zero-traffic candidate smoke, explicit promotion, and revision rollback.
- Numeric Secret Manager versions and service-specific secret IAM.
- Node 24.12.0 base digest and `yt-dlp==2026.8.19` image pin.
- Google OAuth bootstrap, callback routes, helper scripts, and refresh-token configuration removed.

## 1.0.0 — Compact plugin boundary

- Replaced the former eleven-tool catalog with four public tools: `youtube_video_get`, `youtube_search`, `youtube_channel_get`, and `youtube_playlist_get`.
- Consolidated metadata/transcript/comments under video views and global/channel/transcript/trending under search scopes.
- Kept local stdio and stateless Streamable HTTP `/mcp` profiles.
- Standardized `/healthz`, a 2 MiB HTTP body limit, provider provenance, untrusted-field markers, and read-only annotations.

## Gate for future capabilities

Add a new public tool only when an existing view/scope cannot express a distinct authorization, lifecycle, or long-running job boundary. Account OAuth, writes, Analytics/Reporting, and large corpus collection require separate security and product decisions before implementation.

## Public posts extension

The public surface now has five tools. The user-approved post extension adds `youtube_post_get` for the separate post entity and `youtube_search(scope="posts")` for channel lists, retaining all existing calls. This is an explicit exception to the earlier compact-surface gate above; it does not authorize account writes, login cookies, or corpus collection. The implementation uses the installed YouTube.js dependency and bounded process-memory caches.
