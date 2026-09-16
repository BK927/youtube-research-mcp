import { YouTubeMcpError, errorMessage } from "../errors.js";
import type { QuotaBucket, QuotaStore } from "../quota/quota-store.js";
import type { ChannelReference } from "../utils/ids.js";
import {
  channelUrl,
  playlistUrl,
  videoUrl,
} from "../utils/ids.js";
import { parseIso8601Duration } from "../utils/time.js";
import { decodeSearchText } from "../utils/text.js";

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
  prevPageToken?: string;
  pageInfo?: {
    totalResults?: number;
    resultsPerPage?: number;
  };
}

interface Thumbnail {
  url?: string;
  width?: number;
  height?: number;
}

type Thumbnails = Record<string, Thumbnail>;

interface VideoItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    tags?: string[];
    categoryId?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
    liveBroadcastContent?: string;
    thumbnails?: Thumbnails;
  };
  contentDetails?: {
    duration?: string;
    dimension?: string;
    definition?: string;
    caption?: string;
    licensedContent?: boolean;
    projection?: string;
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    favoriteCount?: string;
    commentCount?: string;
  };
  status?: {
    uploadStatus?: string;
    privacyStatus?: string;
    license?: string;
    embeddable?: boolean;
    publicStatsViewable?: boolean;
    madeForKids?: boolean;
  };
  liveStreamingDetails?: Record<string, unknown>;
}

interface ChannelItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    customUrl?: string;
    publishedAt?: string;
    country?: string;
    defaultLanguage?: string;
    thumbnails?: Thumbnails;
  };
  statistics?: {
    viewCount?: string;
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
    videoCount?: string;
  };
  contentDetails?: {
    relatedPlaylists?: {
      uploads?: string;
      likes?: string;
    };
  };
  brandingSettings?: Record<string, unknown>;
}

interface SearchItem {
  id?: {
    kind?: string;
    videoId?: string;
    channelId?: string;
    playlistId?: string;
  };
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    liveBroadcastContent?: string;
    thumbnails?: Thumbnails;
  };
}

interface PlaylistItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    position?: number;
    resourceId?: { videoId?: string };
    thumbnails?: Thumbnails;
  };
  contentDetails?: {
    videoId?: string;
    videoPublishedAt?: string;
  };
  status?: { privacyStatus?: string };
}

interface PlaylistResource {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    defaultLanguage?: string;
    thumbnails?: Thumbnails;
  };
  contentDetails?: { itemCount?: number };
  status?: { privacyStatus?: string };
}

interface CommentSnippet {
  authorDisplayName?: string;
  authorProfileImageUrl?: string;
  authorChannelUrl?: string;
  authorChannelId?: { value?: string };
  textOriginal?: string;
  likeCount?: number;
  publishedAt?: string;
  updatedAt?: string;
  videoId?: string;
  parentId?: string;
}

interface CommentResource {
  id?: string;
  snippet?: CommentSnippet;
}

interface CommentThread {
  id?: string;
  snippet?: {
    videoId?: string;
    canReply?: boolean;
    totalReplyCount?: number;
    isPublic?: boolean;
    topLevelComment?: CommentResource;
  };
  replies?: { comments?: CommentResource[] };
}

