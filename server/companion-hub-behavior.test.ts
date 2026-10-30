import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const scriptsDirectory = resolve("companion_scripts");

function runPythonStub(source: string) {
  const result = spawnSync("python3", ["-c", source], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

describe("Quiver Hub companion client behavior", () => {
  it("uses direct Python stubs to fail closed on malformed responses, unsafe writes, and downloads", () => {
    runPythonStub(`
import contextlib
import gzip
import hashlib
import io
import logging
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, ${JSON.stringify(scriptsDirectory)})
os.environ["POLL_INTERVAL"] = "not-a-number"
import raspberry_pi_client as client_module


def trpc(value):
    return {"result": {"data": {"json": value}}}


class JsonResponse:
    def __init__(self, value, url="https://hub.example/response"):
        self.value = value
        self.url = url
        self.headers = {}
    def raise_for_status(self):
        return None
    def json(self):
        return self.value
    def close(self):
        return None


class StreamResponse:
    def __init__(self, chunks, url="https://files.example/download?signature=private"):
        self.chunks = chunks
        self.url = url
        self.headers = {}
    def raise_for_status(self):
        return None
    def iter_content(self, chunk_size):
        assert chunk_size > 0
        yield from self.chunks
    def close(self):
        return None


class Session:
    def __init__(self):
        self.pending = JsonResponse(trpc({"jobs": []}))
        self.post_response = JsonResponse(trpc({"success": True}))
        self.file_info = None
        self.download = None
    def get(self, url, **kwargs):
        if url.endswith("droneJobs.getPendingJobs"):
            return self.pending
        if url.endswith("droneJobs.getFile"):
            return JsonResponse(trpc({"file": self.file_info}), url)
        assert kwargs.get("stream") is True
        return self.download
    def post(self, url, **kwargs):
        return self.post_response


def new_client(root, *, writes=False):
    instance = client_module.QuiverHubClient(
        "https://hub.example", "drone-1", "api-key", 5,
        allow_remote_file_writes=writes,
    )
    instance.config_dir = root / "config"
    instance.parsers_dir = root / "parsers"
    instance.upload_dir = root / "uploads"
    instance.session = Session()
    return instance


# A valid explicit interval must override an invalid environment default, while
# a missing explicit value is a concise argparse error rather than an import crash.
arguments = client_module.parse_arguments([
    "--server", "https://hub.example", "--drone-id", "drone-1", "--api-key", "key",
    "--poll-interval", "2.5",
])
assert arguments.poll_interval == 2.5
with contextlib.redirect_stderr(io.StringIO()) as stderr:
    try:
        client_module.parse_arguments([
            "--server", "https://hub.example", "--drone-id", "drone-1", "--api-key", "key",
        ])
    except SystemExit as error:
        assert error.code == 2
    else:
        raise AssertionError("invalid configured poll interval was accepted")
assert "invalid POLL_INTERVAL: must be a finite positive number" in stderr.getvalue()
for invalid in ("0", "-1", "nan", "inf", "3601"):
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            client_module.parse_arguments([
                "--server", "https://hub.example", "--drone-id", "drone-1", "--api-key", "key",
                "--poll-interval", invalid,
            ])
        except SystemExit as error:
            assert error.code == 2
        else:
            raise AssertionError("unsafe poll interval was accepted: " + invalid)

with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    disabled = new_client(root, writes=False)
    assert disabled.handle_update_config_job({"payload": {"config": {"a": 1}}}) == (
        False, "Remote file writes are disabled"
    )
    assert not disabled.download_file("file-1", str(root / "uploads" / "data.txt"))

    instance = new_client(root, writes=True)
    # Syntactically valid JSON with unexpected shapes must not terminate a poll
    # or accidentally process malformed jobs.
    instance.session.pending = JsonResponse([])
    assert instance.get_pending_jobs() == []
    instance.session.pending = JsonResponse(trpc({"jobs": [{"id": 1, "type": "upload_file", "payload": {}}, "bad"]}))
    jobs = instance.get_pending_jobs()
    assert jobs == [{"id": 1, "type": "upload_file", "payload": {}}]
    instance.session.post_response = JsonResponse([])
    assert not instance.acknowledge_job(1)
    assert not instance.complete_job(1, True)

    class FailingResponse:
        url = "https://hub.example/response?apiKey=private-key"
        def raise_for_status(self):
            raise RuntimeError("request failed for " + self.url)
    instance.session.pending = FailingResponse()
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    client_module.logger.addHandler(handler)
    try:
        assert instance.get_pending_jobs() == []
    finally:
        client_module.logger.removeHandler(handler)
    assert "private-key" not in stream.getvalue()

    # Config writes are JSON-object only, bounded, atomic, and confined below the
    # dedicated config root.  They cannot target .env, service, or shell files.
    config_path = root / "config" / "settings.json"
    assert instance.handle_update_config_job({"payload": {"config": {"safe": [1, 2]}, "configFile": str(config_path)}}) == (True, None)
    assert config_path.read_text(encoding="utf-8") == '{\\n  "safe": [\\n    1,\\n    2\\n  ]\\n}\\n'
    assert (config_path.stat().st_mode & 0o777) == 0o600
    assert instance.handle_update_config_job({"payload": {"config": [], "configFile": str(config_path)}})[0] is False
    assert instance.handle_update_config_job({"payload": {"config": {}, "configFile": str(root / ".env")}})[0] is False
    assert instance.handle_update_config_job({"payload": {"config": {}, "configFile": str(root / "config" / "unit.service")}})[0] is False
    assert instance.handle_update_config_job({"payload": {"config": {}, "configFile": str(root / "config" / ".." / "escaped.json")}})[0] is False
    outside = root / "outside"
    outside.mkdir()
    os.symlink(outside, root / "config" / "link")
    assert instance.handle_update_config_job({"payload": {"config": {}, "configFile": str(root / "config" / "link" / "bad.json")}})[0] is False
    assert not (outside / "bad.json").exists()

    # File download is streamed into a temp file, SHA-256 verified, and atomically
    # replaces an approved non-executable data target only after verification.
    target = root / "uploads" / "artifact.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"old")
    payload = b"verified artifact"
    instance.session.file_info = {
        "url": "https://files.example/download?signature=private",
        "fileSize": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }
    instance.session.download = StreamResponse([payload[:5], payload[5:]])
    assert instance.download_file("file-1", str(target))
    assert target.read_bytes() == payload
    assert (target.stat().st_mode & 0o777) == 0o600
    assert not instance.download_file("file-1", str(root / "uploads" / "client.py"))

    # A failed hash check preserves the existing target instead of leaving a
    # partial overwrite.  Request exceptions do not leak secret-bearing URLs.
    instance.session.file_info["sha256"] = "0" * 64
    instance.session.download = StreamResponse([b"different"])
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    client_module.logger.addHandler(handler)
    try:
        assert not instance.download_file("file-1", str(target))
    finally:
        client_module.logger.removeHandler(handler)
    assert target.read_bytes() == payload
    assert "signature=private" not in stream.getvalue()

    # Gzip output gets its own decompressed size limit, not an in-memory expand.
    original_limit = client_module.MAX_DOWNLOAD_BYTES
    try:
        client_module.MAX_DOWNLOAD_BYTES = 64
        compressed = gzip.compress(b"x" * 128)
        instance.session.file_info = {
            "url": "https://files.example/download?signature=private",
            "fileSize": len(compressed),
            "sha256": hashlib.sha256(compressed).hexdigest(),
        }
        instance.session.download = StreamResponse([compressed])
        gzip_target = root / "uploads" / "large.txt"
        gzip_target.write_bytes(b"old gzip")
        assert not instance.download_file("file-2", str(gzip_target), True)
        assert gzip_target.read_bytes() == b"old gzip"
    finally:
        client_module.MAX_DOWNLOAD_BYTES = original_limit

# Production requires HTTPS.  Insecure transport is allowed only by an explicit
# local-development flag and only to a loopback host.
for url in ("http://hub.example", "https://user:secret@hub.example"):
    try:
        client_module.validate_remote_url(url, False, allow_query=False)
    except ValueError:
        pass
    else:
        raise AssertionError("unsafe Hub URL accepted: " + url)
assert client_module.validate_remote_url("http://localhost:8080", True, allow_query=False)
try:
    client_module.validate_remote_url("http://hub.example", True, allow_query=False)
except ValueError:
    pass
else:
    raise AssertionError("non-local insecure Hub URL accepted")
`);
  });
});
