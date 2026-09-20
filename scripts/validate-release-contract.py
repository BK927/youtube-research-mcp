"""Dependency-free CI checks for the compact release/plugin boundary."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_VERSION = "1.1.1"
EXPECTED_TOOLS = {
    "youtube_video_get",
    "youtube_search",
    "youtube_channel_get",
    "youtube_playlist_get",
    "youtube_post_get",
}


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict), f"{path} must contain a JSON object"
    return value


plugin = load_json(ROOT / ".codex-plugin" / "plugin.json")
companion = load_json(ROOT / ".mcp.json")
package = load_json(ROOT / "package.json")
package_lock = load_json(ROOT / "package-lock.json")

assert plugin["name"] == "youtube-mcp-aio"
assert plugin["version"] == EXPECTED_VERSION
assert plugin["mcpServers"] == "./.mcp.json"
assert package["version"] == EXPECTED_VERSION
assert package_lock["version"] == EXPECTED_VERSION
assert set(companion["mcpServers"]) == {"youtube-mcp-aio"}
remote = companion["mcpServers"]["youtube-mcp-aio"]
assert remote["type"] == "http" and remote["url"].endswith("/mcp")
assert remote["bearer_token_env_var"] == "YOUTUBE_MCP_ACCESS_TOKEN"
assert remote["url"] == "https://youtube-mcp.example.com/mcp"
assert package["repository"]["url"] == "git+https://github.com/BK927/youtube-research-mcp.git"
assert package["homepage"] == "https://github.com/BK927/youtube-research-mcp#readme"
assert package["bugs"]["url"] == "https://github.com/BK927/youtube-research-mcp/issues"
assert package["author"] == "BK927"

server_source = (ROOT / "src" / "server.ts").read_text(encoding="utf-8")
registered = set(re.findall(r'registerTool\(\s*"([^"]+)"', server_source))
assert registered == EXPECTED_TOOLS, registered

docker = (ROOT / "Dockerfile").read_text(encoding="utf-8")
assert "node:24.12.0-bookworm-slim@sha256:" in docker
assert 'YT_DLP_VERSION="2026.8.19"' in docker
assert 'YT_DLP_POT_PROVIDER_VERSION="1.3.1"' in docker
assert '"bgutil-ytdlp-pot-provider==${YT_DLP_POT_PROVIDER_VERSION}"' in docker

provision = (ROOT / "scripts" / "provision-gcp.ps1").read_text(encoding="utf-8")
deploy = (ROOT / "scripts" / "deploy-cloud-run.ps1").read_text(encoding="utf-8")
deployment = "\n".join(
    path.read_text(encoding="utf-8")
    for path in (ROOT / "scripts").glob("*gcp*.ps1")
)
deployment += deploy
assert ":latest" not in deployment
assert "$RotateAccessToken" in deployment
assert deploy.count('Add-SecretVersion "youtube-mcp-access-token"') == 1
assert 'if ($RotateAccessToken) { Add-SecretVersion "youtube-mcp-access-token"' in deploy
assert provision.count('Add-SecretVersion "youtube-mcp-access-token"') == 1
assert 'if (-not (Get-LatestSecretVersion "youtube-mcp-access-token")) {' in provision
assert 'percent = 0; tag = "candidate"' in deploy and '"$candidateRevision=100"' in deployment
assert "--to-tags" not in deployment
assert 'HEALTH_PATH = "/health"' in deployment
assert 'HTTP_MAX_BODY_BYTES = "2097152"' in deployment
assert 'YOUTUBE_MAX_RESULT_BYTES = "12288"' in deployment
assert 'YT_DLP_POT_PROVIDER_ENABLED = "true"' in deployment
assert 'updateMask=template,traffic,scaling,ingress' in deploy
assert 'ValidateOnly' in deploy
assert 'name = "pot-provider"' in deploy
assert 'name = "mcp"' in deploy
assert 'dependsOn = @("pot-provider")' in deploy
assert "[REDACTED]" in deploy and "poToken" in deploy and "integrityToken" in deploy
assert 'percent = 0; tag = "candidate"' in deploy
assert 'percent = 100' in deploy
assert "brainicism/bgutil-ytdlp-pot-provider@sha256:" in deploy
assert '--videos ($SmokeVideoIds -join ",")' in deploy
assert "arj7oStGLkU" in deploy and "iG9CE55wbtY" in deploy
assert "Get-StableRevision" in deploy
assert 'secret = "youtube-mcp-cursor-secret"; version = $cursorSecretVersion' in deployment

ytdlp_provider = (ROOT / "src" / "providers" / "transcript" / "ytdlp-provider.ts").read_text(encoding="utf-8")
assert "youtube:player_client=web_embedded,tv,android_vr,web" in ytdlp_provider
youtubejs_provider = (ROOT / "src" / "providers" / "transcript" / "youtubejs-provider.ts").read_text(encoding="utf-8")
assert '"WEB_EMBEDDED"' in youtubejs_provider and '"TV_EMBEDDED"' in youtubejs_provider

for path in [ROOT / ".env.example", ROOT / "README.md", ROOT / "src", ROOT / "scripts"]:
    files = [path] if path.is_file() else [p for p in path.rglob("*") if p.is_file()]
    for file in files:
        if file.name == "validate-release-contract.py":
            continue
        assert "GOOGLE_OAUTH_" not in file.read_text(encoding="utf-8"), file

print("YouTube compact release contract passed.")