export interface SearchVideosOptions {
  maxResults: number;
  pageToken: string | undefined;
  order: "date" | "rating" | "relevance" | "title" | "videoCount" | "viewCount";
  channelId: string | undefined;
  publishedAfter: string | undefined;
  publishedBefore: string | undefined;
  regionCode: string | undefined;
  relevanceLanguage: string | undefined;
  safeSearch: "moderate" | "none" | "strict";
  videoDuration: "any" | "long" | "medium" | "short";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeComment(comment: CommentResource | undefined): Record<string, unknown> | null {
  if (!comment?.id || !comment.snippet) return null;
  const snippet = comment.snippet;
  return {
    id: comment.id,
    author: {
      name: snippet.authorDisplayName ?? null,
      channelId: snippet.authorChannelId?.value ?? null,
      channelUrl: snippet.authorChannelUrl ?? null,
      profileImageUrl: snippet.authorProfileImageUrl ?? null,
    },
    text: snippet.textOriginal ?? "",
    likeCount: snippet.likeCount ?? 0,
    publishedAt: snippet.publishedAt ?? null,
    updatedAt: snippet.updatedAt ?? null,
    videoId: snippet.videoId ?? null,
    parentId: snippet.parentId ?? null,
  };
}

function normalizeVideo(item: VideoItem): Record<string, unknown> {
  const id = item.id ?? "";
  const duration = item.contentDetails?.duration;
  return {
    id,
    url: id ? videoUrl(id) : null,
    title: item.snippet?.title ?? null,
    description: item.snippet?.description ?? null,
    channelId: item.snippet?.channelId ?? null,
    channelTitle: item.snippet?.channelTitle ?? null,
    publishedAt: item.snippet?.publishedAt ?? null,
    thumbnails: item.snippet?.thumbnails ?? {},
    tags: item.snippet?.tags ?? [],
    categoryId: item.snippet?.categoryId ?? null,
    defaultLanguage: item.snippet?.defaultLanguage ?? null,
    defaultAudioLanguage: item.snippet?.defaultAudioLanguage ?? null,
    liveBroadcastContent: item.snippet?.liveBroadcastContent ?? null,
    duration: duration ?? null,
    durationSeconds: parseIso8601Duration(duration) ?? null,
    definition: item.contentDetails?.definition ?? null,
    dimension: item.contentDetails?.dimension ?? null,
    // Compatibility alias for the Data API flag, not a transcript probe.
    captionAvailable: item.contentDetails?.caption === "true",
    captionAvailability: {
      source: "youtube-data-api-v3.contentDetails.caption",
      reportedAvailable: item.contentDetails?.caption === "true" ? true
        : item.contentDetails?.caption === "false" ? false : null,
      transcriptRetrievability: "unknown",
      notice: "The Data API caption flag does not determine whether this MCP's separate transcript providers can retrieve captions, including automatic captions. Use view=transcript to check.",
    },
    licensedContent: item.contentDetails?.licensedContent ?? null,
    projection: item.contentDetails?.projection ?? null,
    statistics: item.statistics ?? {},
    status: item.status ?? {},
    liveStreamingDetails: item.liveStreamingDetails ?? null,
    provider: "youtube-data-api-v3",
    completeness: "official",
  };
}

function normalizeChannel(item: ChannelItem): Record<string, unknown> {
  const id = item.id ?? "";
  return {
    id,
    url: id ? channelUrl(id) : null,
    title: item.snippet?.title ?? null,
    description: item.snippet?.description ?? null,
    customUrl: item.snippet?.customUrl ?? null,
    publishedAt: item.snippet?.publishedAt ?? null,
    country: item.snippet?.country ?? null,
    defaultLanguage: item.snippet?.defaultLanguage ?? null,
    thumbnails: item.snippet?.thumbnails ?? {},
    statistics: item.statistics ?? {},
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    brandingSettings: item.brandingSettings ?? {},
    provider: "youtube-data-api-v3",
  };
}

export class YouTubeDataApiClient {
  private readonly baseUrl = "https://www.googleapis.com/youtube/v3";

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly quota: QuotaStore,
  ) {}

