import { TRPCClientError } from "@trpc/client";
import { UNAUTHED_ERR_MSG } from "../../../shared/const";

export type GatewaySnapshot = {
  status: number;
  retryAt: number;
  active: boolean;
};

export class GatewayHttpError extends Error {
  readonly status: number;
  readonly retryAt: number;
  constructor(status: number, retryAt = 0, coolingDown = false) {
    super(
      status === 429
        ? "The server is rate limiting requests. Please wait before trying again."
        : coolingDown
          ? "Requests are paused while the server recovers. Please wait before trying again."
          : `The server returned an unavailable or invalid response (HTTP ${status}). Please try again later.`
    );
    this.name = "GatewayHttpError";
    this.status = status;
    this.retryAt = retryAt;
  }
}

export function gatewayError(error: unknown): GatewayHttpError | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current instanceof GatewayHttpError) return current;
    if (!current || typeof current !== "object" || !("cause" in current)) break;
    current = current.cause;
  }
  return undefined;
}

export function parseRetryAfterMs(
  value: string | null,
  now: number
): number | undefined {
  if (!value?.trim()) return undefined;
  const text = value.trim();
  let delay: number;
  if (/^[0-9]+$/.test(text)) {
    delay = Number(text) * 1000;
  } else {
    // Require an explicit HTTP timezone; do not interpret a date in local time.
    if (!/(?:GMT|UTC|[+-]0000)$/i.test(text)) return undefined;
    const date = Date.parse(text);
    if (!Number.isFinite(date)) return undefined;
    delay = Math.max(0, date - now);
  }
  return Number.isFinite(delay) && delay >= 0 && Number.isFinite(now + delay)
    ? delay
    : undefined;
}

function temporaryStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTrpcEnvelope(payload: unknown): boolean {
  const items = Array.isArray(payload) ? payload : [payload];
  return (
    items.length > 0 &&
    items.every(item => {
      if (!isRecord(item)) return false;
      if (isRecord(item.result) && !("error" in item))
        return "data" in item.result;
      if (!isRecord(item.error) || "result" in item) return false;
      // SuperJSON wraps the error shape in json; untransformed tRPC errors
      // use the shape directly. Do not deserialize or copy either envelope.
      const shape = "json" in item.error ? item.error.json : item.error;
      return (
        isRecord(shape) &&
        typeof shape.message === "string" &&
        typeof shape.code === "number" &&
        Number.isInteger(shape.code)
      );
    })
  );
}

export function safeApiErrorMetadata(error: unknown): {
  status?: number;
  code: string;
} {
  const gateway = gatewayError(error);
  const response =
    error instanceof TRPCClientError ? error.meta?.response : undefined;
  const status =
    gateway?.status ??
    (error instanceof TRPCClientError
      ? (error.data?.httpStatus ??
        (isRecord(response) ? response.status : undefined))
      : undefined);
  const code = error instanceof TRPCClientError ? error.data?.code : undefined;
  const allowed = [
    "UNAUTHORIZED",
    "FORBIDDEN",
    "BAD_REQUEST",
    "NOT_FOUND",
    "INTERNAL_SERVER_ERROR",
    "TOO_MANY_REQUESTS",
    "TIMEOUT",
    "CONFLICT",
  ];
  return {
    status:
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
        ? status
        : undefined,
    code: gateway ? "GATEWAY_ERROR" : allowed.includes(code) ? code : "UNKNOWN",
  };
}

/** Per-browser tRPC gate. Never sleeps/replays a mutation or bypasses gateway limits. */
export class GatewayCooldown {
  private failures = 0;
  private version = 0;
  private snapshot: GatewaySnapshot = { status: 0, retryAt: 0, active: false };
  private listeners = new Set<() => void>();
  constructor(
    private now: () => number = Date.now,
    private random: () => number = Math.random
  ) {}
  getSnapshot = (): GatewaySnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(snapshot: GatewaySnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }
  remainingMs(): number {
    return Math.max(0, this.snapshot.retryAt - this.now());
  }
  /** Short-circuit all queries, interval refetches, focus refetches and writes alike. */
  check(): number {
    if (this.remainingMs() > 0) {
      throw new GatewayHttpError(
        this.snapshot.status,
        this.snapshot.retryAt,
        true
      );
    }
    return this.version;
  }
  fail(status: number, retryAfter: string | null = null): GatewayHttpError {
    this.version++;
    this.failures = Math.min(this.failures + 1, 16);
    const ceiling = Math.min(300_000, 10_000 * 2 ** (this.failures - 1));
    const localDelay = ceiling / 2 + (this.random() * ceiling) / 2;
    const now = this.now();
    const serverDelay = parseRetryAfterMs(retryAfter, now) ?? 0;
    const retryAt = Math.max(
      this.snapshot.retryAt,
      now + Math.max(localDelay, serverDelay)
    );
    this.update({ status, retryAt, active: true });
    return new GatewayHttpError(status, retryAt);
  }
  recover(requestVersion: number): void {
    // A success already in flight before a newer 429 must not clear its cooldown.
    if (requestVersion !== this.version) return;
    this.failures = 0;
    if (this.snapshot.active)
      this.update({ status: 0, retryAt: 0, active: false });
  }
}

