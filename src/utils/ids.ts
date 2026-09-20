import { YouTubeMcpError } from "../errors.js";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{10,}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "gaming.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

function parsePotentialUrl(input: string): URL | undefined {
  const trimmed = input.trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : /(?:youtu\.be|youtube(?:-nocookie)?\.com)/i.test(trimmed)
      ? `https://${trimmed}`
      : undefined;

  if (!candidate) return undefined;
  try {
    return new URL(candidate);
  } catch {
    return undefined;
  }
}

function cleanCandidate(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && VIDEO_ID_PATTERN.test(candidate) ? candidate : undefined;
}

export function extractVideoId(input: string): string {
  const trimmed = input.trim();
  if (VIDEO_ID_PATTERN.test(trimmed)) return trimmed;

  const url = parsePotentialUrl(trimmed);
  if (!url) {
    throw new YouTubeMcpError(
      "INVALID_VIDEO_REFERENCE",
      "Expected an 11-character YouTube video ID or a supported YouTube URL.",
      { input },
    );
  }

  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") {
    const id = cleanCandidate(url.pathname.split("/").filter(Boolean)[0]);
    if (id) return id;
  }

  if (YOUTUBE_HOSTS.has(host)) {
    const queryId = cleanCandidate(url.searchParams.get("v"));
    if (queryId) return queryId;

    const parts = url.pathname.split("/").filter(Boolean);
    if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "")) {
      const pathId = cleanCandidate(parts[1]);
      if (pathId) return pathId;
    }
  }

  throw new YouTubeMcpError(
    "INVALID_VIDEO_REFERENCE",
    "The URL does not contain a valid YouTube video ID.",
    { input },
  );
}

export function extractPlaylistId(input: string): string {
  const trimmed = input.trim();
  if (PLAYLIST_ID_PATTERN.test(trimmed) && !trimmed.includes("/")) {
    return trimmed;
  }

  const url = parsePotentialUrl(trimmed);
  const candidate = url?.searchParams.get("list")?.trim();
  if (candidate && PLAYLIST_ID_PATTERN.test(candidate)) return candidate;

  throw new YouTubeMcpError(
    "INVALID_PLAYLIST_REFERENCE",
    "Expected a YouTube playlist ID or a YouTube URL containing a list parameter.",
    { input },
  );
}

export type ChannelReference =
  | { kind: "id"; value: string }
  | { kind: "handle"; value: string }
  | { kind: "username"; value: string }
  | { kind: "query"; value: string };

export function extractChannelReference(input: string): ChannelReference {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new YouTubeMcpError(
      "INVALID_CHANNEL_REFERENCE",
      "Channel reference cannot be empty.",
    );
  }
  if (CHANNEL_ID_PATTERN.test(trimmed)) return { kind: "id", value: trimmed };
  if (trimmed.startsWith("@") && trimmed.length > 1) {
    return { kind: "handle", value: trimmed.slice(1) };
  }

  const url = parsePotentialUrl(trimmed);
  if (url && YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    const parts = url.pathname.split("/").filter(Boolean);
    const first = parts[0];
    const second = parts[1];

    if (first?.startsWith("@")) {
      return { kind: "handle", value: first.slice(1) };
    }
    if (first === "channel" && second && CHANNEL_ID_PATTERN.test(second)) {
      return { kind: "id", value: second };
    }
    if (first === "user" && second) {
      return { kind: "username", value: decodeURIComponent(second) };
    }
    if (first === "c" && second) {
      return { kind: "query", value: decodeURIComponent(second) };
    }
  }

  return { kind: "query", value: trimmed };
}

export function videoUrl(videoId: string, startSeconds?: number): string {
  const url = new URL(`https://www.youtube.com/watch?v=${videoId}`);
  if (startSeconds !== undefined && startSeconds > 0) {
    url.searchParams.set("t", `${Math.floor(startSeconds)}s`);
  }
  return url.toString();
}

export function channelUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

export function playlistUrl(playlistId: string): string {
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}

const POST_ID_PATTERN = /^Ug[A-Za-z0-9_-]{8,126}$/;
export function extractPostId(input: string): string {
  const value = input.trim();
  if (POST_ID_PATTERN.test(value)) return value;
  const url = parsePotentialUrl(value);
  const parts = url?.pathname.split("/").filter(Boolean) ?? [];
  if (url && ["https:", "http:"].includes(url.protocol) &&
      ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname) &&
      !url.username && !url.password && !url.port && parts.length === 2 &&
      parts[0] === "post" && POST_ID_PATTERN.test(parts[1]!)) return parts[1]!;
  throw new YouTubeMcpError("INVALID_POST_REFERENCE", "Expected a YouTube post ID or youtube.com/post/<id> URL.");
}
export function postUrl(id: string): string { return `https://www.youtube.com/post/${id}`; }
export function exactPostChannel(input: string): string {
  const value = input.trim();
  if (CHANNEL_ID_PATTERN.test(value)) return `https://www.youtube.com/channel/${value}`;
  if (/^@[^\s/?#]+$/u.test(value)) return `https://www.youtube.com/${value}`;
  const url = parsePotentialUrl(value);
  const parts = url?.pathname.split("/").filter(Boolean) ?? [];
  if (url && ["https:", "http:"].includes(url.protocol) &&
      ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname) &&
      !url.username && !url.password && !url.port) {
    if (parts[0]?.startsWith("@") && parts[0].length > 1 &&
        (parts.length === 1 || (parts.length === 2 && ["posts", "community"].includes(parts[1]!))))
      return `https://www.youtube.com/${parts[0]}`;
    if (parts[0] === "channel" && CHANNEL_ID_PATTERN.test(parts[1] ?? "") &&
        (parts.length === 2 || (parts.length === 3 && ["posts", "community"].includes(parts[2]!))))
      return `https://www.youtube.com/channel/${parts[1]}`;
  }
  throw new YouTubeMcpError("INVALID_CHANNEL_REFERENCE", "Post listings require an exact channel ID, @handle, or channel URL; name search is not supported.");
}
