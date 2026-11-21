export interface PageSnapshot {
  url: string;
  title: string;
  capturedAt: string;
  metaDescription: string;
  headings: string[];
  buttons: string[];
  links: Array<{ text: string; href: string }>;
  fields: Array<{ name: string; type: string; label: string }>;
  forms: number;
}

export interface DraftScenario {
  snapshot: PageSnapshot;
  scenario: Record<string, unknown>;
  suggestedKey: string;
}

export interface ProjectOption {
  id: string;
  name: string;
  rootPath: string | null;
  websiteUrl: string | null;
}

export interface ExtensionSettings {
  apiUrl: string;
  token: string;
}

const DEFAULT_API = 'http://127.0.0.1:4000';

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(['apiUrl', 'token']);
  return {
    apiUrl: typeof stored.apiUrl === 'string' && stored.apiUrl ? stored.apiUrl : DEFAULT_API,
    token: typeof stored.token === 'string' ? stored.token : '',
  };
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ apiUrl: settings.apiUrl.replace(/\/+$/, ''), token: settings.token.trim() });
}

export async function saveDraft(draft: DraftScenario): Promise<void> {
  await chrome.storage.local.set({ draft });
  await chrome.action.setBadgeText({ text: '1' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
}

export async function loadDraft(): Promise<DraftScenario | null> {
  const stored = await chrome.storage.local.get('draft');
  return (stored.draft as DraftScenario | undefined) ?? null;
}

export async function clearDraft(): Promise<void> {
  await chrome.storage.local.remove('draft');
  await chrome.action.setBadgeText({ text: '' });
}

export async function captureActiveTab(): Promise<DraftScenario> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error('No active tab is available.');
  if (!/^https?:/i.test(tab.url)) {
    throw new Error('Only http(s) pages can be captured. Open a web page and try again.');
  }
  const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotPage });
  const snapshot = results[0]?.result as PageSnapshot | undefined;
  if (!snapshot) throw new Error('The page did not return a snapshot. Reload it and retry.');
  return { snapshot, scenario: scenarioFor(snapshot), suggestedKey: keyFor(snapshot.url) };
}

export function scenarioFor(snapshot: PageSnapshot): Record<string, unknown> {
  const parsed = new URL(snapshot.url);
  const title = snapshot.title.trim() || parsed.hostname;
  const steps: Array<Record<string, unknown>> = [
    { action: 'goto', url: snapshot.url },
    { action: 'expectTitle', value: title.slice(0, 200), mode: 'contains' },
    { action: 'expectUrl', value: parsed.pathname || '/', mode: 'contains' },
    { action: 'expectNoConsoleErrors' },
  ];
  const primaryHeading = snapshot.headings[0];
  if (primaryHeading) {
    steps.push({
      action: 'expectVisible',
      locator: { strategy: 'role', role: 'heading', value: primaryHeading.slice(0, 200) },
    });
  }
  return {
    name: title.slice(0, 200),
    startUrl: snapshot.url,
    browser: 'chromium',
    viewport: { width: 1280, height: 800 },
    timeoutMs: 60000,
    trace: true,
    steps,
    tags: ['captured', 'extension'],
  };
}

export function keyFor(url: string): string {
  let host = 'page';
  let path = '/';
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, '');
    path = parsed.pathname;
  } catch {
    /* keep defaults */
  }
  const slug = `${host}${path}`
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 140);
  return `capture:${slug || 'page'}:${Date.now().toString(36)}`.slice(0, 190);
}

export async function listProjects(settings: ExtensionSettings): Promise<ProjectOption[]> {
  const response = await apiFetch(settings, '/api/v1/projects?page=1&pageSize=100');
  const body = (await response.json()) as { items?: ProjectOption[] };
  if (!Array.isArray(body.items)) throw new Error('The projects response did not contain an item list.');
  return body.items.map((item) => ({
    id: item.id,
    name: item.name,
    rootPath: item.rootPath ?? null,
    websiteUrl: item.websiteUrl ?? null,
  }));
}

export async function verifyToken(settings: ExtensionSettings): Promise<string> {
  const response = await apiFetch(settings, '/api/v1/auth/me');
  const body = (await response.json()) as { user?: { email?: string } };
  return body.user?.email ?? 'authenticated user';
}

export async function createCase(
  settings: ExtensionSettings,
  projectId: string,
  draft: DraftScenario,
  key: string,
  title: string,
): Promise<{ id: string; key: string; title: string }> {
  const response = await apiFetch(settings, `/api/v1/projects/${encodeURIComponent(projectId)}/cases`, {
    method: 'POST',
    body: JSON.stringify({
      key,
      title,
      kind: 'browser',
      priority: 50,
      reason: `Captured from ${draft.snapshot.url} by the ZetHub Proof browser extension.`,
      tags: ['captured', 'extension'],
      scenario: draft.scenario,
    }),
  });
  const body = (await response.json()) as { case?: { id: string; key: string; title: string } };
  if (!body.case) throw new Error('The case was not returned by the API.');
  return body.case;
}

async function apiFetch(settings: ExtensionSettings, path: string, init: RequestInit = {}): Promise<Response> {
  const apiUrl = settings.apiUrl.replace(/\/+$/, '');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(apiUrl)) {
    throw new Error('The API URL must point at http://127.0.0.1 or http://localhost.');
  }
  if (!settings.token) throw new Error('Add a device token from ZetHub Proof Settings first.');
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* response was not JSON */
    }
    throw new Error(message);
  }
  return response;
}

/**
 * Runs inside the inspected page. It must remain self-contained because Chrome
 * serializes this function; it never reads password or file input values.
 */
function snapshotPage(): PageSnapshot {
  const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));
  const text = (element: Element | null) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const headings = unique(Array.from(document.querySelectorAll('h1, h2, h3')).map((element) => text(element))).slice(
    0,
    12,
  );
  const buttons = unique(
    Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).map(
      (element) => text(element) || (element as HTMLInputElement).value || '',
    ),
  ).slice(0, 25);
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((anchor) => ({ text: text(anchor).slice(0, 120), href: (anchor as HTMLAnchorElement).href }))
    .filter((link) => link.text && /^https?:/i.test(link.href))
    .slice(0, 40);
  const fields = Array.from(
    document.querySelectorAll('input:not([type="password"]):not([type="file"]), textarea, select'),
  )
    .map((field) => {
      const input = field as HTMLInputElement;
      const id = input.id || '';
      const label =
        (id ? text(document.querySelector(`label[for="${CSS.escape(id)}"]`)) : '') ||
        (field.getAttribute('aria-label') ?? '') ||
        (field.getAttribute('name') ?? '');
      return {
        name: input.name || id || '(unnamed)',
        type: input.type || field.tagName.toLowerCase(),
        label: label.slice(0, 120),
      };
    })
    .slice(0, 40);
  const meta = document.querySelector('meta[name="description"]');
  return {
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    metaDescription: (meta?.getAttribute('content') ?? '').slice(0, 300),
    headings,
    buttons,
    links,
    fields,
    forms: document.forms.length,
  };
}
