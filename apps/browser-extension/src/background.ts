import {
  captureActiveTab,
  clearDraft,
  createCase,
  listProjects,
  loadDraft,
  loadSettings,
  saveDraft,
  verifyToken,
} from './shared.js';

type Request =
  | { type: 'capture' }
  | { type: 'loadDraft' }
  | { type: 'clearDraft' }
  | { type: 'projects' }
  | { type: 'verify' }
  | { type: 'save'; projectId: string; key: string; title: string };

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'zethub-capture',
      title: 'Capture page for ZetHub Proof',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'zethub-capture' || !tab?.id) return;
  void captureAndStore(tab.id);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-page') void captureAndStore();
});

chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
  handle(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

async function captureAndStore(tabId?: number): Promise<void> {
  const [active] = tabId ? [{ id: tabId }] : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active?.id) return;
  try {
    if (tabId) await chrome.tabs.update(tabId, { active: true });
    const draft = await captureActiveTab();
    await saveDraft(draft);
  } catch {
    // A capture from the context menu has no popup to report to; the badge stays empty.
  }
}

async function handle(message: Request): Promise<unknown> {
  const settings = await loadSettings();
  switch (message.type) {
    case 'capture': {
      const draft = await captureActiveTab();
      await saveDraft(draft);
      return draft;
    }
    case 'loadDraft':
      return loadDraft();
    case 'clearDraft':
      await clearDraft();
      return { ok: true };
    case 'projects':
      return listProjects(settings);
    case 'verify':
      return { email: await verifyToken(settings) };
    case 'save': {
      const draft = await loadDraft();
      if (!draft) throw new Error('Capture a page before saving a case.');
      if (!message.projectId) throw new Error('Choose a project first.');
      if (!message.key.trim() || !message.title.trim()) throw new Error('A case key and title are required.');
      return createCase(settings, message.projectId, draft, message.key.trim(), message.title.trim());
    }
    default:
      throw new Error('Unsupported extension request.');
  }
}
