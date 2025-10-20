/**
 * content.js
 * Final Stable Version: Overlay Architecture
 * This version contains the definitive fix for the note typing bug and the
 * typo in the updateMarkup function.
 */

let toolbar;
let highlightOverlay;
let observer; // Make observer globally accessible within this script

// --- INITIALIZATION ---
function init() {
  if (!document.getElementById('markup-highlight-overlay')) {
    highlightOverlay = document.createElement('div');
    highlightOverlay.id = 'markup-highlight-overlay';
    highlightOverlay.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; z-index:9998; pointer-events:none;';
    document.body.appendChild(highlightOverlay);
  } else {
    highlightOverlay = document.getElementById('markup-highlight-overlay');
  }

  loadMarkups();
  window.addEventListener('resize', debounce(loadMarkups, 100));
  window.addEventListener('scroll', debounce(loadMarkups, 100));
  
  const debouncedLoadMarkups = debounce(loadMarkups, 250);
  observer = new MutationObserver((mutationsList) => {
    for (const mutation of mutationsList) {
        if (mutation.target.closest('.markup-sticky-note') || mutation.target.closest('#markup-toolbar')) {
            return;
        }
    }
    debouncedLoadMarkups();
  });

  startObserver();
}

// Function to start the observer
function startObserver() {
    if (observer) {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
}

// Function to stop the observer
function stopObserver() {
    if (observer) {
        observer.disconnect();
    }
}

init();

function debounce(func, delay) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}


// --- UI & EVENT LISTENERS ---
document.addEventListener('mouseup', event => {
  try {
    if (event.target.closest('#markup-toolbar') || event.target.closest('.markup-sticky-note')) {
      return;
    }
    if (toolbar) {
      toolbar.remove();
      toolbar = null;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }
    
    const parentMarkupId = findParentMarkupByOverlap(selection);
    const range = selection.getRangeAt(0);

    if (!parentMarkupId && selection.toString().trim() === '') {
        return;
    }

    const currentToolbar = document.createElement('div');
    currentToolbar.id = 'markup-toolbar';
    document.body.appendChild(currentToolbar);
    const rect = range.getBoundingClientRect();
    currentToolbar.style.left = `${rect.left + window.scrollX}px`;
    currentToolbar.style.top = `${rect.top + window.scrollY - 40}px`;

    if (parentMarkupId) {
      currentToolbar.innerHTML = `<button id="remove-btn">Remove Markup</button>`;
      document.getElementById('remove-btn').onclick = () => removeMarkup(parentMarkupId, currentToolbar);
    } else {
      currentToolbar.innerHTML = `
        <button id="highlight-btn">Highlight</button>
        <button id="underline-btn">Underline</button>
        <button id="note-btn">Add Note</button>
      `;
      document.getElementById('highlight-btn').onclick = () => applyNewMarkup('highlight', range, currentToolbar);
      document.getElementById('underline-btn').onclick = () => applyNewMarkup('underline', range, currentToolbar);
      document.getElementById('note-btn').onclick = () => applyNewNote(range, currentToolbar);
    }
    toolbar = currentToolbar;
  } catch (e) {
    console.error("Markup script failed:", e);
  }
});

function doRectsOverlap(rect1, rect2) {
    return !(rect1.right < rect2.left || rect1.left > rect2.right || rect1.bottom < rect2.top || rect1.top > rect2.bottom);
}

function findParentMarkupByOverlap(selection) {
    const range = selection.getRangeAt(0);
    const selectionRects = Array.from(range.getClientRects());
    const mainSelectionRect = range.getBoundingClientRect();
    if (mainSelectionRect.width === 0 && mainSelectionRect.height === 0) {
        return null;
    }

    const allHighlights = highlightOverlay.querySelectorAll('[data-markup-id]');
    for (const highlightEl of allHighlights) {
        const highlightRect = highlightEl.getBoundingClientRect();
        for (const selectionRect of selectionRects) {
            if (doRectsOverlap(selectionRect, highlightRect)) {
                return highlightEl.dataset.markupId;
            }
        }
    }
    return null;
}


// --- CORE MARKUP & NOTE LOGIC ---

