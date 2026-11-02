import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const scriptsDirectory = resolve("companion_scripts");

// Every subprocess replaces configuration, Session, randomness, and sleeping.
// These are behavior tests of the real Python client, not copies of its policy.
const pythonFixture = `
import io
import logging
import math
import re
import sys
import types

sys.path.insert(0, ${JSON.stringify(scriptsDirectory)})
configuration = types.ModuleType("companion_config")
configuration.load_environment = lambda: {}
sys.modules["companion_config"] = configuration
import raspberry_pi_client as hub


def forbidden(*args, **kwargs):
    raise AssertionError("unexpected real network request or sleep")


hub.requests.sessions.Session.request = forbidden
hub.time.sleep = forbidden


def trpc(jobs):
    return {"result": {"data": {"json": {"jobs": jobs}}}}


class Response:
    def __init__(self, status=200, value=None, headers=None, json_error=None,
                 url="https://hub.example/poll?apiKey=url-secret", close_error=False):
        self.status_code = status
        self.value = trpc([]) if value is None else value
        self.headers = {} if headers is None else headers
        self.json_error = json_error
        self.url = url
        self.close_error = close_error
        self.closed = 0
        self.json_calls = 0

    def raise_for_status(self):
        if self.status_code >= 400:
            raise hub.requests.HTTPError(
                "HTTP failure at " + self.url + "; body=exception-body-secret",
                response=self,
            )

    def json(self):
        self.json_calls += 1
        if self.json_error is not None:
            raise self.json_error
        return self.value

    def close(self):
        self.closed += 1
        if self.close_error:
            raise RuntimeError("close-secret")


class Session:
    def __init__(self, actions):
        self.actions = list(actions)
        self.get_calls = []
        self.post_calls = []
        self.closed = 0

    def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        assert self.actions, "unexpected extra GET (retry inside one poll)"
        action = self.actions.pop(0)
        if isinstance(action, BaseException):
            raise action
        return action

    def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        raise hub.requests.Timeout("POST failed ?apiKey=post-secret")

    def close(self):
        self.closed += 1


jitter_calls = []


def upper_jitter(low, high):
    jitter_calls.append((low, high))
    return high


hub.random.uniform = upper_jitter


def new_client(actions=(), interval=5):
    session = Session(actions)
    hub.requests.Session = lambda: session
    client = hub.QuiverHubClient(
        "https://hub.example", "drone-1", "api-key-secret", interval,
        allow_remote_file_writes=False,
    )
    assert client.session is session
    return client, session


class Clock:
    def __init__(self):
        self.current = 100.0
        self.sleeps = []
        self.wall = 1700000000.0
        self.interrupt_on_sleep = None

    def monotonic(self):
        return self.current

    def time(self):
        return self.wall

    def sleep(self, seconds):
        assert 0 < seconds <= 60, ("unbounded sleep", seconds)
        self.sleeps.append(seconds)
        if self.interrupt_on_sleep == len(self.sleeps):
            raise KeyboardInterrupt()
        self.current += seconds
        # Wall-clock changes must not shorten or lengthen monotonic cooldowns.
        self.wall -= 10000

    def install(self):
        hub.time.monotonic = self.monotonic
        hub.time.time = self.time
        hub.time.sleep = self.sleep
`;

