(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const element = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  let guide, evidence, selected, visibleFields = [], pendingFeature;
  const controls = ['policy-search', 'policy-group', 'policy-scope', 'policy-show-fields', 'policy-show-json', 'policy-json-example'];
  const safeAsset = path => typeof path === 'string' && /^assets\/[A-Za-z0-9_./-]+$/.test(path) && !path.includes('..') ? path : null;
  const matchesPath = (pattern, path) => {
    const a = pattern.split('.'), b = path.split('.');
    return a.length === b.length && a.every((part, i) => part === '*' || part === b[i]);
  };
  function fieldForPath(path) {
    if (!guide) return null;
    const candidates = [path, path.replace(/^changes\./, '')];
    return guide.fields.find(f => candidates.some(p => [f.path, ...(f.aliases || [])].some(pattern => matchesPath(pattern, p)))) || null;
  }
  function setView(json) {
    byId('policy-fields').hidden = json;
    byId('policy-json-view').hidden = !json;
    byId('policy-show-fields').setAttribute('aria-pressed', String(!json));
    byId('policy-show-json').setAttribute('aria-pressed', String(json));
    byId('policy-no-results').hidden = json || visibleFields.length > 0;
    byId('policy-detail').hidden = !selected;
  }
  function updateSelection() {
    document.querySelectorAll('#policy-fields [data-policy-field], #policy-json [data-policy-field]').forEach(button => {
      const active = button.dataset.policyField === selected?.id;
      if (button.closest('#policy-fields')) {
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      } else button.setAttribute('aria-pressed', String(active));
    });
  }
  function renderEvidence(field) {
    const container = byId('policy-evidence');
    container.querySelector('video')?.pause();
    container.replaceChildren();
    const reference = field.evidence || {};
    const video = evidence?.videos?.find(v => v.id === reference.videoId);
    const screen = evidence?.media?.screens?.find(s => s.id === reference.screenId);
    if (video && safeAsset(video.file)) {
      container.append(element('span', 'micro-label', 'NAGRANIE POWIĄZANEJ FUNKCJI'));
      const player = element('video');
      player.controls = true; player.muted = true; player.playsInline = true; player.preload = 'none';
      player.setAttribute('aria-label', video.title);
      if (safeAsset(video.poster)) player.poster = video.poster;
      player.src = video.file;
      const fallback = element('p', 'media-fallback', 'Nagranie jest chwilowo niedostępne. Wyjaśnienie pola pozostaje powyżej.');
      fallback.hidden = true;
      player.addEventListener('error', () => { fallback.hidden = false; });
      container.append(player, element('p', '', video.title), fallback);
    } else if (screen && safeAsset(screen.file)) {
      container.append(element('span', 'micro-label', 'SCREEN Z RZECZYWISTEGO DEMO'));
      const image = element('img'); image.src = screen.file; image.alt = field.title + ' — szczegóły w dashboardzie';
      image.loading = 'lazy'; image.width = screen.width; image.height = screen.height;
      image.addEventListener('error', () => {
        image.hidden = true;
        container.append(element('p', 'media-fallback', 'Screen jest chwilowo niedostępny. Wyjaśnienie pola pozostaje powyżej.'));
      });
      container.append(image);
    }
    container.append(element('p', 'evidence-note', reference.note || 'Wyjaśnienie na podstawie schematu i kodu aplikacji. Brak osobnego nagrania tego pola.'));
  }
  function selectField(field) {
    if (!field) return;
    selected = field;
    byId('policy-detail').hidden = false;
    byId('policy-field-path').textContent = field.path;
    byId('policy-field-title').textContent = field.title;
    byId('policy-type').textContent = 'Typ: ' + field.type;
    byId('policy-description').textContent = field.description;
    byId('policy-effect').textContent = field.effect;
    byId('policy-example').textContent = JSON.stringify(field.example, null, 2);
    byId('policy-limits').textContent = field.limits;
    byId('policy-editable').textContent = field.runtimeEditable ? 'Publikacja bez restartu' : 'Konfiguracja przy uruchomieniu';
    byId('policy-editable').dataset.editable = String(field.runtimeEditable);
    byId('policy-aliases').hidden = !field.aliases?.length;
    byId('policy-aliases').textContent = field.aliases?.length ? 'Ta sama reguła dla: ' + field.aliases.join(', ') : '';
    const chips = byId('policy-detail-features'); chips.replaceChildren();
    (field.featureIds || []).forEach(id => {
      const chip = element('button', 'feature-chip', window.BlackwallFeatures?.[id] || id);
      chip.type = 'button'; chip.addEventListener('click', () => selectFeature(id)); chips.append(chip);
    });
    updateSelection();
    // Repeated hover/focus of the same field should preserve a playing clip.
    if (byId('policy-evidence').dataset.field !== field.id) {
      renderEvidence(field); byId('policy-evidence').dataset.field = field.id;
    }
  }
  function bindField(button, field) {
    button.type = 'button'; button.dataset.policyField = field.id;
    button.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') selectField(field); });
    button.addEventListener('focus', () => selectField(field));
    button.addEventListener('click', () => selectField(field));
  }
  function renderFields() {
    if (!guide) return;
    const query = byId('policy-search').value.trim().toLocaleLowerCase('pl');
    const group = byId('policy-group').value, scope = byId('policy-scope').value;
    visibleFields = guide.fields.filter(f => (group === 'all' || f.group === group)
      && (scope === 'all' || f.runtimeEditable === (scope === 'runtime'))
      && (!query || query === '*' || [f.path, f.title, f.description, f.effect, ...(f.aliases || [])].join(' ').toLocaleLowerCase('pl').includes(query)));
    const list = byId('policy-fields'); list.replaceChildren();
    visibleFields.forEach(field => {
      const button = element('button', 'policy-field'); bindField(button, field); button.setAttribute('role', 'option');
      button.append(element('span', 'field-mode' + (field.runtimeEditable ? '' : ' startup'), field.runtimeEditable ? 'runtime' : 'start'), element('code', '', field.path), element('small', '', field.title));
      list.append(button);
    });
    byId('policy-field-count').textContent = visibleFields.length + '/' + guide.fields.length;
    byId('policy-no-results').hidden = visibleFields.length > 0 || !byId('policy-json-view').hidden;
    if (visibleFields.length) {
      selectField(visibleFields.find(f => f.id === selected?.id) || visibleFields[0]);
      const button = [...list.children].find(b => b.dataset.policyField === selected.id);
      if (button) list.scrollTop = button.offsetTop - list.offsetTop;
    }
    else { selected = null; byId('policy-detail').hidden = true; }
  }
  function renderJSON() {
    const example = guide.examples.find(e => e.id === byId('policy-json-example').value) || guide.examples[0];
    byId('policy-json-description').textContent = example.description;
    const output = byId('policy-json'); output.replaceChildren();
    function line(depth, key, path, value, comma, opening) {
      const row = element('div', 'json-line'); row.append(document.createTextNode('  '.repeat(depth)));
      if (key !== null) {
        const field = fieldForPath(path);
        if (field) {
          const button = element('button', 'json-field', JSON.stringify(key));
          bindField(button, field); button.title = field.title; row.append(button);
        } else row.append(element('span', 'json-key', JSON.stringify(key)));
        row.append(document.createTextNode(': '));
      }
      row.append(element('span', 'json-value', opening ?? JSON.stringify(value)));
      if (comma) row.append(document.createTextNode(','));
      output.append(row);
    }
    function object(value, depth, path, key, comma) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        line(depth, key, path, null, false, '{');
        const entries = Object.entries(value);
        entries.forEach(([k, v], i) => object(v, depth + 1, path ? path + '.' + k : k, k, i < entries.length - 1));
        line(depth, null, path, null, comma, '}');
      } else line(depth, key, path, value, comma);
    }
    object(example.patch, 0, '', null, false);
    updateSelection();
  }
  function selectFeature(id) {
    if (!guide) { pendingFeature = id; return; }
    const field = guide.fields.find(f => f.featureIds?.includes(id));
    if (!field) return;
    byId('policy-search').value = ''; byId('policy-group').value = 'all'; byId('policy-scope').value = 'all';
    renderFields(); setView(false); selectField(field);
    const reducedMotion = document.body.classList.contains('reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    byId('polityki').scrollIntoView({behavior: reducedMotion ? 'instant' : 'smooth', block: 'start'});
    const button = [...byId('policy-fields').children].find(b => b.dataset.policyField === field.id);
    button?.focus({preventScroll: true});
    if (button) byId('policy-fields').scrollTop = button.offsetTop - byId('policy-fields').offsetTop;
  }
  window.BlackwallPolicyGuide = {selectFeature, selectField: id => selectField(guide?.fields.find(f => f.id === id || f.path === id))};
  async function loadGuide() {
    controls.forEach(id => { byId(id).disabled = true; });
    byId('policy-load-error').hidden = true;
    try {
      const [response, mediaResponse] = await Promise.all([fetch('assets/policy-guide.json', {cache: 'no-cache'}), fetch('assets/evidence.json', {cache: 'no-cache'})]);
      if (!response.ok) throw new Error('Unavailable guide');
      const data = await response.json();
      if (!Array.isArray(data.fields) || !data.fields.length || !Array.isArray(data.groups) || !data.examples?.length || !data.fields.every(f => f.id && f.path && f.description && f.effect)) throw new Error('Invalid guide');
      guide = data; evidence = mediaResponse.ok ? await mediaResponse.json() : null;
      byId('policy-group').replaceChildren(element('option', '', 'Wszystkie obszary'));
      byId('policy-group').firstChild.value = 'all';
      data.groups.forEach(group => { const option = element('option', '', group.title); option.value = group.id; byId('policy-group').append(option); });
      byId('policy-json-example').replaceChildren();
      data.examples.forEach(example => { const option = element('option', '', example.title); option.value = example.id; byId('policy-json-example').append(option); });
      selected = data.fields.find(f => f.path === 'global.files.read_roots') || data.fields[0];
      byId('policy-evidence').dataset.field = '';
      renderFields(); renderJSON();
      byId('policy-source-note').textContent = `${data.fields.length} objaśnień wygenerowanych na podstawie schematu i kodu Blackwalla. Gwiazdka w ścieżce oznacza nazwę użytkownika, profilu, tematu lub aliasu. Nagrania pokazują powiązaną funkcję; opis pod materiałem wskazuje zakres dowodu.`;
      controls.forEach(id => { byId(id).disabled = false; });
      if (pendingFeature) { const feature = pendingFeature; pendingFeature = null; selectFeature(feature); }
    } catch {
      guide = null; selected = null; byId('policy-detail').hidden = true;
      byId('policy-fields').replaceChildren(element('p', 'loading-copy', 'Opis pól jest chwilowo niedostępny.'));
      byId('policy-load-error').hidden = false;
    }
  }
  ['policy-search', 'policy-group', 'policy-scope'].forEach(id => byId(id).addEventListener(id === 'policy-search' ? 'input' : 'change', renderFields));
  byId('policy-show-fields').addEventListener('click', () => { renderFields(); setView(false); });
  byId('policy-show-json').addEventListener('click', () => { if (!selected) selectField(guide?.fields[0]); setView(true); });
  byId('policy-json-example').addEventListener('change', renderJSON);
  byId('policy-retry').addEventListener('click', loadGuide);
  byId('policy-fields').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !visibleFields.length) return;
    event.preventDefault();
    const index = visibleFields.findIndex(f => f.id === selected?.id);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleFields.length - 1 : Math.max(0, Math.min(visibleFields.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    byId('policy-fields').children[next]?.focus();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) byId('policy-evidence').querySelector('video')?.pause(); });
  loadGuide();
})();
