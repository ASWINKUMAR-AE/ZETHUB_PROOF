export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken = '';

export function setCsrfToken(token: string | null | undefined): void {
  csrfToken = token ?? '';
}

export function getCsrfToken(): string {
  return csrfToken;
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['x-csrf-token'] = csrfToken;

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Cannot reach the local ZetHub Proof API. Check that it is running on 127.0.0.1:4000.',
    );
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    if (!response.ok)
      throw new ApiError(response.status, 'HTTP_ERROR', text.slice(0, 500) || `HTTP ${response.status}`);
    return text as unknown as T;
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; details?: unknown };
  } & T;
  if (!response.ok) {
    const err = payload.error;
    if (response.status === 401) window.dispatchEvent(new CustomEvent('zethub:unauthorized'));
    throw new ApiError(
      response.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `HTTP ${response.status}`,
      err?.details,
    );
  }
  return payload;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export async function downloadFile(path: string, fileName: string): Promise<void> {
  const response = await fetch(apiUrl(path), { credentials: 'include' });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(
      response.status,
      'DOWNLOAD_FAILED',
      text.slice(0, 300) || `Download failed (${response.status})`,
    );
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export interface SseEvent {
  type: string;
  runId: string;
  at: string;
  caseKey?: string;
  title?: string;
  status?: string;
  progress?: { completed: number; total: number };
  message?: string;
}

/** Subscribe to run progress. EventSource cannot send CSRF headers, but GET is safe. */
export function subscribeRunEvents(
  runId: string,
  onEvent: (event: SseEvent) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(apiUrl(`/api/v1/runs/${encodeURIComponent(runId)}/events`), { withCredentials: true });
  let closed = false;
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as SseEvent);
    } catch {
      /* ignore malformed event */
    }
  };
  source.onerror = () => {
    if (closed) return;
    source.close();
    onError?.();
  };
  return () => {
    closed = true;
    source.close();
  };
}
