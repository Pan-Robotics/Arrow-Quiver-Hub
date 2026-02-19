import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import "./index.css";

/**
 * Determine if a tRPC error is a transient network failure
 * (e.g., sandbox hibernation, brief connectivity loss)
 */
function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TRPCClientError) {
    const msg = error.message?.toLowerCase() ?? '';
    return msg.includes('failed to fetch') ||
           msg.includes('network') ||
           msg.includes('load failed') ||
           msg.includes('aborted');
  }
  if (error instanceof TypeError && error.message?.toLowerCase().includes('failed to fetch')) {
    return true;
  }
  return false;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Don't retry auth errors
        if (error instanceof TRPCClientError && error.message === UNAUTHED_ERR_MSG) {
          return false;
        }
        // Retry transient network errors up to 3 times
        if (isTransientNetworkError(error)) {
          return failureCount < 3;
        }
        // Default: retry once for other errors
        return failureCount < 1;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
    },
    mutations: {
      retry: (failureCount, error) => {
        // Retry transient network errors for mutations too (up to 2 times)
        if (isTransientNetworkError(error)) {
          return failureCount < 2;
        }
        return false;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
    },
  },
});

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  window.location.href = getLoginUrl();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    // Only log non-transient errors to avoid console noise
    if (!isTransientNetworkError(error)) {
      console.error("[API Query Error]", error);
    } else {
      console.warn("[API Query] Transient network error, retrying...", error?.message);
    }
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    if (!isTransientNetworkError(error)) {
      console.error("[API Mutation Error]", error);
    } else {
      console.warn("[API Mutation] Transient network error, retrying...", error?.message);
    }
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