function runPythonStub(source: string) {
  const result = spawnSync("python3", ["-c", pythonFixture + source], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.error, result.stderr || result.stdout).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

describe("Quiver Hub polling Retry-After parsing", () => {
  it("accepts ASCII integer seconds including zero and large finite cooldowns", () => {
    runPythonStub(`
for value, expected in [("0", 0.0), ("7", 7.0), ("00012", 12.0),
                        ("1000000000000", 1000000000000.0)]:
    actual = hub._parse_retry_after(value, now=1700000000.0)
    assert actual == expected, (value, actual)
    assert math.isfinite(actual)
`);
  });

  it("uses the supplied Unix clock for aware HTTP dates and clamps past dates to zero", () => {
    runPythonStub(`
from email.utils import formatdate
now = 1700000000.0
hub.time.time = lambda: now + 100000
assert hub._parse_retry_after(formatdate(now + 125, usegmt=True), now=now) == 125
assert hub._parse_retry_after(formatdate(now, usegmt=True), now=now) == 0
assert hub._parse_retry_after(formatdate(now - 125, usegmt=True), now=now) == 0
hub.time.time = lambda: now
assert hub._parse_retry_after(formatdate(now + 45, usegmt=True)) == 45
`);
  });

  it("rejects malformed, negative, nonfinite, non-ASCII, and timezone-naive values", () => {
    runPythonStub(`
invalid = [None, "", "-1", "+1", "1.5", "1e3", "nan", "NaN", "inf",
           "Infinity", "-Infinity", "١٢", "１２", "7 seconds", "not a date",
           "Wed, 21 Oct 2015 07:28:00", "Wed, 99 Oct 2015 07:28:00 GMT"]
for value in invalid:
    assert hub._parse_retry_after(value, now=1700000000.0) is None, repr(value)
`);
  });

  it("returns None rather than raising or returning infinity for overflowing integers", () => {
    runPythonStub(`
for value in ("9" * 400, "9" * 10000):
    assert hub._parse_retry_after(value, now=1700000000.0) is None
`);
  });
});

describe("Quiver Hub polling backoff and recovery", () => {
  it.each(["lower", "upper"] as const)(
    "doubles the failure ceiling, saturates at 300, and permits the %s equal-jitter endpoint",
    endpoint => {
      runPythonStub(`
endpoint = ${JSON.stringify(endpoint)}
def jitter(low, high):
    jitter_calls.append((low, high))
    return low if endpoint == "lower" else high
hub.random.uniform = jitter
responses = [Response(503) for _ in range(9)]
client, session = new_client(responses)
assert client.next_poll_delay == 5
ceilings = [10, 20, 40, 80, 160, 300, 300, 300, 300]
for index, ceiling in enumerate(ceilings):
    assert client.get_pending_jobs() == []
    expected_bounds = (max(5, ceiling / 2), ceiling)
    assert jitter_calls[-1] == expected_bounds, (index, jitter_calls)
    assert client.next_poll_delay == expected_bounds[0 if endpoint == "lower" else 1]
    assert len(session.get_calls) == index + 1
assert len(jitter_calls) == len(responses)
assert all(response.closed == 1 for response in responses)
assert session.post_calls == []
`);
    }
  );

  it("uses the ten-second initial ceiling even with a subsecond configured interval", () => {
    runPythonStub(`
client, session = new_client([Response(502)], interval=0.25)
assert client.next_poll_delay == 0.25
assert client.get_pending_jobs() == []
assert jitter_calls == [(5, 10)]
assert client.next_poll_delay == 10
assert len(session.get_calls) == 1
`);
  });

  it.each([300, 600, 3600])(
    "retains exponential growth and jitter above a configured %s-second interval",
    interval => {
      runPythonStub(`
interval = ${interval}
responses = [Response(503) for _ in range(10)]
client, session = new_client(responses, interval=interval)
assert client.next_poll_delay == interval
for index, response in enumerate(responses):
    assert client.get_pending_jobs() == []
    low, high = jitter_calls[-1]
    assert interval <= low < high
    assert high == min(4 * interval, 2 * interval * (2 ** index))
    assert client.next_poll_delay >= interval
assert jitter_calls[-1] == (2 * interval, 4 * interval)
assert client.next_poll_delay == 4 * interval
assert len(session.get_calls) == len(responses)
`);
    }
  );

  it.each([408, 429, 500, 503, 599])(
    "honors a valid Retry-After as a minimum above the local cap on HTTP %s",
    status => {
      runPythonStub(`
response = Response(${status}, headers={"Retry-After": "900"})
client, session = new_client([response])
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 900
assert jitter_calls == [(5, 10)]
assert response.closed == 1
assert response.json_calls == 0
assert len(session.get_calls) == 1
`);
    }
  );

  it("honors HTTP-date cooldowns while zero, past, missing, and malformed headers use jitter", () => {
    runPythonStub(`
from email.utils import formatdate
now = 1700000000.0
hub.time.time = lambda: now
headers = [
    {"Retry-After": formatdate(now + 700, usegmt=True)},
    {"Retry-After": "0"},
    {"Retry-After": formatdate(now - 700, usegmt=True)},
    {}, {"Retry-After": "later"}, {"Retry-After": "9" * 400},
]
for header in headers:
    client, session = new_client([Response(429, headers=header)])
    assert client.get_pending_jobs() == []
    assert client.next_poll_delay == (700 if header is headers[0] else 10)
    assert len(session.get_calls) == 1
`);
  });

  it.each([401, 403])(
    "backs off HTTP %s without trusting Retry-After or a success-shaped error body",
    status => {
      runPythonStub(`
response = Response(${status}, value=trpc([]), headers={"Retry-After": "900"})
client, session = new_client([Response(503), response])
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 10
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 20
assert response.json_calls == 0
assert response.closed == 1
assert len(session.get_calls) == 2
assert session.post_calls == []
`);
    }
  );

  it("recovers from 429 to 502 to timeout, filters individual jobs, and resets exponential state", () => {
    runPythonStub(`
valid = {"id": 7, "type": "update_config", "payload": {"config": {}}}
responses = [
    Response(429, headers={"Retry-After": "120"}),
    Response(502),
    hub.requests.Timeout("timeout https://hub.example?apiKey=timeout-secret"),
    Response(value=trpc([None, "bad", {}, {"id": True, "type": "x", "payload": {}},
                         {"id": 8, "type": "x", "payload": []}, valid])),
    Response(503),
]
client, session = new_client(responses)
for index, expected_delay in enumerate([120, 20, 40]):
    assert client.get_pending_jobs() == []
    assert client.next_poll_delay == expected_delay
    assert len(session.get_calls) == index + 1
assert client.get_pending_jobs() == [valid]
assert client.next_poll_delay == client.poll_interval == 5
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 10
assert jitter_calls == [(5, 10), (10, 20), (20, 40), (5, 10)]
assert len(session.get_calls) == 5
assert session.post_calls == []
assert all(response.closed == 1 for response in responses if isinstance(response, Response))
`);
  });

  it("does not reset on invalid 2xx JSON or schema, but does reset on an empty jobs list", () => {
    runPythonStub(`
malformed = [
    Response(json_error=ValueError("JSON body-secret")),
    Response(value=[]), Response(value={}), Response(value={"result": []}),
    Response(value={"result": {"data": []}}),
    Response(value={"result": {"data": {"json": []}}}),
    Response(value={"result": {"data": {"json": {}}}}),
    Response(value=trpc(None)), Response(value=trpc({})),
]
empty = Response(value=trpc([]))
next_failure = Response(502)
responses = [Response(503), *malformed, empty, next_failure]
client, session = new_client(responses)
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 10
for index, response in enumerate(malformed):
    assert client.get_pending_jobs() == []
    assert client.next_poll_delay == min(300, 20 * (2 ** index)), index
    assert response.closed == 1
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 5
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 10
assert all(response.closed == 1 for response in responses)
assert len(session.get_calls) == len(responses)
`);
  });

  it("does not count a nonempty list of only malformed jobs as recovery", () => {
    runPythonStub(`
client, session = new_client([Response(503), Response(value=trpc([None, {}, "bad"]))])
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 10
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 20
assert jitter_calls == [(5, 10), (10, 20)]
`);
  });

  it("closes responses on transport rejection and tolerates missing or failing close methods", () => {
    runPythonStub(`
unsafe = Response(url="http://hub.example/poll?apiKey=redirect-secret")
close_failure = Response(close_error=True)
without_close = types.SimpleNamespace(
    status_code=200, headers={}, url="https://hub.example/poll",
    raise_for_status=lambda: None, json=lambda: trpc([]),
)
client, session = new_client([unsafe, close_failure, without_close])
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 10
assert unsafe.closed == 1
assert unsafe.json_calls == 0
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 5
assert close_failure.closed == 1
assert client.get_pending_jobs() == []
assert client.next_poll_delay == 5
assert len(session.get_calls) == 3
`);
  });

  it("logs numeric HTTP status and next delay without exception URLs, credentials, headers, or bodies", () => {
    runPythonStub(`
response = Response(429, value={"body-secret": True}, headers={
    "Retry-After": "120", "Authorization": "Bearer header-secret",
})
client, session = new_client([
    response,
    hub.requests.Timeout("failed https://hub.example?apiKey=timeout-secret"),
    Response(json_error=ValueError("invalid JSON json-secret")),
])
stream = io.StringIO()
handler = logging.StreamHandler(stream)
hub.logger.addHandler(handler)
try:
    for _ in range(3):
        assert client.get_pending_jobs() == []
finally:
    hub.logger.removeHandler(handler)
logs = stream.getvalue()
assert re.search(r"(?<![0-9])429(?![0-9])", logs), logs
assert re.search(r"(?<![0-9])120(?:[.]0)?(?![0-9])", logs), logs
for secret in ("url-secret", "timeout-secret", "api-key-secret", "header-secret",
               "body-secret", "exception-body-secret", "json-secret", "https://",
               "apiKey", "Authorization"):
    assert secret not in logs, (secret, logs)
assert len(session.get_calls) == 3
`);
  });

  it("never replays acknowledge or completion POSTs after a request failure", () => {
    runPythonStub(`
client, session = new_client()
assert client.acknowledge_job(7) is False
assert len(session.post_calls) == 1
assert client.complete_job(7, False, "job failed") is False
assert len(session.post_calls) == 2
assert session.get_calls == []
assert client.next_poll_delay == 5
`);
  });
});

describe("Quiver Hub serial poll loop", () => {
  it("polls immediately and uses the updated delay through _wait_for_next_poll before each later poll", () => {
    runPythonStub(`
clock = Clock()
clock.install()
responses = [Response(429, headers={"Retry-After": "125"}), Response(value=trpc([]))]
client, session = new_client(responses)
events = []
original_get = session.get
def get(url, **kwargs):
    events.append(("poll", clock.current))
    if len(events) == 3:
        raise KeyboardInterrupt()
    return original_get(url, **kwargs)
session.get = get
original_wait = client._wait_for_next_poll
waits = []
def wait():
    waits.append(client.next_poll_delay)
    return original_wait()
client._wait_for_next_poll = wait
client.run()
assert events == [("poll", 100), ("poll", 225), ("poll", 230)], events
assert waits == [125, 5], waits
assert clock.sleeps == [60, 60, 5, 5], clock.sleeps
assert all(response.closed == 1 for response in responses)
assert session.closed == 1
assert session.post_calls == []
`);
  });

  it("uses elapsed monotonic time rather than assuming a sleep consumed its whole chunk", () => {
    runPythonStub(`
clock = Clock()
clock.install()
client, session = new_client()
client.next_poll_delay = 10
sleeps = []
def partial_sleep(seconds):
    sleeps.append(seconds)
    clock.current += seconds / 2 if len(sleeps) == 1 else seconds
    clock.wall += 100000
hub.time.sleep = partial_sleep
client._wait_for_next_poll()
assert sleeps == [10, 5], sleeps
assert clock.current == 110
assert session.get_calls == []
`);
  });

  it("keeps an enormous server cooldown interruptible in at-most-60-second chunks and closes Session", () => {
    runPythonStub(`
clock = Clock()
clock.interrupt_on_sleep = 2
clock.install()
response = Response(429, headers={"Retry-After": "1000000000000"})
client, session = new_client([response])
client.run()
assert client.next_poll_delay == 1000000000000
assert clock.sleeps == [60, 60], clock.sleeps
assert len(session.get_calls) == 1
assert response.closed == 1
assert session.closed == 1
assert session.post_calls == []
`);
  });

  it("closes Session when Ctrl+C arrives during the first immediate poll", () => {
    runPythonStub(`
client, session = new_client([KeyboardInterrupt()])
client.run()
assert len(session.get_calls) == 1
assert session.closed == 1
assert session.post_calls == []
`);
  });

  it("closes Session on a fatal run-loop error without logging the exception's secrets", () => {
    runPythonStub(`
client, session = new_client()
def fatal():
    raise RuntimeError("fatal https://hub.example?apiKey=fatal-secret")
client.get_pending_jobs = fatal
stream = io.StringIO()
handler = logging.StreamHandler(stream)
hub.logger.addHandler(handler)
try:
    try:
        client.run()
    except SystemExit as error:
        assert error.code == 1
    else:
        raise AssertionError("fatal run error must retain the existing nonzero exit")
finally:
    hub.logger.removeHandler(handler)
assert session.closed == 1
assert "fatal-secret" not in stream.getvalue()
assert "https://" not in stream.getvalue()
`);
  });
});
