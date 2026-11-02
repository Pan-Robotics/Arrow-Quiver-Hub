import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const suite = resolve("companion_scripts");
const script = join(suite, "update_companion_suite.sh");
const commit = "c".repeat(40);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    spawnSync("sudo", [
      "-n",
      "chown",
      "-R",
      `${process.getuid!()}:${process.getgid!()}`,
      root,
    ]);
    rmSync(root, { recursive: true, force: true });
  }
});
function sourceFiles(directory = suite, prefix = ""): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
    const name = prefix + entry.name,
      path = join(directory, entry.name);
    if (entry.isDirectory())
      Object.assign(files, sourceFiles(path, name + "/"));
    else if (
      entry.isFile() &&
      /\.(sh|py|lua|md|service|example|txt)$/.test(name)
    )
      files[name] = readFileSync(path);
  }
  return files;
}
function snapshot(root: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name),
      relative = prefix + name,
      stat = lstatSync(path);
    if (stat.isSymbolicLink()) result[relative] = `symlink:${stat.ino}`;
    else if (stat.isDirectory()) {
      result[relative + "/"] = `dir:${stat.mode}`;
      Object.assign(result, snapshot(path, relative + "/"));
    } else
      result[relative] =
        `${stat.ino}:${stat.mode}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  }
  return result;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quiver-suite-update-"));
  roots.push(root);
  const install = join(root, "companion 100% ready");
  mkdirSync(install);
  const delivered = sourceFiles();
  for (const [name, data] of Object.entries(delivered)) {
    mkdirSync(join(install, name, ".."), { recursive: true });
    writeFileSync(join(install, name), data);
  }
  const oldTelemetry = Buffer.from(
      "# old installed telemetry\nOLD_VERSION = True\n"
    ),
    oldReadme = Buffer.from("# operator installed old source\n");
  writeFileSync(join(install, "telemetry_forwarder.py"), oldTelemetry);
  writeFileSync(join(install, "README.md"), oldReadme);
  const env = Buffer.from(
    `# operator formatting must be byte-preserved\r\nAPI_KEY=private-local-secret\r\nHUB_URL=https://operator-hub.invalid\r\nFC_IP=10.42.0.51\r\nCOMPANION_IP=10.42.0.49\r\nUNRELATED="$(touch ${root}/env-was-executed)"\r\n`
  );
  for (const [name, data] of Object.entries({
    ".env": env,
    "forwarder.env": Buffer.from("legacy operator settings\n"),
    "go2rtc.yaml": Buffer.from("streams: operator-defined\n"),
    "firmware_puller.param": Buffer.from(
      "operator generated FC configuration\n"
    ),
    "user-data.bin": Buffer.from("user-data\0untouched"),
  }))
    writeFileSync(join(install, name), data);
  return { root, install, delivered, env, oldTelemetry, oldReadme };
}

