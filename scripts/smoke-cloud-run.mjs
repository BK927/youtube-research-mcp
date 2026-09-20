import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const expected = [
  "youtube_video_get",
  "youtube_search",
  "youtube_channel_get",
  "youtube_playlist_get",
  "youtube_post_get",
];
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const url = args.get("--url");
const skipTranscripts = args.get("--skip-transcripts") === "true";
const videos = (args.get("--videos") ?? "dQw4w9WgXcQ,arj7oStGLkU,iG9CE55wbtY")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const researchVideos = new Set(["arj7oStGLkU", "iG9CE55wbtY"]);
const token = process.env.MCP_SMOKE_ACCESS_TOKEN;
if (!url || !token || (!skipTranscripts && videos.length < 2)) {
  throw new Error(
    "--url, MCP_SMOKE_ACCESS_TOKEN, and at least two --videos unless --skip-transcripts true are required",
  );
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function errorSummary(result) {
  const envelope = object(result.structuredContent);
  const details = object(envelope.details);
  return {
    code: envelope.code ?? "unknown",
    retryable: envelope.retryable ?? null,
    blockedBy: details.blockedBy ?? null,
    attempts: array(details.attempts).map((attempt) => {
      const value = object(attempt);
      return {
        provider: value.provider ?? "unknown",
        code: value.code ?? "unknown",
        blockedBy: value.blockedBy ?? null,
      };
    }),
  };
}

const client = new Client({ name: "youtube-cloud-smoke", version: "1.1.1" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  authProvider: { token: async () => token },
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`exact tools/list mismatch: ${JSON.stringify(names)}`);
  }

  const transcriptSuccesses = [];
  const transcriptFailures = [];
  if (!skipTranscripts) {
    for (const video of videos) {
      const result = await client.callTool({
        name: "youtube_video_get",
        arguments: {
          video,
          view: "transcript",
          options: { include_text: false, include_timestamps: true },
          limit: 1,
          max_chars: 4_000,
        },
      });
      const envelope = object(result.structuredContent);
      if (
        !result.isError &&
        array(envelope.items).length === 1 &&
        nonEmpty(object(array(envelope.items)[0]).text)
      ) {
        transcriptSuccesses.push(video);
      } else {
        transcriptFailures.push({ video, ...errorSummary(result) });
      }
    }
    const researchSuccesses = transcriptSuccesses.filter((video) =>
      researchVideos.has(video),
    );
    if (transcriptSuccesses.length < 2 || researchSuccesses.length < 1) {
      throw new Error(
        `transcript matrix failed: ${JSON.stringify({ transcriptSuccesses, transcriptFailures })}`,
      );
    }

    const languageVideo = transcriptSuccesses[0];
    const defaultLanguagePage = await client.callTool({
      name: "youtube_video_get",
      arguments: {
        video: languageVideo,
        view: "transcript",
        limit: 1,
        max_chars: 4_000,
      },
    });
    const defaultLanguageEnvelope = object(defaultLanguagePage.structuredContent);
    const defaultLanguageData = object(defaultLanguageEnvelope.data);
    if (
      defaultLanguagePage.isError ||
      "availableLanguages" in defaultLanguageData ||
      typeof defaultLanguageData.availableLanguageCount !== "number"
    ) {
      throw new Error("compact transcript language metadata smoke failed");
    }

    const explicitLanguagePage = await client.callTool({
      name: "youtube_video_get",
      arguments: {
        video: languageVideo,
        view: "transcript",
        options: { include_available_languages: true },
        limit: 1,
        max_chars: 4_000,
      },
    });
    const explicitLanguageEnvelope = object(explicitLanguagePage.structuredContent);
    const explicitLanguageData = object(explicitLanguageEnvelope.data);
    const explicitCursor = object(explicitLanguageEnvelope.page).next_cursor;
    if (
      explicitLanguagePage.isError ||
      array(explicitLanguageData.availableLanguages).length === 0 ||
      !nonEmpty(explicitCursor)
    ) {
      throw new Error("opt-in transcript language metadata smoke failed");
    }
    const continuedLanguagePage = await client.callTool({
      name: "youtube_video_get",
      arguments: {
        video: languageVideo,
        view: "transcript",
        options: { include_available_languages: true },
        cursor: explicitCursor,
        limit: 1,
        max_chars: 4_000,
      },
    });
    const continuedLanguageEnvelope = object(continuedLanguagePage.structuredContent);
    if (
      continuedLanguagePage.isError ||
      "availableLanguages" in object(continuedLanguageEnvelope.data)
    ) {
      throw new Error("transcript cursor repeated availableLanguages");
    }
  }

  const defaultComments = await client.callTool({
    name: "youtube_video_get",
    arguments: {
      video: "dQw4w9WgXcQ",
      view: "comments",
      limit: 5,
      max_chars: 4_000,
    },
  });
  const defaultEnvelope = object(defaultComments.structuredContent);
  const defaultItems = array(defaultEnvelope.items);
  if (
    defaultComments.isError ||
    defaultItems.length === 0 ||
    object(defaultEnvelope.page).returned !== defaultItems.length ||
    defaultItems.some((item) => {
      const thread = object(item);
      const comment = object(thread.topLevelComment);
      return (
        !nonEmpty(thread.threadId) ||
        !nonEmpty(comment.id) ||
        !nonEmpty(comment.text) ||
        array(thread.replies).length !== 0
      );
    })
  ) {
    throw new Error("default top-level comment smoke failed");
  }

  const commentsWithReplies = await client.callTool({
    name: "youtube_video_get",
    arguments: {
      video: "dQw4w9WgXcQ",
      view: "comments",
      options: { include_replies: true, reply_limit: 2 },
      limit: 5,
      max_chars: 4_000,
    },
  });
  const repliesEnvelope = object(commentsWithReplies.structuredContent);
  const replyItems = array(repliesEnvelope.items);
  if (
    commentsWithReplies.isError ||
    replyItems.length === 0 ||
    object(repliesEnvelope.page).returned !== replyItems.length ||
    replyItems.some((item) => {
      const thread = object(item);
      const top = object(thread.topLevelComment);
      const replies = array(thread.replies);
      return (
        !nonEmpty(thread.threadId) ||
        !nonEmpty(top.id) ||
        !nonEmpty(top.text) ||
        replies.length > 2 ||
        replies.some((reply) => {
          const value = object(reply);
          return !nonEmpty(value.id) || !nonEmpty(value.text);
        })
      );
    })
  ) {
    throw new Error("bounded reply comment smoke failed");
  }

  const trending = await client.callTool({
    name: "youtube_search",
    arguments: { scope: "trending", locale: "ko-KR", limit: 1 },
  });
  if (
    trending.isError ||
    object(object(trending.structuredContent).data).regionCode !== "KR"
  ) {
    throw new Error("locale-to-region trending smoke failed");
  }

  console.log(
    skipTranscripts
      ? "YouTube MCP SDK targeted smoke passed: exact 5 tools, bounded comments/replies, and locale-region inference."
      : `YouTube MCP SDK smoke passed: exact 5 tools, ${transcriptSuccesses.length}/${videos.length} transcript matrix with research coverage, bounded comments/replies, and locale-region inference.`,
  );
} finally {
  await client.close();
}
