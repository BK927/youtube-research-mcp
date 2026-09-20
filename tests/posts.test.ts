import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Helpers, Innertube, Parser } from "youtubei.js";
import { normalizePost, orderedPosts, POST_TTL_MS, YouTubeJsPostProvider, type PostProvider, type PostResult } from "../src/providers/posts.js";
import { exactPostChannel, extractPostId } from "../src/utils/ids.js";
import { YouTubeService } from "../src/youtube-service.js";
import { createYoutubeMcpServer } from "../src/server.js";
import { FirestorePageStore } from "../src/cache/response-page-store.js";
import { testAppConfig } from "./helpers.js";

const ID = "UgkxAzdixzRQiBw06VNXaEGt5ANIJN0D6hCD";
const CHANNEL = "UCBq8CLRcJN8rgqHOkyL1ozg";
type InnerClient = Awaited<ReturnType<typeof Innertube.create>>;
const post = (id = ID, overrides: Record<string, unknown> = {}) => ({
  type: "BackstagePost", id, content: "Post body", author: { id: CHANNEL, name: "Creator" }, published: "1 day ago", ...overrides,
});
function parsedPost(id = ID) {
  return Parser.parseResponse({ contents: { itemSectionRenderer: { contents: [{ backstagePostRenderer: {
    postId: id, contentText: { simpleText: "Post body" }, publishedTimeText: { simpleText: "1 day ago" },
    authorText: { simpleText: "Creator" }, authorEndpoint: { browseEndpoint: { browseId: CHANNEL } },
    authorThumbnail: { thumbnails: [] }, voteCount: { simpleText: "0" },
  } }] } } });
}
interface FakeFeed { page: unknown; posts: ReturnType<typeof post>[]; has_continuation: boolean; getContinuation: ReturnType<typeof vi.fn> }
function feed(items: ReturnType<typeof post>[], more?: FakeFeed): FakeFeed {
  return { page: { contents: items }, posts: items, has_continuation: Boolean(more), getContinuation: vi.fn(async () => more) };
}
function providerFixture(first = feed([post()])) {
  const resolveURL = vi.fn(async () => ({ name: "browseEndpoint", payload: { browseId: CHANNEL }, call: vi.fn(async () => parsedPost()) }));
  const getCommunity = vi.fn(async () => first);
  const getChannel = vi.fn(async () => ({ metadata: { title: "Creator" }, has_community: true, getCommunity }));
  const getPostComments = vi.fn();
  const fake = { resolveURL, getChannel, getPostComments, actions: {} } as unknown as InnerClient;
  const create = vi.fn(async () => fake);
  return { provider: new YouTubeJsPostProvider("en", "US", 1000, create), resolveURL, getChannel, getCommunity, getPostComments, create };
}
const document = (items: Record<string, unknown>[] = []): PostResult => ({
  data: normalizePost(post()), items, nextPageToken: null,
  retrievedAt: new Date().toISOString(), freshUntil: new Date(Date.now() + POST_TTL_MS).toISOString(), warnings: ["unofficial"],
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("post references and normalization", () => {
  it("accepts canonical IDs/links and exact channels, rejecting unrelated URLs/name guesses", () => {
    expect(extractPostId(ID)).toBe(ID);
    expect(extractPostId(`https://www.youtube.com/post/${ID}?si=shared`)).toBe(ID);
    for (const input of [`https://evil.test/post/${ID}`, `https://youtube.com.evil.test/post/${ID}`, `ftp://youtube.com/post/${ID}`, "dQw4w9WgXcQ", `https://user@youtube.com/post/${ID}`]) expect(() => extractPostId(input)).toThrow();
    expect(exactPostChannel(CHANNEL)).toBe(`https://www.youtube.com/channel/${CHANNEL}`);
    expect(exactPostChannel("https://m.youtube.com/@creator/posts")).toBe("https://www.youtube.com/@creator");
    expect(exactPostChannel("@creator")).toBe("https://www.youtube.com/@creator");
    expect(() => exactPostChannel("Creator name")).toThrow();
    expect(() => exactPostChannel("https://evil.test/@creator")).toThrow();
  });
  it("preserves missing, zero, abbreviated likes and relative dates", () => {
    expect(normalizePost(post())).toMatchObject({ likeCountLabel: null, publishedLabel: "1 day ago" });
    expect(normalizePost(post(ID, { vote_count: "0" }))).toMatchObject({ likeCountLabel: "0" });
    expect(normalizePost(post(ID, { vote_count: "16K" }))).toMatchObject({ likeCountLabel: "16K" });
    expect(normalizePost(post())).not.toHaveProperty("publishedAt");
  });
  it("normalizes attachments without downloads or conditional poll percentages", () => {
    const img = { type: "BackstageImage", image: [{ url: "https://example.test/s.jpg", width: 10 }, { url: "https://example.test/l.jpg", width: 100 }] };
    expect(normalizePost(post(ID, { attachment: img })).attachment).toMatchObject({ type: "image", images: [{ url: "https://example.test/l.jpg" }] });
    expect(normalizePost(post(ID, { attachment: { type: "PostMultiImage", images: [img, img] } })).attachment).toMatchObject({ type: "images", images: [{ width: 100 }, { width: 100 }] });
    expect(normalizePost(post(ID, { attachment: { type: "Video", id: "dQw4w9WgXcQ", title: "Video" } })).attachment).toMatchObject({ type: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    const poll = normalizePost(post(ID, { attachment: { type: "Poll", total_votes: "2K", choices: [{ text: "A", vote_ratio_if_selected: 0.8, vote_percentage_if_not_selected: "50%" }] } }));
    expect(poll.attachment).toEqual({ type: "poll", totalVotesLabel: "2K", resultsAvailability: "not_supplied", choices: [{ text: "A", image: null }] });
    expect(normalizePost(post(ID, { attachment: { type: "FutureAttachment" } }))).toMatchObject({ text: "Post body", attachment: { type: "unsupported" } });
  });
  it("preserves renderer order through parsed wrappers and does not duplicate shared originals", () => {
    const original = post("UgOriginalPost123");
    const shared = post("UgSharedPost123", { type: "SharedPost", original_post: original });
    const first = post("UgFirstPost123", { type: "Post" });
    const tree = { contents: new Helpers.SuperParsedResult([{ type: "Wrapper", content: shared }, first, original] as never), contents_memo: { entries: [original, first, shared] } };
    expect(orderedPosts(tree).map(value => (value as { id: string }).id)).toEqual([shared.id, first.id, original.id]);
    expect(normalizePost(shared)).toMatchObject({ id: shared.id, sharedPost: { id: original.id } });
  });
});

describe("bounded post provider", () => {
  it("resolves the exact post, deduplicates concurrent loads and preserves source times", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { provider, resolveURL, getPostComments } = providerFixture();
    const [a, b] = await Promise.all([provider.getPost(ID), provider.getPost(`https://youtube.com/post/${ID}`)]);
    expect(resolveURL).toHaveBeenCalledOnce();
    expect(a.data).toMatchObject({ id: ID, author: { channelId: CHANNEL } });
    expect(a).toEqual(b);
    expect(getPostComments).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1000);
    expect(await provider.getPost(ID)).toEqual(a);
    vi.setSystemTime(Date.now() + POST_TTL_MS);
    const fresh = await provider.getPost(ID);
    expect(fresh.retrievedAt).not.toBe(a.retrievedAt);
    expect(resolveURL).toHaveBeenCalledTimes(2);
  });
  it("retains order, does not prefetch, and replays a continuation without fetching twice", async () => {
    const second = feed([post("UgSecondPost123")]);
    const first = feed([post()], second);
    const { provider } = providerFixture(first);
    const a = await provider.listPosts("@creator");
    expect(first.getContinuation).not.toHaveBeenCalled();
    const [b, replay] = await Promise.all([provider.listPosts("@creator", "en", a.nextPageToken!), provider.listPosts("@creator", "en", a.nextPageToken!)]);
    expect(b.items.map(item => item.id)).toEqual(["UgSecondPost123"]);
    expect(b).toEqual(replay);
    expect(first.getContinuation).toHaveBeenCalledOnce();
    expect(b.nextPageToken).toBeNull();
    await expect(provider.listPosts("@different", "en", a.nextPageToken!)).rejects.toMatchObject({ code: "CURSOR_MISMATCH" });
    await expect(provider.listPosts("@creator", "ko", a.nextPageToken!)).rejects.toMatchObject({ code: "CURSOR_MISMATCH" });
  });
  it("expires/evicts continuation states and enforces the result cache capacity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { provider, resolveURL } = providerFixture(feed([post()], feed([post("UgNextPost123")])));
    const first = await provider.listPosts("@first");
    for (let i = 0; i < 129; i++) await provider.listPosts(`@channel${i}`);
    await expect(provider.listPosts("@first", "en", first.nextPageToken!)).rejects.toMatchObject({ code: "CURSOR_MISMATCH" });
    await provider.listPosts("@first");
    expect(resolveURL).toHaveBeenCalledTimes(131);
    const recent = await provider.listPosts("@channel128");
    vi.setSystemTime(Date.now() + POST_TTL_MS + 1);
    await expect(provider.listPosts("@channel128", "en", recent.nextPageToken!)).rejects.toMatchObject({ code: "CURSOR_MISMATCH" });
  });
  it("refreshes a first page whose continuation was evicted while its data is still cached", async () => {
    const { provider, resolveURL } = providerFixture(feed([post()], feed([post("UgNextPost123")])));
    const first = await provider.listPosts("@first");
    for (let i = 0; i < 64; i++) await provider.listPosts(`@other${i}`);
    const restarted = await provider.listPosts("@first");
    expect(resolveURL).toHaveBeenCalledTimes(66);
    expect(restarted.nextPageToken).not.toBe(first.nextPageToken);
    expect((await provider.listPosts("@first", "en", restarted.nextPageToken!)).items[0]?.id).toBe("UgNextPost123");
  });
  it("distinguishes a missing posts tab, empty lists, oversized pages and upstream errors", async () => {
    const empty = providerFixture(feed([]));
    expect((await empty.provider.listPosts("@empty")).items).toEqual([]);
    empty.getChannel.mockResolvedValueOnce({ metadata: { title: "Creator" }, has_community: false, getCommunity: empty.getCommunity });
    expect((await empty.provider.listPosts("@absent")).data.availability).toBe("no_posts_tab");
    const huge = providerFixture(feed([post(ID, { content: "x".repeat(600_000) })]));
    await expect(huge.provider.listPosts("@huge")).rejects.toMatchObject({ code: "UPSTREAM_ERROR", details: { reason: "post_page_size" } });
    empty.getCommunity.mockRejectedValueOnce(new Error("parser changed"));
    await expect(empty.provider.listPosts("@broken")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
  it("maps missing posts and timeouts, and retries failed client initialization", async () => {
    const { provider, resolveURL } = providerFixture();
    await expect(provider.getPost("UgMissingPost123")).rejects.toMatchObject({ code: "NOT_FOUND" });
    resolveURL.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    await expect(provider.getPost(ID)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect((await provider.getPost(ID)).data.id).toBe(ID);
    const make = vi.fn().mockRejectedValueOnce(new Error("init failed"));
    const p = new YouTubeJsPostProvider("en", "US", 1000, make);
    await expect(p.getPost(ID)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    await expect(p.getPost(ID)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(make).toHaveBeenCalledTimes(2);
  });
  it("uses identified channel and sort for comments without requesting replies", async () => {
    const { provider, getPostComments } = providerFixture();
    const getReplies = vi.fn();
    const thread = { comment: { comment_id: "c1", content: "hello", author: { id: CHANNEL, name: "reader" }, like_count: "0", published_time: "2 hours ago", reply_count: "5" }, getReplies };
    const next = { page: {}, contents: [{ ...thread, comment: { ...thread.comment, comment_id: "c2" } }], has_continuation: false };
    const getContinuation = vi.fn(async () => next);
    getPostComments.mockResolvedValue({ page: {}, contents: [thread], has_continuation: true, getContinuation });
    const first = await provider.listComments(ID, "newest", "ko");
    expect(getPostComments).toHaveBeenCalledWith(ID, CHANNEL, "NEWEST_FIRST");
    expect(first.items[0]).toMatchObject({ id: "c1", likeCountLabel: "0", repliesIncluded: false, replyCountLabel: "5" });
    const second = await provider.listComments(ID, "newest", "ko", first.nextPageToken!);
    expect(second.items[0]?.id).toBe("c2");
    expect(getContinuation).toHaveBeenCalledOnce();
    expect(getReplies).not.toHaveBeenCalled();
    await expect(provider.listComments(ID, "top", "ko", first.nextPageToken!)).rejects.toMatchObject({ code: "CURSOR_MISMATCH" });
  });
  it("reports unreadable comments separately from a readable empty comments page", async () => {
    const { provider, getPostComments } = providerFixture();
    getPostComments.mockRejectedValueOnce(new Error("The comments page did not have any content"));
    await expect(provider.listComments(ID, "top")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { reason: "comments_unavailable" } });
    getPostComments.mockResolvedValueOnce({ page: { on_response_received_endpoints: [{}, {}] }, contents: [], has_continuation: false });
    expect((await provider.listComments(ID, "top")).items).toEqual([]);
    getPostComments.mockResolvedValueOnce({ page: {}, contents: [], has_continuation: false });
    await expect(provider.listComments(ID, "newest")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
  it("aborts the actual fetch signal at the configured timeout", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    })));
    const provider = new YouTubeJsPostProvider("en", "US", 20);
    await expect(provider.getPost(ID)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(signal?.aborted).toBe(true);
  });
});

async function connect(posts: PostProvider, mode: "official" | "hybrid" = "hybrid", firestore = false) {
  const config = testAppConfig({ providerMode: mode, quotaStoreMode: firestore ? "firestore" : "memory" });
  const service = new YouTubeService(config, { posts, quota: { consume: async () => undefined, status: async () => ({}) as never } });
  const server = createYoutubeMcpServer(config, { service });
  const client = new Client({ name: "post-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function mockedPosts() {
  return { getPost: vi.fn(async () => document()), listPosts: vi.fn(async () => document()), listComments: vi.fn(async () => document()) };
}
function envelope(result: Awaited<ReturnType<Client["callTool"]>>) { return result.structuredContent as Record<string, any>; }

describe("post MCP routing and bounded responses", () => {
  it("keeps official-only mode closed and rejects unsupported options", async () => {
    const posts = mockedPosts();
    const ctx = await connect(posts, "official");
    try {
      const response = await ctx.client.callTool({ name: "youtube_post_get", arguments: { post: ID } });
      expect(response.isError).toBe(true);
      expect(envelope(response).code).toBe("PROVIDER_UNAVAILABLE");
      expect(posts.getPost).not.toHaveBeenCalled();
    } finally { await ctx.close(); }
    const enabled = await connect(posts);
    try {
      for (const args of [{ post: ID, options: { include_replies: true } }, { post: ID, cursor: "bogus" }]) {
        expect((await enabled.client.callTool({ name: "youtube_post_get", arguments: args })).isError).toBe(true);
      }
      expect((await enabled.client.callTool({ name: "youtube_search", arguments: { scope: "posts", within: "@creator", query: "keyword" } })).isError).toBe(true);
    } finally { await enabled.close(); }
  });
  it("preserves provenance and marks text truncation without fetching comments", async () => {
    const posts = mockedPosts(); const value = document(); value.data.text = "x".repeat(3000); posts.getPost.mockResolvedValue(value);
    const ctx = await connect(posts);
    try {
      const r = envelope(await ctx.client.callTool({ name: "youtube_post_get", arguments: { post: ID, max_chars: 256 } }));
      expect(r.data.id).toBe(ID); expect(r.data.text.length).toBeLessThanOrEqual(256); expect(r.data.textTruncated).toBe(true);
      expect(r.meta).toMatchObject({ retrieved_at: value.retrievedAt, fresh_until: value.freshUntil, provider: "youtubejs-posts", quota_cost: { data: 0, search: 0 } });
      expect(r.meta.untrusted_fields).toContain("data.text"); expect(posts.listComments).not.toHaveBeenCalled();
    } finally { await ctx.close(); }
  });
  it("keeps buffered pages memory-only in Firestore mode, bound to inputs, with no skipped items", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const put = vi.spyOn(FirestorePageStore.prototype, "put").mockRejectedValue(new Error("must not persist posts"));
    const posts = mockedPosts(); posts.listPosts.mockResolvedValue(document([normalizePost(post("UgFirstPost123")), normalizePost(post("UgSecondPost123")), normalizePost(post("UgThirdPost123"))]));
    const ctx = await connect(posts, "hybrid", true);
    const args = { scope: "posts", within: "@creator", locale: "ko", limit: 1 };
    try {
      const first = envelope(await ctx.client.callTool({ name: "youtube_search", arguments: args }));
      const cursor = first.page.next_cursor;
      const second = envelope(await ctx.client.callTool({ name: "youtube_search", arguments: { ...args, cursor, limit: 2 } }));
      expect(second.items.map((p: { id: string }) => p.id)).toEqual(["UgSecondPost123", "UgThirdPost123"]);
      expect(second.page.has_more).toBe(false); expect(posts.listPosts).toHaveBeenCalledOnce(); expect(put).not.toHaveBeenCalled();
      expect(second.meta.retrieved_at).toBe(first.meta.retrieved_at);
      for (const change of [{ within: "@else" }, { locale: "en" }, { cursor: cursor + "bad" }]) {
        const bad = envelope(await ctx.client.callTool({ name: "youtube_search", arguments: { ...args, cursor, ...change } }));
        expect(bad.code).toBe("CURSOR_MISMATCH");
      }
      vi.setSystemTime(Date.now() + POST_TTL_MS + 1);
      expect(envelope(await ctx.client.callTool({ name: "youtube_search", arguments: { ...args, cursor } })).code).toBe("CURSOR_MISMATCH");
    } finally { await ctx.close(); }
  });
  it("binds upstream cursors to comment order and keeps all items through byte-cap slicing", async () => {
    const posts = mockedPosts();
    const result = document(Array.from({ length: 100 }, (_, index) => ({ id: `comment-${index}`, text: "x".repeat(300), author: { channelId: CHANNEL, name: "Reader" }, likeCountLabel: "0" })));
    result.nextPageToken = "upstream-page-2"; posts.listComments.mockResolvedValue(result);
    const ctx = await connect(posts);
    const args = { post: ID, view: "comments", options: { order: "top" }, limit: 100 };
    try {
      let output = envelope(await ctx.client.callTool({ name: "youtube_post_get", arguments: args }));
      const ids: string[] = [];
      while (true) {
        expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(12_288);
        ids.push(...output.items.map((p: { id: string }) => p.id));
        const cursor = output.page.next_cursor;
        if (!cursor.startsWith("buffer:")) {
          const mismatch = envelope(await ctx.client.callTool({ name: "youtube_post_get", arguments: { ...args, options: { order: "newest" }, cursor } }));
          expect(mismatch.code).toBe("CURSOR_MISMATCH");
          posts.listComments.mockResolvedValueOnce(document([]));
          await ctx.client.callTool({ name: "youtube_post_get", arguments: { ...args, cursor } });
          expect(posts.listComments).toHaveBeenLastCalledWith(ID, "top", "", "upstream-page-2");
          break;
        }
        output = envelope(await ctx.client.callTool({ name: "youtube_post_get", arguments: { ...args, cursor } }));
      }
      expect(ids).toEqual(result.items.map(item => item.id));
      expect(new Set(ids).size).toBe(100);
    } finally { await ctx.close(); }
  });
});
