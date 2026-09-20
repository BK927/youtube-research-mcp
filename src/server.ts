import { POST_TTL_MS, type PostResult } from "./providers/posts.js";
import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { CursorCodec } from "./cursor.js";
import { YouTubeMcpError } from "./errors.js";
import { SERVER_NAME, SERVER_VERSION } from "./meta.js";
import { runTool, successResult, type ToolPayload } from "./mcp-response.js";
import { outputSchemas } from "./output-schemas.js";
import { ResponsePager } from "./response-pager.js";
import { FirestorePageStore } from "./cache/response-page-store.js";
import type { AppConfig } from "./types.js";
import {
  exactPostChannel,
  extractPostId,
  extractPlaylistId,
  extractVideoId,
} from "./utils/ids.js";
import {
  YouTubeService,
  type ServiceRuntimeInfo,
} from "./youtube-service.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const oauthMeta = {
  securitySchemes: [{ type: "oauth2", scopes: ["youtube.read"] }],
};

const cursorSchema = z.string().min(1).optional();
const limitSchema = z.number().int().min(1).max(100).default(10);
const filtersSchema = z.record(z.string(), z.unknown()).default({});
const responsePagers = new WeakMap<object, ResponsePager>();
const postResponsePagers = new WeakMap<object, ResponsePager>();

const TOOL_SCHEMAS: Record<string, unknown> = {
  youtube_video_get: {
    required: ["video"],
    fields: {
      video: "YouTube video ID or URL",
      view: ["metadata", "transcript", "comments"],
      options: {
        transcript: {
          fields: [
            "language",
            "include_text",
            "include_timestamps",
            "include_available_languages",
          ],
          available_languages:
            "omitted by default; opt in on page one and omitted from cursor pages",
        },
        comments: ["order", "include_replies", "reply_limit"],
      },
      cursor: "opaque signed cursor",
      limit: "1..100",
      max_chars: "256..12000 content-text budget; structural fields remain intact",
      locale: "preferred language code",
    },
  },
  youtube_search: {
    fields: {
      scope: ["global", "channel", "transcript", "trending", "posts"],
      query: "required for global/transcript; optional for channel",
      within: "channel for channel/posts scope; video for transcript scope",
      filters: {
        global: ["order", "channel_id", "published_after", "published_before", "region", "relevance_language", "safe_search", "video_duration", "include_statistics"],
        channel: ["strategy", "include_statistics"],
        posts: [],
        transcript: ["language", "match_mode", "case_sensitive", "context_segments", "from", "to"],
        trending: ["region", "category_id"],
        note: "region overrides locale region; include_statistics=false by default, true batches cached official statistics/duration for global/channel only; missing values are not zero",
      },
      cursor: "opaque signed cursor",
      limit: "1..100",
      locale: "preferred language code",
    },
  },
  youtube_channel_get: {
    required: ["channel"],
    fields: {
      channel: "channel ID, @handle, URL, username, or name",
      select: ["profile", "statistics", "branding", "uploads_playlist"],
    },
  },
  youtube_playlist_get: {
    required: ["playlist"],
    fields: {
      playlist: "playlist ID or URL",
      include_items: "include one signed item page",
      cursor: "opaque signed cursor",
      limit: "1..100",
    },
  },
  youtube_post_get: {
    required: ["post"],
    fields: {
      post: "YouTube post ID or youtube.com/post/<id> URL",
      view: ["content", "comments"],
      options: { comments: { order: ["top", "newest"] } },
      cursor: "signed process-local cursor, expires in 5 minutes; restart query after expiry/restart",
      limit: "1..100, default 10; at most one upstream page per call",
      max_chars: "256..12000 text budget; default 4000",
      locale: "preferred language code",
      note: "Public unofficial reads in hybrid/unofficial mode; no API key or cookies. Top-level comments only, image URLs only; dates/counts retain display labels.",
    },
  },
  error: {
    fields: ["code", "message", "retryable", "schema_uri", "details"],
  },
};

export interface CreateYoutubeMcpServerOptions {
  service?: YouTubeService;
  runtime?: ServiceRuntimeInfo;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireArgument(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized) return normalized;
  throw new YouTubeMcpError(
    "INVALID_ARGUMENT",
    `${name} is required for this operation.`,
    { name },
  );
}

function assertNoArgument(value: string, name: string): void {
  if (!value.trim()) return;
  throw new YouTubeMcpError(
    "INVALID_ARGUMENT",
    `${name} is not accepted for this scope.`,
    { name },
  );
}

function checkedFilters(
  filters: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  const unexpected = Object.keys(filters).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new YouTubeMcpError(
      "INVALID_ARGUMENT",
      "One or more filters are not supported for this view or scope.",
      { unexpected, allowed },
    );
  }
  return filters;
}

function stringFilter(
  filters: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = filters[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new YouTubeMcpError("INVALID_ARGUMENT", `${key} must be a string.`);
  }
  return value.trim() || undefined;
}

function booleanFilter(
  filters: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = filters[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new YouTubeMcpError("INVALID_ARGUMENT", `${key} must be a boolean.`);
  }
  return value;
}

