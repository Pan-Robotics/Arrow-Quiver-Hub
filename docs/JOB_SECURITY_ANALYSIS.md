# Job Pipeline Security Analysis

## Artefact Integrity, Job Allow-Listing, and Reliability/Permissions

**Prepared for:** Pan Robotics Quiver Hub
**Date:** April 2026

---

## 1. Executive Summary

The Quiver Hub job pipeline dispatches commands from the web dashboard to Raspberry Pi companion computers via a database-backed job queue. Three companion scripts consume these jobs: the Hub Client (`raspberry_pi_client.py`) handles file uploads and config updates, the Logs & OTA Service (`logs_ota_service.py`) handles FC log scanning, downloading, and firmware flashing, and the Telemetry Forwarder (`telemetry_forwarder.py`) streams flight data. This document examines three security and reliability models — **artefact integrity**, **job allow-listing**, and **job reliability/permissions** — evaluates their applicability to the Quiver system, and proposes concrete implementation paths where warranted.

The core finding is that all three models are useful and should be implemented, but at different levels of urgency. Artefact integrity for firmware files is the highest priority because a corrupted `.abin` file flashed to the flight controller could render the autopilot inoperative. Job allow-listing is a straightforward hardening measure that prevents undefined job types from entering the queue. Job permissions and reliability improvements provide operational safety as the fleet scales beyond a single drone.

---

## 2. Current System Audit

### 2.1 Job Lifecycle

The job pipeline follows a five-stage lifecycle: **created → pending → acknowledged → completed/failed**. The web UI creates jobs via tRPC mutations, which insert rows into the `droneJobs` MySQL table. Companion scripts poll the Hub's REST endpoint (`GET /api/rest/jobs/pending`) every few seconds, acknowledge jobs they intend to process, execute them, and report completion or failure back to the Hub.

| Stage | Actor | Mechanism |
|-------|-------|-----------|
| Creation | Web UI (admin user) | tRPC mutation → `createDroneJob()` |
| Queuing | Hub server | MySQL `droneJobs` table, status = `pending` |
| Polling | Companion script | REST `GET /api/rest/jobs/pending` with API key |
| Acknowledgment | Companion script | REST `POST /api/rest/jobs/{id}/acknowledge` |
| Execution | Companion script | Local handler (MAVFTP, file download, config write) |
| Completion | Companion script | REST `POST /api/rest/jobs/{id}/complete` |

### 2.2 Current Job Types

Five job types currently exist in the system, consumed by two different companion scripts:

| Job Type | Consumer | Payload | Risk Level |
|----------|----------|---------|------------|
| `upload_file` | `raspberry_pi_client.py` | `{ fileId, fileUrl, filename }` | Medium — writes files to Pi filesystem |
| `update_config` | `raspberry_pi_client.py` | `{ configPath, configData }` | Medium — modifies service configuration |
| `scan_fc_logs` | `logs_ota_service.py` | `{ logPath }` | Low — read-only directory listing |
| `download_fc_log` | `logs_ota_service.py` | `{ logId, remotePath, filename }` | Low — read from FC, upload to Hub |
| `flash_firmware` | `logs_ota_service.py` | `{ updateId, firmwareUrl, filename }` | **Critical** — writes to FC SD card, triggers reboot |

### 2.3 Current Security Controls

The system already implements several security measures. Every REST endpoint validates the API key and verifies that the `droneId` in the request matches the API key's bound drone. The tRPC mutations that create jobs require authentication via `protectedProcedure`, meaning only logged-in users can dispatch jobs. The companion scripts filter jobs by type before processing — the `logs_ota_service.py` explicitly skips any job type not in `("scan_fc_logs", "download_fc_log", "flash_firmware")`, and the `raspberry_pi_client.py` logs a warning for unknown types.

