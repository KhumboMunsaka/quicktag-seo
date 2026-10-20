// QuickTag background script (Chrome service worker / Firefox event page).
// The shortcut is bound to _execute_action, so pressing it fires action.onClicked
// just like clicking the toolbar icon.

const api = globalThis.browser ?? globalThis.chrome;

api.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await api.tabs.sendMessage(tab.id, { type: 'quicktag:toggle' });
  } catch {
    // No content script in this tab yet (tab was open before install/update, or the
    // browser hasn't granted site access). The shortcut grants activeTab, so inject now.
    try {
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await api.tabs.sendMessage(tab.id, { type: 'quicktag:toggle', forceOn: true });
    } catch (err) {
      // Browser-internal pages (chrome://, about:, extension stores, PDF viewer) can't be scripted.
      console.warn('QuickTag cannot run on this page:', err);
    }
  }
});

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // The panel footer shows the user's actual shortcut, which they can rebind in the settings page.
  if (msg?.type === 'quicktag:get-shortcut') {
    api.commands
      .getAll()
      .then((cmds) => sendResponse(cmds.find((c) => c.name === '_execute_action')?.shortcut ?? ''))
      .catch(() => sendResponse(null));
    return true;
  }
  // Content scripts can't open the options page themselves.
  if (msg?.type === 'quicktag:open-settings') {
    api.runtime.openOptionsPage();
  }
});
