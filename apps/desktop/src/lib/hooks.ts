import * as React from 'react';
import { ApiError } from './api';

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unexpected error occurred.';
}

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Small fetch hook that aborts stale requests and exposes an explicit reload. */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: React.DependencyList): AsyncState<T> {
  const [state, setState] = React.useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [nonce, setNonce] = React.useState(0);
  const loaderRef = React.useRef(loader);
  loaderRef.current = loader;

  React.useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error as Error).name === 'AbortError') return;
        setState({ data: null, error: errorMessage(error), loading: false });
      });
    return () => controller.abort();
    // The caller owns dependency identity; reload is driven by nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = React.useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, reload };
}

export function useInterval(callback: () => void, delay: number | null): void {
  const saved = React.useRef(callback);
  saved.current = callback;
  React.useEffect(() => {
    if (delay === null) return;
    const timer = setInterval(() => saved.current(), delay);
    return () => clearInterval(timer);
  }, [delay]);
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useDocumentTitle(title: string): void {
  React.useEffect(() => {
    document.title = `${title} · ZetHub Proof`;
  }, [title]);
}