However, several gaps exist. The `createJob` tRPC mutation accepts `type: z.string()` and `payload: z.any()` — meaning any authenticated user can create a job with an arbitrary type string and an unconstrained payload object. There is no per-user permission model distinguishing who can flash firmware versus who can only scan logs. There is no retry mechanism for failed jobs, and no timeout for jobs that get stuck in the `acknowledged` state.

**Note (April 2026 update):** SHA-256 hash verification for firmware files has since been implemented. The Hub computes a SHA-256 hash at upload time and stores it in the `firmwareUpdates` table. The companion script verifies the hash after downloading from S3 and before uploading to the FC. Additionally, the FC log upload pipeline now supports multipart form-data uploads (preferred) with base64 JSON fallback, and a session-authenticated download proxy (`GET /api/rest/logs/fc-download/:logId`) enables browser-based file download.

---

## 3. Artefact Integrity Model

### 3.1 Is It Useful Here?

**Yes — this is the highest-priority improvement.** The `flash_firmware` job downloads a `.abin` file from S3 and uploads it to the flight controller's SD card. If the file is corrupted during transfer, truncated, or tampered with, the consequences range from a failed flash (recoverable) to a bricked autopilot (potentially unrecoverable without physical access). The OWASP Drone Security Cheat Sheet identifies firmware integrity as a critical control, recommending that "firmware and configuration updates are signed with cryptographic signatures" and verified before application [1]. ArduPilot itself supports tamperproof firmware via signed bootloaders and ECDSA key pairs [2], but this operates at the FC bootloader level — it does not protect against corrupted files being written to the SD card in the first place.

The defence-in-depth principle applies here: the Hub should verify the artefact before dispatching the job, the companion script should verify it after downloading, and the FC's own bootloader provides the final check (if secure boot is enabled). Even without FC-level secure boot, the first two layers catch the most common failure modes: S3 transfer corruption and man-in-the-middle tampering.

### 3.2 Proposed Implementation

The implementation adds a SHA-256 hash at upload time and verifies it at two checkpoints: when the job is dispatched and when the companion script downloads the file.

**Step 1: Store hash at upload time.** When the admin uploads a firmware file via the `firmware.upload` tRPC mutation, compute the SHA-256 hash of the file buffer before calling `storagePut()`. Store the hash in a new `sha256Hash` column on the `firmwareUpdates` table.

```sql
ALTER TABLE firmwareUpdates ADD COLUMN sha256Hash VARCHAR(64) AFTER url;
```

**Step 2: Include hash in job payload.** When the `firmware.flash` mutation creates the `flash_firmware` job, include the hash in the payload:

```typescript
await createDroneJob({
  droneId: input.droneId,
  type: "flash_firmware",
  payload: {
    updateId: input.updateId,
    firmwareUrl: update.url,
    filename: update.filename,
    sha256Hash: update.sha256Hash,  // NEW
  },
  createdBy: ctx.user.id,
});
```

**Step 3: Verify on the companion.** In `logs_ota_service.py`, after downloading the firmware file from S3, compute the SHA-256 hash and compare it to the expected hash from the job payload. If they do not match, fail the job immediately without uploading to the FC.

```python
import hashlib

def verify_hash(data: bytes, expected_hash: str) -> bool:
    actual = hashlib.sha256(data).hexdigest()
    return actual == expected_hash
```

**Step 4: Verify FC log downloads (optional).** For FC log downloads, the companion can compute the SHA-256 of the downloaded `.BIN` file and include it in the upload to the Hub. The Hub stores this hash in the `fcLogs` table, allowing the Flight Analytics app to verify the log file integrity before parsing.

### 3.3 What About Digital Signatures?

Full ECDSA/RSA signing (where the Hub signs the firmware with a private key and the companion verifies with a public key) provides stronger guarantees than hash-only verification — it proves the file was produced by the Hub, not just that it was not corrupted. However, for the Quiver system, the threat model is primarily about accidental corruption rather than active adversaries injecting malicious firmware. The companion scripts communicate with the Hub over HTTPS (TLS), which already provides transport-level integrity and authentication. Adding SHA-256 hash verification catches the remaining edge cases (S3 storage corruption, partial downloads, CDN caching errors) without the operational complexity of key management.

