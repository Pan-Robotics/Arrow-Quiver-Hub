import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const helper = resolve("companion_scripts/installer_support.py");
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach(root => rmSync(root, { recursive: true, force: true }))
);
function python(source: string) {
  return spawnSync("python3", ["-c", source], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
  });
}
const fixture = `
import importlib.util, importlib.metadata, sys, types
spec = importlib.util.spec_from_file_location('support', ${JSON.stringify(helper)})
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)
sys.modules['requests'] = types.ModuleType('requests')
sys.modules['aiohttp'] = types.ModuleType('aiohttp')
sdk = types.ModuleType('mavsdk')
sdk.__file__ = '/system/site-packages/mavsdk/__init__.py'
ftp = types.ModuleType('mavsdk.ftp')
ftp.FtpResult = object
sys.modules['mavsdk'] = sdk
sys.modules['mavsdk.ftp'] = ftp
constructed = []
class System:
    def __init__(self): constructed.append(True)
sdk.System = System
`;

describe("Exact legacy MAVSDK installation preflight", () => {
  it.each(["4.1.0", "3.16.0", "3.17.3", "3.17.4rc1"])(
    "rejects %s before constructing the native/unknown API",
    version => {
      const run = python(
        fixture +
          `
importlib.metadata.version = lambda name: ${JSON.stringify(version)}
try:
    support.sdk_preflight()
except ValueError as error:
    assert '3.17.4' in str(error)
else:
    raise AssertionError('unsupported version accepted')
assert not constructed
`
      );
      expect(run.status, run.stderr).toBe(0);
    }
  );
  it("constructs the pinned legacy System without connecting and reports the actual interpreter/module", () => {
    const run = python(
      fixture +
        `
importlib.metadata.version = lambda name: '3.17.4'
support.sdk_preflight()
assert constructed == [True]
`
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      "Legacy MAVSDK/FTP API preflight passed: 3.17.4"
    );
    expect(run.stdout).toContain("Interpreter:");
    expect(run.stdout).toContain(
      "MAVSDK module: /system/site-packages/mavsdk/__init__.py"
    );
  });
  it("rejects a shadowed native System even when package metadata claims the correct version", () => {
    const run = python(
      fixture +
        `
importlib.metadata.version = lambda name: '3.17.4'
def wrong_system(): raise RuntimeError('native failure URL?apiKey=SECRET')
sdk.System = wrong_system
try:
    support.sdk_preflight()
except ValueError as error:
    assert 'System API does not match' in str(error)
    assert 'SECRET' not in str(error)
else:
    raise AssertionError('shadowed native API accepted')
`
    );
    expect(run.status, run.stderr).toBe(0);
  });
  it("rejects an installation missing the legacy FTP API before construction", () => {
    const run = python(
      fixture +
        `
importlib.metadata.version = lambda name: '3.17.4'
del ftp.FtpResult
try:
    support.sdk_preflight()
except ImportError:
    pass
else:
    raise AssertionError('missing FTP API accepted')
assert not constructed
`
    );
    expect(run.status, run.stderr).toBe(0);
  });
});

describe("Literal service-account environment execution", () => {
  it("loads the selected file literally and invokes only the absolute interpreter", () => {
    const root = mkdtempSync(join(tmpdir(), "quiver-service-environment-"));
    roots.push(root);
    const config = join(root, "settings.conf");
    writeFileSync(
      config,
      'HUB_URL="https://hub.example"\nAPI_KEY="$(touch should-not-run)"\nDRONE_ID=sample\n'
    );
    const run = python(`
import importlib.util, sys, types
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(resolve("companion_scripts"))})
spec=importlib.util.spec_from_file_location('support', ${JSON.stringify(helper)})
support=importlib.util.module_from_spec(spec); spec.loader.exec_module(support)
observed=[]
support.os.execve=lambda program,args,env: observed.append((program,args,env))
support.service_run(Path(${JSON.stringify(config)}), ['/usr/bin/python3','-s','/chosen/telemetry.py','--check'])
program,args,env=observed[0]
assert program == '/usr/bin/python3'
assert args[-1] == '--check'
assert env['QUIVER_ENV_FILE'] == ${JSON.stringify(config)}
assert env['API_KEY'] == '$(touch should-not-run)'
assert env['DRONE_ID'] == 'sample'
assert not Path('should-not-run').exists()
`);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).not.toContain("API_KEY");
  });
});
