import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createYoutubeMcpServer } from "../src/server.js";
import { outputSchemas } from "../src/output-schemas.js";
import type { YouTubeService } from "../src/youtube-service.js";
import { testAppConfig } from "./helpers.js";

const TOOL_NAMES = [
  "youtube_video_get",
  "youtube_search",
  "youtube_channel_get",
  "youtube_playlist_get",
  "youtube_post_get",
];

function stringCharacterCount(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => total + stringCharacterCount(item),
      0,
    );
  }
  if (!value || typeof value !== "object") return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (total, item) => total + stringCharacterCount(item),
    0,
  );
}

async function connectedClient(options: {
  apiKey?: string;
  service?: YouTubeService;
} = {}) {
  const server = createYoutubeMcpServer(
    testAppConfig({ apiKey: options.apiKey }),
    options.service ? { service: options.service } : {},
  );
  const client = new Client({ name: "youtube-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("MCP protocol surface", () => {
  it("exposes the exact compact tool and resource contract", async () => {
    const { client, server } = await connectedClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      expect(Buffer.byteLength(JSON.stringify(tools), "utf8")).toBeLessThanOrEqual(
        24_000,
      );
      for (const tool of tools) {
        expect(Buffer.byteLength(JSON.stringify(tool), "utf8")).toBeLessThanOrEqual(
          6_000,
        );
        expect(tool.outputSchema).toMatchObject({
          type: "object",
          required: ["schema_version", "kind", "data", "items", "job", "page", "meta"],
          properties: {
            data: { type: "object" },
            items: { type: "array" },
            page: {
              required: ["returned", "has_more", "next_cursor"],
              properties: { next_cursor: { type: ["string", "null"] } },
            },
            meta: {
              properties: {
                provider: { type: "string" },
                warnings: { type: "array", items: { type: "string" } },
              },
            },
          },
        });
        expect(
          Buffer.byteLength(tool.description ?? "", "utf8"),
        ).toBeLessThanOrEqual(180);
        const limit = (
          tool.inputSchema as {
            properties?: { limit?: { maximum?: number } };
          }
        ).properties?.limit;
        if (limit?.maximum !== undefined) {
          expect(limit.maximum).toBeLessThanOrEqual(100);
        }
      }

      const properties = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          Object.keys(
            (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
          ).sort(),
        ]),
      );
      expect(properties).toEqual({
        youtube_video_get: [
          "cursor",
          "limit",
          "locale",
          "max_chars",
          "options",
          "video",
          "view",
        ],
        youtube_search: [
          "cursor",
          "filters",
          "limit",
          "locale",
          "query",
          "scope",
          "within",
        ],
        youtube_channel_get: ["channel", "select"],
        youtube_playlist_get: ["cursor", "include_items", "limit", "playlist"],
        youtube_post_get: ["cursor", "limit", "locale", "max_chars", "options", "post", "view"],
      });

      expect((await client.listResources()).resources).toEqual([]);
      expect((await client.listPrompts()).prompts).toEqual([]);
      expect(
        (await client.listResourceTemplates()).resourceTemplates.map(
          (template) => template.uriTemplate,
        ),
      ).toEqual([
        "youtube://catalog",
        "youtube://schema/{operation}",
        "youtube://entity/{kind}/{id}",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps tools/list static with or without an API key", async () => {
    const withoutKey = await connectedClient();
    const withKey = await connectedClient({ apiKey: "test-api-key" });
    try {
      expect(await withKey.client.listTools()).toEqual(
        await withoutKey.client.listTools(),
      );
    } finally {
      await Promise.all([
        withoutKey.client.close(),
        withoutKey.server.close(),
        withKey.client.close(),
        withKey.server.close(),
      ]);
    }
  });

  it("accepts limit 100 while capping Data API page sizes at 50", async () => {
    const searchVideos = vi.fn(
      async (_query: string, _options: { maxResults: number }) => ({ items: [] }),
    );
    const listChannelVideos = vi.fn(async (
      _channel: string,
      _maxResults: number,
      _pageToken: string | undefined,
    ) => ({
      channel: { id: "UC123" },
      items: [],
    }));
    const trending = vi.fn(async (
      _region: string | undefined,
      _category: string | undefined,
      _maxResults: number,
      _pageToken: string | undefined,
    ) => ({ items: [] }));
    const getPlaylist = vi.fn(async (
      _playlist: string,
      _maxResults: number,
      _pageToken: string | undefined,
      _includeItems: boolean,
    ) => ({
      playlist: { id: "PL1234567890123456" },
      page: { items: [] },
    }));
    const service = {
      searchVideos,
      listChannelVideos,
      trending,
      getPlaylist,
    } as unknown as YouTubeService;
    const { client, server } = await connectedClient({ service });
    try {
      await client.callTool({
        name: "youtube_search",
        arguments: { scope: "global", query: "cats", limit: 100 },
      });
      await client.callTool({
        name: "youtube_search",
        arguments: { scope: "channel", within: "UC123", limit: 100 },
      });
      await client.callTool({
        name: "youtube_search",
        arguments: { scope: "trending", limit: 100 },
      });
      await client.callTool({
        name: "youtube_playlist_get",
        arguments: { playlist: "PL1234567890123456", limit: 100 },
      });
      expect(searchVideos.mock.calls[0]?.[1]).toMatchObject({ maxResults: 50 });
      expect(listChannelVideos.mock.calls[0]?.[1]).toBe(50);
      expect(trending.mock.calls[0]?.[2]).toBe(50);
      expect(getPlaylist.mock.calls[0]?.[1]).toBe(50);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns the fixed success and error envelopes without JSON text duplication", async () => {
    const fakeService = {
      getChannel: async () => ({
        id: "UC123",
        title: "Channel title",
        description: "Channel description",
        statistics: { subscriberCount: "10" },
        brandingSettings: {},
        uploadsPlaylistId: "UU123",
        provider: "test-provider",
      }),
    } as unknown as YouTubeService;
    const { client, server } = await connectedClient({ service: fakeService });
    try {
      await client.listTools();
      const success = await client.callTool({
        name: "youtube_channel_get",
        arguments: { channel: "UC123", select: ["profile", "statistics"] },
      });
      expect(success.isError).not.toBe(true);
      expect(outputSchemas.youtube_channel_get.safeParse(success.structuredContent).success).toBe(true);
      expect(success.content).toEqual([
        { type: "text", text: "entity completed; returned=0; more=no." },
      ]);
      expect(Object.keys(success.structuredContent ?? {}).sort()).toEqual([
        "data",
        "items",
        "job",
        "kind",
        "meta",
        "page",
        "schema_version",
      ]);
      expect(success.structuredContent).toMatchObject({
        schema_version: "1",
        kind: "entity",
        page: { returned: 0, has_more: false, next_cursor: null },
      });
      expect(
        Object.keys(
          (success.structuredContent as { meta: Record<string, unknown> }).meta,
        ).sort(),
      ).toEqual([
        "canonical_uri",
        "fresh_until",
        "provider",
        "quota_cost",
        "retrieved_at",
        "source",
        "untrusted_fields",
        "warnings",
      ]);

      const failure = await client.callTool({
        name: "youtube_video_get",
        arguments: {
          video: "dQw4w9WgXcQ",
          view: "metadata",
          cursor: "not-allowed",
        },
      });
      expect(failure.isError).toBe(true);
      expect(failure.structuredContent).toMatchObject({
        code: "INVALID_ARGUMENT",
        retryable: false,
        schema_uri: "youtube://schema/youtube_video_get",
      });
      expect(Object.keys(failure.structuredContent ?? {}).sort()).toEqual([
        "code",
        "details",
        "message",
        "retryable",
        "schema_uri",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects malformed declared fields without discarding extra provider fields", async () => {
    const service = {
      getVideo: async () => ({
        id: "dQw4w9WgXcQ",
        title: "Video",
        provider: "test-provider",
        providerSpecific: { evidence: "retained" },
      }),
      getChannel: async () => ({ statistics: { subscriberCount: 10 } }),
    } as unknown as YouTubeService;
    const { client, server } = await connectedClient({ service });
    try {
      // Discovery also enables the client's JSON Schema output validation.
      await client.listTools();
      const success = await client.callTool({
        name: "youtube_video_get",
        arguments: { video: "dQw4w9WgXcQ" },
      });
      expect(success.isError).not.toBe(true);
      expect(success.structuredContent).toMatchObject({
        data: { providerSpecific: { evidence: "retained" } },
      });
      const schema = outputSchemas.youtube_video_get;
      const envelope = success.structuredContent as Record<string, unknown>;
      expect(schema.safeParse(envelope).success).toBe(true);
      for (const invalid of [
        { ...envelope, page: { returned: "1", has_more: false, next_cursor: null } },
        { ...envelope, meta: { ...(envelope.meta as object), warnings: "warning" } },
        { ...envelope, data: { title: 123 } },
        { ...envelope, items: [{ index: "0", text: "segment" }] },
        { ...envelope, job: { status: "queued" } },
      ]) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
      const invalidOutput = await client.callTool({
        name: "youtube_channel_get",
        arguments: { channel: "UC123", select: ["statistics"] },
      });
      expect(invalidOutput.isError).toBe(true);
      expect(invalidOutput.structuredContent).toBeUndefined();
      expect(invalidOutput.content).toEqual([
        { type: "text", text: expect.stringContaining("Output validation error") },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reads catalog and operation schema through templates", async () => {
    const { client, server } = await connectedClient();
    try {
      const catalog = await client.readResource({ uri: "youtube://catalog" });
      const catalogText = catalog.contents[0];
      const catalogValue =
        catalogText && "text" in catalogText ? catalogText.text : "";
      expect(Buffer.byteLength(catalogValue, "utf8")).toBeLessThanOrEqual(8_192);
      expect(catalogValue).toContain(
        '"videoCacheEntries":256',
      );
      expect(catalogValue).toContain(
        '"transcriptCacheEntries":32',
      );

      for (const operation of TOOL_NAMES) {
        const schema = await client.readResource({
          uri: `youtube://schema/${operation}`,
        });
        const schemaContent = schema.contents[0];
        const schemaText =
          schemaContent && "text" in schemaContent ? schemaContent.text : "";
        expect(Buffer.byteLength(schemaText, "utf8")).toBeLessThanOrEqual(4_096);
        expect(schemaText).toContain('"schema_version":"1"');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("caps transcript text and envelope size under the public limits", async () => {
    const segments = Array.from({ length: 50 }, (_, index) => ({
      index,
      startSeconds: index,
      durationSeconds: 1,
      endSeconds: index + 1,
      timestamp: `00:${String(index).padStart(2, "0")}`,
      text: "untrusted transcript text ".repeat(40),
      url: `https://youtu.be/dQw4w9WgXcQ?t=${index}`,
    }));
    const fakeService = {
      getTranscript: async () => ({
        videoId: "dQw4w9WgXcQ",
        provider: "test-transcript",
        language: "en",
        availableLanguages: ["en"],
        generated: false,
        totalSegments: segments.length,
        durationSeconds: 50,
        offset: 0,
        limit: 50,
        nextOffset: undefined,
        segments,
        text: undefined,
        warnings: [],
      }),
    } as unknown as YouTubeService;
    const { client, server } = await connectedClient({ service: fakeService });
    try {
      const result = await client.callTool({
        name: "youtube_video_get",
        arguments: {
          video: "dQw4w9WgXcQ",
          view: "transcript",
          limit: 50,
          max_chars: 256,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8"),
      ).toBeLessThanOrEqual(12_288);
      const envelope = result.structuredContent as {
        data: {
          availableLanguageCount: number;
          availableLanguages?: string[];
          truncation?: {
            truncated: boolean;
            reason: string;
            original_items: number;
            returned_items: number;
          };
        };
        items: Array<{ text?: string; timestamp?: string; url?: string }>;
        page: { returned: number; has_more: boolean; next_cursor: string | null };
        meta: { warnings: string[] };
      };
      expect(envelope.items.length).toBeGreaterThan(0);
      expect(envelope.items.length).toBeLessThan(50);
      expect(envelope.page.returned).toBe(envelope.items.length);
      expect(envelope.page.has_more).toBe(true);
      expect(envelope.page.next_cursor).toBeTruthy();
      expect(envelope.data.availableLanguageCount).toBe(1);
      expect(envelope.data.availableLanguages).toBeUndefined();
      expect(envelope.data.truncation).toMatchObject({
        truncated: true,
        reason: "max_chars",
        original_items: 50,
        returned_items: envelope.items.length,
      });
      expect(
        envelope.items.reduce(
          (total, item) => total + (item.text?.length ?? 0),
          0,
        ),
      ).toBeLessThanOrEqual(256);
      expect(
        envelope.items.every(
          (item) => item.text && item.timestamp && item.url,
        ),
      ).toBe(true);
      expect(envelope.meta.warnings).toContain(
        "Transcript text was bounded to max_chars; structural fields remain intact and next_cursor continues at the first omitted segment.",
      );

      const withLanguages = await client.callTool({
        name: "youtube_video_get",
        arguments: {
          video: "dQw4w9WgXcQ",
          view: "transcript",
          options: { include_available_languages: true },
          limit: 50,
          max_chars: 256,
        },
      });
      expect(
        (withLanguages.structuredContent as {
          data: { availableLanguages?: string[] };
        }).data.availableLanguages,
      ).toEqual(["en"]);
      const languagePage = withLanguages.structuredContent as {
        page: { next_cursor: string | null };
      };
      const continued = await client.callTool({
        name: "youtube_video_get",
        arguments: {
          video: "dQw4w9WgXcQ",
          view: "transcript",
          options: { include_available_languages: true },
          cursor: languagePage.page.next_cursor,
          limit: 50,
          max_chars: 256,
        },
      });
      const continuedEnvelope = continued.structuredContent as {
        data: { availableLanguages?: string[]; availableLanguageCount: number };
        meta: { warnings: string[] };
      };
      expect(continuedEnvelope.data.availableLanguages).toBeUndefined();
      expect(continuedEnvelope.data.availableLanguageCount).toBe(1);
      expect(continuedEnvelope.meta.warnings).toContain(
        "availableLanguages is returned only on the first transcript page.",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
