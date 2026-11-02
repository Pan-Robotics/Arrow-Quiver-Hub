import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const suite = resolve("companion_scripts");
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

type Options = {
  active?: boolean;
  refusesStop?: boolean;
  restartInactive?: boolean;
  pipExit?: number;
  aptExit?: number;
  checkExit?: number;
  testExit?: number;
  sdkFailures?: number;
  canEnabled?: boolean;
  invalidDropIn?: boolean;
  wrongInterpreter?: boolean;
};
function fixture(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "quiver-telemetry-install-"));
  roots.push(root);
  const install = join(root, "companion 100% ready"),
    bin = join(root, "bin"),
    units = join(root, "units");
  mkdirSync(install);
  mkdirSync(bin);
  mkdirSync(units);
  const envFile = join(install, ".env"),
    log = join(root, "commands.log"),
    state = join(root, "active");
  const missingCan = "quiver-test-missing-can";
  expect(existsSync(`/sys/class/net/${missingCan}`)).toBe(false);
  writeFileSync(state, options.active === false ? "inactive\n" : "active\n");
  writeFileSync(log, "");
  const secret = "fixture-private-api-key";
  const config = `# retained operator comment\nHUB_URL=https://hub.invalid/prefix\nWEB_SERVER_URL=https://hub.invalid/prefix\nAPI_KEY=${secret}\nDRONE_ID=fixture-drone\nINSTALL_DIR="${install}"\nSERVICE_USER=ubuntu\nFC_IP=10.42.0.51\nCOMPANION_IP=10.42.0.49\nMAVLINK_URL=udpin://0.0.0.0:14540\nCAN_INTERFACE=${missingCan}\nENABLE_UAVCAN=${options.canEnabled ? "true" : "false"}\nUPDATE_RATE_HZ=8\nLOG_STORE_DIR="${install}/logs"\nUNRELATED="$(touch ${root}/env-was-executed)"\n`;
  writeFileSync(envFile, config);
  function executable(name: string, body: string) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  }
  executable(
    "apt-get",
    `printf 'apt-get %s\\n' "$*" >> "$MOCK_LOG"\nexit "$MOCK_APT_EXIT"`
  );
  executable(
    "systemctl",
    `printf 'systemctl %s\\n' "$*" >> "$MOCK_LOG"
case "$1" in
  is-active) [ "$(cat "$MOCK_STATE")" = active ] ;;
  stop) if [ "$MOCK_REFUSES_STOP" != 1 ]; then echo inactive > "$MOCK_STATE"; fi ;;
  restart) if [ "$MOCK_RESTART_INACTIVE" != 1 ]; then echo active > "$MOCK_STATE"; fi ;;
  enable|daemon-reload) : ;;
  *) echo "Unexpected systemctl action" >&2; exit 99 ;;
esac`
  );
  executable(
    "python3",
    `if [ "\${1:-}" = -m ] && [ "\${2:-}" = pip ]; then
  printf 'pip %s\\n' "$*" >> "$MOCK_LOG"; exit "$MOCK_PIP_EXIT"
fi
if [[ "\${1:-}" == */installer_support.py ]] && [ "\${2:-}" = sdk-preflight ]; then
  count=0; [ ! -f "$MOCK_SDK_COUNT" ] || count=$(cat "$MOCK_SDK_COUNT")
  count=$((count + 1)); echo "$count" > "$MOCK_SDK_COUNT"
  printf 'sdk-preflight %s\\n' "$count" >> "$MOCK_LOG"
  [ "$count" -gt "$MOCK_SDK_FAILURES" ]; exit $?
fi
if [[ "\${1:-}" == */installer_support.py ]] && [ "\${2:-}" = install-units ]; then
  printf 'validate-units\\n' >> "$MOCK_LOG"
fi
if [ "$MOCK_WRONG_INTERPRETER" = 1 ] && [ "\${1:-}" = -c ]; then
  printf '/fixture/incompatible/python3\\n'; exit 0
fi
exec /usr/bin/python3 "$@"`
  );
  // Refuse any unrecognized runuser call rather than accidentally exercising FC,
  // CAN, an SDK server, or Hub networking. Log argv, never parsed credentials.
  executable(
    "runuser",
    `printf 'runuser %s\\n' "$*" >> "$MOCK_LOG"
[ "$1" = --user ] && [ "$2" = ubuntu ] && [ "$3" = -- ] && [ "$4" = /usr/bin/python3 ] && [ "$5" = -s ]
[ "$6" = "$QUIVER_INSTALL_DIR/installer_support.py" ] && [ "$7" = service-run ] && [ "$8" = "$QUIVER_ENV_FILE" ]
[ "$9" = /usr/bin/python3 ] && [ "\${10}" = -s ] && [ "\${11}" = "$QUIVER_INSTALL_DIR/telemetry_forwarder.py" ]
case "\${12:-}" in
  --check) [ "$#" = 12 ]; exit "$MOCK_CHECK_EXIT" ;;
  --test-run) [ "$#" = 14 ] && [ "\${13}" = --test-seconds ]; exit "$MOCK_TEST_EXIT" ;;
  *) echo 'Unexpected runuser call; refusing real execution' >&2; exit 99 ;;
esac`
  );
  if (options.invalidDropIn) {
    mkdirSync(join(units, "telemetry-forwarder.service.d"));
    writeFileSync(
      join(units, "telemetry-forwarder.service.d", "invalid.conf"),
      "[Service]\nWorkingDirectory=relative/invalid\n"
    );
  }
  function run(args: string[] = [], input = "\n".repeat(30)) {
    return spawnSync(
      "sudo",
      [
        "-n",
        "env",
        `PATH=${bin}:/usr/bin:/bin`,
        `QUIVER_INSTALL_DIR=${install}`,
        `QUIVER_ENV_FILE=${envFile}`,
        `QUIVER_SYSTEMD_DIR=${units}`,
        `SYSTEMD_UNIT_PATH=${units}:/usr/lib/systemd/system:/lib/systemd/system`,
        `MOCK_LOG=${log}`,
        `MOCK_STATE=${state}`,
        `MOCK_SDK_COUNT=${root}/sdk-count`,
        `MOCK_WRONG_INTERPRETER=${options.wrongInterpreter ? 1 : 0}`,
        `MOCK_REFUSES_STOP=${options.refusesStop ? 1 : 0}`,
        `MOCK_RESTART_INACTIVE=${options.restartInactive ? 1 : 0}`,
        `MOCK_PIP_EXIT=${options.pipExit ?? 0}`,
        `MOCK_APT_EXIT=${options.aptExit ?? 0}`,
        `MOCK_CHECK_EXIT=${options.checkExit ?? 0}`,
        `MOCK_TEST_EXIT=${options.testExit ?? 0}`,
        `MOCK_SDK_FAILURES=${options.sdkFailures ?? 0}`,
        "bash",
        join(suite, "install_telemetry_forwarder.sh"),
        ...args,
      ],
      { input, encoding: "utf8", timeout: 30000 }
    );
  }
  const commands = () => readFileSync(log, "utf8");
  const configValues = () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        "import json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from companion_config import parse_environment_file;print(json.dumps(parse_environment_file(Path(sys.argv[2]))))",
        suite,
        envFile,
      ],
      { encoding: "utf8", timeout: 10000 }
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Record<string, string>;
  };
  return {
    root,
    install,
    units,
    envFile,
    state,
    secret,
    run,
    commands,
    configValues,
  };
}
function expectStopped(f: ReturnType<typeof fixture>) {
  expect(readFileSync(f.state, "utf8").trim()).toBe("inactive");
  expect(f.commands()).not.toMatch(/systemctl (?:enable|restart|start)\b/);
}
function expectOrder(log: string, events: string[]) {
  let previous = -1;
  for (const event of events) {
    const position = log.indexOf(event, previous + 1);
    expect(position, `Missing/out-of-order ${event}\n${log}`).toBeGreaterThan(
      previous
    );
    previous = position;
  }
}