If the fleet scales to production deployments where physical security of the companion computer cannot be guaranteed, or if firmware is distributed through untrusted channels, upgrading to ECDSA signatures would be warranted. The hash column provides a natural migration path — replace the SHA-256 hash with an ECDSA signature over the hash, and add the public key to the companion script's configuration.

---

## 4. Job Allow-Listing Model

### 4.1 Is It Useful Here?

**Yes — this is a straightforward hardening measure with minimal implementation cost.** The current `createJob` tRPC mutation accepts `type: z.string()`, which means any authenticated user could create a job with type `"rm -rf /"` or `"execute_arbitrary_command"`. While the companion scripts would simply skip unknown types (the `logs_ota_service.py` checks against a hardcoded set, and the `raspberry_pi_client.py` logs a warning), the job would still occupy a row in the database and could confuse monitoring or auditing. More importantly, if a future companion script is less careful about filtering, an undefined job type could be accidentally processed.

The allow-list should be enforced at the Hub level (server-side validation) rather than relying on each companion script to filter independently. This follows the principle of "validate at the gate" — reject invalid input as early as possible in the pipeline.

### 4.2 Proposed Implementation

**Step 1: Define the canonical job type enum.** Replace the free-form `z.string()` with a Zod enum in the tRPC mutation and add a corresponding TypeScript type:

```typescript
// shared/jobTypes.ts
export const JOB_TYPES = [
  "upload_file",
  "update_config",
  "scan_fc_logs",
  "download_fc_log",
  "flash_firmware",
] as const;

export type JobType = typeof JOB_TYPES[number];
```

**Step 2: Constrain the createJob mutation.** Update the `droneJobs.createJob` tRPC mutation to use the enum:

```typescript
createJob: protectedProcedure
  .input(z.object({
    droneId: z.string(),
    type: z.enum(JOB_TYPES),      // was: z.string()
    payload: z.any(),
  }))
  .mutation(async ({ input, ctx }) => { ... })
```

**Step 3: Add typed payload schemas (optional but recommended).** For each job type, define the expected payload shape. This prevents malformed payloads from reaching the companion script:

```typescript
const JOB_PAYLOAD_SCHEMAS = {
  upload_file: z.object({
    fileId: z.number(),
    fileUrl: z.string().url(),
    filename: z.string(),
  }),
  scan_fc_logs: z.object({
    logPath: z.string().default("/APM/LOGS"),
  }),
  download_fc_log: z.object({
    logId: z.number(),
    remotePath: z.string(),
    filename: z.string(),
  }),
  flash_firmware: z.object({
    updateId: z.number(),
    firmwareUrl: z.string().url(),
    filename: z.string(),
    sha256Hash: z.string().optional(),
  }),
  update_config: z.object({
    configPath: z.string(),
    configData: z.record(z.unknown()),
  }),
} as const;
```

**Step 4: Update the database schema (optional).** Change the `type` column from `varchar` to a MySQL enum to enforce the allow-list at the database level as well. This provides a final safety net even if the application layer is bypassed:

```sql
ALTER TABLE droneJobs MODIFY COLUMN type ENUM(
  'upload_file', 'update_config', 'scan_fc_logs',
  'download_fc_log', 'flash_firmware'
) NOT NULL;
```

The trade-off with a database-level enum is that adding new job types requires a schema migration. For a system that evolves frequently, keeping the allow-list in application code (Zod enum) and leaving the database column as `varchar` is more pragmatic. The Zod validation catches invalid types before they reach the database.

---

## 5. Job Reliability and Permissions

### 5.1 Reliability: Is It Useful Here?

**Yes — the current system has several reliability gaps that will surface as the fleet grows.** The most significant issues are:

