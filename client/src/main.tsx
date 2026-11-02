import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import GatewayNotice from "./components/GatewayNotice";
import { getLoginUrl } from "./const";
import {
  gatewayCooldown,
  gatewayFetch,
  isTransientApiError,
  queryRetryDelay,
  safeApiErrorMetadata,
  shouldRetryQuery,
} from "./lib/gatewayTransport";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetryQuery,
      retryDelay: (attempt, error) =>
        queryRetryDelay(attempt, error, gatewayCooldown),
    },
    // A dropped response does not prove the server did not apply a write.
    // Never replay mutations automatically, including after gateway failures.
    mutations: { retry: false },
  },
});

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;
  if (error.message !== UNAUTHED_ERR_MSG) return;
  window.location.href = getLoginUrl();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    if (isTransientApiError(error)) {
      console.warn(
        "[API Query] Temporarily unavailable; retry cooldown active."
      );
    } else {
      console.error("[API Query Error]", safeApiErrorMetadata(error));
    }
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    if (isTransientApiError(error)) {
      console.warn(
        "[API Mutation] Temporarily unavailable. Action was not automatically retried."
      );
    } else {
      console.error("[API Mutation Error]", safeApiErrorMetadata(error));
    }
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch: gatewayFetch,
    }),
  ],
});

const retryQueries = () => {
  void queryClient
    .refetchQueries({ type: "active" }, { cancelRefetch: false })
    .catch(() => undefined);
};

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <GatewayNotice retryQueries={retryQueries} />
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