describe("Telemetry installer health gate (hermetic privileged-command simulation)", () => {
  it("stops the old worker before upgraded pinned packages, checks as the service user, validates, bench-tests, then starts", () => {
    const f = fixture(),
      result = f.run(["--test-run"]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const log = f.commands();
    expectOrder(log, [
      "systemctl is-active",
      "systemctl stop telemetry-forwarder.service",
      "systemctl is-active",
      "apt-get update",
      "pip -m pip install --break-system-packages --upgrade -r",
      "sdk-preflight 1",
      "--check",
      "validate-units",
      "systemctl daemon-reload",
      "--test-run --test-seconds 30",
      "systemctl enable telemetry-forwarder.service",
      "systemctl restart telemetry-forwarder.service",
      "systemctl is-active",
    ]);
    expect(log).toContain(
      `runuser --user ubuntu -- /usr/bin/python3 -s ${f.install}/installer_support.py service-run ${f.envFile} /usr/bin/python3 -s ${f.install}/telemetry_forwarder.py --check`
    );
    expect(log).not.toContain(f.secret);
    expect(
      readFileSync(join(suite, "requirements-companion.txt"), "utf8")
    ).toMatch(/^mavsdk==3\.17\.4$/m);
    const unit = readFileSync(
      join(f.units, "telemetry-forwarder.service"),
      "utf8"
    );
    expect(unit).toContain("Environment=PYTHONNOUSERSITE=1");
    expect(unit).toContain(
      `WorkingDirectory=${f.install.replaceAll("%", "%%")}`
    );
    expect(unit).not.toContain(f.secret);
    expect(result.stdout).toContain("bench test PASSED");
  });
  it("preserves Hub identity, operator IPs, unrelated literal settings, and does not execute .env", () => {
    const f = fixture(),
      result = f.run(["--no-start"]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(f.configValues()).toMatchObject({
      API_KEY: f.secret,
      HUB_URL: "https://hub.invalid/prefix",
      WEB_SERVER_URL: "https://hub.invalid/prefix",
      DRONE_ID: "fixture-drone",
      FC_IP: "10.42.0.51",
      COMPANION_IP: "10.42.0.49",
      MAVLINK_URL: "udpin://0.0.0.0:14540",
      ENABLE_UAVCAN: "false",
      UPDATE_RATE_HZ: "8",
      UNRELATED: `$(touch ${f.root}/env-was-executed)`,
    });
    expect(readFileSync(f.envFile, "utf8")).toContain(
      "# retained operator comment"
    );
    expect(existsSync(join(f.root, "env-was-executed"))).toBe(false);
    expectStopped(f);
  });
  it("does not stop an already inactive worker and still verifies inactivity before pip", () => {
    const f = fixture({ active: false }),
      result = f.run(["--no-start"]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(f.commands()).not.toContain("systemctl stop");
    expectOrder(f.commands(), [
      "systemctl is-active",
      "systemctl is-active",
      "pip ",
      "--check",
    ]);
    expectStopped(f);
  });
  it("refuses a foreground competitor when the old worker remains active", () => {
    const f = fixture({ refusesStop: true }),
      result = f.run(["--test-run"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Telemetry did not stop");
    expect(f.commands()).not.toMatch(
      /apt-get|pip |sdk-preflight|runuser|systemctl (?:enable|restart)/
    );
    expect(readFileSync(f.state, "utf8").trim()).toBe("active");
  });
  it.each([{ aptExit: 7 }, { pipExit: 8 }])(
    "dependency failure %j stays stopped before checks and unit installation",
    options => {
      const f = fixture(options),
        result = f.run(["--test-run"]);
      expect(result.status).toBe(options.aptExit ?? options.pipExit);
      expectStopped(f);
      expect(f.commands()).not.toMatch(/sdk-preflight|runuser|validate-units/);
      expect(existsSync(join(f.units, "telemetry-forwarder.service"))).toBe(
        false
      );
    }
  );
  it("repairs a failed root SDK preflight exactly once with the legacy pin", () => {
    const f = fixture({ sdkFailures: 1 }),
      result = f.run(["--no-start"]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expectOrder(f.commands(), [
      "sdk-preflight 1",
      "pip -m pip install --break-system-packages --force-reinstall --no-deps mavsdk==3.17.4",
      "sdk-preflight 2",
      "--check",
    ]);
    expectStopped(f);
  });
  it("a repeated SDK preflight failure aborts before any service-user execution or start", () => {
    const f = fixture({ sdkFailures: 2 }),
      result = f.run(["--test-run"]);
    expect(result.status).not.toBe(0);
    expectStopped(f);
    expect(f.commands().match(/--force-reinstall/g)).toHaveLength(1);
    expect(f.commands()).not.toMatch(/runuser|validate-units/);
  });
  it("a failed service-user --check never installs/starts a unit or runs the bench test", () => {
    const f = fixture({ checkExit: 9 }),
      result = f.run(["--test-run"]);
    expect(result.status).toBe(9);
    expectStopped(f);
    expect(f.commands()).toContain("--check");
    expect(f.commands()).not.toMatch(/--test-run|validate-units|daemon-reload/);
    expect(existsSync(join(f.units, "telemetry-forwarder.service"))).toBe(
      false
    );
  });
  it("a real unit validator rejects an invalid installed drop-in before bench/start", () => {
    const f = fixture({ invalidDropIn: true }),
      result = f.run(["--test-run"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unit validation failed BEFORE");
    expectStopped(f);
    expect(f.commands()).not.toMatch(/--test-run|daemon-reload/);
    expect(existsSync(join(f.units, "telemetry-forwarder.service"))).toBe(
      false
    );
  });
  it("a failed bounded bench test leaves the installed unit stopped and reports failure", () => {
    const f = fixture({ testExit: 10 }),
      result = f.run(["--test-run"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bench test FAILED");
    expect(f.commands()).toContain("--test-run --test-seconds 30");
    expectStopped(f);
  });
  it("supports an explicit bounded duration and --no-start even after a successful bench test", () => {
    const f = fixture(),
      result = f.run(["--test-run", "--test-seconds", "17", "--no-start"]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(f.commands()).toContain("--test-run --test-seconds 17");
    expect(result.stdout).toContain("intentionally left stopped (--no-start)");
    expectStopped(f);
  });
  it("does not silently run a live bench test unless explicitly requested", () => {
    const f = fixture(),
      result = f.run();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(f.commands()).toContain("--check");
    expect(f.commands()).not.toContain("--test-run");
    expect(f.commands()).toContain(
      "systemctl restart telemetry-forwarder.service"
    );
    expect(result.stdout).not.toContain("bench test PASSED");
  });
  it("reports an unhealthy post-start service rather than treating restart as success", () => {
    const f = fixture({ restartInactive: true }),
      result = f.run(["--test-run"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not a healthy install");
  });
  it("missing CAN refusal leaves CAN enabled and aborts before package or service commands", () => {
    const f = fixture({ canEnabled: true }),
      result = f.run([], "\n".repeat(9) + "N\n");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      "is missing. No CAN setup will be attempted"
    );
    expect(f.configValues().ENABLE_UAVCAN).toBe("true");
    expect(f.commands()).toBe("");
    expect(readFileSync(f.state, "utf8").trim()).toBe("active");
  });
  it("only an explicit affirmative missing-CAN answer persists FC-only telemetry", () => {
    const f = fixture({ canEnabled: true }),
      result = f.run(["--no-start"], "\n".repeat(9) + "yes\n\n");
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(f.configValues().ENABLE_UAVCAN).toBe("false");
    expectStopped(f);
  });
  it("--disable-uavcan explicitly changes configuration without any interface setup", () => {
    const f = fixture({ canEnabled: true }),
      result = f.run(["--disable-uavcan", "--no-start"]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(f.configValues().ENABLE_UAVCAN).toBe("false");
    expect(result.stdout).toContain("explicitly disabled by --disable-uavcan");
    expect(f.commands()).not.toMatch(/\b(?:ip|modprobe|ifconfig|can-utils)\b/);
    expectStopped(f);
  });
  it("rejects a PATH Python that differs from the actual service interpreter before any configuration/package/service writes", () => {
    const f = fixture({ wrongInterpreter: true }),
      before = readFileSync(f.envFile),
      result = f.run(["--test-run"]);
    expect(result.status).toBe(2);
    expect(readFileSync(f.envFile)).toEqual(before);
    expect(f.commands()).toBe("");
    expect(existsSync(join(f.install, "installer_support.py"))).toBe(false);
  });
  it.each(["0", "301", "abc", "-1"])(
    "rejects invalid test duration %s before configuration/package/service work",
    duration => {
      const f = fixture(),
        before = readFileSync(f.envFile),
        result = f.run(["--test-seconds", duration]);
      expect(result.status).toBe(2);
      expect(readFileSync(f.envFile)).toEqual(before);
      expect(f.commands()).toBe("");
    }
  );
});
