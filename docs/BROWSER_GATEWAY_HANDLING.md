# Browser gateway and rate-limit handling

Updated: 2026-11-02. Scope: browser tRPC traffic only; no companion retry loops, server limits, credentials, or URLs are changed.

## Failure mode and correction

A development-preview gateway can reject an API request with HTTP 429 and the plain-text body `Too many requests. Please try again later.`. tRPC normally expects a JSON envelope, so blindly parsing that response produces the misleading `Unexpected token 'T'` JSON error. The gateway can also return HTML/text during 502/503 outages or even an unexpected HTTP 200 proxy page.

The fetch function in `client/src/lib/gatewayTransport.ts`, wired through the existing tRPC `httpBatchLink` in `client/src/main.tsx`, detects these responses before tRPC JSON decoding. It returns a typed `GatewayHttpError` with safe status/cooldown information instead of including raw response text, HTML, headers, or request URLs. JSON-labelled invalid bodies or non-tRPC JSON objects are converted to the same controlled temporary failure. Normal JSON/tRPC/SuperJSON data is still parsed only once, with the existing credentials included. Genuine tRPC errors, including non-2xx authentication/validation/429/5xx envelopes, retain their original code/data/path/message; temporary HTTP statuses also schedule the shared cooldown. All API console-error logs include only an allowlisted code and numeric status, never the full error, cause, or response metadata.

## Shared cooldown

All tRPC operations in a loaded browser instance share a single in-memory cooldown. HTTP 408/429/5xx and network failures use exponential equal-jitter windows of 5–10, 10–20, 20–40, 40–80, 80–160, then 150–300 seconds. Subsequent locally generated cooldowns remain capped at 300 seconds. A valid `Retry-After`, as nonnegative integer seconds or a timezone-qualified HTTP date, establishes a minimum deadline even when it exceeds the local cap. Missing/invalid/past header values cannot remove local backoff. Browser timers are bounded to avoid overflow for very long server cooldowns; a short-circuited request never sends HTTP before the actual deadline.

During cooldown, interval/focus/mount refetches and user-triggered mutations fail locally with a safe explanatory error rather than adding gateway traffic. Mutations are never automatically resent, because a network failure is not proof that a server-side write was not applied. Queries have limited retry attempts and use the shared deadline; the notice schedules an active-query refetch after the deadline to recover queries such as the auth lookup that normally disable retries. That refetch uses `cancelRefetch:false`, retaining any already-running retry/refetch rather than canceling it and creating duplicate traffic. An in-flight response started before a newer gateway failure cannot clear that newer cooldown. A validated non-temporary tRPC response (including a genuine HTTP 400/401/404 application error) proves the application is reachable and clears outage state; arbitrary JSON does not.

## User-visible and authentication behavior

`GatewayNotice.tsx` shows an accessible status notice with the remaining pause and explains that writes are not automatically replayed. Transient errors are logged as credential-free warnings rather than console JSON parsing exceptions. Non-transient tRPC errors remain errors; genuine unauthorized responses retain the existing login handling. The auth hook no longer interprets a failed/unavailable lookup as a confirmed logged-out response. No identity is invented, and no cookie/authentication control is bypassed.

## Limits and rollout

This corrects application-level error handling and traffic during cooldown. It cannot remove the gateway's rate limit. If the gateway rejects the **HTML document or JavaScript assets before the app loads**, none of this browser code can execute. Allow the upstream restriction to clear and then reload the updated application; use an appropriate published deployment for unattended operations rather than assuming a temporary preview is always available.

No database/schema, systemd units, companion files, dependencies, API keys, `.env`, firmware behavior, or Mission Planner implementation are changed by this browser fix. Safety-critical actions must be checked by the operator after any uncertain response and must not be manually repeated blindly.