  private async request<T>(
    resource: string,
    params: Record<string, string | number | boolean | undefined>,
    bucket: QuotaBucket = "data",
    onRequest?: () => void,
  ): Promise<T> {
    const endpoint = new URL(`${this.baseUrl}/${resource}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        endpoint.searchParams.set(key, String(value));
      }
    }
    endpoint.searchParams.set("key", this.apiKey);

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.quota.consume(bucket, 1, resource);
      onRequest?.();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(endpoint, { signal: controller.signal });
        const payload = (await response.json().catch(() => null)) as
          | Record<string, unknown>
          | null;

        if (response.ok) return payload as T;

        const retriable = response.status === 429 || response.status >= 500;
        const message =
          typeof payload?.error === "object" && payload.error !== null
            ? JSON.stringify(payload.error)
            : `HTTP ${response.status}`;
        lastError = new YouTubeMcpError(
          "YOUTUBE_API_ERROR",
          `YouTube Data API request failed: ${message}`,
          { resource, status: response.status },
        );
        if (!retriable || attempt === 2) throw lastError;
      } catch (error) {
        lastError = error;
        if (error instanceof YouTubeMcpError || attempt === 2) throw error;
      } finally {
        clearTimeout(timer);
      }
      await sleep(250 * 2 ** attempt);
    }

    throw new YouTubeMcpError(
      "YOUTUBE_API_ERROR",
      `YouTube Data API request failed: ${errorMessage(lastError)}`,
    );
  }

  async getVideo(videoId: string): Promise<Record<string, unknown>> {
    const response = await this.request<ListResponse<VideoItem>>("videos", {
      part: "snippet,contentDetails,statistics,status,liveStreamingDetails",
      id: videoId,
    });
    const item = response.items?.[0];
    if (!item) {
      throw new YouTubeMcpError(
        "VIDEO_NOT_FOUND",
        "The YouTube Data API returned no accessible video for this ID.",
        { videoId },
      );
    }
    return normalizeVideo(item);
  }

  async getVideos(
    videoIds: string[],
    onRequest?: () => void,
  ): Promise<Record<string, unknown>[]> {
    const ids = [...new Set(videoIds)];
    if (ids.length === 0) return [];
    if (ids.length > 50) {
      throw new YouTubeMcpError("INVALID_ARGUMENT", "A video metadata batch supports at most 50 IDs.");
    }
    const response = await this.request<ListResponse<VideoItem>>("videos", {
      part: "snippet,contentDetails,statistics,status,liveStreamingDetails",
      id: ids.join(","),
    }, "data", onRequest);
    return (response.items ?? []).map(normalizeVideo);
  }

  async searchVideos(
    query: string,
    options: SearchVideosOptions,
  ): Promise<Record<string, unknown>> {
    const response = await this.request<ListResponse<SearchItem>>(
      "search",
      {
        part: "snippet",
        q: query,
        type: "video",
        maxResults: options.maxResults,
        pageToken: options.pageToken,
        order: options.order,
        channelId: options.channelId,
        publishedAfter: options.publishedAfter,
        publishedBefore: options.publishedBefore,
        regionCode: options.regionCode,
        relevanceLanguage: options.relevanceLanguage,
        safeSearch: options.safeSearch,
        videoDuration: options.videoDuration,
      },
      "search",
    );

    return {
      query,
      items: (response.items ?? []).flatMap((item) => {
        const id = item.id?.videoId;
        if (!id) return [];
        return [
          {
            id,
            url: videoUrl(id),
            title: decodeSearchText(item.snippet?.title),
            description: decodeSearchText(item.snippet?.description),
            channelId: item.snippet?.channelId ?? null,
            channelTitle: decodeSearchText(item.snippet?.channelTitle),
            publishedAt: item.snippet?.publishedAt ?? null,
            liveBroadcastContent:
              item.snippet?.liveBroadcastContent ?? null,
            thumbnails: item.snippet?.thumbnails ?? {},
          },
        ];
      }),
      nextPageToken: response.nextPageToken ?? null,
      prevPageToken: response.prevPageToken ?? null,
      pageInfo: response.pageInfo ? { ...response.pageInfo, totalResultsReliable: false } : null,
      provider: "youtube-data-api-v3",
    };
  }

  private async resolveChannelId(
    reference: ChannelReference,
  ): Promise<{ channelId: string; resolvedBy: string }> {
    if (reference.kind === "id") {
      return { channelId: reference.value, resolvedBy: "channel-id" };
    }

    if (reference.kind === "handle" || reference.kind === "username") {
      const response = await this.request<ListResponse<ChannelItem>>("channels", {
        part: "id",
        forHandle: reference.kind === "handle" ? reference.value : undefined,
        forUsername:
          reference.kind === "username" ? reference.value : undefined,
        maxResults: 1,
      });
      const channelId = response.items?.[0]?.id;
      if (channelId) {
        return {
          channelId,
          resolvedBy: reference.kind,
        };
      }
      throw new YouTubeMcpError(
        "CHANNEL_NOT_FOUND",
        "No channel matches this exact handle or username.",
        { reference },
      );
    }

    const response = await this.request<ListResponse<SearchItem>>(
      "search",
      {
        part: "snippet",
        q: reference.value,
        type: "channel",
        maxResults: 5,
      },
      "search",
    );
    const channelId = response.items?.[0]?.id?.channelId;
    if (!channelId) {
      throw new YouTubeMcpError(
        "CHANNEL_NOT_FOUND",
        "Could not resolve the channel reference.",
        { reference },
      );
    }
    return { channelId, resolvedBy: "search-first-result" };
  }

  async getChannel(
    reference: ChannelReference,
  ): Promise<Record<string, unknown>> {
    const resolution = await this.resolveChannelId(reference);
    const response = await this.request<ListResponse<ChannelItem>>("channels", {
      part: "snippet,statistics,contentDetails,brandingSettings",
      id: resolution.channelId,
      maxResults: 1,
    });
    const item = response.items?.[0];
    if (!item) {
      throw new YouTubeMcpError(
        "CHANNEL_NOT_FOUND",
        "The YouTube Data API returned no accessible channel.",
        { reference },
      );
    }
    return {
      ...normalizeChannel(item),
      resolution: {
        inputKind: reference.kind,
        resolvedBy: resolution.resolvedBy,
      },
    };
  }

  async listChannelVideos(
    reference: ChannelReference,
    maxResults: number,
    pageToken: string | undefined,
  ): Promise<Record<string, unknown>> {
    const channel = await this.getChannel(reference);
    const uploadsPlaylistId = channel.uploadsPlaylistId;
    if (typeof uploadsPlaylistId !== "string" || !uploadsPlaylistId) {
      throw new YouTubeMcpError(
        "UPLOADS_PLAYLIST_NOT_FOUND",
        "The channel did not expose an uploads playlist.",
        { reference },
      );
    }

    const page = await this.listPlaylistItems(
      uploadsPlaylistId,
      maxResults,
      pageToken,
    );
    return {
      channel,
      ...page,
      retrievalStrategy:
        "channels.list -> uploads playlist -> playlistItems.list (does not spend the search bucket)",
    };
  }

  async searchChannelVideos(
    reference: ChannelReference,
    query: string,
    maxResults: number,
    pageToken: string | undefined,
  ): Promise<Record<string, unknown>> {
    const channel = await this.getChannel(reference);
    const channelId = channel.id;
    if (typeof channelId !== "string" || !channelId) {
      throw new YouTubeMcpError(
        "CHANNEL_NOT_FOUND",
        "The channel did not expose a usable ID.",
        { reference },
      );
    }
    const page = await this.searchVideos(query, {
      maxResults,
      pageToken,
      order: "relevance",
      channelId,
      publishedAfter: undefined,
      publishedBefore: undefined,
      regionCode: undefined,
      relevanceLanguage: undefined,
      safeSearch: "moderate",
      videoDuration: "any",
    });
    return {
      channel,
      ...page,
      retrievalStrategy: "search.list(q, channelId, type=video)",
      resultLimitNote:
        "YouTube limits channelId+type=video search results to at most 500 videos.",
    };
  }

  private async listPlaylistItems(
    playlistId: string,
    maxResults: number,
    pageToken: string | undefined,
  ): Promise<Record<string, unknown>> {
    const response = await this.request<ListResponse<PlaylistItem>>(
      "playlistItems",
      {
        part: "snippet,contentDetails,status",
        playlistId,
        maxResults,
        pageToken,
      },
    );

    return {
      playlistId,
      playlistUrl: playlistUrl(playlistId),
      items: (response.items ?? []).map((item) => {
        const videoId =
          item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
        return {
          id: item.id ?? null,
          videoId: videoId ?? null,
          videoUrl: videoId ? videoUrl(videoId) : null,
          title: item.snippet?.title ?? null,
          description: item.snippet?.description ?? null,
          channelId: item.snippet?.channelId ?? null,
          channelTitle: item.snippet?.channelTitle ?? null,
          addedAt: item.snippet?.publishedAt ?? null,
          videoPublishedAt: item.contentDetails?.videoPublishedAt ?? null,
          position: item.snippet?.position ?? null,
          privacyStatus: item.status?.privacyStatus ?? null,
          thumbnails: item.snippet?.thumbnails ?? {},
        };
      }),
      nextPageToken: response.nextPageToken ?? null,
      prevPageToken: response.prevPageToken ?? null,
      pageInfo: response.pageInfo ?? null,
      provider: "youtube-data-api-v3",
    };
  }

  async getPlaylist(
    playlistId: string,
    maxResults: number,
    pageToken: string | undefined,
    includeItems: boolean,
  ): Promise<Record<string, unknown>> {
    const response = await this.request<ListResponse<PlaylistResource>>(
      "playlists",
      {
        part: "snippet,contentDetails,status",
        id: playlistId,
        maxResults: 1,
      },
    );
    const item = response.items?.[0];
    if (!item) {
      throw new YouTubeMcpError(
        "PLAYLIST_NOT_FOUND",
        "The YouTube Data API returned no accessible playlist.",
        { playlistId },
      );
    }

    const playlist = {
      id: item.id ?? playlistId,
      url: playlistUrl(item.id ?? playlistId),
      title: item.snippet?.title ?? null,
      description: item.snippet?.description ?? null,
      channelId: item.snippet?.channelId ?? null,
      channelTitle: item.snippet?.channelTitle ?? null,
      publishedAt: item.snippet?.publishedAt ?? null,
      defaultLanguage: item.snippet?.defaultLanguage ?? null,
      thumbnails: item.snippet?.thumbnails ?? {},
      itemCount: item.contentDetails?.itemCount ?? null,
      privacyStatus: item.status?.privacyStatus ?? null,
      provider: "youtube-data-api-v3",
    };

    if (!includeItems) return { playlist };
    return {
      playlist,
      page: await this.listPlaylistItems(playlistId, maxResults, pageToken),
    };
  }

  async listComments(
    videoId: string,
    maxResults: number,
    pageToken: string | undefined,
    order: "relevance" | "time",
    includeReplies: boolean,
    replyLimit: number,
  ): Promise<Record<string, unknown>> {
    const requestReplies = includeReplies && replyLimit > 0;
    const response = await this.request<ListResponse<CommentThread>>(
      "commentThreads",
      {
        part: requestReplies ? "snippet,replies" : "snippet",
        videoId,
        maxResults,
        pageToken,
        order,
        textFormat: "plainText",
      },
    );

    return {
      videoId,
      videoUrl: videoUrl(videoId),
      items: (response.items ?? []).map((thread) => {
        const replies = requestReplies
          ? (thread.replies?.comments ?? [])
              .map(normalizeComment)
              .filter((comment) => comment !== null)
              .slice(0, replyLimit)
          : [];
        const totalReplyCount = thread.snippet?.totalReplyCount ?? 0;
        return {
          threadId: thread.id ?? null,
          canReply: thread.snippet?.canReply ?? null,
          isPublic: thread.snippet?.isPublic ?? null,
          totalReplyCount,
          topLevelComment: normalizeComment(
            thread.snippet?.topLevelComment,
          ),
          repliesIncluded: requestReplies,
          replies,
          repliesReturned: replies.length,
          repliesComplete:
            requestReplies ? replies.length >= totalReplyCount : null,
        };
      }),
      nextPageToken: response.nextPageToken ?? null,
      prevPageToken: response.prevPageToken ?? null,
      pageInfo: response.pageInfo
        ? {
            ...response.pageInfo,
            estimatedTotalResults: response.pageInfo.totalResults ?? null,
            totalResults: null,
            totalResultsReliable: false,
          }
        : null,
      provider: "youtube-data-api-v3",
      note:
        "Embedded replies are capped by reply_limit and may be partial.",
    };
  }

  async trending(
    regionCode: string,
    categoryId: string | undefined,
    maxResults: number,
    pageToken: string | undefined,
  ): Promise<Record<string, unknown>> {
    const response = await this.request<ListResponse<VideoItem>>("videos", {
      part: "snippet,contentDetails,statistics",
      chart: "mostPopular",
      fields: "items(id,snippet(title,channelId,channelTitle,publishedAt,thumbnails/high),contentDetails/duration,statistics(viewCount,likeCount,commentCount)),nextPageToken,prevPageToken,pageInfo",
      regionCode,
      videoCategoryId: categoryId,
      maxResults,
      pageToken,
    });
    return {
      regionCode,
      categoryId: categoryId ?? null,
      items: (response.items ?? []).map((item) => {
        const video = normalizeVideo(item);
        return {
          id: video.id, url: video.url, title: video.title,
          channelId: video.channelId, channelTitle: video.channelTitle,
          publishedAt: video.publishedAt, durationSeconds: video.durationSeconds,
          statistics: video.statistics,
          thumbnail: item.snippet?.thumbnails?.high?.url ?? null,
          provider: video.provider, completeness: video.completeness,
        };
      }),
      nextPageToken: response.nextPageToken ?? null,
      prevPageToken: response.prevPageToken ?? null,
      pageInfo: response.pageInfo ?? null,
      provider: "youtube-data-api-v3",
    };
  }
}
