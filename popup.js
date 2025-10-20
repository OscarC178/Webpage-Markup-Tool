/**
 * popup.js
 * Handles all user interactions within the extension's popup window.
 */

const statusDiv = document.getElementById('status');
const highlightColorPicker = document.getElementById('highlightColorPicker');
const underlineColorPicker = document.getElementById('underlineColorPicker');

const showStatus = (message, isError = false) => {
  statusDiv.textContent = message;
  statusDiv.style.color = isError ? '#D8000C' : '#4F8A10';
  setTimeout(() => statusDiv.textContent = '', 3000); // Clear status after 3 seconds
};

// Load saved colors when the popup opens
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(['highlightColor', 'underlineColor'], (settings) => {
    highlightColorPicker.value = settings.highlightColor || '#fff888'; // Default yellow
    underlineColorPicker.value = settings.underlineColor || '#ff5555'; // Default red
  });
});

// Save the highlight color when it's changed
highlightColorPicker.addEventListener('input', () => {
    chrome.storage.sync.set({ highlightColor: highlightColorPicker.value });
});

// Save the underline color when it's changed
underlineColorPicker.addEventListener('input', () => {
    chrome.storage.sync.set({ underlineColor: underlineColorPicker.value });
});


// --- Exporter Functions ---

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getMarkupsForCurrentPage() {
  const tab = await getCurrentTab();
  if (!tab || !tab.url) {
    return { url: '', markups: [] };
  }
  
  const data = await chrome.storage.local.get(tab.url);
  const markups = (data[tab.url] && data[tab.url].markups) ? data[tab.url].markups : [];
  return { url: tab.url, markups };
}

document.getElementById('copyTextBtn').addEventListener('click', async () => {
  const { url, markups } = await getMarkupsForCurrentPage();
  const textMarkups = markups.filter(m => m.type === 'highlight' || m.type === 'underline');

  if (textMarkups.length === 0) {
    showStatus("No highlighted/underlined text.", true);
    return;
  }

  const textToCopy = [`Source: ${url}`];
  textMarkups.forEach(markup => {
    textToCopy.push(`\n---\n"${markup.text}"`);
  });

  try {
    await navigator.clipboard.writeText(textToCopy.join(''));
    showStatus(" Marked text copied!");
  } catch (err) {
    showStatus(" Could not copy to clipboard.", true);
  }
});

document.getElementById('downloadPdfBtn').addEventListener('click', async () => {
  const tab = await getCurrentTab();
  if (!tab) {
    showStatus("Could not find active tab.", true);
    return;
  }
  
  showStatus("Opening print dialog...");
  
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.print(),
    });
  } catch (err) {
    showStatus(" Could not open print dialog.", true);
  }
});