**Stuck jobs.** If a companion script acknowledges a job but crashes before completing it, the job remains in the `acknowledged` state indefinitely. No mechanism exists to detect or recover from this. The fix is a **timeout reaper** — a server-side cron job that resets jobs stuck in `acknowledged` for longer than a configurable threshold (e.g., 10 minutes for log downloads, 30 minutes for firmware flashes) back to `pending` status, with a retry counter.

**No retry logic.** If a job fails due to a transient error (network timeout, FC busy), it is marked as `failed` and never retried. The admin must manually create a new job. Adding a `retryCount` column and automatic retry (up to 3 attempts with exponential backoff) would handle the most common transient failures without human intervention.

**No job expiry.** A job created while the drone is offline will sit in the queue indefinitely. When the drone eventually connects (possibly days later), it will execute a stale job that may no longer be relevant. Adding an `expiresAt` timestamp allows the companion script to skip expired jobs.

**No concurrency control.** Nothing prevents two `flash_firmware` jobs from being queued simultaneously for the same drone, which could cause race conditions on the FC. A **mutex check** at job creation time — rejecting a new `flash_firmware` job if one is already pending or in progress for that drone — would prevent this.

### 5.2 Proposed Reliability Implementation

The following schema changes and server-side logic address the reliability gaps:

```sql
ALTER TABLE droneJobs
  ADD COLUMN retryCount INT DEFAULT 0 AFTER status,
  ADD COLUMN maxRetries INT DEFAULT 3 AFTER retryCount,
  ADD COLUMN expiresAt TIMESTAMP NULL AFTER maxRetries,
  ADD COLUMN timeoutSeconds INT DEFAULT 600 AFTER expiresAt;
```

| Mechanism | Implementation | Default |
|-----------|---------------|---------|
| Stuck job reaper | Server-side interval (every 60s) checks for `acknowledged` jobs older than `timeoutSeconds` | 600s (10 min) |
| Retry on failure | On `complete` with `success: false`, if `retryCount < maxRetries`, reset to `pending` | 3 retries |
| Job expiry | Companion skips jobs where `expiresAt < now()`; reaper marks expired jobs as `failed` | 1 hour |
| Concurrency mutex | `createDroneJob()` checks for existing active jobs of the same type for the same drone | Per-type |

The timeout values should be configurable per job type. Firmware flashing can take 5-15 minutes depending on file size and FC speed, so the default timeout for `flash_firmware` should be 1800 seconds (30 minutes). Log scanning completes in seconds, so 120 seconds is sufficient.

### 5.3 Permissions: Is It Useful Here?

**Moderately useful — depends on how many operators will use the system.** Currently, the Quiver Hub has a single admin user (the owner). All job creation goes through `protectedProcedure`, which only checks that the user is logged in. There is no distinction between "can scan logs" and "can flash firmware."

If the system will only ever have one or two trusted operators, a full RBAC (Role-Based Access Control) system is over-engineering. However, if the fleet grows to include field technicians, pilots, or third-party maintenance personnel, permission boundaries become important. Flashing firmware is a destructive operation that should be restricted to senior operators, while scanning logs and viewing diagnostics are safe read-like operations that any team member should be able to perform.

### 5.4 Proposed Permissions Implementation

The existing `role` field on the `users` table (`admin` | `user`) provides a natural two-tier model. The proposal maps job types to minimum required roles:

| Job Type | Minimum Role | Rationale |
|----------|-------------|-----------|
| `scan_fc_logs` | `user` | Read-only operation, no risk |
| `download_fc_log` | `user` | Read-only, downloads to Hub storage |
| `flash_firmware` | `admin` | Destructive, can brick the FC |
| `upload_file` | `admin` | Writes to Pi filesystem |
| `update_config` | `admin` | Modifies service configuration |

Implementation is a single middleware check in the `createJob` mutation:

