export function h(tag, props = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
        if (value === undefined || value === null)
            continue;
        if (key === 'class')
            element.className = value;
        else if (key === 'text')
            element.textContent = value;
        else if (key === 'html')
            element.innerHTML = value;
        else if (key === 'dataset') {
            for (const [name, data] of Object.entries(value))
                element.dataset[name] = data;
        } else if (key.startsWith('on') && typeof value === 'function')
            element.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key in element)
            element[key] = value;
        else
            element.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false)
            continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
}

export function icon(provider) {
    return h('img', {
        src: `/icons/provider-${provider}-symbolic.svg`,
        alt: '',
        loading: 'lazy',
    });
}

export function panel(title, subtitle, ...contents) {
    const head = title
        ? h('div', {class: 'panel-head'},
            h('div', {},
                h('h2', {class: 'panel-title', text: title}),
                subtitle ? h('p', {class: 'panel-sub', text: subtitle}) : null))
        : null;
    return h('section', {class: 'panel'}, head, ...contents);
}

export function row(title, description, control) {
    return h('div', {class: 'row'},
        h('div', {class: 'row-copy'},
            h('div', {class: 'row-title', text: title}),
            description ? h('div', {class: 'row-desc', text: description}) : null),
        control ? h('div', {class: 'row-control'}, control) : null);
}

export function switchControl(checked, onChange, label = '') {
    const input = h('input', {type: 'checkbox', checked: Boolean(checked)});
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', {class: 'switch'}, input, label ? h('span', {text: label}) : null);
}

export function numberControl(value, {min = 0, max = 100, step = 1, onChange} = {}) {
    const input = h('input', {
        type: 'number',
        value: String(value ?? 0),
        min: String(min),
        max: String(max),
        step: String(step),
    });
    input.addEventListener('change', () => {
        const parsed = Number.parseInt(input.value, 10);
        if (!Number.isFinite(parsed)) {
            input.value = String(value ?? 0);
            return;
        }
        const clamped = Math.max(min, Math.min(max, parsed));
        input.value = String(clamped);
        onChange(clamped);
    });
    return input;
}

export function selectControl(options, value, onChange) {
    const select = h('select');
    for (const option of options) {
        const item = h('option', {
            value: String(option.value),
            text: option.label,
        });
        item.selected = String(option.value) === String(value);
        select.append(item);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
}

export function button(label, {onClick, className = 'button', type = 'button', disabled = false} = {}) {
    const element = h('button', {class: className, type, text: label, disabled});
    if (onClick)
        element.addEventListener('click', onClick);
    return element;
}

export function statusPill(text, tone = '') {
    return h('span', {class: `pill ${tone}`.trim(), text});
}

export function providerPill(provider) {
    if (provider.secret)
        return statusPill('Secret', 'muted');
    if (provider.browser)
        return statusPill('Browser', 'muted');
    return statusPill('CLI', 'muted');
}

export function errorBox(message, retry) {
    const box = h('div', {class: 'error-box'},
        h('div', {text: message}),
        retry ? h('div', {style: 'margin-top:10px;'},
            button('Retry', {onClick: retry})) : null);
    return box;
}
