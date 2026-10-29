'use strict';

// Firefox uses the browser.* namespace (Promise-based); Chrome/Edge use chrome.*
const storageLocal = (typeof browser !== 'undefined') ? browser.storage.local : chrome.storage.local;

// agentPort is replaced per-browser by the build script (build.js writeBackgroundJS).
// Chrome/Firefox/Safari use 61337; Edge uses 62337.
const agentPort = 61337;
const httpListener = `http://localhost:${agentPort}/`;

// Persistent per-Chrome-profile identifier stored in chrome.storage.local.
// Unlike a random value generated at runtime, this survives service-worker
// restarts and is unique per OS user on a shared device (each Chrome profile
// has its own chrome.storage.local). Initialized async before any connections.
let lsUDID = null;
let sessionToken = null; // issued by the agent on WS connect, required for HTTP tab data

let refreshInt;
let ws;
let wsConnected = false;
let wsSupported = false; // true once WS connects — disables HTTP poll fallback
let wsReconnectTimeout;
let wsHeartbeat; // keeps MV3 service worker alive via periodic Chrome API calls

// //
// Load or mint the persistent ls-udid, then start connections.
async function initLsUDID() {
  const stored = await storageLocal.get('ls-udid');
  if (stored['ls-udid'] && stored['ls-udid'].startsWith('ls-udid-')) {
    lsUDID = stored['ls-udid'];
  } else {
    lsUDID = 'ls-udid-' + crypto.randomUUID();
    await storageLocal.set({ 'ls-udid': lsUDID });
  }
}

// //
// WebSocket — connect and manage lifecycle
function connectWS() {
  if (!lsUDID) return; // not initialized yet
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  // iid carries the ls-udid so the agent fingerprints this Chrome profile
  // distinctly from other OS users on the same device.
  const wsURL = `ws://localhost:${agentPort}/ws?iid=${lsUDID}`;
  try {
    ws = new WebSocket(wsURL);
  } catch (e) {
    console.debug('[ws] failed to create WebSocket:', e.message);
    scheduleRefresh();
    return;
  }

  ws.onopen = () => {
    console.debug('[ws] connected', lsUDID);
    wsConnected = true;
    wsSupported = true;
    // Stop the poll timer — WS handles delivery from here
    if (refreshInt) {
      clearTimeout(refreshInt);
      refreshInt = undefined;
    }
    if (wsReconnectTimeout) {
      clearTimeout(wsReconnectTimeout);
      wsReconnectTimeout = undefined;
    }
    // Send initial tab data immediately
    sendTabsWS();
    // MV3 service workers terminate after ~30s of idle. Sending tab data every
    // 20s via Chrome API calls (chrome.tabs.query etc.) resets that timer.
    if (wsHeartbeat) clearInterval(wsHeartbeat);
    wsHeartbeat = setInterval(sendTabsWS, 20000);
  };

  ws.onmessage = (event) => {
    try {
      const jResp = JSON.parse(event.data);
      if (jResp.command === 'session_token') {
        sessionToken = jResp.token;
        console.debug('[ws] session token received');
        return;
      }
      processCommand(jResp);
    } catch (e) {
      console.debug('[ws] bad message:', e.message);
    }
  };

  ws.onerror = (err) => {
    console.debug('[ws] error:', err);
  };

  ws.onclose = () => {
    wsConnected = false;
    ws = undefined;
    sessionToken = null;
    if (wsHeartbeat) { clearInterval(wsHeartbeat); wsHeartbeat = undefined; }
    if (wsSupported) {
      console.debug('[ws] disconnected, reconnecting');
      wsReconnectTimeout = setTimeout(connectWS, 5000);
    } else {
      console.debug('[ws] disconnected, falling back to poll');
      scheduleRefresh();
      wsReconnectTimeout = setTimeout(connectWS, 5000);
    }
  };
}

// //
// Send tab data over the WebSocket
function sendTabsWS() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  chrome.windows.getLastFocused({}, (lastFocused) => {
    if (chrome.runtime.lastError || !lastFocused) {
      // Firefox can return null when no window is focused; send empty list as keepalive
      ws.send(JSON.stringify({ action: 'sendTabs', ls_udid: lsUDID, data: [] }));
      return;
    }
    chrome.tabs.query({}, (tabs) => {
      chrome.windows.getAll((windows) => {
        const isBrowserActive = windows.some((w) => w.focused);
        for (const tab of tabs) {
          tab.browserActive = isBrowserActive;
          tab.active = tab.active && tab.windowId === lastFocused.id;
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'sendTabs', ls_udid: lsUDID, data: tabs }));
        }
      });
    });
  });
}

// //
// HTTP poll path — used when WS is unavailable
function scheduleRefresh() {
  if (wsConnected) return; // WS is up, no need to poll
  if (refreshInt) clearTimeout(refreshInt);
  refreshInt = setTimeout(refresh, 1000);
}