function integerFilter(
  filters: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = filters[key];
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new YouTubeMcpError(
      "INVALID_ARGUMENT",
      `${key} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function enumFilter<const T extends string>(
  filters: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = filters[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new YouTubeMcpError(
      "INVALID_ARGUMENT",
      `${key} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value as T;
}

function timeFilter(
  filters: Record<string, unknown>,
  key: string,
): string | number | undefined {
  const value = filters[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new YouTubeMcpError(
      "INVALID_ARGUMENT",
      `${key} must be a timestamp string or seconds.`,
    );
  }
  return value;
}

function regionFilter(
  filters: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = stringFilter(filters, key);
  if (!value) return undefined;
  if (!/^[a-z]{2}$/iu.test(value)) {
    throw new YouTubeMcpError(
      "INVALID_ARGUMENT",
      `${key} must be a two-letter ISO 3166-1 region code.`,
    );
  }
  return value.toUpperCase();
}

function regionFromLocale(locale: string): string | undefined {
  const value = locale.trim();
  if (!value) return undefined;
  try {
    return new Intl.Locale(value.replaceAll("_", "-")).region?.toUpperCase();
  } catch {
    return undefined;
  }
}

function pageToken(
  codec: CursorCodec,
  cursor: string | undefined,
  operation: string,
  filters: Record<string, unknown>,
): string | undefined {
  if (!cursor) return undefined;
  const value = codec.decode(cursor, operation, filters).pageToken;
  if (typeof value !== "string" || !value) {
    throw new YouTubeMcpError("CURSOR_MISMATCH", "The cursor state is invalid.");
  }
  return value;
}

function offset(
  codec: CursorCodec,
  cursor: string | undefined,
  operation: string,
  filters: Record<string, unknown>,
): number {
  if (!cursor) return 0;
  const value = codec.decode(cursor, operation, filters).offset;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new YouTubeMcpError("CURSOR_MISMATCH", "The cursor state is invalid.");
  }
  return value;
}

function nextCursor(
  codec: CursorCodec,
  operation: string,
  filters: Record<string, unknown>,
  state: Record<string, unknown> | undefined,
): string | null {
  return state ? codec.encode(operation, filters, state) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function provider(value: Record<string, unknown>): string | null {
  return typeof value.provider === "string" ? value.provider : null;
}

function without(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

function capPayloadText(
  data: unknown,
  items: unknown[],
  maxChars: number,
): { data: unknown; items: unknown[]; warning?: string | undefined } {
  let remaining = maxChars;
  let truncated = false;
  const visit = (item: unknown, key = ""): unknown => {
    if (typeof item === "string" && key === "description") {
      const capped = item.slice(0, remaining);
      remaining -= capped.length;
      truncated ||= capped.length < item.length;
      return capped.length < item.length && capped.length >= 3
        ? `${capped.slice(0, -3)}...`
        : capped;
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, key));
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>).map(([key, child]) => [
        key,
        visit(child, key),
      ]),
    );
  };
  const cappedData = visit(data);
  const cappedItems = visit(items) as unknown[];
  return {
    data: truncated ? { ...record(cappedData), truncation: { reason: "max_chars", max_chars: maxChars, content_omitted: true, fields: ["description"] } } : cappedData,
    items: cappedItems,
    warning: truncated ? "Description text was shortened to max_chars; structured metadata was preserved." : undefined,
  };
}

interface CappedComments {
  data: Record<string, unknown>;
  items: unknown[];
  warning: string | undefined;
}

function capText(value: string, limit: number): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= limit) return { text: value, truncated: false };
  if (limit >= 4) {
    return { text: `${value.slice(0, limit - 3)}...`, truncated: true };
  }
  return { text: value.slice(0, Math.max(1, limit)), truncated: true };
}

interface CappedTranscript {
  data: Record<string, unknown>;
  items: unknown[];
  warning: string | undefined;
}

function capTranscriptPayload(
  data: Record<string, unknown>,
  inputItems: unknown[],
  maxChars: number,
): CappedTranscript {
  const outputData = { ...data };
  const aggregateText =
    typeof outputData.text === "string" ? outputData.text : undefined;
  delete outputData.text;

  const itemBudget = aggregateText
    ? Math.max(1, Math.floor(maxChars * 0.65))
    : maxChars;
  let remaining = itemBudget;
  let textCharsReturned = 0;
  let truncatedTextFields = 0;
  const items: Record<string, unknown>[] = [];

  for (const value of inputItems) {
    const segment = record(value);
    const text = typeof segment.text === "string" ? segment.text : "";
    if (!text || remaining <= 0) break;
    if (text.length <= remaining) {
      items.push({ ...segment, text });
      remaining -= text.length;
      textCharsReturned += text.length;
      continue;
    }
    if (items.length === 0) {
      const capped = capText(text, remaining);
      items.push({ ...segment, text: capped.text, textTruncated: true });
      textCharsReturned += capped.text.length;
      truncatedTextFields += 1;
    }
    break;
  }

  if (aggregateText !== undefined) {
    const aggregateBudget = Math.max(0, maxChars - textCharsReturned);
    if (aggregateBudget > 0) {
      const capped = capText(aggregateText, aggregateBudget);
      outputData.text = capped.text;
      textCharsReturned += capped.text.length;
      if (capped.truncated) truncatedTextFields += 1;
    }
  }

  const omittedItems = inputItems.length - items.length;
  const truncated =
    omittedItems > 0 ||
    truncatedTextFields > 0 ||
    (aggregateText !== undefined && outputData.text === undefined);
  if (!truncated) {
    if (aggregateText !== undefined) outputData.text = aggregateText;
    return { data: outputData, items, warning: undefined };
  }

  outputData.truncation = {
    truncated: true,
    reason: "max_chars",
    max_chars: maxChars,
    original_items: inputItems.length,
    returned_items: items.length,
    omitted_items: omittedItems,
    truncated_text_fields: truncatedTextFields,
    text_chars_returned: textCharsReturned,
  };
  return {
    data: outputData,
    items,
    warning:
      "Transcript text was bounded to max_chars; structural fields remain intact and next_cursor continues at the first omitted segment.",
  };
}