async function applyNewMarkup(type, range, toolbarToRemove) {
    const positionData = getSelectorForRange(range);
    const selectedText = range.toString();
    const groupId = `markup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const { highlightColor, underlineColor } = await chrome.storage.sync.get(['highlightColor', 'underlineColor']);
    const color = type === 'highlight' ? highlightColor || '#fff888' : underlineColor || '#ff5555';
    
    const markupData = { id: groupId, type, text: selectedText, position: positionData, color: color };
    
    drawHighlight(range, type, groupId, color);
    await saveMarkup(markupData);

    if (toolbarToRemove) {
        toolbarToRemove.remove();
        toolbar = null;
    }
    window.getSelection().removeAllRanges();
}

function drawHighlight(range, type, groupId, color) {
    const rects = range.getClientRects();
    for (const rect of rects) {
        const highlightEl = document.createElement('div');
        highlightEl.className = `markup--${type}`;
        highlightEl.dataset.markupId = groupId;

        let style = `
            position: absolute;
            top: ${rect.top + window.scrollY}px;
            left: ${rect.left + window.scrollX}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            pointer-events: none;
            z-index: 9998;
        `;
        if (type === 'highlight') {
            const rgbaColor = hexToRgba(color, 0.5);
            style += `background-color: ${rgbaColor};`;
            style += `box-shadow: 0 0 2px 2px ${rgbaColor};`;
        } else if (type === 'underline') {
            style += `border-bottom: 2px solid ${color};`;
        }
        highlightEl.style.cssText = style;
        
        highlightOverlay.appendChild(highlightEl);
    }
}

async function removeMarkup(groupId, toolbarToRemove) {
  const highlightElements = highlightOverlay.querySelectorAll(`[data-markup-id="${groupId}"]`);
  highlightElements.forEach(el => el.remove());

  const url = window.location.href;
  const data = await chrome.storage.local.get(url);
  if (!data[url] || !data[url].markups) return;
  const newMarkups = data[url].markups.filter(m => m.id !== groupId);
  await chrome.storage.local.set({ [url]: { markups: newMarkups } });

  if (toolbarToRemove) {
    toolbarToRemove.remove();
    toolbar = null;
  }
  window.getSelection().removeAllRanges();
}

async function loadMarkups() {
    if (!highlightOverlay) return;

    const url = window.location.href;
    const data = await chrome.storage.local.get(url);
    const markups = (data[url] && data[url].markups) ? data[url].markups : [];

    // --- Redraw Highlights/Underlines ---
    const textMarkups = markups.filter(m => m.type === 'highlight' || m.type === 'underline');
    const drawnMarkupIds = new Set();

    for (const markup of textMarkups) {
        drawnMarkupIds.add(markup.id);
        try {
            const range = getRangeFromSelector(markup.position);
            if (range) {
                const newRects = Array.from(range.getClientRects());
                const existingElements = highlightOverlay.querySelectorAll(`[data-markup-id="${markup.id}"]`);
                
                for (let i = 0; i < newRects.length; i++) {
                    const rect = newRects[i];
                    let el = existingElements[i];
                    if (!el) {
                        el = document.createElement('div');
                        highlightOverlay.appendChild(el);
                    }
                    
                    const color = markup.color || (markup.type === 'highlight' ? '#fff888' : '#ff5555');
                    
                    el.className = `markup--${markup.type}`;
                    el.dataset.markupId = markup.id;
                    el.style.position = 'absolute';
                    el.style.top = `${rect.top + window.scrollY}px`;
                    el.style.left = `${rect.left + window.scrollX}px`;
                    el.style.width = `${rect.width}px`;
                    el.style.height = `${rect.height}px`;
                    el.style.pointerEvents = 'none';

                    if (markup.type === 'highlight') {
                        const rgbaColor = hexToRgba(color, 0.5);
                        el.style.backgroundColor = rgbaColor;
                        el.style.boxShadow = `0 0 2px 2px ${rgbaColor}`;
                        el.style.borderBottom = '';
                    } else if (markup.type === 'underline') {
                        el.style.borderBottom = `2px solid ${color}`;
                        el.style.backgroundColor = 'transparent';
                        el.style.boxShadow = '';
                    }
                }
                for (let i = newRects.length; i < existingElements.length; i++) {
                    existingElements[i].remove();
                }
            }
        } catch (e) { console.error('Could not re-apply markup:', markup.id, e); }
    }
    
    highlightOverlay.querySelectorAll('[data-markup-id]').forEach(el => {
        if (!drawnMarkupIds.has(el.dataset.markupId)) {
            el.remove();
        }
    });

    // --- Redraw Notes ---
    document.querySelectorAll('.markup-sticky-note').forEach(note => note.remove());
    const noteMarkups = markups.filter(m => m.type === 'note');
    for (const markup of noteMarkups) {
        createNoteElement(markup);
    }
}

// NOTE-SPECIFIC FUNCTIONS
async function applyNewNote(range, toolbarToRemove) {
  try {
    const rect = range.getBoundingClientRect();
    const noteData = {
      id: `note-${Date.now()}`,
      type: 'note', text: '',
      position: { top: rect.top + window.scrollY, left: 20 },
      selection: getSelectorForRange(range)
    };
    createNoteElement(noteData);
    await saveMarkup(noteData);
  } catch(e) {
     console.error("Failed to apply new note:", e);
  } finally {
    if (toolbarToRemove) {
      toolbarToRemove.remove();
      toolbar = null;
    }
  }
}

function createNoteElement(noteData) {
  if (document.getElementById(noteData.id)) return;
  const note = document.createElement('div');
  note.id = noteData.id;
  note.className = 'markup-sticky-note';
  note.style.left = `${noteData.position.left}px`;
  note.style.top = `${noteData.position.top}px`;
  
  const textarea = document.createElement('textarea');
  textarea.value = noteData.text;
  textarea.placeholder = 'Type your note...';

  note.addEventListener('focusin', () => {
    stopObserver();
  });
  
  note.addEventListener('focusout', () => {
    startObserver();
  });

  const closeButton = document.createElement('button');
  closeButton.style.cssText = 'position: absolute; top: 2px; right: 2px; background: none; border: none; font-size: 18px; cursor: pointer; padding: 0; line-height: 1; color: #555;';
  closeButton.innerHTML = '&times;';
  closeButton.onclick = () => removeNote(noteData.id);

  let textUpdateTimeout;
  textarea.oninput = () => {
    clearTimeout(textUpdateTimeout);
    textUpdateTimeout = setTimeout(() => {
      noteData.text = textarea.value;
      updateMarkup(noteData);
    }, 500);
  };
  
  note.appendChild(closeButton);
  note.appendChild(textarea);
  document.body.appendChild(note);
  
  textarea.focus();
}

async function removeNote(noteId) {
  const noteElement = document.getElementById(noteId);
  if (noteElement) noteElement.remove();
  const url = window.location.href;
  const data = await chrome.storage.local.get(url);
  if (!data[url] || !data[url].markups) return;
  const newMarkups = data[url].markups.filter(m => m.id !== noteId);
  await chrome.storage.local.set({ [url]: { markups: newMarkups } });
}


// --- DATA PERSISTENCE & HELPERS ---
async function saveMarkup(markupData) {
  const url = window.location.href;
  const data = await chrome.storage.local.get(url);
  const markups = (data[url] && data[url].markups) ? data[url].markups : [];
  markups.push(markupData);
  await chrome.storage.local.set({ [url]: { markups } });
}

async function updateMarkup(updatedMarkup) {
  const url = window.location.href;
  const data = await chrome.storage.local.get(url);
  if (!data[url] || !data[url].markups) return;

  // THE FIX: The constant was named 'markups' but the save function used 'newMarkups'.
  const newMarkups = data[url].markups.map(m => m.id === updatedMarkup.id ? updatedMarkup : m);
  await chrome.storage.local.set({ [url]: { markups: newMarkups } });
}

function hexToRgba(hex, alpha = 1) {
    if (!hex || hex.length < 7) hex = '#fff888';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// --- XPATH & RANGE HELPERS ---
function getPathTo(element) {
    if (element.id) return `//*[@id="${element.id}"]`;
    if (element === document.body) return '/html/body';
    if (element.nodeType === Node.TEXT_NODE) {
        let index = 1; let sibling = element.previousSibling;
        while (sibling) {
            if (sibling.nodeType === Node.TEXT_NODE) { index++; }
            sibling = sibling.previousSibling;
        }
        return getPathTo(element.parentNode) + `/text()[${index}]`;
    }
    let index = 1; let sibling = element.previousElementSibling;
    while (sibling) {
        if (sibling.tagName === element.tagName) { index++; }
        sibling = sibling.previousElementSibling;
    }
    return getPathTo(element.parentNode) + `/${element.tagName.toLowerCase()}[${index}]`;
}

function getNodeByXpath(path) {
  try {
    return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  } catch (e) { return null; }
}

function getSelectorForRange(range) {
  return {
    startContainerPath: getPathTo(range.startContainer),
    startOffset: range.startOffset,
    endContainerPath: getPathTo(range.endContainer),
    endOffset: range.endOffset,
  };
}

function getRangeFromSelector(selector) {
    const startNode = getNodeByXpath(selector.startContainerPath);
    const endNode = getNodeByXpath(selector.endContainerPath);
    if (startNode && endNode) {
        const range = document.createRange();
        range.setStart(startNode, selector.startOffset);
        range.setEnd(endNode, selector.endOffset);
        return range;
    }
    return null;
}