(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const reducedMotion = () => document.body.classList.contains('reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior = () => reducedMotion() ? 'instant' : 'smooth';
  let suppressPolicyHover = false;
  document.addEventListener('pointerenter', event => {
    if (suppressPolicyHover && event.pointerType === 'mouse' && event.target.closest?.('#policy-fields [data-policy-field], #policy-json [data-policy-field]')) event.stopImmediatePropagation();
  }, true);
  document.addEventListener('pointermove', () => { suppressPolicyHover = false; }, true);

  function mappedDisclosure(target) {
    if (!target) return null;
    for (const [contentId, detailId] of [['replay', 'audit-details'], ['proces', 'sequence-details'], ['polityki', 'policy-details']]) {
      const content = byId(contentId);
      if (content && (content === target || content.contains(target))) return byId(detailId);
    }
    return null;
  }
  function revealTarget(target) {
    if (!target) return;
    const ancestors = [];
    for (let element = target; element; element = element.parentElement) {
      if (element.matches?.('details')) ancestors.push(element);
    }
    if (target.matches?.('details')) ancestors.unshift(target);
    const mapped = mappedDisclosure(target);
    if (mapped && !ancestors.includes(mapped)) ancestors.push(mapped);
    ancestors.forEach(detail => { detail.open = true; });
  }
  function targetFromHash(hash) {
    if (!hash || hash === '#') return null;
    let id;
    try { id = decodeURIComponent(hash.slice(1)); } catch { id = hash.slice(1); }
    return byId(id);
  }
  function followHash(hash, scroll = false) {
    const target = targetFromHash(hash);
    if (!target) return;
    revealTarget(target);
    if (scroll) requestAnimationFrame(() => target.scrollIntoView({behavior: behavior(), block: 'start'}));
  }
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href^="#"]');
    if (!link) return;
    followHash(link.getAttribute('href'));
  }, true);
  addEventListener('hashchange', () => followHash(location.hash, true));
  if (location.hash) followHash(location.hash, true);

  function handleDisclosureClose(detail) {
    if (detail.open) return;
    if (detail.id === 'audit-details' || detail.contains(byId('dashboard'))) window.BlackwallPresentation?.pause();
    if (detail.querySelectorAll) detail.querySelectorAll('video').forEach(video => video.pause());
    if (detail.id === 'sequence-details' || detail.contains(byId('process-workbench'))) window.BlackwallProcess?.stop();
  }
  document.querySelectorAll('details').forEach(detail => detail.addEventListener('toggle', () => handleDisclosureClose(detail)));

  document.addEventListener('click', event => {
    const sessionControl = event.target.closest?.('[data-demo-session]');
    if (sessionControl) {
      const audit = byId('audit-details'); if (audit) audit.open = true;
      window.BlackwallPresentation?.selectSessionById(sessionControl.dataset.demoSession, sessionControl.dataset.demoEvent || 'first');
      requestAnimationFrame(() => byId('dashboard')?.scrollIntoView({behavior: behavior(), block: 'start'}));
      return;
    }

    const preset = event.target.closest?.('[data-policy-preset]');
    if (preset) { void selectPolicyPreset(preset.dataset.policyPreset); return; }

    if (event.target.closest?.('.feature-chip, [data-feature]')) {
      const policy = byId('policy-details'); if (policy) policy.open = true;
    }
  }, true);

  async function selectPolicyPreset(fieldId) {
    suppressPolicyHover = true;
    const detail = byId('policy-details'); if (detail) detail.open = true;
    const search = byId('policy-search'), group = byId('policy-group'), scope = byId('policy-scope');
    if (!search || !group || !scope) return;
    search.value = ''; group.value = 'all'; scope.value = 'all';
    search.dispatchEvent(new Event('input', {bubbles: true}));
    group.dispatchEvent(new Event('change', {bubbles: true}));
    scope.dispatchEvent(new Event('change', {bubbles: true}));
    byId('policy-show-fields')?.click();

    let fieldButton = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      fieldButton = [...(byId('policy-fields')?.querySelectorAll('[data-policy-field]') || [])]
        .find(button => button.dataset.policyField === fieldId) || null;
      if (fieldButton) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!fieldButton) return;
    const fieldDetail = byId('policy-detail');
    if (fieldDetail) {
      window.BlackwallPolicyGuide?.selectField(fieldId);
      if (!fieldDetail.hasAttribute('tabindex')) fieldDetail.tabIndex = -1;
      fieldDetail.scrollIntoView({behavior: behavior(), block: 'nearest'});
      // Scrolling can move the stationary pointer over a different field button.
      // Reapply the requested field after hit testing, then focus its explanation.
      await new Promise(resolve => setTimeout(resolve, 120));
      window.BlackwallPolicyGuide?.selectField(fieldId);
      fieldDetail.focus({preventScroll: true});
    }
  }

  // Policy feature chips can be rendered before the policy module is ready.
  // Wrap the public API when it appears so every caller reveals its disclosure first.
  function guardFeatureNavigation() {
    const guide = window.BlackwallPolicyGuide;
    if (!guide || guide.__juryGuideWrapped) return false;
    const selectFeature = guide.selectFeature;
    guide.selectFeature = id => {
      const detail = byId('policy-details'); if (detail) detail.open = true;
      requestAnimationFrame(() => selectFeature.call(guide, id));
    };
    Object.defineProperty(guide, '__juryGuideWrapped', {value: true});
    return true;
  }
  if (!guardFeatureNavigation()) {
    const observer = new MutationObserver(() => { if (guardFeatureNavigation()) observer.disconnect(); });
    observer.observe(document.documentElement, {childList: true, subtree: true});
    setTimeout(() => observer.disconnect(), 15000);
  }
})();
