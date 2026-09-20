import * as z from "zod/v4";

const text = z.string().nullable().optional();
const count = z.number().int().nonnegative();
const number = z.number().nullable().optional();
const flag = z.boolean().nullable().optional();
const statistics = z.looseObject({
  viewCount: z.string().optional(),
  likeCount: z.string().optional(),
  commentCount: z.string().optional(),
  subscriberCount: z.string().optional(),
  videoCount: z.string().optional(),
  hiddenSubscriberCount: z.boolean().optional(),
}).optional();
const pageInfo = z.looseObject({
  totalResults: number,
  resultsPerPage: number,
  totalResultsReliable: flag,
}).nullable().optional();

// Provider- and selection-dependent fields are optional. Extra provider fields
// remain intact; these schemas describe the existing response, not a projection.
const entityFields = {
  id: text,
  url: text,
  title: text,
  description: text,
  channelId: text,
  channelTitle: text,
  publishedAt: text,
  provider: text,
};
const videoFields = {
  ...entityFields,
  durationSeconds: number,
  statistics,
  captionAvailable: flag,
  captionAvailability: z.looseObject({
    source: z.string(),
    reportedAvailable: z.boolean().nullable(),
    transcriptRetrievability: z.literal("unknown"),
  }).optional(),
};
const segment = z.looseObject({
  index: count,
  startSeconds: z.number(),
  durationSeconds: z.number(),
  endSeconds: z.number(),
  timestamp: z.string(),
  text: z.string(),
  url: z.string(),
});
const comment = z.looseObject({
  id: z.string(),
  text: z.string(),
  author: z.looseObject({ name: text, channelId: text }).optional(),
  likeCount: number,
  publishedAt: text,
}).nullable();
const videoItem = z.looseObject({
  ...segment.partial().shape,
  threadId: text,
  topLevelComment: comment.optional(),
  totalReplyCount: number,
  replies: z.array(comment).optional(),
  repliesReturned: number,
  repliesIncluded: flag,
  repliesComplete: flag,
});
const transcriptFields = {
  videoId: text,
  language: text,
  generated: flag,
  offset: number,
  limit: number,
};
const playlistFields = {
  ...entityFields,
  itemCount: number,
  privacyStatus: text,
};
const playlistItemFields = {
  ...entityFields,
  videoId: text,
  videoUrl: text,
  position: number,
  addedAt: text,
};
const paginationFields = { pageInfo, provider: text };

function envelope(data: z.ZodType, item: z.ZodType, kind: z.ZodType) {
  return z.object({
    schema_version: z.literal("1"),
    kind,
    data,
    items: z.array(item),
    // These synchronous tools retain an empty job slot in the common envelope.
    job: z.strictObject({}),
    page: z.object({
      returned: count,
      has_more: z.boolean(),
      next_cursor: z.string().nullable(),
    }),
    meta: z.object({
      canonical_uri: z.string().nullable(),
      source: z.string(),
      provider: z.string(),
      retrieved_at: z.string(),
      fresh_until: z.string().nullable(),
      quota_cost: z.object({ data: count, search: count }).nullable(),
      warnings: z.array(z.string()),
      untrusted_fields: z.array(z.string()),
    }),
  });
}

const postFields = {
  id: text, url: text, text,
  author: z.looseObject({ channelId: text, name: text, url: text }).optional(),
  publishedLabel: text, likeCountLabel: text,
  attachment: z.looseObject({ type: z.string() }).nullable().optional(),
  sharedPost: z.looseObject({ id: text, url: text }).optional(),
};
export const outputSchemas = {
  youtube_post_get: envelope(z.looseObject({ ...postFields, postId: text, order: text, repliesIncluded: flag }),
    z.looseObject({ ...postFields, replyCountLabel: text, repliesIncluded: flag, isPinned: flag }), z.enum(["entity", "collection"])),
  youtube_video_get: envelope(z.looseObject({
    ...videoFields,
    ...transcriptFields,
    totalSegments: number,
    availableLanguageCount: number,
    availableLanguages: z.array(z.string()).optional(),
    text,
    pageInfo,
  }), videoItem, z.enum(["entity", "collection"])),
  youtube_search: envelope(z.looseObject({
    ...paginationFields,
    channelId: text, channelTitle: text, order: text, availability: text,
    ...transcriptFields,
    query: text,
    channel: z.looseObject({ id: z.string(), title: text }).optional(),
    totalResultsReliable: flag,
    totalMatches: number,
    regionCode: text,
    categoryId: text,
  }), z.looseObject({
    ...playlistItemFields,
    ...postFields,
    durationSeconds: number,
    statistics,
    matchIndex: number,
    segmentIndex: number,
    startSeconds: number,
    timestamp: text,
    text,
    context: z.array(segment).optional(),
  }), z.literal("collection")),
  youtube_channel_get: envelope(z.looseObject({
    ...entityFields,
    customUrl: text,
    country: text,
    statistics,
    uploadsPlaylistId: text,
    brandingSettings: z.record(z.string(), z.unknown()).optional(),
  }), z.never(), z.literal("entity")),
  youtube_playlist_get: envelope(z.looseObject({
    ...playlistFields,
    playlist: z.looseObject(playlistFields).nullable().optional(),
    page: z.looseObject({
      ...paginationFields,
      playlistId: text,
      playlistUrl: text,
    }).optional(),
  }), z.looseObject(playlistItemFields), z.enum(["entity", "collection"])),
};