```typescript
const JOB_PERMISSIONS: Record<JobType, "user" | "admin"> = {
  scan_fc_logs: "user",
  download_fc_log: "user",
  flash_firmware: "admin",
  upload_file: "admin",
  update_config: "admin",
};

createJob: protectedProcedure
  .input(z.object({
    droneId: z.string(),
    type: z.enum(JOB_TYPES),
    payload: z.any(),
  }))
  .mutation(async ({ input, ctx }) => {
    const requiredRole = JOB_PERMISSIONS[input.type];
    if (requiredRole === "admin" && ctx.user.role !== "admin") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Job type "${input.type}" requires admin privileges`,
      });
    }
    // ... create job
  })
```

If more granular permissions are needed in the future (e.g., per-drone access, per-team permissions), the system can be extended with a `userDronePermissions` junction table. For now, the two-tier model is sufficient and avoids premature complexity.

---

## 6. Implementation Status

The following table tracks the implementation status of each security model:

| Priority | Model | Status | Implementation Details |
|----------|-------|--------|------------------------|
| **1** | Job allow-listing (Zod enum + typed payloads) | **Planned** | Not yet implemented. The `createJob` mutation still accepts `z.string()` for the type field. |
| **2** | Artefact integrity (SHA-256 hash on firmware) | **Implemented** | SHA-256 computed at upload time (`routers.ts`), stored in `firmwareUpdates.sha256Hash`, included in `flash_firmware` job payload. Companion script verifies hash after S3 download, aborts with `hash_verification_failed` if mismatch. `fcLogs` table also has `sha256Hash` column. |
| **3** | Job reliability (timeout reaper, retry, expiry, mutex) | **Implemented** | Schema columns added (`retryCount`, `maxRetries`, `expiresAt`, `lockedBy`, `lockedAt`, `timeoutSeconds`). Server-side reaper runs every 60s (`droneJobsDb.ts`). Mutex lock via atomic compare-and-swap on acknowledge. Both `logs_ota_service.py` and `raspberry_pi_client.py` send `lockedBy` companion identifier. Artefact cleanup in `finally` block. Superuser check at startup. |
| **4** | Job permissions (role-based job creation) | **Planned** | Not yet implemented. The existing `role` field on `users` table supports the two-tier model described in Section 5.4. |

---

## 7. Summary

Two of the four security models have been fully implemented:

The **artefact integrity model** is now live — SHA-256 hashes are computed at firmware upload time, stored in the database, included in the job payload, and verified by the companion script before any firmware is flashed to the flight controller. A hash mismatch aborts the flash with a clear error message (`hash_verification_failed`), and the downloaded temp file is cleaned up regardless of outcome.

The **job reliability model** is now live — the server-side timeout reaper runs every 60 seconds, resetting stuck jobs back to pending (with retry counting) or marking them as permanently failed after `maxRetries` is exceeded. Pending jobs with expired `expiresAt` timestamps are automatically expired. Job acknowledgement uses an atomic mutex lock with a companion identifier (`lockedBy`) to prevent double-execution. Both `logs_ota_service.py` and `raspberry_pi_client.py` send their companion ID when acknowledging jobs. The `logs_ota_service.py` script also includes a superuser check at startup and automatic artefact cleanup in a `finally` block.

The **job allow-listing model** and **permissions model** remain planned for a future sprint. The allow-listing change (replacing `z.string()` with `z.enum()`) is a straightforward hardening measure that can be implemented independently. The permissions model maps naturally onto the existing `role` field on the `users` table.

---

## References

[1]: https://cheatsheetseries.owasp.org/cheatsheets/Drone_Security_Cheat_Sheet.html "OWASP Drone Security Cheat Sheet"

[2]: https://ardupilot.org/dev/docs/secure-firmware.html "ArduPilot — Creating Tamperproof Firmware"

[3]: https://docs.aws.amazon.com/iot/latest/developerguide/iot-jobs-lifecycle.html "AWS IoT Core — Jobs and Job Execution States"