function refresh() {
  if (wsConnected) return;
  closeBookmark();

  chrome.windows.getLastFocused({}, (lastFocused) => {
    if (chrome.runtime.lastError || !lastFocused) {
      sendArrayData('sendTabs', JSON.stringify([]));
      return;
    }
    chrome.tabs.query({}, (tabs) => {
      chrome.windows.getAll((windows) => {
        const isBrowserActive = windows.some((window) => window.focused);
        for (const tab of tabs) {
          tab.browserActive = isBrowserActive;
          tab.active = tab.active && tab.windowId == lastFocused.id;
        }
        sendArrayData('sendTabs', JSON.stringify(tabs));
      });
    });
  });
}

// //
// Tab events — send immediately when WS is connected
function onTabChange() {
  if (wsConnected) {
    sendTabsWS();
  }
}

chrome.tabs.onActivated.addListener(onTabChange);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  // Only send on meaningful changes, not every loading state tick
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    onTabChange();
  }
});
chrome.tabs.onCreated.addListener(onTabChange);
chrome.tabs.onMoved.addListener(onTabChange);
chrome.windows.onFocusChanged.addListener(onTabChange);

// //
// Send empty tab list when all tabs are closed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  chrome.tabs.query({}, (tabs) => {
    if (tabs.length === 0) {
      if (wsConnected) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'sendTabs', ls_udid: lsUDID, data: [] }));
        }
      } else {
        sendArrayData('sendTabs', JSON.stringify([]));
      }
    } else {
      onTabChange();
    }
  });
});

// //
// Alarm keeps the background script alive and reconnects WS if dropped
chrome.alarms.create('wake', { delayInMinutes: 1, periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'wake') {
    if (wsConnected) {
      sendTabsWS();
    } else {
      connectWS();
      if (!wsSupported) scheduleRefresh();
    }
  }
});

// //
// find previously created bookmarklets and remove those as well
function closeBookmark() {
  if (!chrome.bookmarks) return;
  chrome.bookmarks.search('javascript:', function(results) {
    for (const result of results) {
      if (result.url && result.url.match(/^javascript:/i)) {
        console.debug('Removing bookmarklet: ' + result.url);
        chrome.bookmarks.remove(result.id);
      }
    }
  });
}

if (chrome.bookmarks) {
  chrome.bookmarks.onCreated.addListener((_id, bookmark) => {
    if (bookmark.url && bookmark.url.match(/^javascript:/i)) {
      console.debug('Removing bookmarklet: ' + bookmark.url);
      chrome.bookmarks.remove(bookmark.id);
    }
  });
}

// //
// Send tab data to listener via HTTP (poll fallback)
function sendArrayData(action, data) {
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Instance-Id': lsUDID,
      'X-Session-Token': sessionToken || '',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS,POST,PUT',
      'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization'
    },
    body: '{"action":"' + action + '","ls_udid":"' + lsUDID + '","data":' + data + '}'
  };

  fetch(httpListener, options)
    .then(async (response) => {
      const jResp = await response.json();
      await processCommand(jResp);
      scheduleRefresh();
    }).catch((error) => {
      console.debug(error.message);
      scheduleRefresh();
    });
}

// //
// Process command (shared by both WS and HTTP paths)
async function processCommand(jResp) {
  switch (jResp.command) {
  case 'closeTabWithId':
    await closeTabWithId(jResp);
    break;
  case 'focusTab':
    await focusTab(jResp);
    break;
  case 'newTab':
    await newTab(jResp);
    break;
  case 'updateTab':
    await updateTab(jResp);
    break;
  case 'commandList':
    await commandList(jResp);
    break;
  }
}

async function closeTabWithId(jResp) {
  console.debug('Closing tab with id:', Number(jResp.data));
  // Firefox's chrome.* namespace doesn't return a Promise for tabs.remove;
  // use browser.tabs.remove when available.
  const tabsApi = (typeof browser !== 'undefined') ? browser.tabs : chrome.tabs;
  await tabsApi.remove(jResp.data);
}

async function focusTab(jResp) {
  console.debug('Focusing tab with id:', Number(jResp.data));
  const tab = await chrome.tabs.get(jResp.data);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(jResp.data, { active: true });
}

async function newTab(jResp) {
  console.debug('Creating new tab');
  await chrome.tabs.create({ url: jResp.data });
}

async function updateTab(jResp) {
  console.debug('Updating tab with id:', Number(jResp.data));
  const tabsApi = (typeof browser !== 'undefined') ? browser.tabs : chrome.tabs;
  await tabsApi.update(jResp.data, { url: jResp.data2 });
}

async function commandList(jResp) {
  const commands = jResp.data;
  for (const command of commands) {
    await processCommand(command);
  }
}

// //
// Startup — load persistent ls-udid first, then connect
initLsUDID().then(() => {
  connectWS();
  scheduleRefresh();
});