// Execute only the updater's specific self-contained Python body, not downloaded
// Python or shell. urlopen always returns a fixture or raises: no live GitHub,
// package managers, real systemctl, FC/CAN devices, or Hub requests are possible.
const networkHarness = String.raw`
import io, json, pathlib, stat, sys, urllib.request, zipfile
suite, chosen, repo, ref, variant, code, report = sys.argv[1:]
sha = 'c' * 40
files = {p.relative_to(suite).as_posix(): p.read_bytes() for p in pathlib.Path(suite).rglob('*') if p.is_file() and '__pycache__' not in p.parts and not any(part.startswith('.') for part in p.relative_to(suite).parts) and p.suffix in ('.sh','.py','.lua','.md','.service','.example','.txt')}
files['telemetry_forwarder.py'] = b'# valid fixture source; never executed\nNEW_VERSION = True\n'
files['nested/extra.md'] = b'nested documentation source\n'
files.update({'.env': b'API_KEY=remote-forbidden', 'forwarder.env': b'API_KEY=remote-forbidden', 'go2rtc.yaml': b'remote-generated-camera', 'firmware_puller.param': b'remote-generated-FC', 'companion-suite.manifest.json': b'remote-manifest', '.git/config': b'remote-metadata', '__pycache__/skip.py': b'invalid python!@'})
if variant == 'missing-required': files.pop('installer_support.py')
if variant == 'missing-updater': files.pop('update_companion_suite.sh')
if variant == 'traversal': files['../../escaped.py'] = b'ESCAPED = True\n'
if variant == 'backslash': files['nested\\escaped.py'] = b'ESCAPED = True\n'
if variant == 'zip-symlink': files['linked.py'] = b'telemetry_forwarder.py'
if variant == 'malformed-python': files['telemetry_forwarder.py'] = b'def broken(:\n'
if variant == 'malformed-shell': files['install_telemetry_forwarder.sh'] = b'#!/bin/bash\nif then\n'
if variant == 'source-too-large': files['large.md'] = b'x' * (33 * 1024 * 1024)
if variant == 'installer-stub': files['install_telemetry_forwarder.sh'] = b'#!/bin/bash\nprintf "telemetry-installer %s\\n" "$*" >> "$MOCK_LOG"\nprintf "install=%s\\nenv=%s\\n" "$QUIVER_INSTALL_DIR" "$QUIVER_ENV_FILE" >> "$MOCK_LOG"\n'
archive = io.BytesIO()
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for name, payload in files.items():
        info = zipfile.ZipInfo('suite-' + sha + '/companion_scripts/' + name)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = ((stat.S_IFLNK if name == 'linked.py' else stat.S_IFREG) | 0o644) << 16
        z.writestr(info, payload)
    if variant == 'duplicate': z.writestr('suite-' + sha + '/companion_scripts/README.md', b'duplicate')
requests = []
class Oversize(io.BytesIO):
    def read(self, maximum=-1): return b'x' * maximum

def opened(request, timeout=0):
    address = request.full_url
    requests.append(address)
    if variant == 'download-failure': raise OSError('fixture network unavailable')
    if '/commits/' in address:
        if len(ref) == 40: raise AssertionError('caller-supplied commit must skip the API')
        return io.BytesIO(json.dumps({'sha':'bad' if variant == 'invalid-commit' else sha}).encode())
    expected = 'https://codeload.github.com/' + repo + '/zip/' + sha
    if address != expected: raise AssertionError('archive not pinned to full commit: ' + address)
    if variant == 'download-too-large': return Oversize()
    if variant == 'invalid-zip': return io.BytesIO(b'not a ZIP archive')
    return io.BytesIO(archive.getvalue())
urllib.request.urlopen = opened
sys.argv = ['suite-update', repo, ref, chosen]
try:
    exec(compile(code, 'standalone-updater', 'exec'))
finally:
    pathlib.Path(report).write_text(json.dumps(requests))
`;
function extractedBody() {
  const match = readFileSync(script, "utf8").match(
    /python3 - "\$SOURCE_REPO" "\$REF" "\$INSTALL_DIR" <<'PY'\n([\s\S]*?)\nPY/
  );
  expect(
    match,
    "standalone updater body must remain extractable and self-contained"
  ).not.toBeNull();
  return match![1];
}
function update(
  f: ReturnType<typeof fixture>,
  options: {
    variant?: string;
    repo?: string;
    ref?: string;
    chosen?: string;
  } = {}
) {
  const report = join(f.root, "requests.json");
  const result = spawnSync(
    "python3",
    [
      "-c",
      networkHarness,
      suite,
      options.chosen ?? f.install,
      options.repo ?? "Pan-Robotics/Arrow-Quiver-Hub",
      options.ref ?? commit,
      options.variant ?? "normal",
      extractedBody(),
      report,
    ],
    { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 }
  );
  const requests = existsSync(report)
    ? (JSON.parse(readFileSync(report, "utf8")) as string[])
    : [];
  return { result, requests };
}
function expectNoWrite(
  f: ReturnType<typeof fixture>,
  options: Parameters<typeof update>[1]
) {
  const before = snapshot(f.install),
    outside = join(f.root, "outside.py");
  const outsideBefore = existsSync(outside) ? readFileSync(outside) : undefined;
  const run = update(f, options);
  expect(
    run.result.status,
    "Expected updater refusal, not a successful partial update"
  ).not.toBe(0);
  expect(snapshot(f.install)).toEqual(before);
  expect(readFileSync(join(f.install, ".env"))).toEqual(f.env);
  expect(existsSync(join(f.root, "env-was-executed"))).toBe(false);
  if (outsideBefore) expect(readFileSync(outside)).toEqual(outsideBefore);
  return run;
}

