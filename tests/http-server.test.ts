import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  startHttpServer,
  type HttpServerHandle,
} from "../src/http/http-server.js";
import { createYoutubeMcpServer } from "../src/server.js";
import {
  TEST_ACCESS_TOKEN,
  testAppConfig,
  testRuntimeConfig,
} from "./helpers.js";

let handle: HttpServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("Streamable HTTP server", () => {
  it("preserves health/auth and serves the same registry as stdio", async () => {
    const appConfig = testAppConfig();
    handle = await startHttpServer(appConfig, testRuntimeConfig());

    const health = await fetch(`${handle.localUrl}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      service: "youtube-mcp-aio",
      version: "1.1.1",
    });

    const unauthorized = await fetch(`${handle.localUrl}/mcp`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("Bearer");

    const httpClient = new Client({ name: "http-test", version: "1.0.0" });
    const httpTransport = new StreamableHTTPClientTransport(
      new URL(`${handle.localUrl}/mcp`),
      { authProvider: { token: async () => TEST_ACCESS_TOKEN } },
    );
    const stdioServer = createYoutubeMcpServer(appConfig);
    const stdioClient = new Client({ name: "stdio-test", version: "1.0.0" });
    const [stdioClientTransport, stdioServerTransport] =
      InMemoryTransport.createLinkedPair();
    await stdioServer.connect(stdioServerTransport);
    await Promise.all([
      httpClient.connect(httpTransport),
      stdioClient.connect(stdioClientTransport),
    ]);

    try {
      expect(await httpClient.listTools()).toEqual(await stdioClient.listTools());
      expect(await httpClient.listResources()).toEqual(
        await stdioClient.listResources(),
      );
      expect(await httpClient.listResourceTemplates()).toEqual(
        await stdioClient.listResourceTemplates(),
      );

      const catalog = await httpClient.readResource({ uri: "youtube://catalog" });
      const catalogContent = catalog.contents[0];
      const catalogText =
        catalogContent && "text" in catalogContent ? catalogContent.text : "";
      expect(catalogText).toContain(
        '"transport":"streamable-http"',
      );
      expect(catalogText).toContain(
        '"authentication":"static-bearer"',
      );
    } finally {
      await Promise.all([
        httpClient.close(),
        stdioClient.close(),
        stdioServer.close(),
      ]);
    }
  });

  it("enforces Origin and body-size guards before dispatch", async () => {
    handle = await startHttpServer(
      testAppConfig(),
      testRuntimeConfig({
        allowedOrigins: ["https://allowed.example"],
        maxBodyBytes: 1_024,
      }),
    );

    const badOrigin = await fetch(`${handle.localUrl}/mcp`, {
      headers: { Origin: "https://blocked.example" },
    });
    expect(badOrigin.status).toBe(403);

    const oversized = await fetch(`${handle.localUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: "x".repeat(2_000) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("rejects an unapproved Host before authentication", async () => {
    handle = await startHttpServer(
      testAppConfig(),
      testRuntimeConfig({ allowedHosts: ["allowed.example"] }),
    );
    const response = await fetch(`${handle.localUrl}/mcp`, {
      headers: { Host: "blocked.example" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden" });
  });

  it("completes the ChatGPT OAuth PKCE flow and rejects code replay", async () => {
    const loginSecret = "login-" + "a".repeat(40);
    handle = await startHttpServer(
      testAppConfig(),
      testRuntimeConfig({
        publicBaseUrl: "http://127.0.0.1",
        allowedHosts: ["127.0.0.1"],
        oauth: {
          issuer: "http://127.0.0.1",
          resource: "http://127.0.0.1/mcp",
          scope: "youtube.read",
          loginSecret,
          signingSecret: "signing-" + "b".repeat(40),
          store: "memory",
          projectId: undefined,
          codeCollection: "test_codes",
        },
      }),
    );

    const issuer = handle.localUrl;
    const resource = `${issuer}/mcp`;
    const runtime = testRuntimeConfig({
      port: Number.parseInt(new URL(issuer).port, 10),
      publicBaseUrl: issuer,
      allowedHosts: [new URL(issuer).hostname],
      oauth: {
        issuer,
        resource,
        scope: "youtube.read",
        loginSecret,
        signingSecret: "signing-" + "b".repeat(40),
        store: "memory",
        projectId: undefined,
        codeCollection: "test_codes",
      },
    });
    await handle.close();
    handle = await startHttpServer(testAppConfig(), runtime);

    const metadata = await fetch(
      `${issuer}/.well-known/oauth-authorization-server`,
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
    });
    const unauthorized = await fetch(`${issuer}/mcp`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain(
      `${issuer}/.well-known/oauth-protected-resource/mcp`,
    );

    const verifier = "v".repeat(64);
    const challenge = createHash("sha256")
      .update(verifier, "utf8")
      .digest("base64url");
    const authorize = new URL(`${issuer}/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: "https://chatgpt.com/oauth/client.json",
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      scope: "youtube.read",
      state: "opaque-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    }).toString();
    const authorization = await fetch(authorize, { redirect: "manual" });
    expect(authorization.status).toBe(302);
    const loginUrl = authorization.headers.get("location");
    expect(loginUrl).toBeTruthy();
    const transaction = new URL(loginUrl!).searchParams.get("transaction");
    expect(transaction).toBeTruthy();

    const loginPage = await fetch(loginUrl!);
    expect(loginPage.status).toBe(200);
    expect(loginPage.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://chatgpt.com",
    );
    expect(loginPage.headers.get("content-security-policy")).not.toContain(
      "form-action *",
    );

    const login = await fetch(`${issuer}/oauth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ transaction: transaction!, access_key: loginSecret }),
    });
    expect(login.status).toBe(302);
    const callback = new URL(login.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("opaque-state");
    expect(callback.searchParams.get("iss")).toBe(issuer);
    const code = callback.searchParams.get("code")!;
    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      client_id: "https://chatgpt.com/oauth/client.json",
      code_verifier: verifier,
      resource,
    });
    const token = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm,
    });
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as { access_token: string };
    expect(tokenBody.access_token).toBeTruthy();

    const replay = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenForm,
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    const client = new Client({ name: "oauth-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${issuer}/mcp`), {
      authProvider: { token: async () => tokenBody.access_token },
    });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools).toHaveLength(5);
    } finally {
      await client.close();
    }
  });
});