function capCommentPayload(
  data: Record<string, unknown>,
  inputItems: unknown[],
  maxChars: number,
): CappedComments {
  const validThreads = inputItems.flatMap((item) => {
    const thread = record(item);
    const topLevel = record(thread.topLevelComment);
    const id = typeof topLevel.id === "string" ? topLevel.id.trim() : "";
    const text = typeof topLevel.text === "string" ? topLevel.text.trim() : "";
    return id && text ? [{ thread, topLevel, text }] : [];
  });
  const omittedItems = inputItems.length - validThreads.length;
  const primaryBudget = Math.max(
    validThreads.length,
    Math.floor(maxChars * 0.65),
  );
  let primaryRemaining = primaryBudget;
  let textCharsReturned = 0;
  let truncatedTextFields = 0;

  const prepared = validThreads.map((entry, index) => {
    const share = Math.max(
      1,
      Math.floor(primaryRemaining / (validThreads.length - index)),
    );
    const capped = capText(entry.text, share);
    primaryRemaining -= capped.text.length;
    textCharsReturned += capped.text.length;
    if (capped.truncated) truncatedTextFields += 1;
    const rawReplies = Array.isArray(entry.thread.replies)
      ? entry.thread.replies
      : [];
    return {
      thread: {
        ...entry.thread,
        topLevelComment: {
          ...entry.topLevel,
          text: capped.text,
          ...(capped.truncated ? { textTruncated: true } : {}),
        },
      },
      rawReplies,
      replies: [] as Record<string, unknown>[],
    };
  });

  const totalReplies = prepared.reduce(
    (total, entry) => total + entry.rawReplies.length,
    0,
  );
  let replyRemaining = Math.max(0, maxChars - textCharsReturned);
  let repliesVisited = 0;
  let omittedReplies = 0;

  for (const entry of prepared) {
    for (const value of entry.rawReplies) {
      const reply = record(value);
      const id = typeof reply.id === "string" ? reply.id.trim() : "";
      const text = typeof reply.text === "string" ? reply.text.trim() : "";
      const repliesLeft = totalReplies - repliesVisited;
      repliesVisited += 1;
      if (!id || !text || replyRemaining <= 0) {
        omittedReplies += 1;
        continue;
      }
      const share = Math.max(1, Math.floor(replyRemaining / repliesLeft));
      const capped = capText(text, share);
      replyRemaining -= capped.text.length;
      textCharsReturned += capped.text.length;
      if (capped.truncated) truncatedTextFields += 1;
      entry.replies.push({
        ...reply,
        text: capped.text,
        ...(capped.truncated ? { textTruncated: true } : {}),
      });
    }
  }

  const items = prepared.map((entry) => {
    const repliesIncluded = record(entry.thread).repliesIncluded === true;
    return {
      ...entry.thread,
      replies: entry.replies,
      repliesReturned: entry.replies.length,
      repliesComplete: repliesIncluded
        ? record(entry.thread).repliesComplete === true &&
          entry.replies.length === entry.rawReplies.length
        : null,
    };
  });
  const truncated =
    omittedItems > 0 || omittedReplies > 0 || truncatedTextFields > 0;
  if (!truncated) return { data, items, warning: undefined };

  return {
    data: {
      ...data,
      truncation: {
        truncated: true,
        reason: "max_chars",
        max_chars: maxChars,
        original_items: inputItems.length,
        returned_items: items.length,
        omitted_items: omittedItems,
        omitted_replies: omittedReplies,
        truncated_text_fields: truncatedTextFields,
        text_chars_returned: textCharsReturned,
      },
    },
    items,
    warning:
      "Comment text or replies were shortened to the requested max_chars budget; identity and timestamp fields were preserved.",
  };
}

type ChannelSelection =
  | "profile"
  | "statistics"
  | "branding"
  | "uploads_playlist";

