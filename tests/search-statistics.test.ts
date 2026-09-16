import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createYoutubeMcpServer } from "../src/server.js";
import { YouTubeService } from "../src/youtube-service.js";
import { testAppConfig } from "./helpers.js";

const A = "aaaaaaaaaaa", B = "bbbbbbbbbbb", C = "ccccccccccc";
const channel = "UC1234567890123456789012";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const video = (id: string) => ({ id, snippet: { title: id, tags: ["full-metadata"] }, statistics: { viewCount: "0", likeCount: "0", commentCount: "1" }, contentDetails: { duration: "PT2M" } });
const contentOf = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, unknown>;

afterEach(() => { vi.unstubAllGlobals(); });

describe("batched search statistics", () => {
  it("reuses metadata cache, deduplicates misses, preserves order and missing videos", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const ids = new URL(String(input)).searchParams.get("id")!.split(",");
      return json({ items: ids.filter((id) => id !== C).reverse().map(video) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new YouTubeService(testAppConfig({ apiKey: "test" }));
    await service.getVideo(A);
    const result = await service.enrichSearchItems([{ id: B }, { id: A }, { id: B }, { id: C }]);
    expect(result.dataCost).toBe(1);
    expect(result.items).toMatchObject([
      { id: B, statistics: { viewCount: "0" }, durationSeconds: 120, statisticsAvailability: "available" },
      { id: A, statisticsAvailability: "available" },
      { id: B, statisticsAvailability: "available" },
      { id: C, statisticsAvailability: "unavailable", statisticsReason: "VIDEO_NOT_FOUND" },
    ]);
    const request = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(request.searchParams.get("id")).toBe(`${B},${C}`);
    expect(request.searchParams.has("maxResults")).toBe(false);
    expect(await service.getVideo(B)).toMatchObject({ tags: ["full-metadata"] });
    expect((await service.enrichSearchItems([{ id: A }, { id: B }])).dataCost).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("splits batches at 50 IDs and does not invent missing metrics", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const ids = new URL(String(input)).searchParams.get("id")!.split(",");
      expect(ids.length).toBeLessThanOrEqual(50);
      return json({ items: ids.map((id) => ({ id, statistics: { viewCount: "0" } })) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new YouTubeService(testAppConfig({ apiKey: "test" })).enrichSearchItems(
      Array.from({ length: 51 }, (_, i) => ({ id: String(i).padStart(11, "0") })),
    );
    expect(result.dataCost).toBe(2);
    expect(result.items).toHaveLength(51);
    expect(result.items[0]).toMatchObject({ statistics: { viewCount: "0" }, statisticsAvailability: "partial", durationSeconds: null });
    expect(result.items[0]).not.toHaveProperty("statistics.likeCount");
  });

  it("counts every attempted retry and preserves results after upstream failure", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => json({ error: { message: "limited" } }, 429)));
    const service = new YouTubeService(testAppConfig({ apiKey: "test" }));
    const result = await service.enrichSearchItems([{ id: A, title: "Retained" }]);
    expect(result.dataCost).toBe(3);
    expect(result.items).toMatchObject([{ id: A, title: "Retained", statisticsAvailability: "unavailable" }]);
    expect(result.warnings).toHaveLength(1);
    expect((await service.catalog()).quota).toMatchObject({ data: { used: 3 } });
  });
});

async function connected(overrides = {}) {
  const config = testAppConfig({ apiKey: "test", ...overrides });
  const server = createYoutubeMcpServer(config);
  const client = new Client({ name: "statistics-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, server };
}

describe("search statistics MCP contract", () => {
  it("defaults off and adds stats only on opt-in; upstream cursors bind the flag", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/search")
        ? json({ items: [{ id: { videoId: A }, snippet: { title: "First" } }], nextPageToken: "next" })
        : json({ items: [video(A)] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connected();
    try {
      const plain = await client.callTool({ name: "youtube_search", arguments: { query: "game" } });
      expect(contentOf(plain).items).toEqual([expect.not.objectContaining({ statistics: expect.anything() })]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const enriched = await client.callTool({ name: "youtube_search", arguments: { query: "game", filters: { include_statistics: true } } });
      expect(enriched.structuredContent).toMatchObject({ items: [{ statistics: { viewCount: "0" } }], meta: { quota_cost: { data: 1, search: 1 } } });
      const cursor = (contentOf(enriched).page as { next_cursor: string }).next_cursor;
      const wrong = await client.callTool({ name: "youtube_search", arguments: { query: "game", cursor } });
      expect(wrong.isError).toBe(true);
      const invalid = await client.callTool({ name: "youtube_search", arguments: { query: "game", filters: { include_statistics: "true" } } });
      expect(invalid.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally { await client.close(); await server.close(); }
  });

  it("returns base search results when the data quota guard prevents enrichment", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [{ id: { videoId: A }, snippet: { title: "Found" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connected({ apiDailyBudget: 0 });
    try {
      const result = await client.callTool({ name: "youtube_search", arguments: { query: "game", filters: { include_statistics: true } } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ items: [{ id: A, title: "Found", statisticsReason: "RATE_LIMITED" }], meta: { quota_cost: { data: 0, search: 1 } } });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { await client.close(); await server.close(); }
  });

  it("enriches channel uploads by videoId after local filtering", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/channels")) return json({ items: [{ id: channel, snippet: { title: "Channel" }, contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] });
      if (url.pathname.endsWith("/playlistItems")) return json({ items: [
        { id: "playlist-item-1", snippet: { title: "Match game" }, contentDetails: { videoId: A } },
        { id: "playlist-item-2", snippet: { title: "Other" }, contentDetails: { videoId: B } },
      ] });
      expect(url.searchParams.get("id")).toBe(A);
      return json({ items: [video(A)] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connected();
    try {
      const result = await client.callTool({ name: "youtube_search", arguments: { scope: "channel", within: channel, query: "Match", filters: { strategy: "uploads", include_statistics: true } } });
      expect(result.structuredContent).toMatchObject({ items: [{ videoId: A, statisticsAvailability: "available" }], meta: { quota_cost: { data: 3, search: 0 } } });
      expect(contentOf(result).items).toHaveLength(1);
    } finally { await client.close(); await server.close(); }
  });

  it("pages enriched results without dropping items or fetching again", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => String(i).padStart(11, "0"));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/search")
        ? json({ items: ids.map((id) => ({ id: { videoId: id }, snippet: { title: id, description: "description ".repeat(100) } })) })
        : json({ items: ids.map(video) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { client, server } = await connected({ maxResultBytes: 4096 });
    try {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const result = await client.callTool({ name: "youtube_search", arguments: { query: "game", limit: 20, filters: { include_statistics: true }, ...(cursor ? { cursor } : {}) } });
        expect(result.isError).not.toBe(true);
        const content = contentOf(result);
        if (pages++) expect(content.meta).toMatchObject({ quota_cost: { data: 0, search: 0 } });
        const items = content.items as { id: string; statisticsAvailability: string }[];
        expect(items.every((row) => row.statisticsAvailability === "available")).toBe(true);
        seen.push(...items.map((row) => row.id));
        cursor = (content.page as { next_cursor?: string }).next_cursor ?? undefined;
        expect(pages).toBeLessThan(25);
      } while (cursor);
      expect(pages).toBeGreaterThan(1);
      expect(seen).toEqual(ids);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { await client.close(); await server.close(); }
  });
});