describe("Standalone companion source-suite updater", () => {
  it("refreshes all current suite sources from one full commit, preserving local settings and unchanged-file inodes", () => {
    const f = fixture(),
      unchanged = join(f.install, "companion_config.py"),
      inode = statSync(unchanged).ino;
    const beforeGenerated = Object.fromEntries(
      [
        ".env",
        "forwarder.env",
        "go2rtc.yaml",
        "firmware_puller.param",
        "user-data.bin",
      ].map(name => [name, readFileSync(join(f.install, name))])
    );
    const { result, requests } = update(f);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(requests).toEqual([
      `https://codeload.github.com/Pan-Robotics/Arrow-Quiver-Hub/zip/${commit}`,
    ]);
    expect(statSync(unchanged).ino).toBe(inode);
    expect(
      readFileSync(join(f.install, "telemetry_forwarder.py"), "utf8")
    ).toContain("NEW_VERSION = True");
    expect(readFileSync(join(f.install, "nested/extra.md"), "utf8")).toBe(
      "nested documentation source\n"
    );
    for (const [name, bytes] of Object.entries(beforeGenerated))
      expect(readFileSync(join(f.install, name)), name).toEqual(bytes);
    expect(existsSync(join(f.root, "env-was-executed"))).toBe(false);
    const backups = readdirSync(f.install).filter(name =>
      name.startsWith(".source-backup-")
    );
    expect(backups).toHaveLength(1);
    const backup = join(f.install, backups[0]);
    expect(statSync(backup).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(backup, "telemetry_forwarder.py"))).toEqual(
      f.oldTelemetry
    );
    expect(readFileSync(join(backup, "README.md"))).toEqual(f.oldReadme);
    expect(existsSync(join(backup, "companion_config.py"))).toBe(false);
    const manifest = JSON.parse(
      readFileSync(join(f.install, "companion-suite.manifest.json"), "utf8")
    );
    expect(manifest.source_commit).toBe(commit);
    expect(manifest.repository).toBe("Pan-Robotics/Arrow-Quiver-Hub");
    for (const name of Object.keys(f.delivered)) {
      expect(manifest.files, name).toHaveProperty(name);
      expect(manifest.files[name], name).toBe(
        createHash("sha256")
          .update(readFileSync(join(f.install, name)))
          .digest("hex")
      );
    }
    expect(manifest.files["nested/extra.md"]).toBe(
      createHash("sha256")
        .update(readFileSync(join(f.install, "nested/extra.md")))
        .digest("hex")
    );
    expect(manifest.files).not.toHaveProperty(".env");
    expect(manifest.files).not.toHaveProperty("forwarder.env");
    expect(existsSync(join(f.install, ".git"))).toBe(false);
    expect(existsSync(join(f.install, "__pycache__"))).toBe(false);
    expect(result.stdout).toContain("NOT changed");
  });
  it("repeating an unchanged source refresh preserves every source inode, does not create another backup, and replaces stale manifest hashes", () => {
    const f = fixture();
    expect(update(f).result.status).toBe(0);
    const inodes = Object.fromEntries(
      Object.keys(f.delivered).map(name => [
        name,
        statSync(join(f.install, name)).ino,
      ])
    );
    const backups = readdirSync(f.install).filter(name =>
      name.startsWith(".source-backup-")
    );
    writeFileSync(
      join(f.install, "companion-suite.manifest.json"),
      '{"source_commit":"stale","files":{}}\n'
    );
    const { result } = update(f);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Updated source files: 0");
    expect(
      readdirSync(f.install).filter(name => name.startsWith(".source-backup-"))
    ).toEqual(backups);
    for (const [name, inode] of Object.entries(inodes))
      expect(statSync(join(f.install, name)).ino, name).toBe(inode);
    expect(
      JSON.parse(
        readFileSync(join(f.install, "companion-suite.manifest.json"), "utf8")
      ).source_commit
    ).toBe(commit);
    expect(readFileSync(join(f.install, ".env"))).toEqual(f.env);
  });
  it("resolves a branch once through the commit API before downloading the pinned ZIP", () => {
    const f = fixture(),
      { result, requests } = update(f, {
        repo: "Other-Team/Other-Hub",
        ref: "feature/telemetry",
      });
    expect(result.status, result.stderr).toBe(0);
    expect(requests).toEqual([
      "https://api.github.com/repos/Other-Team/Other-Hub/commits/feature%2Ftelemetry",
      `https://codeload.github.com/Other-Team/Other-Hub/zip/${commit}`,
    ]);
  });
  it.each([
    "missing-required",
    "missing-updater",
    "traversal",
    "backslash",
    "zip-symlink",
    "duplicate",
    "malformed-python",
    "malformed-shell",
    "download-failure",
    "invalid-zip",
    "source-too-large",
    "download-too-large",
  ])(
    "rejects %s with no installed file/config/manifest/backup writes",
    variant => {
      const f = fixture(),
        { result } = expectNoWrite(f, { variant });
      expect(result.stderr).toContain("installed source/config unchanged");
    }
  );
  it("rejects an invalid API-resolved commit without writing", () => {
    const f = fixture();
    expectNoWrite(f, { ref: "main", variant: "invalid-commit" });
  });
  it.each([
    "https://evil.invalid/team/repo",
    "team/../repo",
    "team/repo/extra",
    "team repo/repo",
  ])("rejects invalid repository %s before downloading or writing", repo => {
    const f = fixture(),
      run = expectNoWrite(f, { repo });
    expect(run.requests).toEqual([]);
  });
  it.each(["", "-main", "main\nInjected"])(
    "rejects invalid ref %j before downloading or writing",
    ref => {
      const f = fixture(),
        run = expectNoWrite(f, { ref });
      expect(run.requests).toEqual([]);
    }
  );
  it.each([
    "/",
    "/usr",
    "/usr/local/quiver",
    "/etc/quiver",
    "/home",
    "/var",
    "/opt",
    "relative/quiver",
    "/tmp/unsafe$path",
    "/tmp/bad\npath",
  ])("rejects unsafe install path %j without any installed writes", chosen => {
    const f = fixture(),
      run = expectNoWrite(f, { chosen });
    expect(run.requests).toEqual([]);
  });
  it("requires an existing installation directory with suite markers, not an arbitrary folder", () => {
    const f = fixture();
    rmSync(join(f.install, "raspberry_pi_client.py"));
    const run = expectNoWrite(f, {});
    expect(run.requests).toEqual([]);
    expect(run.result.stderr).toContain("not an installed companion suite");
  });
  it("refuses a missing installation folder without creating it", () => {
    const f = fixture(),
      chosen = join(f.root, "missing-suite");
    const run = expectNoWrite(f, { chosen });
    expect(run.requests).toEqual([]);
    expect(existsSync(chosen)).toBe(false);
  });
  it("refuses a symlink installation folder or symlink ancestor before downloading", () => {
    const f = fixture(),
      link = join(f.root, "suite-link");
    symlinkSync(f.install, link, "dir");
    expect(expectNoWrite(f, { chosen: link }).requests).toEqual([]);
    const ancestor = join(f.root, "ancestor-link");
    symlinkSync(f.root, ancestor, "dir");
    expect(
      expectNoWrite(f, { chosen: join(ancestor, "companion 100% ready") })
        .requests
    ).toEqual([]);
  });
  it("refuses an existing source destination symlink and preserves its external target", () => {
    const f = fixture(),
      outside = join(f.root, "outside.py");
    writeFileSync(outside, "EXTERNAL = True\n");
    rmSync(join(f.install, "telemetry_forwarder.py"));
    symlinkSync(outside, join(f.install, "telemetry_forwarder.py"));
    expectNoWrite(f, {});
  });
  it("refuses a source destination symlink ancestor without touching the external folder", () => {
    const f = fixture(),
      external = join(f.root, "external");
    mkdirSync(external);
    writeFileSync(join(external, "extra.md"), "operator external file\n");
    symlinkSync(external, join(f.install, "nested"), "dir");
    expectNoWrite(f, {});
    expect(readFileSync(join(external, "extra.md"), "utf8")).toBe(
      "operator external file\n"
    );
  });
  it("refuses a nonregular source destination before replacing any source", () => {
    const f = fixture();
    rmSync(join(f.install, "README.md"));
    mkdirSync(join(f.install, "README.md"));
    expectNoWrite(f, {});
  });
  it("refuses a manifest symlink before writing source or backup files", () => {
    const f = fixture(),
      outside = join(f.root, "outside.py");
    writeFileSync(outside, "outside unchanged\n");
    symlinkSync(outside, join(f.install, "companion-suite.manifest.json"));
    expectNoWrite(f, {});
  });
});