function selectChannel(
  channel: Record<string, unknown>,
  select: ChannelSelection[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (select.includes("profile")) {
    for (const key of [
      "id",
      "url",
      "title",
      "description",
      "customUrl",
      "publishedAt",
      "country",
      "defaultLanguage",
      "thumbnails",
      "provider",
      "resolution",
    ]) {
      if (key in channel) output[key] = channel[key];
    }
  }
  if (select.includes("statistics")) output.statistics = channel.statistics ?? {};
  if (select.includes("branding")) {
    output.brandingSettings = channel.brandingSettings ?? {};
  }
  if (select.includes("uploads_playlist")) {
    output.uploadsPlaylistId = channel.uploadsPlaylistId ?? null;
  }
  return output;
}

function freshUntil(config: AppConfig): string {
  return new Date(Date.now() + config.cacheTtlMs).toISOString();
}

function payload(
  kind: ToolPayload["kind"],
  data: unknown,
  items: unknown[],
  cursor: string | null,
  canonicalUri: string | null,
  sourceRecord: Record<string, unknown>,
  quotaCost: { data: number; search: number },
  untrustedFields: string[],
  config: AppConfig,
  maxChars?: number,
): ToolPayload {
  const capped =
    maxChars === undefined
      ? { data, items }
      : capPayloadText(data, items, maxChars);
  return {
    kind,
    data: capped.data,
    items: capped.items,
    page: {
      returned: items.length,
      has_more: Boolean(cursor),
      next_cursor: cursor,
    },
    meta: {
      canonical_uri: canonicalUri,
      source: "youtube",
      provider: provider(sourceRecord) ?? "unknown",
      fresh_until: freshUntil(config),
      quota_cost: quotaCost,
      warnings: [...stringArray(sourceRecord.warnings), ...("warning" in capped && capped.warning ? [capped.warning] : [])],
      untrusted_fields: untrustedFields,
    },
  };
}

function postPayload(result: PostResult, kind: ToolPayload["kind"], next: string | null, uri: string, maxChars: number): ToolPayload {
  const body = structuredClone({ data: result.data, items: result.items });
  const fields: { parent: Record<string, unknown>; text: string }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "text" && typeof child === "string") fields.push({ parent: record(value), text: child });
      else visit(child);
    }
  };
  visit(body);
  let remaining = maxChars;
  let shortened = false;
  fields.forEach((field, index) => {
    const capped = capText(field.text, Math.max(1, Math.floor(remaining / (fields.length - index))));
    field.parent.text = capped.text;
    remaining -= capped.text.length;
    if (capped.truncated) { field.parent.textTruncated = true; shortened = true; }
  });
  if (shortened) body.data.truncation = { truncated: true, reason: "max_chars", max_chars: maxChars, content_omitted: true };
  return {
    kind, ...body, page: { returned: body.items.length, has_more: Boolean(next), next_cursor: next },
    meta: {
      canonical_uri: uri, source: "youtube", provider: "youtubejs-posts",
      retrieved_at: result.retrievedAt, fresh_until: result.freshUntil,
      quota_cost: { data: 0, search: 0 },
      warnings: [...result.warnings, ...(shortened ? ["Post/comment text was shortened to max_chars; IDs, display labels and attachment references were preserved."] : [])],
      untrusted_fields: ["data.text", "data.author.name", "data.attachment", "data.sharedPost", "data.channelTitle", "items[].text", "items[].author.name", "items[].attachment", "items[].sharedPost"],
    },
  };
}

function templateVariable(
  variables: Record<string, string | string[]>,
  name: string,
): string {
  const value = variables[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value),
      },
    ],
  };
}

