(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const actorOrder = ['pi', 'blackwall', 'policies', 'embeddings', 'guardian', 'jev', 'llm', 'approval', 'executor', 'audit'];
  const icons = {pi: 'π', blackwall: '▥', llm: '◈', embeddings: '∿', guardian: '◎', jev: '◇', policies: '{ }', approval: '✓?', executor: '›_', audit: '≡'};
  const mapLabels = {
    pi: ['Pi', 'chat + tool_call'], blackwall: ['Blackwall', 'gateway + Core · bramka kontroli'],
    llm: ['Model agenta', 'prompt ↔ odpowiedź / tool_call'], embeddings: ['Embeddingi', 'OpenAI / cache → wektory'],
    guardian: ['Guardian', 'nadzór treści · LLM'], jev: ['Jev', 'ocena proponowanej operacji'],
    policies: ['Polityki', 'snapshot Core · lokalnie'], approval: ['Człowiek', 'zgoda w Pi / przegląd admina'],
    executor: ['Executor Pi', 'lokalnie, po udanym consume'], audit: ['SQLite / audyt', 'decyzje · stan · receipts']
  };
  const outcomeLabels = {'model-safe': 'Odpowiedź dopuszczona', 'tool-allow': 'allow → wykonanie', 'tool-approval': 'Ponowna ocena po zgodzie', 'hard-deny': 'deny · brak wykonania', 'topic-violation': 'terminated', 'topic-uncertain': 'Przegląd administratora', publication: 'Nowa wersja aktywna', 'jev-deny': 'deny · brak wykonania'};
  const ns = 'http://www.w3.org/2000/svg';
  let data, scenario, stepIndex = 0, selectedNode, timer = null, messages = [], sequenceWidth = 1100;
  const svg = (tag, attributes, text) => {
    const n = document.createElementNS(ns, tag);
    Object.entries(attributes || {}).forEach(([k, v]) => n.setAttribute(k, String(v)));
    if (text !== undefined) n.textContent = text;
    return n;
  };
  function stop() {
    clearTimeout(timer); timer = null;
    $('process-play').textContent = '▶'; $('process-play').setAttribute('aria-label', 'Odtwórz kroki procesu');
  }
  function valueText(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  function chips(target, values) {
    target.replaceChildren();
    (values || []).forEach(value => target.append(el('code', 'process-event-chip', value)));
  }
  function selectNode(id) {
    const node = data?.nodes.find(n => n.id === id);
    if (!node) return;
    selectedNode = id;
    $('process-detail-title').textContent = node.title;
    $('process-detail-description').textContent = node.description;
    $('process-detail-input').textContent = valueText(node.input);
    $('process-detail-output').textContent = valueText(node.output);
    $('process-detail-conditions').replaceChildren(...(node.conditions || []).map(c => el('li', '', c)));
    const policies = $('process-detail-policies'); policies.replaceChildren();
    (node.policyFields || []).forEach(path => {
      const button = el('button', 'feature-chip', path); button.type = 'button';
      button.title = 'Znajdź opis tego pola w przewodniku po politykach';
      button.addEventListener('click', () => {
        const search = $('policy-search'); search.value = path.endsWith('.*') ? path.slice(0, -1) : path;
        $('policy-group').value = 'all'; $('policy-scope').value = 'all';
        search.dispatchEvent(new Event('input', {bubbles: true})); $('policy-show-fields').click();
        $('polityki').scrollIntoView({behavior: document.body.classList.contains('reduced-motion') ? 'instant' : 'smooth'});
        search.focus({preventScroll: true});
      });
      policies.append(button);
    });
    if (!node.policyFields?.length) policies.append(el('span', 'process-no-policy', 'W tym komponencie brak osobnego pola polityki.'));
    chips($('process-detail-events'), node.auditEvents);
    $('process-detail-sources').replaceChildren(...(node.sources || []).map(source => el('li', '', typeof source === 'string' ? source : `${source.path}${source.line ? ':' + source.line : ''}`)));
    document.querySelectorAll('[data-process-node]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.processNode === id)));
  }
  function sequenceMessages() {
    return scenario.sequenceMessages || scenario.steps.map((step, index) => {
      const edge = data.edges.find(e => e.id === step.edge);
      return {step: index, from: edge?.from || step.node, to: edge?.to || step.node, label: edge?.label || step.title, kind: edge?.kind || 'self', condition: step.condition};
    });
  }
  function wrapLabel(label, limit) {
    const lines = []; let line = '';
    label.split(' ').forEach(word => {
      if (line && (line + ' ' + word).length > limit) { lines.push(line); line = word; }
      else line += (line ? ' ' : '') + word;
    });
    if (line) lines.push(line);
    return lines;
  }
  function renderMap() {
    messages = sequenceMessages();
    const used = new Set(messages.flatMap(m => [m.from, m.to]));
    const actors = actorOrder.filter(id => used.has(id));
    sequenceWidth = Math.max(1100, document.querySelector('.process-map-scroll').clientWidth, actors.length * 155 + 90);
    const height = 130 + messages.length * 82;
    const x = id => 60 + (actors.indexOf(id) + .5) * (sequenceWidth - 120) / actors.length;
    const map = $('process-map'); map.replaceChildren();
    map.classList.add('process-sequence'); map.style.width = sequenceWidth + 'px'; map.style.height = height + 'px';
    const wires = svg('svg', {viewBox: `0 0 ${sequenceWidth} ${height}`, class: 'process-wires', role: 'img', 'aria-labelledby': 'process-svg-title process-svg-description'});
    wires.append(svg('title', {id: 'process-svg-title'}, 'Sequence Diagram — ' + scenario.title), svg('desc', {id: 'process-svg-description'}, 'Pionowe linie oznaczają uczestników. Czas biegnie od góry do dołu. Strzałki pokazują kierunek komunikatu; przerywane strzałki oznaczają odpowiedzi. Warunkowe komunikaty opisano w nawiasach. Kliknij wiersz, aby poznać szczegóły kroku.'));
    const defs = svg('defs');
    ['normal', 'active'].forEach(name => {
      const marker = svg('marker', {id: 'process-arrow-' + name, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto'});
      marker.append(svg('path', {d: 'M0,0 L7,3.5 L0,7 Z', fill: name === 'active' ? '#ffc26a' : '#88a6b7'})); defs.append(marker);
    }); wires.append(defs);
    wires.append(svg('text', {x: 14, y: 115, class: 'sequence-time-label'}, 'CZAS ↓'));
    actors.forEach(id => wires.append(svg('line', {x1: x(id), x2: x(id), y1: 87, y2: height - 20, class: 'sequence-lifeline'})));
    messages.forEach((message, index) => {
      if (message.kind !== 'request' || message.from === message.to) return;
      const reply = messages.findIndex((m, i) => i > index && m.kind === 'response' && m.from === message.to && m.to === message.from);
      if (reply >= 0) wires.append(svg('rect', {x: x(message.to) - 5, y: 152 + index * 82, width: 10, height: (reply - index) * 82, class: 'sequence-activation'}));
    });
    messages.forEach((message, index) => {
      const y = 152 + index * 82, x1 = x(message.from), x2 = x(message.to), self = message.from === message.to;
      const group = svg('g', {'data-sequence-group': index, 'data-sequence-step': message.step, class: 'sequence-message'});
      group.append(svg('rect', {x: 5, y: y - 40, width: sequenceWidth - 10, height: 80, rx: 4, class: 'sequence-row-background'}));
      const path = svg('path', {d: self ? `M ${x1} ${y} h 52 v 18 h -52` : `M ${x1} ${y} H ${x2}`, class: 'sequence-message-wire ' + (message.kind === 'response' ? 'response' : ''), 'marker-end': 'url(#process-arrow-normal)'});
      group.append(path);
      const maxChars = self ? 30 : Math.max(18, Math.floor(Math.abs(x2 - x1) / 7) - 2);
      const labelX = self ? x1 + 12 : (x1 + x2) / 2;
      const label = svg('text', {x: labelX, y: y - 22, 'text-anchor': self ? 'start' : 'middle', class: 'sequence-message-label'});
      const lines = wrapLabel(message.label, maxChars);
      if (lines.length > 2) lines[1] += '…';
      lines.slice(0, 2).forEach((line, n) => label.append(svg('tspan', {x: labelX, dy: n ? 14 : 0}, line)));
      label.append(svg('title', {}, message.label)); group.append(label);
      group.append(svg('text', {x: 18, y: y + 3, class: 'sequence-number'}, String(index + 1).padStart(2, '0')));
      if (message.condition) group.append(svg('text', {x: 56, y: y + 35, class: 'sequence-condition'}, '[' + message.condition + ']'));
      wires.append(group);
    });
    map.append(wires);
    const rail = el('div', 'sequence-actors');
    actors.forEach(id => {
      const node = data.nodes.find(n => n.id === id);
      const button = el('button', 'process-node process-node-' + id); button.type = 'button'; button.dataset.processNode = id;
      button.style.left = x(id) - 65 + 'px'; button.style.width = '130px';
      const icon = el('span', 'process-node-icon', icons[id]); icon.setAttribute('aria-hidden', 'true');
      button.setAttribute('aria-label', node.title + '. ' + node.subtitle);
      button.append(icon, el('strong', '', mapLabels[id][0]), el('small', '', mapLabels[id][1]));
      button.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') selectNode(id); });
      button.addEventListener('focus', () => selectNode(id)); button.addEventListener('click', () => selectNode(id)); rail.append(button);
    }); map.append(rail);
    messages.forEach((message, index) => {
      const from = data.nodes.find(n => n.id === message.from).title, to = data.nodes.find(n => n.id === message.to).title;
      const button = el('button', 'sequence-row'); button.type = 'button'; button.dataset.sequenceMessage = index;
      button.style.top = 112 + index * 82 + 'px'; button.style.height = '80px';
      button.setAttribute('aria-label', `Komunikat ${index + 1}: ${from} → ${to}. ${message.label}${message.condition ? '. Warunek: ' + message.condition : ''}`);
      button.title = `${from} → ${to}: ${message.label}`;
      button.addEventListener('click', () => { stop(); renderStep(message.step, index); }); map.append(button);
    });
  }
  function renderStep(index, messageIndex) {
    stepIndex = index;
    const step = scenario.steps[index];
    $('process-step-label').textContent = `${index + 1} / ${scenario.steps.length}`;
    $('process-step-title').textContent = step.title; $('process-step-description').textContent = step.description;
    $('process-step-condition').textContent = step.condition || 'ETAP WYBRANEJ ŚCIEŻKI';
    chips($('process-step-events'), step.events);
    $('process-prev').disabled = index === 0; $('process-next').disabled = index === scenario.steps.length - 1;
    $('process-outcome').textContent = index === scenario.steps.length - 1 ? outcomeLabels[scenario.id] || 'Koniec ścieżki' : 'Ścieżka w toku';
    $('process-outcome').dataset.outcome = index === scenario.steps.length - 1 ? scenario.id : 'pending';
    $('process-final-summary').hidden = index !== scenario.steps.length - 1;
    $('process-final-summary').textContent = scenario.outcome;
    selectNode(step.node);
    const related = messages.filter(m => m.step === index);
    const first = related[0];
    $('process-hop').textContent = first ? `${data.nodes.find(n => n.id === first.from).title} → ${data.nodes.find(n => n.id === first.to).title} · ${first.label}${related.length > 1 ? ' · ' + related.length + ' komunikaty w tym kroku' : ''}` : step.title;
    document.querySelectorAll('[data-process-node]').forEach(button => { button.dataset.active = String(button.dataset.processNode === step.node); });
    document.querySelectorAll('[data-sequence-group]').forEach(group => {
      const active = Number(group.dataset.sequenceStep) === index;
      group.classList.toggle('active', active);
      group.querySelector('path').setAttribute('marker-end', 'url(#process-arrow-' + (active ? 'active' : 'normal') + ')');
    });
    document.querySelectorAll('[data-sequence-message]').forEach(button => button.setAttribute('aria-pressed', String(messages[Number(button.dataset.sequenceMessage)].step === index)));
    const rowIndex = messageIndex ?? messages.findIndex(m => m.step === index);
    if (rowIndex >= 0) {
      const scroller = document.querySelector('.process-map-scroll'), top = 112 + rowIndex * 82;
      if (top < scroller.scrollTop + 100 || top + 82 > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = Math.max(0, top - 130);
    }
    document.querySelectorAll('[data-process-step]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.processStep) === index)));
  }
  function selectScenario(id) {
    stop(); scenario = data.scenarios.find(s => s.id === id) || data.scenarios[0];
    renderMap(); document.querySelector('.process-map-scroll').scrollTop = 0;
    $('process-scenario').value = scenario.id; $('process-summary').textContent = scenario.summary;
    const list = $('process-route-list'); list.replaceChildren();
    scenario.steps.forEach((step, i) => {
      const button = el('button', 'process-route-step'); button.type = 'button'; button.dataset.processStep = String(i);
      button.append(el('span', '', String(i + 1).padStart(2, '0')), el('strong', '', step.title));
      button.addEventListener('click', () => { stop(); renderStep(i); }); list.append(button);
    }); renderStep(0);
  }
  function schedule() {
    $('process-play').textContent = 'Ⅱ'; $('process-play').setAttribute('aria-label', 'Wstrzymaj kroki procesu');
    timer = setTimeout(() => { if (stepIndex < scenario.steps.length - 1) { renderStep(stepIndex + 1); schedule(); } else stop(); }, 2300);
  }
  async function load() {
    stop(); $('process-load-error').hidden = true;
    ['process-scenario', 'process-play', 'process-reset', 'process-prev', 'process-next'].forEach(id => { $(id).disabled = true; });
    try {
      const response = await fetch('assets/process-flow.json', {cache: 'no-cache'});
      if (!response.ok) throw new Error('Unavailable process');
      const d = await response.json();
      if (d.schemaVersion !== 1 || !Array.isArray(d.nodes) || d.nodes.length !== actorOrder.length || new Set(d.nodes.map(n => n.id)).size !== d.nodes.length || !d.nodes.every(n => actorOrder.includes(n.id) && n.title && n.description && n.input && n.output) || !Array.isArray(d.edges) || !d.edges.every(e => actorOrder.includes(e.from) && actorOrder.includes(e.to)) || !d.scenarios?.length || !d.scenarios.every(s => s.id && s.steps?.length && s.steps.every(step => actorOrder.includes(step.node) && (!step.edge || d.edges.some(e => e.id === step.edge))))) throw new Error('Invalid process');
      if (!d.scenarios.every(s => Array.isArray(s.sequenceMessages) && s.sequenceMessages.length && s.sequenceMessages.every(m => actorOrder.includes(m.from) && actorOrder.includes(m.to) && m.label && Number.isInteger(m.step) && m.step >= 0 && m.step < s.steps.length && ['request', 'response', 'self', 'audit', 'policy'].includes(m.kind)) && s.steps.every((_, i) => s.sequenceMessages.some(m => m.step === i)))) throw new Error('Invalid sequence');
      data = d;
      $('process-scenario').replaceChildren(...d.scenarios.map(s => { const option = el('option', '', s.title); option.value = s.id; return option; }));
      $('process-routes-count').textContent = d.scenarios.length + ' ścieżek · ' + d.nodes.length + ' komponentów';
      $('process-notes').replaceChildren(...(d.notes || []).map(note => el('p', '', note)));
      ['process-scenario', 'process-play', 'process-reset'].forEach(id => { $(id).disabled = false; });
      $('process-detail').hidden = false; selectScenario(d.scenarios.find(s => s.id === 'tool-allow')?.id || d.scenarios[0].id);
    } catch {
      data = null; scenario = null; $('process-detail').hidden = true;
      $('process-map').replaceChildren(el('p', 'loading-copy', 'Nie udało się wczytać mapy komponentów.'));
      $('process-load-error').hidden = false;
    }
  }
  $('process-scenario').addEventListener('change', event => selectScenario(event.target.value));
  $('process-next').addEventListener('click', () => { stop(); if (scenario) renderStep(Math.min(stepIndex + 1, scenario.steps.length - 1)); });
  $('process-prev').addEventListener('click', () => { stop(); if (scenario) renderStep(Math.max(stepIndex - 1, 0)); });
  $('process-reset').addEventListener('click', () => { stop(); if (scenario) renderStep(0); });
  $('process-play').addEventListener('click', () => { if (!scenario) return; if (timer) stop(); else { if (stepIndex === scenario.steps.length - 1) renderStep(0); schedule(); } });
  $('process-retry').addEventListener('click', load);
  $('proces').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !data) return;
    const button = event.target.closest('[data-process-node]');
    if (button) {
      event.preventDefault();
      const nodes = [...document.querySelectorAll('[data-process-node]')];
      const index = nodes.indexOf(button);
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + nodes.length) % nodes.length;
      nodes[target].focus();
    } else if (event.target.closest('#process-controls,#process-route-list,[data-sequence-message]') && scenario) {
      event.preventDefault(); stop();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? scenario.steps.length - 1 : Math.max(0, Math.min(scenario.steps.length - 1, stepIndex + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1)));
      renderStep(next);
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.BlackwallProcess = {selectNode, selectScenario: id => { if (data) selectScenario(id); }, stop};
  load();
})();
