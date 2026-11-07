import { trpc } from "@/lib/trpc";
import { useMemo } from "react";

/**
 * Local single-user mode: `auth.me` always returns the local admin operator,
 * so this hook simply surfaces that user. There is no login, logout, session
 * or redirect flow.
 */
export function useAuth() {
  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const state = useMemo(() => {
    return {
      user: meQuery.data ?? null,
      loading: meQuery.isLoading,
      error: meQuery.error ?? null,
      isAuthenticated: Boolean(meQuery.data),
    };
  }, [meQuery.data, meQuery.error, meQuery.isLoading]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
  };
}
