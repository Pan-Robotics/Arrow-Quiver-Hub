import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { getLocalUser } from "../db";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  // Local single-user mode: the Hub has no login. Every request is the
  // fixed local admin operator. (Companion computers still authenticate to the
  // REST API with per-drone API keys, independent of this user context.)
  const user = await getLocalUser();

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
