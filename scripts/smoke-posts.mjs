import assert from "node:assert/strict";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Log } from "youtubei.js";

// Read-only canary. Do not print credentials or creator/viewer-authored content.
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const url = args.get("--url");
const post = args.get("--post") ?? "UgkxAzdixzRQiBw06VNXaEGt5ANIJN0D6hCD";
const commentPost = args.get("--comment-post") ?? "UgkxmT3LaNj0b4cjqab6MmBCF-9OTfcR3rQe";
const channel = args.get("--channel") ?? "@supergiantgames";
Log.setLevel(Log.Level.NONE);
const client = new Client({ name: "youtube-post-smoke", version: "1" });
let server;
let networkRequests = 0;
const originalFetch = globalThis.fetch;
const rssBefore = process.memoryUsage().rss;
if (url) {
  if (!process.env.MCP_SMOKE_ACCESS_TOKEN) throw new Error("MCP_SMOKE_ACCESS_TOKEN is required for remote checks.");
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    authProvider: { token: async () => process.env.MCP_SMOKE_ACCESS_TOKEN },
  }));
} else {
  globalThis.fetch = (...input) => { networkRequests += 1; return originalFetch(...input); };
  const { createYoutubeMcpServer } = await import("../dist/server.js");
  const { loadConfig } = await import("../dist/config.js");
  server = createYoutubeMcpServer({ ...loadConfig(), apiKey: undefined, providerMode: "unofficial", quotaStoreMode: "memory", transcriptProviders: [] });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
}
const checks = [];
const call = async (name, input) => {
  const result = await client.callTool({ name, arguments: input });
  assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result.structuredContent)}`);
  const body = result.structuredContent;
  assert.equal(body.meta.provider, "youtubejs-posts");
  assert.deepEqual(body.meta.quota_cost, { data: 0, search: 0 });
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 32_768);
  return body;
};
try {
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.deepEqual(tools, ["youtube_video_get", "youtube_search", "youtube_channel_get", "youtube_playlist_get", "youtube_post_get"]);
  checks.push({ check: "five_tools", passed: true });
  const contentArgs = { post, locale: "ko" };
  const content = await call("youtube_post_get", contentArgs);
  assert.ok(content.data.id && content.data.author?.channelId && typeof content.data.text === "string");
  checks.push({ check: "post_content", passed: true, id: content.data.id, attachment: content.data.attachment?.type ?? null });
  const beforeCache = networkRequests;
  const cached = await call("youtube_post_get", contentArgs);
  assert.equal(cached.meta.retrieved_at, content.meta.retrieved_at);
  assert.equal(cached.meta.fresh_until, content.meta.fresh_until);
  if (!url) assert.equal(networkRequests, beforeCache);
  checks.push({ check: "source_timestamp_cache", passed: true });
  const targetComments = await call("youtube_post_get", { post, view: "comments", locale: "ko", limit: 100 });
  checks.push({ check: "supplied_post_comments", passed: true, returned: targetComments.items.length });
  for (const [name, input, label] of [
    ["youtube_search", { scope: "posts", within: channel, locale: "ko", limit: 100 }, "channel_posts"],
    ["youtube_post_get", { post: commentPost, view: "comments", options: { order: "top" }, locale: "ko", limit: 100 }, "post_comments"],
  ]) {
    let first = await call(name, input);
    const ids = new Set(first.items.map(item => item.id));
    assert.equal(ids.size, first.items.length);
    // Consume bounded local slices before checking a real upstream continuation.
    let slices = 0;
    while (first.page.next_cursor?.startsWith("buffer:") && slices++ < 10) {
      first = await call(name, { ...input, cursor: first.page.next_cursor });
      for (const item of first.items) { assert.ok(!ids.has(item.id)); ids.add(item.id); }
    }
    assert.ok(first.page.next_cursor, `${label}: choose a canary with a next page`);
    const nextArgs = { ...input, cursor: first.page.next_cursor };
    const second = await call(name, nextArgs);
    const beforeReplay = networkRequests;
    const replay = await call(name, nextArgs);
    assert.deepEqual(replay.items, second.items);
    assert.equal(replay.meta.retrieved_at, second.meta.retrieved_at);
    if (!url) assert.equal(networkRequests, beforeReplay);
    for (const item of second.items) assert.ok(!ids.has(item.id));
    const mismatch = await client.callTool({ name, arguments: { ...nextArgs, locale: "en" } });
    assert.equal(mismatch.structuredContent.code, "CURSOR_MISMATCH");
    checks.push({ check: label, passed: true, firstPage: ids.size, secondPage: second.items.length, replay: true, mismatchedCursorRejected: true });
  }
  const newest = await call("youtube_post_get", { post, view: "comments", options: { order: "newest" }, locale: "ko", limit: 3 });
  checks.push({ check: "newest_comments", passed: true, returned: newest.items.length });
  console.log(JSON.stringify({ passed: true, mode: url ? "remote" : "local", checkedAt: new Date().toISOString(), checks,
    ...(url ? {} : { networkRequests, localRssBeforeBytes: rssBefore, localRssAfterBytes: process.memoryUsage().rss }),
  }, null, 2));
} finally {
  await client.close(); if (server) await server.close(); globalThis.fetch = originalFetch;
}
