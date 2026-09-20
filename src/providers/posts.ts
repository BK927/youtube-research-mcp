import { randomUUID } from "node:crypto";
import { Innertube, Mixins, Helpers } from "youtubei.js";
import { TtlCache } from "../cache/ttl-cache.js";
import { YouTubeMcpError } from "../errors.js";
import { exactPostChannel, extractPostId, postUrl } from "../utils/ids.js";

export const POST_TTL_MS = 300_000;
export const POST_CACHE_ENTRIES = 128;
export const POST_PAGE_ENTRIES = 64;
const MAX_PAGE_BYTES = 512 * 1024;
const NOTICE = "Public posts use unofficial YouTube InnerTube requests, not Data API quota. Availability can change; displayed dates/counts may be approximate.";
type Row = Record<string, unknown>;
type Client = Awaited<ReturnType<typeof Innertube.create>>;
type Feed = Pick<Mixins.Feed, "page" | "posts" | "has_continuation" | "getContinuation">;
type Comments = Awaited<ReturnType<Client["getPostComments"]>>;
export interface PostResult {
  data: Row; items: Row[]; nextPageToken: string | null;
  retrievedAt: string; freshUntil: string; warnings: string[];
}
export interface PostProvider {
  getPost(reference: string, locale?: string): Promise<PostResult>;
  listPosts(channel: string, locale?: string, token?: string): Promise<PostResult>;
  listComments(post: string, order: "top" | "newest", locale?: string, token?: string): Promise<PostResult>;
}
interface PageState {
  key: string; expiresAt: number; load: () => Promise<PostResult>;
  pending?: Promise<PostResult>; result?: PostResult;
}
function row(value: unknown): Row { return value && typeof value === "object" ? value as Row : {}; }
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value.toString !== Object.prototype.toString) return String(value);
  return null;
}
function author(value: unknown): Row {
  const item = row(value);
  const id = typeof item.id === "string" && /^UC[A-Za-z0-9_-]{22}$/.test(item.id) ? item.id : null;
  return { channelId: id, name: text(item.name), url: id ? `https://www.youtube.com/channel/${id}` : null };
}
function image(value: unknown): Row | null {
  if (!Array.isArray(value)) return null;
  const images = value.map(row).filter(item => typeof item.url === "string" && /^https:\/\//.test(item.url));
  images.sort((a, b) => Number(b.width ?? 0) - Number(a.width ?? 0));
  const best = images[0];
  return best ? { url: best.url, width: best.width ?? null, height: best.height ?? null } : null;
}
function attachment(value: unknown): Row | null {
  if (!value) return null;
  const item = row(value);
  switch (item.type) {
    case "BackstageImage": return { type: "image", images: [image(item.image)].filter(Boolean) };
    case "PostMultiImage": return { type: "images", images: (Array.isArray(item.images) ? item.images : []).map(img => image(row(img).image)).filter(Boolean) };
    case "Video": case "CompactVideo": return {
      type: "video", id: item.id ?? null, title: text(item.title),
      url: typeof item.id === "string" ? `https://www.youtube.com/watch?v=${item.id}` : null,
    };
    case "Poll": return {
      type: "poll", totalVotesLabel: text(item.total_votes), resultsAvailability: "not_supplied",
      // Conditional percentages describe a hypothetical vote, not observed results.
      choices: (Array.isArray(item.choices) ? item.choices : []).map(choice => ({ text: text(row(choice).text), image: image(row(choice).image) })),
    };
    default: return { type: "unsupported", providerType: text(item.type), availability: "unsupported" };
  }
}
export function normalizePost(value: unknown): Row {
  const item = row(value);
  const id = text(item.id);
  if (!id) throw new YouTubeMcpError("UPSTREAM_ERROR", "The post renderer has no ID.");
  const shared = row(item.original_post);
  return {
    id, url: postUrl(id), author: author(item.author), text: text(item.content),
    publishedLabel: text(item.published), likeCountLabel: text(item.vote_count), attachment: attachment(item.attachment),
    ...(item.type === "SharedPost" ? { sharedPost: {
      id: text(shared.id), url: typeof shared.id === "string" ? postUrl(shared.id) : null, author: author(shared.author),
    } } : {}),
  };
}
export function orderedPosts(page: unknown): unknown[] {
  const found: unknown[] = [];
  const visited = new Set<object>();
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (value instanceof Helpers.SuperParsedResult) { visit(value.is_array ? value.array() : value.item()); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const item = row(value);
    if (["BackstagePost", "Post", "SharedPost"].includes(String(item.type))) {
      if (typeof item.id === "string" && !ids.has(item.id)) { ids.add(item.id); found.push(value); }
      return; // Embedded originals are not additional feed entries.
    }
    for (const [key, child] of Object.entries(item)) {
      if (!key.endsWith("_memo") && !["metadata", "header", "sidebar", "secondary_results", "endpoint", "menu", "actions"].includes(key)) visit(child);
    }
  };
  const root = row(page);
  for (const key of ["contents", "on_response_received_actions", "on_response_received_commands", "on_response_received_endpoints", "continuation_contents"]) visit(root[key]);
  return found;
}
function normalizeComment(value: unknown): Row {
  const comment = row(row(value).comment);
  if (typeof comment.comment_id !== "string") throw new YouTubeMcpError("UPSTREAM_ERROR", "An unsupported comment renderer was returned.");
  return {
    id: comment.comment_id, text: text(comment.content), author: author(comment.author),
    publishedLabel: text(comment.published_time), likeCountLabel: text(comment.like_count),
    replyCountLabel: text(comment.reply_count), repliesIncluded: false, isPinned: comment.is_pinned === true,
  };
}
function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value, (key, item: unknown) => key.endsWith("_memo") ? undefined : item instanceof Helpers.SuperParsedResult ? (item.is_array ? item.array() : item.item()) : item), "utf8") > MAX_PAGE_BYTES)
    throw new YouTubeMcpError("UPSTREAM_ERROR", "The post page exceeds the 512 KiB memory-page limit.", { reason: "post_page_size" }, false);
}
export class YouTubeJsPostProvider implements PostProvider {
  private readonly cache = new TtlCache<PostResult>(POST_TTL_MS, POST_CACHE_ENTRIES);
  private readonly pages = new TtlCache<PageState>(POST_TTL_MS, POST_PAGE_ENTRIES);
  private readonly clients = new TtlCache<Client>(POST_TTL_MS, 8);
  constructor(
    private readonly language: string,
    private readonly region: string,
    private readonly timeoutMs: number,
    private readonly createClient: (locale: string) => Promise<Client> = async (locale) => Innertube.create({
      lang: locale, location: region, retrieve_player: false, generate_session_locally: true,
      fetch: async (input, init) => {
        const upstreamSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(upstreamSignal ? [upstreamSignal] : [])]);
        const response = await fetch(input, { ...init, signal });
        if (response.status === 429) throw new YouTubeMcpError("RATE_LIMITED", "YouTube temporarily limited public post requests.");
        return response;
      },
    }),
  ) {}
  private locale(value?: string): string { return value?.trim().toLowerCase() || this.language; }
  private client(locale: string): Promise<Client> { return this.clients.getOrLoad(locale, () => this.createClient(locale)); }
  private async cached(key: string, loader: () => Promise<PostResult>): Promise<PostResult> {
    const previous = this.cache.get(key);
    // A restarted query must not keep returning a token evicted before its data.
    if (previous?.nextPageToken && !this.pages.get(previous.nextPageToken)) this.cache.delete(key);
    return structuredClone(await this.cache.getOrLoad(key, () => this.guarded(loader)));
  }
  private async guarded<T>(load: () => Promise<T>): Promise<T> {
    try { return await load(); }
    catch (error) {
      if (error instanceof YouTubeMcpError) throw error;
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
        throw new YouTubeMcpError("TIMEOUT", "The public post request timed out.");
      throw new YouTubeMcpError("UPSTREAM_ERROR", "YouTube's public post response could not be read; it may be unavailable or its format may have changed.");
    }
  }
  private result(data: Row, items: Row[], next: (() => Promise<PostResult>) | null, key: string): PostResult {
    bounded({ data, items });
    const now = Date.now();
    const expiresAt = now + POST_TTL_MS;
    let nextPageToken: string | null = null;
    if (next) {
      nextPageToken = randomUUID();
      this.pages.set(nextPageToken, { key, expiresAt, load: next });
    }
    const warnings = [NOTICE];
    if ([data, ...items].some(item => row(item.attachment).type === "unsupported")) warnings.push("An attachment type was unsupported; post text was retained.");
    return { data, items, nextPageToken, retrievedAt: new Date(now).toISOString(), freshUntil: new Date(expiresAt).toISOString(), warnings };
  }
  private async continuation(token: string, key: string): Promise<PostResult> {
    const state = this.pages.get(token);
    if (!state || state.key !== key || state.expiresAt <= Date.now())
      throw new YouTubeMcpError("CURSOR_MISMATCH", "The post page expired or is unavailable on this process. Restart without a cursor.");
    if (state.result) return structuredClone(state.result);
    state.pending ??= this.guarded(state.load).then(result => {
      state.result = result;
      state.load = async () => result;
      return result;
    }).finally(() => { delete state.pending; });
    return structuredClone(await state.pending);
  }
  private feedResult(feed: Feed, key: string, data: Row): PostResult {
    bounded(feed.page);
    const raw = orderedPosts(feed.page);
    if (raw.length === 0 && feed.posts.length > 0)
      throw new YouTubeMcpError("UPSTREAM_ERROR", "The post page order could not be determined from the provider response.");
    return this.result(data, raw.map(normalizePost), feed.has_continuation
      ? async () => this.feedResult(await feed.getContinuation(), key, data) : null, key);
  }
  private commentResult(page: Comments, key: string, data: Row): PostResult {
    bounded(page.page);
    const endpoints = page.page.on_response_received_endpoints;
    if (page.contents.length === 0 && (!endpoints || endpoints.length < 2))
      throw new YouTubeMcpError("UPSTREAM_ERROR", "The comments response is missing its body; it cannot be interpreted as an empty comments page.");
    return this.result(data, page.contents.map(normalizeComment), page.has_continuation
      ? async () => this.commentResult(await page.getContinuation(), key, data) : null, key);
  }
  async getPost(reference: string, locale?: string): Promise<PostResult> {
    const id = extractPostId(reference);
    const language = this.locale(locale);
    const key = `post:${id}:${language}`;
    return this.cached(key, async () => {
      const client = await this.client(language);
      const endpoint = await client.resolveURL(postUrl(id));
      if (endpoint.name !== "browseEndpoint") throw new YouTubeMcpError("NOT_FOUND", "The link did not resolve to a publicly readable post.");
      const page = await endpoint.call(client.actions, { parse: true });
      const feed = new Mixins.Feed(client.actions, page, true);
      const post = [...feed.posts].find(item => item.id === id);
      if (!post) throw new YouTubeMcpError("NOT_FOUND", "The requested post is not publicly readable.");
      return this.result(normalizePost(post), [], null, key);
    });
  }
  async listPosts(channel: string, locale?: string, token?: string): Promise<PostResult> {
    const url = exactPostChannel(channel);
    const language = this.locale(locale);
    const key = `posts:${url}:${language}`;
    if (token) return this.continuation(token, key);
    return this.cached(key, async () => {
      const client = await this.client(language);
      const endpoint = await client.resolveURL(url);
      const id: unknown = endpoint.payload.browseId;
      if (typeof id !== "string" || !/^UC[A-Za-z0-9_-]{22}$/.test(id))
        throw new YouTubeMcpError("NOT_FOUND", "The channel reference did not resolve to an exact public channel.");
      const info = await client.getChannel(id);
      const data = { channelId: id, channelTitle: info.metadata.title ?? null, order: "youtube", availability: info.has_community ? "available" : "no_posts_tab" };
      if (!info.has_community) return this.result(data, [], null, key);
      return this.feedResult(await info.getCommunity(), key, data);
    });
  }
  async listComments(post: string, order: "top" | "newest", locale?: string, token?: string): Promise<PostResult> {
    const id = extractPostId(post);
    const language = this.locale(locale);
    const key = `comments:${id}:${order}:${language}`;
    if (token) return this.continuation(token, key);
    return this.cached(key, async () => {
      const content = await this.getPost(id, language);
      const channelId = row(content.data.author).channelId;
      if (typeof channelId !== "string") throw new YouTubeMcpError("PROVIDER_UNAVAILABLE", "The post's channel could not be identified; comments are unavailable.");
      const client = await this.client(language);
      let comments: Comments;
      try { comments = await client.getPostComments(id, channelId, order === "top" ? "TOP_COMMENTS" : "NEWEST_FIRST"); }
      catch (error) {
        if (error instanceof Error && error.message.includes("comments page did not have any content"))
          throw new YouTubeMcpError("PROVIDER_UNAVAILABLE", "The post does not expose a readable comments page.", { reason: "comments_unavailable" });
        throw error;
      }
      return this.commentResult(comments, key, { postId: id, url: postUrl(id), order, repliesIncluded: false });
    });
  }
}
