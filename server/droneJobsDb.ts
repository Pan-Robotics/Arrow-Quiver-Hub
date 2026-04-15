import { eq, and, desc, lt, isNull, or, sql } from "drizzle-orm";
import { droneJobs, droneFiles, InsertDroneJob, InsertDroneFile } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * Create a new job for a drone
 */
export async function createDroneJob(job: InsertDroneJob) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(droneJobs).values(job);
  return result;
}

/**
 * Get pending jobs for a specific drone.
 * Filters out expired jobs (expiresAt < now) — those are left for the reaper to mark as expired.
 */
export async function getPendingJobsForDrone(droneId: string) {
  const db = await getDb();
  if (!db) return [];

  const now = new Date();
  const jobs = await db
    .select()
    .from(droneJobs)
    .where(
      and(
        eq(droneJobs.droneId, droneId),
        eq(droneJobs.status, "pending"),
        // Only return non-expired jobs (expiresAt is null OR expiresAt > now)
        or(isNull(droneJobs.expiresAt), sql`${droneJobs.expiresAt} > ${now}`)
      )
    )
    .orderBy(droneJobs.createdAt);

  return jobs;
}

/**
 * Acknowledge a job with mutex lock.
 * Sets status to in_progress and records the companion identifier.
 * Returns true if the lock was acquired (status was still pending), false if already taken.
 */
export async function acknowledgeJob(jobId: number, lockedBy?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Atomic compare-and-swap: only update if status is still "pending"
  const result = await db
    .update(droneJobs)
    .set({
      status: "in_progress",
      acknowledgedAt: new Date(),
      lockedBy: lockedBy || null,
    })
    .where(
      and(
        eq(droneJobs.id, jobId),
        eq(droneJobs.status, "pending")
      )
    );

  // Check if the update actually affected a row (MySQL affectedRows)
  const affectedRows = (result as any)?.[0]?.affectedRows ?? (result as any)?.rowCount ?? 1;
  return affectedRows > 0;
}

/**
 * Mark a job as completed
 */
export async function completeJob(jobId: number, success: boolean, errorMessage?: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(droneJobs)
    .set({
      status: success ? "completed" : "failed",
      completedAt: new Date(),
      errorMessage: errorMessage || null,
      lockedBy: null, // release mutex
    })
    .where(eq(droneJobs.id, jobId));
}

/**
 * Get all jobs for a drone (for history/monitoring)
 */
export async function getAllJobsForDrone(droneId: string, limit: number = 50) {
  const db = await getDb();
  if (!db) return [];

  const jobs = await db
    .select()
    .from(droneJobs)
    .where(eq(droneJobs.droneId, droneId))
    .orderBy(desc(droneJobs.createdAt))
    .limit(limit);

  return jobs;
}

/**
 * Get a single job by ID
 */
export async function getJobById(jobId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const jobs = await db
    .select()
    .from(droneJobs)
    .where(eq(droneJobs.id, jobId))
    .limit(1);

  return jobs.length > 0 ? jobs[0] : undefined;
}

// ─── Job Reliability: Timeout Reaper ─────────────────────────────────────────

/**
 * Reap stuck jobs: find in_progress jobs that have exceeded their timeout window.
 * - If retryCount < maxRetries: reset to pending, increment retryCount, clear lock
 * - If retryCount >= maxRetries: mark as failed with "Max retries exceeded" error
 *
 * Also expire pending jobs whose expiresAt has passed.
 *
 * Returns { timedOut, retried, expired } counts for logging.
 */
export async function reapStuckJobs(): Promise<{ timedOut: number; retried: number; expired: number }> {
  const db = await getDb();
  if (!db) return { timedOut: 0, retried: 0, expired: 0 };

  const now = new Date();
  let timedOut = 0;
  let retried = 0;
  let expired = 0;

  // 1. Find in_progress jobs that have timed out
  const stuckJobs = await db
    .select()
    .from(droneJobs)
    .where(eq(droneJobs.status, "in_progress"));

  for (const job of stuckJobs) {
    if (!job.acknowledgedAt) continue;

    const elapsedSeconds = (now.getTime() - job.acknowledgedAt.getTime()) / 1000;
    if (elapsedSeconds <= job.timeoutSeconds) continue;

    timedOut++;

    if (job.retryCount < job.maxRetries) {
      // Retry: reset to pending
      await db
        .update(droneJobs)
        .set({
          status: "pending",
          acknowledgedAt: null,
          lockedBy: null,
          retryCount: job.retryCount + 1,
          errorMessage: `Timed out after ${job.timeoutSeconds}s (retry ${job.retryCount + 1}/${job.maxRetries})`,
        })
        .where(eq(droneJobs.id, job.id));
      retried++;
    } else {
      // Permanently failed
      await db
        .update(droneJobs)
        .set({
          status: "failed",
          completedAt: now,
          lockedBy: null,
          errorMessage: `Max retries exceeded (${job.maxRetries}). Last timeout after ${job.timeoutSeconds}s.`,
        })
        .where(eq(droneJobs.id, job.id));
    }
  }

  // 2. Expire pending jobs whose expiresAt has passed
  const expiredJobs = await db
    .select()
    .from(droneJobs)
    .where(
      and(
        eq(droneJobs.status, "pending"),
        lt(droneJobs.expiresAt!, now)
      )
    );

  for (const job of expiredJobs) {
    await db
      .update(droneJobs)
      .set({
        status: "expired",
        completedAt: now,
        errorMessage: `Job expired at ${job.expiresAt?.toISOString() || "unknown"}. Never picked up by companion.`,
      })
      .where(eq(droneJobs.id, job.id));
    expired++;
  }

  return { timedOut, retried, expired };
}

/**
 * Start the job reaper interval. Runs every 60 seconds.
 * Call this once at server startup.
 */
let reaperInterval: ReturnType<typeof setInterval> | null = null;

export function startJobReaper(intervalMs: number = 60_000) {
  if (reaperInterval) {
    console.warn("[JobReaper] Already running, skipping duplicate start");
    return;
  }

  console.log(`[JobReaper] Starting with ${intervalMs / 1000}s interval`);

  reaperInterval = setInterval(async () => {
    try {
      const result = await reapStuckJobs();
      if (result.timedOut > 0 || result.expired > 0) {
        console.log(
          `[JobReaper] Reaped: ${result.timedOut} timed out (${result.retried} retried), ${result.expired} expired`
        );
      }
    } catch (error) {
      console.error("[JobReaper] Error during reap cycle:", error);
    }
  }, intervalMs);
}

export function stopJobReaper() {
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
    console.log("[JobReaper] Stopped");
  }
}

// ─── File Helpers ────────────────────────────────────────────────────────────

/**
 * Store uploaded file metadata
 */
export async function createDroneFile(file: InsertDroneFile) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(droneFiles).values(file);
  return result;
}

/**
 * Get file by fileId
 */
export async function getDroneFile(fileId: string) {
  const db = await getDb();
  if (!db) return undefined;

  const files = await db
    .select()
    .from(droneFiles)
    .where(eq(droneFiles.fileId, fileId))
    .limit(1);

  return files.length > 0 ? files[0] : undefined;
}

/**
 * Get all files for a drone
 */
export async function getDroneFiles(droneId: string) {
  const db = await getDb();
  if (!db) return [];

  const files = await db
    .select()
    .from(droneFiles)
    .where(eq(droneFiles.droneId, droneId))
    .orderBy(desc(droneFiles.createdAt));

  return files;
}

/**
 * Delete a file
 */
export async function deleteDroneFile(fileId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.delete(droneFiles).where(eq(droneFiles.fileId, fileId));
}
