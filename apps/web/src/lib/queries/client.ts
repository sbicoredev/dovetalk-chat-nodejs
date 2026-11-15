import { MutationCache, QueryClient } from "@tanstack/react-query";

import { errorMessage, isApiError } from "@/lib/api/errors";
import { notify } from "@/lib/stores/ui";

/**
 * Shows a toast for any mutation that fails, unless the mutation sets `meta: { silent: true }`
 * (used where the form shows its own error).
 */
export function createQueryClient() {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.silent) {
          return;
        }
        notify(errorMessage(error));
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retry network trouble and server errors, but never a request the server refused.
        retry: (count, error) =>
          count < 2 && !(isApiError(error) && error.status >= 400 && error.status < 500),
      },
      mutations: { retry: false },
    },
  });
}
