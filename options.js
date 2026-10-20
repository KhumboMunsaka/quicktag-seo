// QuickTag settings page: default copy format and the keyboard shortcut.

const api = globalThis.browser ?? globalThis.chrome;
const SETTINGS_KEY = 'quicktag_settings';
const COMMAND = '_execute_action';
const isMac = /Mac/i.test(navigator.platform);
const browserName = /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome';
const $ = (id) => document.getElementById(id);

$('version').textContent = api.runtime.getManifest().version;

// ---------- copy format ----------

async function getSettings() {
  return (await api.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? {};
}

async function initCopyFormat() {
  const format = (await getSettings()).copyFormat ?? 'columns';
  for (const input of document.querySelectorAll('input[name="copy-format"]')) {
    input.checked = input.value === format;
    input.addEventListener('change', async () => {
      await api.storage.local.set({ [SETTINGS_KEY]: { ...(await getSettings()), copyFormat: input.value } });
    });
  }
}

// ---------- keyboard shortcut ----------

// Firefox lets an extension change its own shortcut; Chrome and Edge only allow it on their own page.
const canEdit = typeof api.commands?.update === 'function';

const KEY_LABELS = { MacCtrl: 'Ctrl', Command: '⌘', Comma: ',', Period: '.', Up: '↑', Down: '↓', Left: '←', Right: '→' };

function showKeys(el, shortcut, emptyText = 'Not set') {
  el.replaceChildren();
  el.classList.toggle('none', !shortcut);
  el.classList.remove('waiting');
  if (!shortcut) {
    el.textContent = emptyText;
    return;
  }
  // Chrome on Mac reports symbols without separators (e.g. "⌥⇧Q").
  for (const key of shortcut.includes('+') ? shortcut.split('+') : [...shortcut]) {
    const kbd = document.createElement('kbd');
    kbd.textContent = KEY_LABELS[key] ?? key;
    el.append(kbd);
  }
}

async function refreshShortcut() {
  const cmds = await api.commands.getAll();
  showKeys($('current-shortcut'), cmds.find((c) => c.name === COMMAND)?.shortcut ?? '');
}

function message(text, kind = '') {
  $('shortcut-message').textContent = text;
  $('shortcut-message').className = `message ${kind}`;
}

// Firefox's shortcut syntax for the key part of a keydown, or null for keys it can't use.
function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  const named = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
  if (named[code]) return named[code];
  return ['Comma', 'Period', 'Space', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].includes(code) ? code : null;
}

function modifiers(e) {
  const mods = [];
  if (isMac) {
    if (e.metaKey) mods.push('Command');
    if (e.ctrlKey) mods.push('MacCtrl');
  } else if (e.ctrlKey) {
    mods.push('Ctrl');
  }
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return mods;
}

let recording = false;

function setRecording(on) {
  recording = on;
  $('recorder').hidden = !on;
  $('editor-actions').hidden = on;
  if (on) {
    $('recorder-keys').textContent = 'Press the keys you want to use…';
    $('recorder-keys').className = 'keys waiting';
    message('');
  }
}

async function onRecordKey(e) {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  const mods = modifiers(e);
  if (e.code === 'Escape' && !mods.length) return setRecording(false);

  const key = keyName(e.code);
  showKeys($('recorder-keys'), [...mods, key].filter(Boolean).join('+'));
  if (!key) {
    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) message("That key can't be used in a shortcut.", 'error');
    return; // still waiting for the main key
  }
  if (!mods.some((m) => m !== 'Shift') && !/^F\d+$/.test(key)) {
    return message('Include Ctrl or Alt, for example Alt+Shift+Q.', 'error');
  }
  if (mods.length > 2) return message('Use at most two modifier keys, for example Ctrl+Shift+K.', 'error');

  const shortcut = [...mods, key].join('+');
  try {
    await api.commands.update({ name: COMMAND, shortcut });
  } catch (err) {
    return message(`That shortcut can't be used: ${err.message}`, 'error');
  }
  setRecording(false);
  await refreshShortcut();
  message(`Saved. ${shortcut.replace('MacCtrl', 'Ctrl')} now shows and hides QuickTag.`, 'good');
}

function initShortcut() {
  for (const el of document.querySelectorAll('.browser-name')) el.textContent = browserName;
  $(canEdit ? 'shortcut-editor' : 'shortcut-browser').hidden = false;

  if (canEdit) {
    $('change-shortcut').addEventListener('click', () => setRecording(true));
    $('cancel-shortcut').addEventListener('click', () => setRecording(false));
    $('reset-shortcut').addEventListener('click', async () => {
      await api.commands.reset(COMMAND);
      await refreshShortcut();
      message('Shortcut reset to Alt+Shift+Q.', 'good');
    });
    window.addEventListener('keydown', onRecordKey, true);
    api.commands.onChanged?.addListener(refreshShortcut);
  } else {
    $('open-browser-shortcuts').addEventListener('click', () => {
      api.tabs.create({ url: browserName === 'Edge' ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts' });
    });
  }

  // Pick up a change made on the browser's own page when the user comes back to this tab.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshShortcut();
  });
  refreshShortcut();
}

initCopyFormat();
initShortcut();