function shellUpdate(f: ReturnType<typeof fixture>, args: string[]) {
  const bin = join(f.root, "bin"),
    log = join(f.root, "commands.log"),
    report = join(f.root, "requests.json"),
    harness = join(f.root, "zip-network-fixture.py");
  mkdirSync(bin);
  writeFileSync(log, "");
  // The shim consumes the exact embedded heredoc and installs a network fixture.
  // Downloaded sources still undergo the updater's real AST and bash validators.
  writeFileSync(
    harness,
    `import sys\ncode = sys.stdin.read()\nsys.argv = ['fixture', ${JSON.stringify(suite)}, sys.argv[3], sys.argv[1], sys.argv[2], 'installer-stub', code, ${JSON.stringify(report)}]\nexec(compile(${JSON.stringify(networkHarness)}, 'network-fixture', 'exec'))\n`
  );
  writeFileSync(
    join(bin, "python3"),
    `#!/bin/bash\nset -eu\n[ "$1" = - ] && [ "$#" = 4 ] || { echo 'Unexpected Python call' >&2; exit 99; }\nshift\nexec /usr/bin/python3 "${harness}" "$@"\n`
  );
  chmodSync(join(bin, "python3"), 0o755);
  for (const name of ["systemctl", "apt-get", "pip", "pip3", "runuser"]) {
    writeFileSync(
      join(bin, name),
      `#!/bin/bash\nprintf '${name} %s\\n' "$*" >> "$MOCK_LOG"\nexit 99\n`
    );
    chmodSync(join(bin, name), 0o755);
  }
  const result = spawnSync(
    "sudo",
    [
      "-n",
      "env",
      `PATH=${bin}:/usr/bin:/bin`,
      `MOCK_LOG=${log}`,
      "bash",
      script,
      "--install-dir",
      f.install,
      "--ref",
      commit,
      ...args,
    ],
    { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 }
  );
  return { result, log: readFileSync(log, "utf8") };
}

