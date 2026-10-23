import {hasToken} from './api.js';
import {
    loadState,
    state,
    stopServer,
    subscribe,
} from './store.js';
import {errorBox} from './ui.js';
import {renderGeneral} from './general.js';
import {renderProviders} from './providers.js';
import {renderLayout} from './layout-editor.js';
import {renderAppearance} from './appearance.js';

const pages = {
    general: {title: 'General', render: renderGeneral},
    providers: {title: 'Providers', render: renderProviders},
    layout: {title: 'Layout', render: renderLayout},
    appearance: {title: 'Appearance', render: renderAppearance},
};

let activeTab = 'general';

function setServerStatus(kind, text) {
    document.getElementById('server-dot')?.classList.remove('ok', 'bad');
    if (kind)
        document.getElementById('server-dot')?.classList.add(kind);
    const element = document.getElementById('server-state');
    if (element)
        element.textContent = text;
}

function setSaveStatus(detail) {
    const element = document.getElementById('save-status');
    if (!element)
        return;
    element.classList.remove('saving', 'saved', 'error');
    if (detail.saving) {
        element.textContent = 'Saving…';
        element.classList.add('saving');
    } else if (detail.saved) {
        element.textContent = 'Saved';
        element.classList.add('saved');
        window.setTimeout(() => {
            if (element.textContent === 'Saved') {
                element.textContent = '';
                element.classList.remove('saved');
            }
        }, 1800);
    }
}

function renderNav() {
    for (const item of document.querySelectorAll('.nav-item')) {
        item.classList.toggle('active', item.dataset.tab === activeTab);
        item.setAttribute('aria-current', item.dataset.tab === activeTab ? 'page' : 'false');
    }
    const title = document.getElementById('page-title');
    if (title)
        title.textContent = pages[activeTab].title;
}

function renderError(error) {
    const content = document.getElementById('content');
    if (!content)
        return;
    content.replaceChildren(errorBox(error.message ?? String(error), () => {
        content.replaceChildren();
        load();
    }));
}

function render() {
    renderNav();
    const content = document.getElementById('content');
    if (!content || !state.data)
        return;
    try {
        pages[activeTab].render(content);
    } catch (error) {
        console.error(error);
        renderError(error);
    }
}

async function load() {
    if (!hasToken()) {
        renderError(new Error('This settings page is missing its access token. Open it from the Agent Quota Settings window.'));
        return;
    }
    setServerStatus('', 'Loading…');
    try {
        await loadState();
        setServerStatus('ok', 'Connected');
        render();
    } catch (error) {
        setServerStatus('bad', 'Disconnected');
        renderError(error);
    }
}

function wireNavigation() {
    for (const item of document.querySelectorAll('.nav-item')) {
        item.addEventListener('click', () => {
            activeTab = item.dataset.tab;
            render();
        });
    }
    document.getElementById('refresh')?.addEventListener('click', () => {
        load();
    });
    document.getElementById('stop-server')?.addEventListener('click', () => {
        stopServer();
    });
}

subscribe('save-status', setSaveStatus);
subscribe('reload', () => {
    if (state.error)
        return;
    render();
});

wireNavigation();
load();