export function createYoutubeMcpServer(
  config: AppConfig = loadConfig(),
  options: CreateYoutubeMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only YouTube research. Use catalog resources for capabilities and schemas.",
    },
  );
  const service = options.service ?? new YouTubeService(config);
  const codec = new CursorCodec(config.cursorSecret, config.cursorTtlMs);
  let pager = responsePagers.get(service);
  if (!pager) {
    pager = new ResponsePager(codec, config.cursorTtlMs, config.maxResultBytes,
      config.quotaStoreMode === "firestore" ? new FirestorePageStore(config.firestoreProjectId) : undefined);
    responsePagers.set(service, pager);
  }
  const responsePager = pager;
  // Post snapshots must remain in memory even when official quota/pages use Firestore.
  const postCodec = new CursorCodec(config.cursorSecret, POST_TTL_MS);
  let postPager = postResponsePagers.get(service);
  if (!postPager) {
    postPager = new ResponsePager(postCodec, POST_TTL_MS, config.maxResultBytes);
    postResponsePagers.set(service, postPager);
  }
  const postResponsePager = postPager;

  server.registerTool(
    "youtube_video_get",
    {
      description: "Get video data. max_chars: text only. View options: youtube://schema/youtube_video_get.",
      outputSchema: outputSchemas.youtube_video_get,
      inputSchema: z.object({
        video: z.string().min(1),
        view: z.enum(["metadata", "transcript", "comments"]).default("metadata"),
        options: filtersSchema,
        cursor: cursorSchema,
        limit: limitSchema,
        max_chars: z.number().int().min(256).max(12_000).default(4_000),
        locale: z.string().default(""),
      }),
      annotations: readOnlyAnnotations,
      _meta: oauthMeta,
    },
    async ({ video, view, options, cursor, limit, max_chars: maxChars, locale }) =>
      responsePager.run("youtube_video_get", { video, view, options, maxChars, locale }, cursor, limit, async () => {
        const videoId = extractVideoId(video);
        const canonicalUri = `youtube://entity/video/${videoId}`;
        if (view === "metadata") {
          checkedFilters(options, []);
          if (cursor) {
            throw new YouTubeMcpError(
              "INVALID_ARGUMENT",
              "metadata view does not use a cursor.",
            );
          }
          const result = await service.getVideo(videoId);
          return payload(
            "entity",
            without(result, ["warnings"]),
            [],
            null,
            canonicalUri,
            result,
            { data: provider(result) === "youtube-data-api-v3" ? 1 : 0, search: 0 },
            ["data.title", "data.description", "data.tags", "data.channelTitle"],
            config,
            maxChars,
          );
        }

        if (view === "transcript") {
          const normalized = checkedFilters(options, [
            "language",
            "include_text",
            "include_timestamps",
            "include_available_languages",
          ]);
          const language =
            (stringFilter(normalized, "language") ?? locale.trim()) || undefined;
          const includeText = booleanFilter(normalized, "include_text", false);
          const includeTimestamps = booleanFilter(
            normalized,
            "include_timestamps",
            true,
          );
          const includeAvailableLanguages = booleanFilter(
            normalized,
            "include_available_languages",
            false,
          );
          const cursorFilters = {
            videoId,
            view,
            language: language ?? null,
            includeText,
            includeTimestamps,
            includeAvailableLanguages,
          };
          const pageOffset = offset(
            codec,
            cursor,
            "youtube_video_get",
            cursorFilters,
          );
          const result = await service.getTranscript(videoId, {
            language,
            offset: pageOffset,
            limit,
            includeText,
            includeTimestamps,
          });
          const resultRecord = record(result);
          const availableLanguages = Array.isArray(resultRecord.availableLanguages)
            ? resultRecord.availableLanguages
            : [];
          const transcriptData = {
            ...without(resultRecord, [
              "segments",
              "nextOffset",
              "warnings",
              "availableLanguages",
            ]),
            availableLanguageCount: availableLanguages.length,
            ...(includeAvailableLanguages && pageOffset === 0
              ? { availableLanguages }
              : {}),
          };
          const capped = capTranscriptPayload(
            transcriptData,
            result.segments,
            maxChars,
          );
          const continuationOffset =
            capped.items.length < result.segments.length
              ? pageOffset + capped.items.length
              : result.nextOffset;
          const next =
            continuationOffset === undefined
              ? null
              : nextCursor(codec, "youtube_video_get", cursorFilters, {
                  offset: continuationOffset,
                });
          const transcriptWarnings = [
            ...stringArray(resultRecord.warnings),
            ...(capped.warning ? [capped.warning] : []),
            ...(includeAvailableLanguages && pageOffset > 0
              ? ["availableLanguages is returned only on the first transcript page."]
              : []),
          ];
          const sourceRecord = {
            ...resultRecord,
            warnings: transcriptWarnings,
          };
          return payload(
            "collection",
            capped.data,
            capped.items,
            next,
            canonicalUri,
            sourceRecord,
            { data: 0, search: 0 },
            ["items[].text", "data.text"],
            config,
          );
        }

        const normalized = checkedFilters(options, [
          "order",
          "include_replies",
          "reply_limit",
        ]);
        const order = enumFilter(normalized, "order", ["relevance", "time"], "relevance");
        const includeReplies = booleanFilter(normalized, "include_replies", false);
        if (!includeReplies && normalized.reply_limit !== undefined) {
          throw new YouTubeMcpError(
            "INVALID_ARGUMENT",
            "reply_limit requires include_replies=true.",
          );
        }
        const replyLimit = includeReplies
          ? integerFilter(normalized, "reply_limit", 3, 0, 20)
          : 0;
        const cursorFilters = {
          videoId,
          view,
          order,
          includeReplies,
          replyLimit,
        };
        const result = await service.listComments(
          videoId,
          limit,
          pageToken(codec, cursor, "youtube_video_get", cursorFilters),
          order,
          includeReplies,
          replyLimit,
        );
        const items = Array.isArray(result.items) ? result.items : [];
        const next =
          typeof result.nextPageToken === "string"
            ? nextCursor(codec, "youtube_video_get", cursorFilters, {
                pageToken: result.nextPageToken,
              })
            : null;
        const commentData = without(result, [
          "items",
          "nextPageToken",
          "prevPageToken",
          "warnings",
        ]);
        const capped = capCommentPayload(commentData, items, maxChars);
        const sourceRecord = capped.warning
          ? {
              ...result,
              warnings: [
                ...stringArray(result.warnings),
                capped.warning,
              ],
            }
          : result;
        return payload(
          "collection",
          capped.data,
          capped.items,
          next,
          canonicalUri,
          sourceRecord,
          { data: 1, search: 0 },
          [
            "items[].topLevelComment.author.name",
            "items[].topLevelComment.text",
            "items[].replies[].author.name",
            "items[].replies[].text",
          ],
          config,
        );
      }),
  );

  server.registerTool(
    "youtube_search",
    {
      description: "Search videos/transcripts or list channel posts (scope=posts, within=channel). Filters: youtube://schema/youtube_search.",
      outputSchema: outputSchemas.youtube_search,
      inputSchema: z.object({
        scope: z.enum(["global", "channel", "transcript", "trending", "posts"]).default("global"),
        query: z.string().default(""),
        within: z.string().default(""),
        filters: filtersSchema,
        cursor: cursorSchema,
        limit: limitSchema,
        locale: z.string().default(""),
      }),
      annotations: readOnlyAnnotations,
      _meta: oauthMeta,
    },
    async ({ scope, query, within, filters, cursor, limit, locale }) =>
      (scope === "posts" ? postResponsePager : responsePager).run("youtube_search", { scope, query, within, filters, locale }, cursor, limit, async () => {
        if (scope === "posts") {
          checkedFilters(filters, []);
          assertNoArgument(query, "query");
          const channel = exactPostChannel(requireArgument(within, "within"));
          const binding = { scope, query, within, filters, locale };
          const result = await service.listPosts(channel, locale, pageToken(postCodec, cursor, "youtube_search", binding));
          const next = result.nextPageToken ? postCodec.encode("youtube_search", binding, { pageToken: result.nextPageToken }, Date.parse(result.freshUntil)) : null;
          return postPayload(result, "collection", next, `youtube://entity/channel/${String(result.data.channelId)}`, 12_000);
        }
        if (scope === "global") {
          const normalized = checkedFilters(filters, [
            "order",
            "channel_id",
            "published_after",
            "published_before",
            "region",
            "relevance_language",
            "safe_search",
            "video_duration",
            "include_statistics",
          ]);
          const normalizedQuery = requireArgument(query, "query");
          const includeStatistics = booleanFilter(normalized, "include_statistics", false);
          assertNoArgument(within, "within");
          const searchFilters = {
            scope,
            ...(includeStatistics ? { includeStatistics: true } : {}),
            query: normalizedQuery,
            order: enumFilter(
              normalized,
              "order",
              ["date", "rating", "relevance", "title", "videoCount", "viewCount"],
              "relevance",
            ),
            channelId: stringFilter(normalized, "channel_id"),
            publishedAfter: stringFilter(normalized, "published_after"),
            publishedBefore: stringFilter(normalized, "published_before"),
            regionCode: regionFilter(normalized, "region"),
            relevanceLanguage:
              stringFilter(normalized, "relevance_language") || locale.trim() || undefined,
            safeSearch: enumFilter(
              normalized,
              "safe_search",
              ["moderate", "none", "strict"],
              "moderate",
            ),
            videoDuration: enumFilter(
              normalized,
              "video_duration",
              ["any", "long", "medium", "short"],
              "any",
            ),
          };
          const result = await service.searchVideos(normalizedQuery, {
            maxResults: Math.min(limit, 50),
            pageToken: pageToken(codec, cursor, "youtube_search", searchFilters),
            ...searchFilters,
          });
          const rawItems = Array.isArray(result.items) ? result.items : [];
          const enriched = includeStatistics
            ? await service.enrichSearchItems(rawItems)
            : { items: rawItems, dataCost: 0, warnings: [] };
          const next =
            typeof result.nextPageToken === "string"
              ? nextCursor(codec, "youtube_search", searchFilters, {
                  pageToken: result.nextPageToken,
                })
              : null;
          return payload(
            "collection",
            { ...without(result, ["items", "nextPageToken", "prevPageToken", "warnings"]), totalResultsReliable: false },
            enriched.items,
            next,
            null,
            { ...result, warnings: [...stringArray(result.warnings), ...enriched.warnings] },
            { data: enriched.dataCost, search: 1 },
            ["items[].title", "items[].description", "items[].channelTitle"],
            config,
          );
        }

        if (scope === "channel") {
          const normalized = checkedFilters(filters, ["strategy", "include_statistics"]);
          const includeStatistics = booleanFilter(normalized, "include_statistics", false);
          const channel = requireArgument(within, "within");
          const normalizedQuery = query.trim();
          const requestedStrategy = enumFilter(
            normalized,
            "strategy",
            ["auto", "search", "uploads"],
            "auto",
          );
          const strategy =
            requestedStrategy === "auto"
              ? normalizedQuery
                ? "search"
                : "uploads"
              : requestedStrategy;
          if (strategy === "search" && !normalizedQuery) {
            throw new YouTubeMcpError(
              "INVALID_ARGUMENT",
              "channel strategy=search requires query.",
            );
          }
          const searchFilters = {
            scope,
            channel,
            ...(includeStatistics ? { includeStatistics: true } : {}),
            query: normalizedQuery,
            strategy,
          };
          const upstreamCursor = pageToken(
            codec,
            cursor,
            "youtube_search",
            searchFilters,
          );
          const result =
            strategy === "search"
              ? await service.searchChannelVideos(
                  channel,
                  normalizedQuery,
                  Math.min(limit, 50),
                  upstreamCursor,
                )
              : await service.listChannelVideos(
                  channel,
                  Math.min(limit, 50),
                  upstreamCursor,
                );
          const rawItems = Array.isArray(result.items) ? result.items : [];
          const needle = normalizedQuery.toLocaleLowerCase();
          const items = strategy === "uploads" && needle
            ? rawItems.filter((item) => {
                const value = record(item);
                return `${String(value.title ?? "")} ${String(value.description ?? "")}`
                  .toLocaleLowerCase()
                  .includes(needle);
              })
            : rawItems;
          const enriched = includeStatistics
            ? await service.enrichSearchItems(items)
            : { items, dataCost: 0, warnings: [] };
          const next =
            typeof result.nextPageToken === "string"
              ? nextCursor(codec, "youtube_search", searchFilters, {
                  pageToken: result.nextPageToken,
                })
              : null;
          const channelRecord = record(result.channel);
          const channelId =
            typeof channelRecord.id === "string" ? channelRecord.id : channel;
          return payload(
            "collection",
            {
              ...without(result, ["items", "nextPageToken", "prevPageToken", "warnings", "channel"]),
              channel: { id: channelId, title: channelRecord.title ?? null },
              ...(strategy === "search" ? { totalResultsReliable: false } : {}),
            },
            enriched.items,
            next,
            `youtube://entity/channel/${channelId}`,
            { ...result, warnings: [...stringArray(result.warnings), ...enriched.warnings] },
            strategy === "search"
              ? { data: 1 + enriched.dataCost, search: 1 }
              : { data: 2 + enriched.dataCost, search: 0 },
            ["data.channel.title", "items[].title", "items[].description", "items[].channelTitle"],
            config,
          );
        }

        if (scope === "transcript") {
          const normalized = checkedFilters(filters, [
            "language",
            "match_mode",
            "case_sensitive",
            "context_segments",
            "from",
            "to",
          ]);
          const videoId = extractVideoId(requireArgument(within, "within"));
          const normalizedQuery = requireArgument(query, "query");
          const transcriptFilters = {
            scope,
            videoId,
            query: normalizedQuery,
            language: stringFilter(normalized, "language") || locale.trim() || undefined,
            matchMode: enumFilter(
              normalized,
              "match_mode",
              ["substring", "word"],
              "substring",
            ),
            caseSensitive: booleanFilter(normalized, "case_sensitive", false),
            contextSegments: integerFilter(
              normalized,
              "context_segments",
              1,
              0,
              10,
            ),
            from: timeFilter(normalized, "from"),
            to: timeFilter(normalized, "to"),
          };
          const result = await service.searchTranscript(videoId, normalizedQuery, {
            ...transcriptFilters,
            offset: offset(codec, cursor, "youtube_search", transcriptFilters),
            limit,
          });
          const items = Array.isArray(result.matches) ? result.matches : [];
          const next =
            typeof result.nextOffset === "number"
              ? nextCursor(codec, "youtube_search", transcriptFilters, {
                  offset: result.nextOffset,
                })
              : null;
          return payload(
            "collection",
            without(result, ["matches", "nextOffset", "warnings"]),
            items,
            next,
            `youtube://entity/video/${videoId}`,
            result,
            { data: 0, search: 0 },
            ["items[].text", "items[].context[].text"],
            config,
          );
        }

        assertNoArgument(query, "query");
        assertNoArgument(within, "within");
        const normalized = checkedFilters(filters, ["region", "category_id"]);
        const trendingFilters = {
          scope,
          regionCode:
            regionFilter(normalized, "region") ??
            regionFromLocale(locale) ??
            config.defaultRegion,
          categoryId: stringFilter(normalized, "category_id"),
        };
        const result = await service.trending(
          trendingFilters.regionCode,
          trendingFilters.categoryId,
          Math.min(limit, 50),
          pageToken(codec, cursor, "youtube_search", trendingFilters),
        );
        const items = Array.isArray(result.items) ? result.items : [];
        const next =
          typeof result.nextPageToken === "string"
            ? nextCursor(codec, "youtube_search", trendingFilters, {
                pageToken: result.nextPageToken,
              })
            : null;
        return payload(
          "collection",
          without(result, ["items", "nextPageToken", "prevPageToken", "warnings"]),
          items,
          next,
          null,
          result,
          { data: 1, search: 0 },
          ["items[].title", "items[].description", "items[].tags", "items[].channelTitle"],
          config,
        );
      }),
  );

  server.registerTool(
    "youtube_channel_get",
    {
      description: "Resolve and get one YouTube channel profile.",
      outputSchema: outputSchemas.youtube_channel_get,
      inputSchema: z.object({
        channel: z.string().min(1),
        select: z
          .array(z.enum(["profile", "statistics", "branding", "uploads_playlist"]))
          .min(1)
          .default(["profile", "statistics", "branding", "uploads_playlist"]),
      }),
      annotations: readOnlyAnnotations,
      _meta: oauthMeta,
    },
    async ({ channel, select }) =>
      runTool("youtube_channel_get", async () => {
        const result = await service.getChannel(channel);
        const channelId = typeof result.id === "string" ? result.id : channel;
        return payload(
          "entity",
          selectChannel(without(result, ["warnings"]), select),
          [],
          null,
          `youtube://entity/channel/${channelId}`,
          result,
          { data: 1, search: 0 },
          ["data.title", "data.description", "data.brandingSettings"],
          config,
        );
      }, config.maxResultBytes),
  );

  server.registerTool(
    "youtube_playlist_get",
    {
      description: "Get playlist metadata or one signed page of playlist items.",
      outputSchema: outputSchemas.youtube_playlist_get,
      inputSchema: z.object({
        playlist: z.string().min(1),
        include_items: z.boolean().default(true),
        cursor: cursorSchema,
        limit: limitSchema,
      }),
      annotations: readOnlyAnnotations,
      _meta: oauthMeta,
    },
    async ({ playlist, include_items: includeItems, cursor, limit }) =>
      responsePager.run("youtube_playlist_get", { playlist, includeItems }, cursor, limit, async () => {
        const playlistId = extractPlaylistId(playlist);
        const cursorFilters = { playlistId, includeItems };
        if (!includeItems && cursor) {
          throw new YouTubeMcpError(
            "INVALID_ARGUMENT",
            "include_items=false does not use a cursor.",
          );
        }
        const result = await service.getPlaylist(
          playlistId,
          Math.min(limit, 50),
          includeItems
            ? pageToken(codec, cursor, "youtube_playlist_get", cursorFilters)
            : undefined,
          includeItems,
        );
        const page = record(result.page);
        const items = Array.isArray(page.items) ? page.items : [];
        const next =
          typeof page.nextPageToken === "string"
            ? nextCursor(codec, "youtube_playlist_get", cursorFilters, {
                pageToken: page.nextPageToken,
              })
            : null;
        return payload(
          includeItems ? "collection" : "entity",
          includeItems
            ? {
                playlist: result.playlist ?? null,
                page: without(page, ["items", "nextPageToken", "prevPageToken"]),
              }
            : result.playlist ?? null,
          items,
          next,
          `youtube://entity/playlist/${playlistId}`,
          record(result.playlist),
          { data: includeItems ? 2 : 1, search: 0 },
          includeItems
            ? ["data.playlist.title", "data.playlist.description", "data.playlist.channelTitle", "items[].title", "items[].description", "items[].channelTitle"]
            : ["data.title", "data.description", "data.channelTitle"],
          config,
        );
      }),
  );

  server.registerTool(
    "youtube_post_get",
    {
      description: "Read a public community post or its top-level comments. Unofficial, no API key. Options: youtube://schema/youtube_post_get.",
      outputSchema: outputSchemas.youtube_post_get,
      inputSchema: z.object({
        post: z.string().min(1), view: z.enum(["content", "comments"]).default("content"),
        options: filtersSchema, cursor: cursorSchema, limit: limitSchema,
        max_chars: z.number().int().min(256).max(12_000).default(4_000), locale: z.string().default(""),
      }),
      annotations: readOnlyAnnotations, _meta: oauthMeta,
    },
    async ({ post, view, options, cursor, limit, max_chars: maxChars, locale }) =>
      postResponsePager.run("youtube_post_get", { post, view, options, maxChars, locale }, cursor, limit, async () => {
        const id = extractPostId(post);
        const binding = { post, view, options, maxChars, locale };
        if (view === "content") {
          checkedFilters(options, []);
          if (cursor) throw new YouTubeMcpError("INVALID_ARGUMENT", "content view does not use a cursor.");
          return postPayload(await service.getPost(id, locale), "entity", null, `youtube://entity/post/${id}`, maxChars);
        }
        checkedFilters(options, ["order"]);
        const order = enumFilter(options, "order", ["top", "newest"], "top");
        const result = await service.listPostComments(id, order, locale, pageToken(postCodec, cursor, "youtube_post_get", binding));
        const next = result.nextPageToken ? postCodec.encode("youtube_post_get", binding, { pageToken: result.nextPageToken }, Date.parse(result.freshUntil)) : null;
        return postPayload(result, "collection", next, `youtube://entity/post/${id}`, maxChars);
      }),
  );

  server.registerResource(
    "catalog",
    new ResourceTemplate("youtube://catalog", { list: undefined }),
    {
      description: "Capabilities, limits, provider state, and quota status.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, await service.catalog(options.runtime)),
  );

  server.registerResource(
    "schema",
    new ResourceTemplate("youtube://schema/{operation}", { list: undefined }),
    {
      description: "Compact input or error schema by operation name.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const operation = templateVariable(variables, "operation");
      const schema = TOOL_SCHEMAS[operation];
      if (!schema) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri, {
        schema_version: "1",
        operation,
        schema,
      });
    },
  );

  server.registerResource(
    "entity",
    new ResourceTemplate("youtube://entity/{kind}/{id}", { list: undefined }),
    {
      description: "Canonical video, channel, playlist, or post metadata.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const kind = templateVariable(variables, "kind");
      const id = templateVariable(variables, "id");
      let entity: Record<string, unknown>;
      if (kind === "video") entity = await service.getVideo(id);
      else if (kind === "post") {
        const result = postPayload(await service.getPost(id), "entity", null, uri.href, 4_000);
        return jsonResource(uri, successResult(result, config.maxResultBytes).structuredContent);
      }
      else if (kind === "channel") entity = await service.getChannel(id);
      else if (kind === "playlist") {
        const result = await service.getPlaylist(id, 1, undefined, false);
        entity = record(result.playlist);
      } else {
        throw new ResourceNotFoundError(uri.href);
      }
      return jsonResource(uri, entity);
    },
  );

  return server;
}
