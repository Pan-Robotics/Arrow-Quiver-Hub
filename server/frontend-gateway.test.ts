import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNAUTHED_ERR_MSG } from "../shared/const";
import {
  GatewayCooldown,
  GatewayHttpError,
  createGatewayFetch,
  gatewayError,
  isTransientApiError,
  parseRetryAfterMs,
  queryRetryDelay,
  safeApiErrorMetadata,
  shouldRetryQuery,
} from "../client/src/lib/gatewayTransport";

// This router supplies actual client types only. Its procedures are never invoked:
// every HTTP request is handled by an injected fake fetch, not a server or login.
const t = initTRPC.create({ transformer: superjson });
const procedure = t.procedure.input((input: unknown) => input);
const fixtureRouter = t.router({
  read: procedure.query(() => null),
  other: procedure.query(() => null),
  write: procedure.mutation(() => null),
  auth: t.router({ me: t.procedure.query(() => null) }),
});
type FixtureRouter = typeof fixtureRouter;

const START = Date.parse("Mon, 02 Nov 2026 19:30:00 GMT");
const SECRET = "private-body-token=do-not-expose";

function clock(random = 0) {
  let now = START;
  const cooldown = new GatewayCooldown(
    () => now,
    () => random
  );
  return {
    cooldown,
    now: () => now,
    set: (value: number) => {
      now = value;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function client(cooldown: GatewayCooldown, fetcher: typeof fetch) {
  return createTRPCClient<FixtureRouter>({
    links: [
      httpBatchLink({
        url: "https://gateway.invalid/api/trpc",
        transformer: superjson,
        fetch: createGatewayFetch(cooldown, fetcher),
      }),
    ],
  });
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: HeadersInit = {}
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function success(data: unknown) {
  return jsonResponse([{ result: { data: superjson.serialize(data) } }]);
}

function authResponse(code: "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST") {
  const httpStatus = { UNAUTHORIZED: 401, FORBIDDEN: 403, BAD_REQUEST: 400 }[
    code
  ];
  const shape = {
    message:
      code === "UNAUTHORIZED" ? UNAUTHED_ERR_MSG : `Existing ${code} message`,
    code: { UNAUTHORIZED: -32001, FORBIDDEN: -32003, BAD_REQUEST: -32600 }[
      code
    ],
    data: { code, httpStatus, path: "auth.me" },
  };
  return {
    shape,
    response: jsonResponse([{ error: superjson.serialize(shape) }], httpStatus),
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected the operation to reject, but it succeeded");
}

async function trpcRejection(promise: Promise<unknown>) {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(TRPCClientError);
  return error as TRPCClientError<FixtureRouter>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function expectSanitized(error: Error) {
  const exposed = `${inspect(error, { depth: 10 })}\n${JSON.stringify(error)}`;
  expect(exposed).not.toContain(SECRET);
  expect(exposed).not.toContain("<html>");
  expect(exposed).not.toContain("SyntaxError");
  expect(gatewayError(error)?.cause).toBeUndefined();
}

beforeEach(() => {
  // Even an accidental use of default fetch cannot touch the network.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error(
      "Unexpected real network request in frontend gateway tests"
    );
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("frontend Retry-After parser", () => {
  it.each([
    ["0", 0],
    ["7", 7_000],
    ["00012", 12_000],
    [" 120 ", 120_000],
    ["1000000000000", 1_000_000_000_000_000],
  ] as const)(
    "accepts integer delta seconds %s without a local backoff cap",
    (header, expected) => {
      expect(parseRetryAfterMs(header, START)).toBe(expected);
    }
  );

  it.each(["GMT", "UTC", "+0000"])(
    "honors an explicit %s HTTP date using the injected clock",
    timezone => {
      const future = new Date(START + 125_000)
        .toUTCString()
        .replace(/GMT$/, timezone);
      expect(parseRetryAfterMs(future, START)).toBe(125_000);
    }
  );

  it.each([0, -125_000])(
    "clamps present/past HTTP dates (%s ms) to zero",
    offset => {
      expect(
        parseRetryAfterMs(new Date(START + offset).toUTCString(), START)
      ).toBe(0);
    }
  );

  it.each(
    [
      null,
      "",
      "   ",
      "-1",
      "+1",
      "1.5",
      "1e3",
      "NaN",
      "Infinity",
      "-Infinity",
      "١٢",
      "１２",
      "7 seconds",
      "later",
      "Mon, 02 Nov 2026 19:32:00",
      "Mon, 99 Nov 2026 19:32:00 GMT",
      "Mon, 02 Nov 2026 19:32:00 PST",
      "9".repeat(400),
      "9".repeat(10_000),
    ].map(header => ({
      label:
        header && header.length > 100
          ? `${header.length}-digit overflow`
          : JSON.stringify(header),
      header,
    }))
  )("rejects malformed or overflowing Retry-After $label", ({ header }) => {
    expect(parseRetryAfterMs(header, START)).toBeUndefined();
  });

  it("rejects a finite delay when adding it to the clock overflows the deadline", () => {
    expect(
      parseRetryAfterMs("1" + "0".repeat(305), Number.MAX_VALUE)
    ).toBeUndefined();
  });
});

describe("real tRPC httpBatchLink gateway error handling", () => {
  it.each([
    [429, "text/html; charset=utf-8"],
    [502, "text/html"],
    [429, "text/plain"],
    [502, "text/plain"],
    [200, "text/html"],
    [503, "text/html"],
  ] as const)(
    "sanitizes HTTP %s %s before tRPC attempts JSON parsing",
    async (status, contentType) => {
      const c = clock();
      const response = new Response(`<html>${SECRET}</html>`, {
        status,
        headers: { "Content-Type": contentType, "Retry-After": "120" },
      });
      const parse = vi.spyOn(response, "json");
      const text = vi.spyOn(response, "text");
      const cancel = vi.spyOn(response.body!, "cancel");
      const logs = ["log", "warn", "error", "debug"].map(method =>
        vi
          .spyOn(console, method as "log" | "warn" | "error" | "debug")
          .mockImplementation(() => undefined)
      );
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const error = await trpcRejection(
        client(c.cooldown, fetcher).read.query(undefined)
      );
      const expectedStatus = status === 200 ? 502 : status;

      expect(error.cause).toBeInstanceOf(GatewayHttpError);
      expect(gatewayError(error)).toBe(error.cause);
      expect(gatewayError(error)).toMatchObject({
        status: expectedStatus,
        retryAt: START + 120_000,
      });
      expect(c.cooldown.getSnapshot()).toEqual({
        status: expectedStatus,
        retryAt: START + 120_000,
        active: true,
      });
      expect(error.data).toBeUndefined();
      expect(parse).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1]?.credentials).toBe("include");
      expectSanitized(error);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    }
  );

  it.each([200, 503])(
    "converts malformed application/json HTTP %s into a safe 502 with its tRPC cause intact",
    async status => {
      const c = clock();
      const response = new Response(`{broken:${SECRET}`, {
        status,
        headers: { "Content-Type": "application/json" },
      });
      const parse = vi.spyOn(response, "json");
      const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const error = await trpcRejection(
        client(c.cooldown, fetcher).read.query(undefined)
      );

      expect(error.cause).toBeInstanceOf(GatewayHttpError);
      expect(gatewayError(error)).toMatchObject({
        status: 502,
        retryAt: START + 5_000,
      });
      expect(c.cooldown.remainingMs()).toBe(5_000);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expectSanitized(error);
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      label: "gateway object",
      payload: { message: SECRET, url: `https://gateway.invalid/?${SECRET}` },
    },
    { label: "null", payload: null },
    { label: "empty batch", payload: [] },
    { label: "primitive", payload: SECRET },
    { label: "result without data", payload: { result: { message: SECRET } } },
    {
      label: "string error code",
      payload: { error: { message: SECRET, code: "INTERNAL_SERVER_ERROR" } },
    },
    {
      label: "fractional error code",
      payload: { error: { message: SECRET, code: -32001.5 } },
    },
    {
      label: "missing error message",
      payload: { error: { code: -32603, data: SECRET } },
    },
    {
      label: "invalid SuperJSON error",
      payload: { error: { json: { message: SECRET, code: "-32603" } } },
    },
    {
      label: "ambiguous result and error",
      payload: {
        result: { data: SECRET },
        error: { message: SECRET, code: -32603 },
      },
    },
    {
      label: "mixed valid and invalid batch",
      payload: [
        { result: { data: superjson.serialize(null) } },
        { message: SECRET },
      ],
    },
  ])(
    "rejects a valid JSON $label on HTTP 200 as a safe 502, never as recovery",
    async ({ payload }) => {
      const c = clock();
      c.cooldown.fail(429, "120");
      c.set(c.cooldown.getSnapshot().retryAt);
      const listener = vi.fn();
      c.cooldown.subscribe(listener);
      const response = jsonResponse(payload);
      const parse = vi.spyOn(response, "json");
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const error = await trpcRejection(
        client(c.cooldown, fetcher).read.query(undefined)
      );

      expect(error.cause).toBeInstanceOf(GatewayHttpError);
      expect(gatewayError(error)).toMatchObject({
        status: 502,
        retryAt: c.now() + 10_000,
      });
      expect(error.data).toBeUndefined();
      expect(error.meta?.responseJSON).toBeUndefined();
      expect(c.cooldown.getSnapshot()).toEqual({
        status: 502,
        retryAt: c.now() + 10_000,
        active: true,
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(safeApiErrorMetadata(error)).toEqual({
        status: 502,
        code: "GATEWAY_ERROR",
      });
      expectSanitized(error);
    }
  );

  it.each([400, 401])(
    "does not accept an HTTP %s gateway JSON object as an authentic app error",
    async status => {
      const c = clock();
      c.cooldown.fail(502);
      c.set(c.cooldown.getSnapshot().retryAt);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({ message: SECRET, code: "UNAUTHORIZED" }, status)
        );
      const error = await trpcRejection(
        client(c.cooldown, fetcher).auth.me.query()
      );

      expect(gatewayError(error)).toMatchObject({
        status: 502,
        retryAt: c.now() + 10_000,
      });
      expect(error.meta?.responseJSON).toBeUndefined();
      expect(c.cooldown.getSnapshot().active).toBe(true);
      expectSanitized(error);
    }
  );

  it.each([
    [500, "INTERNAL_SERVER_ERROR", -32603],
    [429, "TOO_MANY_REQUESTS", -32029],
  ] as const)(
    "preserves genuine HTTP %s tRPC %s code/data/path/message while starting a shared cooldown",
    async (status, code, numericCode) => {
      const c = clock();
      const shape = {
        message: `Existing application message ${SECRET}`,
        code: numericCode,
        data: { code, httpStatus: status, path: "read", detail: SECRET },
      };
      const response = jsonResponse(
        [{ error: superjson.serialize(shape) }],
        status,
        { "Retry-After": "120" }
      );
      const parse = vi.spyOn(response, "json");
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const api = client(c.cooldown, fetcher);
      const error = await trpcRejection(api.read.query(undefined));

      expect(error.message).toBe(shape.message);
      expect(error.shape).toEqual(shape);
      expect(error.data).toEqual(shape.data);
      expect(gatewayError(error)).toBeUndefined();
      expect(c.cooldown.getSnapshot()).toEqual({
        status,
        retryAt: START + 120_000,
        active: true,
      });
      expect(isTransientApiError(error)).toBe(true);
      expect([0, 1, 2, 3].map(count => shouldRetryQuery(count, error))).toEqual(
        [true, true, true, false]
      );
      expect(queryRetryDelay(0, error, c.cooldown)).toBe(120_000);
      expect(safeApiErrorMetadata(error)).toEqual({ status, code });
      expect(JSON.stringify(safeApiErrorMetadata(error))).not.toContain(SECRET);
      const blocked = await trpcRejection(
        api.write.mutate({ nonIdempotent: true })
      );
      expect(gatewayError(blocked)).toMatchObject({
        status,
        retryAt: START + 120_000,
      });
      expect(parse).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );

  it("round-trips real SuperJSON result types and batches two simultaneous queries", async () => {
    const c = clock();
    const payload = {
      date: new Date(START),
      count: 12345678901234567890n,
      map: new Map([["sensor", 42]]),
      set: new Set(["online"]),
      optional: undefined,
      notANumber: Number.NaN,
    };
    const response = jsonResponse([
      { result: { data: superjson.serialize(payload) } },
      { result: { data: superjson.serialize(null) } },
    ]);
    const parse = vi.spyOn(response, "json");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const api = client(c.cooldown, fetcher);
    const results = await Promise.all([
      api.read.query(undefined),
      api.other.query(undefined),
    ]);

    expect(results).toEqual([payload, null]);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("read,other");
    expect(c.cooldown.getSnapshot()).toEqual({
      status: 0,
      retryAt: 0,
      active: false,
    });
  });

  it.each([null, { id: 7, name: "Existing session user", role: "user" }])(
    "preserves an ordinary auth.me success envelope: %j",
    async user => {
      const c = clock();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(success(user));
      expect(await client(c.cooldown, fetcher).auth.me.query()).toEqual(user);
      expect(c.cooldown.remainingMs()).toBe(0);
    }
  );

  it.each(["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST"] as const)(
    "leaves the valid %s tRPC auth envelope unchanged and does not retry it",
    async code => {
      const c = clock();
      const { shape, response } = authResponse(code);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const error = await trpcRejection(
        client(c.cooldown, fetcher).auth.me.query()
      );

      expect(error.message).toBe(shape.message);
      expect(error.shape).toEqual(shape);
      expect(error.data).toEqual(shape.data);
      expect(gatewayError(error)).toBeUndefined();
      expect(c.cooldown.getSnapshot()).toEqual({
        status: 0,
        retryAt: 0,
        active: false,
      });
      expect(shouldRetryQuery(0, error)).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );

  it.each([401, 403, 404])(
    "sanitizes non-JSON HTTP %s without treating it as a temporary outage",
    async status => {
      const c = clock();
      const response = new Response(`<html>${SECRET}</html>`, {
        status,
        headers: { "Content-Type": "text/html", "Retry-After": "900" },
      });
      const error = await trpcRejection(
        client(
          c.cooldown,
          vi.fn<typeof fetch>().mockResolvedValue(response)
        ).read.query(undefined)
      );
      expect(gatewayError(error)).toMatchObject({ status, retryAt: 0 });
      expect(c.cooldown.remainingMs()).toBe(0);
      expect(shouldRetryQuery(0, error)).toBe(false);
      expectSanitized(error);
    }
  );

  it("puts network failures into cooldown without exposing the original request error or retrying", async () => {
    const c = clock();
    const networkError = new TypeError(
      `Failed to fetch https://gateway.invalid/?${SECRET}`
    );
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(networkError);
    const error = await trpcRejection(
      client(c.cooldown, fetcher).read.query(undefined)
    );
    expect(error.cause).toBeInstanceOf(GatewayHttpError);
    expect(error.cause).not.toBe(networkError);
    expect(gatewayError(error)).toMatchObject({
      status: 503,
      retryAt: START + 5_000,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expectSanitized(error);
  });
});

describe("production fetch wrapper: cancellation, unchanged responses, and recovery", () => {
  it("returns the same JSON Response, parses once, and preserves credentials and request options", async () => {
    const c = clock();
    const payload = [
      { result: { data: superjson.serialize({ date: new Date(START) }) } },
    ];
    const response = jsonResponse(payload, 200, { "X-Existing": "unchanged" });
    const parse = vi.spyOn(response, "json");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const signal = new AbortController().signal;
    const headers = { "X-Request": "unchanged" };
    const wrapped = await createGatewayFetch(c.cooldown, fetcher)(
      "https://gateway.invalid",
      {
        method: "POST",
        body: "existing serialized input",
        headers,
        signal,
        credentials: "omit",
      }
    );

    expect(wrapped).toBe(response);
    expect(wrapped.headers.get("X-Existing")).toBe("unchanged");
    expect(await wrapped.json()).toEqual(payload);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toEqual({
      method: "POST",
      body: "existing serialized input",
      headers,
      signal,
      credentials: "include",
    });
  });

  it("accepts JSON-suffix media types without changing their payload", async () => {
    const c = clock();
    const payload = {
      result: { data: superjson.serialize({ unchanged: true }) },
    };
    const response = jsonResponse(payload, 200, {
      "Content-Type": "Application/Problem+JSON; charset=utf-8",
    });
    const wrapped = await createGatewayFetch(
      c.cooldown,
      vi.fn<typeof fetch>().mockResolvedValue(response)
    )("https://gateway.invalid");
    expect(wrapped).toBe(response);
    expect(await wrapped.json()).toEqual(payload);
    expect(c.cooldown.remainingMs()).toBe(0);
  });

  it.each([
    { label: "single result", payload: { result: { data: null } } },
    {
      label: "batched result",
      payload: [{ result: { data: { json: null } } }],
    },
    {
      label: "single direct error",
      payload: { error: { message: "Existing error", code: -32600 } },
    },
    {
      label: "batched direct error",
      payload: [{ error: { message: "Existing error", code: -32600 } }],
    },
    {
      label: "single SuperJSON error",
      payload: {
        error: superjson.serialize({ message: "Existing error", code: -32600 }),
      },
    },
    {
      label: "batched SuperJSON error",
      payload: [
        {
          error: superjson.serialize({
            message: "Existing error",
            code: -32600,
          }),
        },
      ],
    },
  ])(
    "accepts an authentic $label envelope without rewriting its JSON",
    async ({ payload }) => {
      const c = clock();
      c.cooldown.fail(502);
      c.set(c.cooldown.getSnapshot().retryAt);
      const response = jsonResponse(payload);
      const parse = vi.spyOn(response, "json");
      const wrapped = await createGatewayFetch(
        c.cooldown,
        vi.fn<typeof fetch>().mockResolvedValue(response)
      )("https://gateway.invalid");

      expect(c.cooldown.getSnapshot().active).toBe(true);
      expect(wrapped).toBe(response);
      expect(await wrapped.json()).toEqual(payload);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(c.cooldown.getSnapshot()).toEqual({
        status: 0,
        retryAt: 0,
        active: false,
      });
    }
  );

  it.each(["AbortError", "aborted signal"])(
    "preserves intentional %s rejection identity without cooldown",
    async mode => {
      const c = clock();
      const controller = new AbortController();
      const original =
        mode === "AbortError"
          ? new DOMException("Deliberately cancelled", "AbortError")
          : new Error("Cancellation supplied by caller");
      if (mode === "aborted signal") controller.abort();
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(original);
      const error = await rejection(
        createGatewayFetch(c.cooldown, fetcher)("https://gateway.invalid", {
          signal: controller.signal,
        })
      );
      expect(error).toBe(original);
      expect(gatewayError(error)).toBeUndefined();
      expect(c.cooldown.getSnapshot()).toEqual({
        status: 0,
        retryAt: 0,
        active: false,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["AbortError", "aborted signal"])(
    "does not mistake %s during JSON consumption for a malformed gateway body",
    async mode => {
      const c = clock();
      const controller = new AbortController();
      const original =
        mode === "AbortError"
          ? new DOMException("Body read deliberately cancelled", "AbortError")
          : new Error("Body cancelled by caller");
      const response = success(null);
      vi.spyOn(response, "json").mockRejectedValue(original);
      const wrapped = await createGatewayFetch(
        c.cooldown,
        vi.fn<typeof fetch>().mockResolvedValue(response)
      )("https://gateway.invalid", { signal: controller.signal });
      if (mode === "aborted signal") controller.abort();
      expect(await rejection(wrapped.json())).toBe(original);
      expect(c.cooldown.getSnapshot()).toEqual({
        status: 0,
        retryAt: 0,
        active: false,
      });
    }
  );

  it("does not let an earlier in-flight 200 clear a newer 429 cooldown", async () => {
    const c = clock();
    const pendingResponse = deferred<Response>();
    const requestStarted = deferred<void>();
    const lateFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      requestStarted.resolve();
      return pendingResponse.promise;
    });
    const lateSuccess = client(c.cooldown, lateFetch).read.query(undefined);
    await requestStarted.promise;
    const failureFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(SECRET, {
        status: 429,
        headers: { "Content-Type": "text/html", "Retry-After": "120" },
      })
    );
    await trpcRejection(
      client(c.cooldown, failureFetch).other.query(undefined)
    );
    const newerSnapshot = c.cooldown.getSnapshot();
    pendingResponse.resolve(success({ late: true }));

    expect(await lateSuccess).toEqual({ late: true });
    expect(c.cooldown.getSnapshot()).toBe(newerSnapshot);
    expect(c.cooldown.remainingMs()).toBe(120_000);
    expect(() => c.cooldown.check()).toThrow(GatewayHttpError);
    expect(lateFetch).toHaveBeenCalledTimes(1);
    expect(failureFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["BAD_REQUEST", "UNAUTHORIZED"] as const)(
    "clears an expired older cooldown after an authentic %s response and resets backoff",
    async code => {
      const c = clock();
      c.cooldown.fail(502);
      c.set(c.cooldown.getSnapshot().retryAt);
      const listener = vi.fn();
      c.cooldown.subscribe(listener);
      const { shape, response } = authResponse(code);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(new Response(SECRET, { status: 502 }));
      const error = await trpcRejection(
        client(c.cooldown, fetcher).auth.me.query()
      );

      expect(error.shape).toEqual(shape);
      expect(gatewayError(error)).toBeUndefined();
      expect(shouldRetryQuery(0, error)).toBe(false);
      expect(c.cooldown.getSnapshot()).toEqual({
        status: 0,
        retryAt: 0,
        active: false,
      });
      expect(listener).toHaveBeenCalledTimes(1);
      await trpcRejection(client(c.cooldown, fetcher).read.query(undefined));
      expect(c.cooldown.remainingMs()).toBe(5_000);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  );

  it.each(["BAD_REQUEST", "UNAUTHORIZED"] as const)(
    "does not let an earlier in-flight authentic %s response clear a newer cooldown",
    async code => {
      const c = clock();
      c.cooldown.fail(502);
      c.set(c.cooldown.getSnapshot().retryAt);
      const pendingResponse = deferred<Response>();
      const requestStarted = deferred<void>();
      const lateFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
        requestStarted.resolve();
        return pendingResponse.promise;
      });
      const lateError = trpcRejection(
        client(c.cooldown, lateFetch).auth.me.query()
      );
      await requestStarted.promise;
      c.cooldown.fail(429, "120");
      const newerSnapshot = c.cooldown.getSnapshot();
      const { shape, response } = authResponse(code);
      pendingResponse.resolve(response);

      expect((await lateError).shape).toEqual(shape);
      expect(c.cooldown.getSnapshot()).toBe(newerSnapshot);
      expect(c.cooldown.remainingMs()).toBe(120_000);
      expect(() => c.cooldown.check()).toThrow(GatewayHttpError);
      expect(lateFetch).toHaveBeenCalledTimes(1);
    }
  );

  it("recovers only after a post-deadline success is parsed and resets local exponential backoff", async () => {
    const c = clock();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(SECRET, { status: 502 }))
      .mockResolvedValueOnce(new Response(SECRET, { status: 502 }))
      .mockResolvedValueOnce(success({ healthy: true }))
      .mockResolvedValueOnce(new Response(SECRET, { status: 502 }));
    const wrappedFetch = createGatewayFetch(c.cooldown, fetcher);
    await rejection(wrappedFetch("https://gateway.invalid"));
    expect(c.cooldown.remainingMs()).toBe(5_000);
    c.set(c.cooldown.getSnapshot().retryAt);
    await rejection(wrappedFetch("https://gateway.invalid"));
    expect(c.cooldown.remainingMs()).toBe(10_000);
    c.set(c.cooldown.getSnapshot().retryAt);
    const response = await wrappedFetch("https://gateway.invalid");
    expect(c.cooldown.getSnapshot().active).toBe(true);
    await response.json();
    expect(c.cooldown.getSnapshot()).toEqual({
      status: 0,
      retryAt: 0,
      active: false,
    });
    await rejection(wrappedFetch("https://gateway.invalid"));
    expect(c.cooldown.remainingMs()).toBe(5_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe("shared browser cooldown and no hidden request replay", () => {
  it("blocks all clients' batched queries and POST mutations until the exact Retry-After deadline", async () => {
    const c = clock();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(SECRET, {
          status: 429,
          headers: { "Content-Type": "text/html", "Retry-After": "120" },
        })
      )
      .mockResolvedValueOnce(success({ applied: true }));
    const first = client(c.cooldown, fetcher);
    const second = client(c.cooldown, fetcher);
    const initial = await trpcRejection(first.read.query(undefined));
    const retryAt = gatewayError(initial)!.retryAt;
    const blocked = await Promise.all([
      trpcRejection(first.read.query(undefined)),
      trpcRejection(first.other.query(undefined)),
      trpcRejection(second.auth.me.query()),
      trpcRejection(second.write.mutate({ command: "must not be sent" })),
    ]);
    for (const error of blocked) {
      expect(gatewayError(error)).toMatchObject({ status: 429, retryAt });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(c.cooldown.getSnapshot().retryAt).toBe(retryAt);
    c.set(retryAt - 1);
    await trpcRejection(first.write.mutate({ command: "still blocked" }));
    expect(fetcher).toHaveBeenCalledTimes(1);

    c.set(retryAt);
    expect(
      await second.write.mutate({ command: "explicit user action" })
    ).toEqual({ applied: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
    expect(fetcher.mock.calls[1][1]?.method).toBe("POST");
    const input = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
    expect(superjson.deserialize(input["0"])).toEqual({
      command: "explicit user action",
    });
    expect(c.cooldown.getSnapshot().active).toBe(false);
  });

  it("sends a failed mutation once, then only sends the explicitly requested recovery query", async () => {
    const c = clock();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError(`Network failure ${SECRET}`))
      .mockResolvedValueOnce(success({ recovered: true }));
    const api = client(c.cooldown, fetcher);
    await trpcRejection(api.write.mutate({ nonIdempotent: true }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    c.set(c.cooldown.getSnapshot().retryAt);
    expect(await api.read.query(undefined)).toEqual({ recovered: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual([
      "POST",
      "GET",
    ]);
  });

  it.each([
    [0, [5_000, 10_000, 20_000, 40_000, 80_000, 150_000]],
    [0.5, [7_500, 15_000, 30_000, 60_000, 120_000, 225_000]],
    [1, [10_000, 20_000, 40_000, 80_000, 160_000, 300_000]],
  ] as const)(
    "escalates equal jitter at random=%s and saturates the local cap for repeated failures",
    (random, delays) => {
      const c = clock(random);
      for (let index = 0; index < 22; index++) {
        const error = c.cooldown.fail(502);
        expect(c.cooldown.remainingMs()).toBe(
          delays[Math.min(index, delays.length - 1)]
        );
        expect(error.retryAt).toBe(c.cooldown.getSnapshot().retryAt);
        expect(() => c.cooldown.check()).toThrow(GatewayHttpError);
        c.set(error.retryAt);
        expect(() => c.cooldown.check()).not.toThrow();
      }
    }
  );

  it.each(["900", "1000000000000"])(
    "honors uncapped server deadline %s and never shortens it after another failure",
    header => {
      const c = clock(1);
      const first = c.cooldown.fail(429, header);
      expect(first.retryAt).toBe(START + Number(header) * 1_000);
      expect(c.cooldown.remainingMs()).toBeGreaterThan(300_000);
      const later = c.cooldown.fail(502, "1");
      expect(later.retryAt).toBe(first.retryAt);
      expect(c.cooldown.getSnapshot().retryAt).toBe(first.retryAt);
    }
  );

  it("uses an HTTP-date server deadline while past/malformed headers retain local jitter", () => {
    const future = clock();
    expect(
      future.cooldown.fail(429, new Date(START + 900_000).toUTCString()).retryAt
    ).toBe(START + 900_000);
    for (const header of [
      null,
      "0",
      "later",
      "9".repeat(400),
      new Date(START - 1_000).toUTCString(),
    ]) {
      const c = clock();
      expect(c.cooldown.fail(429, header).retryAt).toBe(START + 5_000);
    }
  });

  it("notifies subscribers on failure and parsed recovery, and supports unsubscribing", () => {
    const c = clock();
    const listener = vi.fn();
    const unsubscribe = c.cooldown.subscribe(listener);
    c.cooldown.fail(429);
    expect(listener).toHaveBeenCalledTimes(1);
    c.set(c.cooldown.getSnapshot().retryAt);
    c.cooldown.recover(c.cooldown.check());
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    c.cooldown.fail(503);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("production query retry policy", () => {
  it.each([408, 429, 500, 502, 503, 599])(
    "limits transient HTTP %s to three retries",
    status => {
      const c = clock();
      const error = TRPCClientError.from<FixtureRouter>(
        c.cooldown.fail(status)
      );
      expect(isTransientApiError(error)).toBe(true);
      expect(
        [0, 1, 2, 3, 10].map(count => shouldRetryQuery(count, error))
      ).toEqual([true, true, true, false, false]);
    }
  );

  it.each([400, 401, 403, 404])(
    "never retries non-transient HTTP %s",
    status => {
      const error = TRPCClientError.from<FixtureRouter>(
        new GatewayHttpError(status)
      );
      expect(isTransientApiError(error)).toBe(false);
      expect(shouldRetryQuery(0, error)).toBe(false);
    }
  );

  it.each([
    new TypeError("Failed to fetch"),
    new TypeError("NetworkError"),
    TRPCClientError.from<FixtureRouter>(new Error("Load failed")),
  ])("recognizes transport-style failures and bounds retries: %s", error => {
    expect(isTransientApiError(error)).toBe(true);
    expect(shouldRetryQuery(2, error)).toBe(true);
    expect(shouldRetryQuery(3, error)).toBe(false);
  });

  it("never retries the existing login-required message even without a structured data code", () => {
    const error = TRPCClientError.from<FixtureRouter>(
      new Error(UNAUTHED_ERR_MSG)
    );
    expect(error.data).toBeUndefined();
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it.each([
    new Error("ordinary application failure"),
    new TypeError("invalid type"),
    null,
  ])("limits unknown non-transient failures to one retry: %s", error => {
    expect(isTransientApiError(error)).toBe(false);
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(false);
  });

  it.each([
    [0, 1_000],
    [1, 2_000],
    [2, 4_000],
    [3, 8_000],
    [4, 10_000],
    [40, 10_000],
    [Number.MAX_VALUE, 10_000],
  ])("bounds the ordinary retry timer at attempt %s", (attempt, expected) => {
    expect(
      queryRetryDelay(attempt, new Error("ordinary"), clock().cooldown)
    ).toBe(expected);
  });

  it("never schedules a query retry earlier than the shared server cooldown", () => {
    const c = clock();
    const error = c.cooldown.fail(429, "120");
    expect(queryRetryDelay(0, error, c.cooldown)).toBe(120_000);
    c.advance(60_000);
    expect(queryRetryDelay(4, error, c.cooldown)).toBe(60_000);
    c.set(error.retryAt);
    expect(queryRetryDelay(0, error, c.cooldown)).toBe(1_000);
  });

  it("chunks enormous deadlines into safe browser timers without permitting early HTTP", () => {
    const c = clock();
    const error = c.cooldown.fail(429, "1000000000000");
    const fullDeadline = error.retryAt;
    expect(queryRetryDelay(0, error, c.cooldown)).toBe(2_147_000_000);
    c.advance(2_147_000_000);
    expect(queryRetryDelay(1, error, c.cooldown)).toBe(2_147_000_000);
    expect(c.cooldown.getSnapshot().retryAt).toBe(fullDeadline);
    expect(() => c.cooldown.check()).toThrow(GatewayHttpError);
    c.set(fullDeadline - 20_000);
    expect(queryRetryDelay(0, error, c.cooldown)).toBe(20_000);
    c.set(fullDeadline);
    expect(() => c.cooldown.check()).not.toThrow();
  });

  it("unwraps the actual gateway cause through nested errors without confusing auth or unrelated errors", () => {
    const original = new GatewayHttpError(429, START + 120_000);
    const trpc = TRPCClientError.from<FixtureRouter>(original);
    expect(gatewayError(new Error("wrapper", { cause: trpc }))).toBe(original);
    expect(gatewayError(new Error(UNAUTHED_ERR_MSG))).toBeUndefined();
    expect(gatewayError({ cause: null })).toBeUndefined();
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(gatewayError(cyclic)).toBeUndefined();
  });
});

describe("safe API error logging metadata", () => {
  const allowedCodes = [
    "UNAUTHORIZED",
    "FORBIDDEN",
    "BAD_REQUEST",
    "NOT_FOUND",
    "INTERNAL_SERVER_ERROR",
    "TOO_MANY_REQUESTS",
    "TIMEOUT",
    "CONFLICT",
  ] as const;

  function privateError(code: unknown, httpStatus: unknown = 401) {
    return TRPCClientError.from<FixtureRouter>(
      {
        error: {
          message: `Raw message ${SECRET}`,
          code: -32001,
          data: {
            code,
            httpStatus,
            path: `private.${SECRET}`,
            stack: SECRET,
            url: `https://gateway.invalid/?${SECRET}`,
          },
        },
      },
      {
        meta: {
          response: { status: 500, url: `https://gateway.invalid/?${SECRET}` },
          responseJSON: { body: SECRET },
          raw: SECRET,
        },
      }
    );
  }

  it.each(allowedCodes)(
    "retains only whitelisted %s and numeric status, never raw message/data/meta/cause/URL",
    code => {
      const error = privateError(code);
      Object.defineProperty(error, "cause", {
        value: new Error(`Private cause ${SECRET}`),
      });
      const metadata = safeApiErrorMetadata(error);

      expect(metadata).toEqual({ status: 401, code });
      expect(Object.keys(metadata).sort()).toEqual(["code", "status"]);
      expect(
        `${inspect(metadata, { depth: 10 })}\n${JSON.stringify(metadata)}`
      ).not.toContain(SECRET);
      expect(JSON.stringify(metadata)).not.toContain("https://");
      expect(metadata).not.toHaveProperty("message");
      expect(metadata).not.toHaveProperty("data");
      expect(metadata).not.toHaveProperty("meta");
      expect(metadata).not.toHaveProperty("cause");
    }
  );

  it.each([
    SECRET,
    `UNAUTHORIZED\n${SECRET}`,
    `https://gateway.invalid/?${SECRET}`,
    "UNAUTHORIZED ",
    "unauthorized",
    "__proto__",
    "GATEWAY_ERROR",
    "PARSE_ERROR",
    -32001,
    null,
    undefined,
    { secret: SECRET },
    ["UNAUTHORIZED", SECRET],
  ])("replaces untrusted/nonwhitelisted code %j with UNKNOWN", code => {
    const metadata = safeApiErrorMetadata(privateError(code));
    expect(metadata).toEqual({ status: 401, code: "UNKNOWN" });
    expect(JSON.stringify(metadata)).not.toContain(SECRET);
  });

  it.each([
    99,
    600,
    401.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "401",
    SECRET,
    null,
  ])("omits invalid status %j instead of logging it", status => {
    expect(safeApiErrorMetadata(privateError("UNAUTHORIZED", status))).toEqual({
      status: status === null ? 500 : undefined,
      code: "UNAUTHORIZED",
    });
  });

  it("uses only numeric response status when structured status is absent", () => {
    const error = TRPCClientError.from<FixtureRouter>(
      new Error(`Network ${SECRET}`),
      {
        meta: {
          response: new Response(SECRET, { status: 429 }),
          responseJSON: { secret: SECRET },
        },
      }
    );
    expect(safeApiErrorMetadata(error)).toEqual({
      status: 429,
      code: "UNKNOWN",
    });
  });

  it("prefers typed gateway status and constant GATEWAY_ERROR over all private tRPC fields", () => {
    const error = privateError(SECRET);
    Object.defineProperty(error, "cause", {
      value: new Error(`Private wrapper ${SECRET}`, {
        cause: new GatewayHttpError(502, START + 5_000),
      }),
    });
    expect(safeApiErrorMetadata(error)).toEqual({
      status: 502,
      code: "GATEWAY_ERROR",
    });
  });

  it.each([
    null,
    undefined,
    SECRET,
    new Error(`Raw ${SECRET}`),
    new TypeError(`https://gateway.invalid/?${SECRET}`),
    {
      message: SECRET,
      data: { code: "UNAUTHORIZED", httpStatus: 401 },
      meta: { responseJSON: SECRET },
    },
  ])(
    "does not trust arbitrary non-tRPC errors or lookalike data: %j",
    error => {
      expect(safeApiErrorMetadata(error)).toEqual({
        status: undefined,
        code: "UNKNOWN",
      });
    }
  );
});

describe("frontend wiring safety (source-only; no DOM or login initialization)", () => {
  it("wires the production gate and bounded query policy, with automatic mutation retries disabled", () => {
    const source = readFileSync(
      new URL("../client/src/main.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toMatch(/retry:\s*shouldRetryQuery/);
    expect(source).toMatch(
      /retryDelay:\s*\(attempt,\s*error\)\s*=>\s*queryRetryDelay\(attempt,\s*error,\s*gatewayCooldown\)/
    );
    expect(source).toMatch(/mutations:\s*\{\s*retry:\s*false\s*\}/);
    expect(source).toMatch(
      /httpBatchLink\(\{[^}]*transformer:\s*superjson[^}]*fetch:\s*gatewayFetch/s
    );
  });

  it("logs only sanitized metadata or static warnings, never a raw query/mutation error", () => {
    const source = readFileSync(
      new URL("../client/src/main.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toMatch(
      /safeApiErrorMetadata[\s\S]*from\s*["']\.\/lib\/gatewayTransport["']/
    );
    const logs = Array.from(
      source.matchAll(/console\.(error|warn|log|debug)\(([\s\S]*?)\);/g)
    );
    expect(logs).toHaveLength(4);
    const errorLogs = logs.filter(([, method]) => method === "error");
    expect(errorLogs).toHaveLength(2);
    for (const [, , argumentsSource] of errorLogs) {
      expect(argumentsSource.trim()).toMatch(
        /^"\[API (?:Query|Mutation) Error\]",\s*safeApiErrorMetadata\(error\)$/
      );
    }
    for (const [, method, argumentsSource] of logs) {
      if (method === "warn")
        expect(argumentsSource.trim()).toMatch(/^"[^"\n]*"$/);
      expect(argumentsSource).not.toMatch(
        /error\.(?:message|meta|cause|data|shape)|JSON\.stringify\(error\)/
      );
    }
  });

  it("refetches only active queries without cancelling/restarting in-flight recovery or replaying mutations", () => {
    const source = readFileSync(
      new URL("../client/src/main.tsx", import.meta.url),
      "utf8"
    );
    const recovery = source.slice(
      source.indexOf("const retryQueries ="),
      source.indexOf("createRoot(")
    );
    expect(recovery).toMatch(
      /refetchQueries\(\s*\{\s*type:\s*["']active["']\s*\},\s*\{\s*cancelRefetch:\s*false\s*\}\s*\)/
    );
    expect(recovery.match(/refetchQueries\(/g)).toHaveLength(1);
    expect(recovery).not.toMatch(
      /invalidateQueries|resetQueries|cancelQueries|\.mutate\(|resumePausedMutations/
    );
    expect(source).toMatch(/mutations:\s*\{\s*retry:\s*false\s*\}/);
    expect(source).toMatch(/<GatewayNotice\s+retryQueries=\{retryQueries\}/);
  });

  it("has no login redirect, so an unavailable auth lookup can never bounce the operator out of the Hub", () => {
    // Local single-user mode: there is no OAuth portal to redirect to. Neither the
    // auth hook nor the query-cache error handlers may navigate away on failure.
    for (const file of ["_core/hooks/useAuth.ts", "main.tsx", "const.ts"]) {
      const source = readFileSync(
        new URL(`../client/src/${file}`, import.meta.url),
        "utf8"
      );
      expect(source).not.toMatch(/window\.location\.href\s*=/);
      expect(source).not.toMatch(/getLoginUrl|VITE_OAUTH_PORTAL_URL/);
    }
  });
});