describe("Updater shell routing without real install/service execution", () => {
  it("source-only update performs no package, installer, or service commands", () => {
    const f = fixture(),
      { result, log } = shellUpdate(f, []);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(log).toBe("");
    expect(readFileSync(join(f.install, ".env"))).toEqual(f.env);
    expect(result.stdout).toContain("no package changes or service restarts");
  });
  it("invokes only the explicitly selected telemetry installer with bounded-test/no-start/CAN flags and chosen paths", () => {
    const f = fixture(),
      { result, log } = shellUpdate(f, [
        "--install-telemetry",
        "--test-run",
        "--test-seconds",
        "17",
        "--no-start",
        "--disable-uavcan",
      ]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(log).toContain(
      "telemetry-installer --test-run --test-seconds 17 --no-start --disable-uavcan"
    );
    expect(log).toContain(`install=${f.install}\nenv=${f.install}/.env`);
    expect(log).not.toMatch(
      /systemctl|apt-get|pip|runuser|private-local-secret/
    );
    expect(readFileSync(join(f.install, ".env"))).toEqual(f.env);
  });
  it("rejects live-test routing without --install-telemetry before downloading or writing", () => {
    const f = fixture(),
      before = snapshot(f.install),
      { result, log } = shellUpdate(f, ["--test-run"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Use --install-telemetry");
    expect(log).toBe("");
    expect(snapshot(f.install)).toEqual(before);
  });
});