export function createGatewayFetch(
  cooldown: GatewayCooldown,
  fetcher: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    const version = cooldown.check();
    let response: Response;
    try {
      response = await fetcher(input, { ...init, credentials: "include" });
    } catch (error) {
      // Cancellation is deliberate, not a gateway outage. Preserve its identity.
      if (
        init?.signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      throw cooldown.fail(503);
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    const json =
      contentType === "application/json" || contentType?.endsWith("+json");
    if (!json) {
      // Never consume/log untrusted HTML/text (which can include private request data).
      void response.body?.cancel().catch(() => undefined);
      const status = response.ok ? 502 : response.status;
      if (temporaryStatus(status)) {
        throw cooldown.fail(status, response.headers.get("Retry-After"));
      }
      throw new GatewayHttpError(status);
    }
    // Leave tRPC/SuperJSON/auth envelopes untouched; parse only once, as before.
    const originalJson = response.json.bind(response);
    response.json = async () => {
      let payload: unknown;
      try {
        payload = await originalJson();
      } catch (error) {
        if (
          init?.signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        )
          throw error;
        throw cooldown.fail(502);
      }
      if (!isTrpcEnvelope(payload)) {
        const status = temporaryStatus(response.status) ? response.status : 502;
        throw cooldown.fail(status, response.headers.get("Retry-After"));
      }
      if (temporaryStatus(response.status)) {
        // Preserve the genuine application error (code/path/message), while
        // still honoring rate limits and temporary HTTP failure cooldowns.
        cooldown.fail(response.status, response.headers.get("Retry-After"));
      } else {
        // A valid BAD_REQUEST/UNAUTHORIZED/etc. proves the app is reachable.
        cooldown.recover(version);
      }
      return payload;
    };
    return response;
  };
}

export function isTransientApiError(error: unknown): boolean {
  const gateway = gatewayError(error);
  if (gateway) return temporaryStatus(gateway.status);
  const status = safeApiErrorMetadata(error).status;
  if (status !== undefined && temporaryStatus(status)) return true;
  if (error instanceof TRPCClientError || error instanceof TypeError) {
    const message = error.message.toLowerCase();
    return ["failed to fetch", "network", "load failed"].some(part =>
      message.includes(part)
    );
  }
  return false;
}

export function shouldRetryQuery(
  failureCount: number,
  error: unknown
): boolean {
  if (
    error instanceof TRPCClientError &&
    (error.message === UNAUTHED_ERR_MSG ||
      error.data?.code === "UNAUTHORIZED" ||
      error.data?.code === "FORBIDDEN" ||
      error.data?.code === "BAD_REQUEST")
  )
    return false;
  const gateway = gatewayError(error);
  if (gateway && !temporaryStatus(gateway.status)) return false;
  return failureCount < (isTransientApiError(error) ? 3 : 1);
}

export function queryRetryDelay(
  attempt: number,
  error: unknown,
  cooldown: GatewayCooldown
): number {
  // Browser timers overflow at 2^31ms. Wake in bounded chunks; check() still
  // blocks actual HTTP until the complete server deadline has elapsed.
  return Math.min(
    2_147_000_000,
    Math.max(
      0,
      cooldown.remainingMs(),
      Math.min(1000 * 2 ** Math.min(attempt, 10), 10_000)
    )
  );
}

export const gatewayCooldown = new GatewayCooldown();
export const gatewayFetch = createGatewayFetch(gatewayCooldown);
