import type { DraftScenario, ProjectOption } from './shared.js';

interface Envelope<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
};

const apiUrl = $<HTMLInputElement>('apiUrl');
const token = $<HTMLInputElement>('token');
const project = $<HTMLSelectElement>('project');
const caseKey = $<HTMLInputElement>('caseKey');
const caseTitle = $<HTMLInputElement>('caseTitle');
const preview = $<HTMLPreElement>('preview');
const status = $<HTMLDivElement>('status');
const saveButton = $<HTMLButtonElement>('save');
const downloadButton = $<HTMLButtonElement>('download');

let draft: DraftScenario | null = null;

function send<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: Envelope<T> | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('The extension background worker did not respond.'));
        return;
      }
      if (!response.ok) {
        reject(new Error(response.error ?? 'Unknown extension error.'));
        return;
      }
      resolve(response.result as T);
    });
  });
}

function show(kind: 'info' | 'ok' | 'error', message: string): void {
  status.className = `status ${kind}`;
  status.textContent = message;
}

function busy(button: HTMLButtonElement, value: boolean): void {
  button.disabled = value;
  button.classList.toggle('busy', value);
}

function renderDraft(): void {
  if (!draft) {
    preview.textContent = 'No capture yet. Open a web page and choose “Capture current tab”.';
    saveButton.disabled = true;
    downloadButton.disabled = true;
    return;
  }
  preview.textContent = JSON.stringify(draft.scenario, null, 2);
  saveButton.disabled = false;
  downloadButton.disabled = false;
  caseKey.value = draft.suggestedKey;
  caseTitle.value = draft.snapshot.title.slice(0, 200) || 'Captured page';
  show('info', `Captured ${draft.snapshot.url}`);
}

async function refreshProjects(): Promise<void> {
  project.innerHTML = '<option value="">Loading…</option>';
  try {
    const items = await send<ProjectOption[]>({ type: 'projects' });
    project.innerHTML = '';
    if (items.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No projects exist yet';
      project.append(option);
      return;
    }
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.websiteUrl ? `${item.name} — ${item.websiteUrl}` : item.name;
      project.append(option);
    }
  } catch (error) {
    project.innerHTML = '<option value="">Unable to load projects</option>';
    show('error', error instanceof Error ? error.message : String(error));
  }
}

$('saveSettings').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ apiUrl: apiUrl.value.replace(/\/+$/, ''), token: token.value.trim() });
    show('ok', 'Connection settings saved locally in this browser profile.');
    await refreshProjects();
  } catch (error) {
    show('error', error instanceof Error ? error.message : String(error));
  }
});

$('testConnection').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('testConnection');
  busy(button, true);
  try {
    await chrome.storage.local.set({ apiUrl: apiUrl.value.replace(/\/+$/, ''), token: token.value.trim() });
    const result = await send<{ email: string }>({ type: 'verify' });
    show('ok', `Connected as ${result.email}.`);
  } catch (error) {
    show('error', error instanceof Error ? error.message : String(error));
  } finally {
    busy(button, false);
  }
});

$('loadProjects').addEventListener('click', async () => {
  await chrome.storage.local.set({ apiUrl: apiUrl.value.replace(/\/+$/, ''), token: token.value.trim() });
  await refreshProjects();
});

$('capture').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('capture');
  busy(button, true);
  try {
    draft = await send<DraftScenario>({ type: 'capture' });
    renderDraft();
  } catch (error) {
    show('error', error instanceof Error ? error.message : String(error));
  } finally {
    busy(button, false);
  }
});

saveButton.addEventListener('click', async () => {
  busy(saveButton, true);
  try {
    if (!draft) throw new Error('Capture a page first.');
    const created = await send<{ id: string; key: string; title: string }>({
      type: 'save',
      projectId: project.value,
      key: caseKey.value,
      title: caseTitle.value,
    });
    show('ok', `Saved case ${created.key}. Open ZetHub Proof to review it.`);
    await send({ type: 'clearDraft' });
    draft = null;
    renderDraft();
  } catch (error) {
    show('error', error instanceof Error ? error.message : String(error));
  } finally {
    busy(saveButton, false);
  }
});

downloadButton.addEventListener('click', () => {
  if (!draft) return;
  const blob = new Blob([JSON.stringify(draft.scenario, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${draft.suggestedKey.replace(/[^a-z0-9._:-]+/gi, '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  show('ok', 'Scenario JSON downloaded. Nothing was sent to the API.');
});

$('openApp').addEventListener('click', (event) => {
  event.preventDefault();
  const base = apiUrl.value.replace(/\/+$/, '') || 'http://127.0.0.1:4000';
  void chrome.tabs.create({ url: `${base}/` });
});

$('clearCapture').addEventListener('click', async () => {
  await send({ type: 'clearDraft' });
  draft = null;
  renderDraft();
  show('info', 'Local capture cleared.');
});

async function init(): Promise<void> {
  const stored = await chrome.storage.local.get(['apiUrl', 'token']);
  apiUrl.value = typeof stored.apiUrl === 'string' ? stored.apiUrl : 'http://127.0.0.1:4000';
  token.value = typeof stored.token === 'string' ? stored.token : '';
  draft = await send<DraftScenario | null>({ type: 'loadDraft' });
  renderDraft();
  if (token.value) await refreshProjects();
}

void init().catch((error: unknown) => {
  show('error', error instanceof Error ? error.message : String(error));
});
