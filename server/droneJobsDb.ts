import { eq, and, desc } from "drizzle-orm";
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
 * Get pending jobs for a specific drone
 */
export async function getPendingJobsForDrone(droneId: string) {
  const db = await getDb();
  if (!db) return [];

  const jobs = await db
    .select()
    .from(droneJobs)
    .where(
      and(
        eq(droneJobs.droneId, droneId),
        eq(droneJobs.status, "pending")
      )
    )
    .orderBy(droneJobs.createdAt);

  return jobs;
}

/**
 * Mark a job as acknowledged (in progress)
 */
export async function acknowledgeJob(jobId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(droneJobs)
    .set({
      status: "in_progress",
      acknowledgedAt: new Date(),
    })
    .where(eq(droneJobs.id, jobId));
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
