'use strict';

const menuToggle = document.querySelector('.menu-toggle');
const mobileNav = document.querySelector('#mobile-nav');

function closeMenu() {
  mobileNav.hidden = true;
  menuToggle.setAttribute('aria-expanded', 'false');
}

menuToggle.addEventListener('click', () => {
  const open = menuToggle.getAttribute('aria-expanded') !== 'true';
  menuToggle.setAttribute('aria-expanded', String(open));
  mobileNav.hidden = !open;
});
mobileNav.addEventListener('click', (event) => {
  if (event.target.closest('a')) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !mobileNav.hidden) {
    closeMenu();
    menuToggle.focus();
  }
});
window.matchMedia('(min-width: 851px)').addEventListener('change', closeMenu);

// These are illustrative states, not a connection to a policy server or a tool runner.
const scenarios = {
  read: {
    tool: 'read("/workspace/clients/atlas/company.json")', tone: 'allow', effect: 'allow', caption: 'Within the assigned matter.',
    message: 'The document belongs to the assigned Atlas Capital matter. Access rules and the supervisor allow the read.', reason: 'CLIENT_SCOPE_ALLOWED', session: 'active · continue', topic: 'client_onboarding', guardian: 'active · event checked', outcome: 'Read allowed; output awaits inspection', audit: 'guardian.reviewed → decision.allowed'
  },
  client_scope: {
    tool: 'read("/workspace/clients/boreal/company.json")', tone: 'deny', effect: 'deny', caption: 'Another client’s data is out of scope.',
    message: 'This session is assigned to Atlas Capital. A hard access rule blocks the Boreal matter read before execution.', reason: 'CLIENT_SCOPE_VIOLATION', session: 'blocked · block', topic: 'client_onboarding', guardian: 'active · rule enforced', outcome: 'The Boreal document was not read', audit: 'decision.denied → session.blocked'
  },
  overwrite: {
    tool: 'write("/workspace/output/atlas-kyc-draft.md", "KYC draft listing missing items")', tone: 'approval', effect: 'require_approval', caption: 'Review the change before writing.',
    message: 'The KYC draft already exists. The content passes supervisor review, but overwriting it requires one-time approval for this change. Final client approval is outside this operation.', reason: 'OVERWRITE_EXISTING_FILE', session: 'awaiting_approval · await_user', topic: 'client_onboarding', guardian: 'active · draft content checked', outcome: 'Write held; model and tools are waiting', audit: 'guardian.reviewed → approval.requested'
  },
  deal_publish: {
    tool: 'POST https://reports.example.com/api/reports · raport transakcji Orion', tone: 'deny', effect: 'deny', caption: 'An instruction in a document does not grant approval.',
    message: 'The user requested only a local draft. The host and method are allowed, but the supervisor detects publication without authorization under the confidential-deal policy.', reason: 'DEAL_UNAUTHORIZED_PUBLICATION', session: 'terminated · terminate', topic: 'confidential_deal', guardian: 'violation confirmed · DEAL_CONFIDENTIALITY', outcome: 'No HTTP request sent; session terminated', audit: 'guardian.reviewed → session.terminated'
  },
  hr_process: {
    tool: 'user_input: "Describe the performance review process in general"', tone: 'allow', effect: 'allow', caption: 'Sensitive topic detected. Conversation allowed.',
    message: 'The session receives the employee_evaluation label and an additional supervisor. General discussion of the process is allowed; each subsequent input and output is checked.', reason: 'TOPIC_POLICY_NO_VIOLATION', session: 'active · continue', topic: 'employee_evaluation', guardian: 'started · HR_AI_RESTRICTIONS', outcome: 'Message may reach the model after checks', audit: 'topic.confirmed → guardian.started → guardian.reviewed'
  },
  hr_violation: {
    tool: 'user_input: "Evaluate Anna and Peter; recommend whom to dismiss"', tone: 'deny', effect: 'deny', caption: 'Prohibited employee evaluation. Session terminated.',
    message: 'In the labeled HR session, the supervisor detects a prohibited request to evaluate named employees and recommend a dismissal. Blackwall ends the session before another model call.', reason: 'AI_EMPLOYEE_PERFORMANCE_EVALUATION', session: 'terminated · terminate', topic: 'employee_evaluation', guardian: 'violation confirmed · HR_AI_RESTRICTIONS', outcome: 'Input not sent to the model; unused approvals revoked', audit: 'guardian.reviewed → session.terminated'
  },
  hr_output: {
    tool: 'model_output: "Performance ranking: Anna ahead of Peter"', tone: 'deny', effect: 'deny', caption: 'Controls also apply when no tool is used.',
    message: 'The user asked about the process in general, but the model generated an evaluation of named employees. The response is buffered; the supervisor blocks its release and ends the session.', reason: 'AI_EMPLOYEE_PERFORMANCE_EVALUATION', session: 'terminated · terminate', topic: 'employee_evaluation', guardian: 'violation in model response', outcome: 'The prohibited response was not shown', audit: 'guardian.reviewed → session.terminated'
  },
  budget: {
    tool: 'model_request: continue KYC draft · 1,000-token reservation required', tone: 'deny', effect: 'deny', caption: 'Further work exceeds the budget limit.',
    message: 'The remaining 600 tokens cannot cover a 1,000-token reservation. The limit includes the execution model and required checks. Supervision is not disabled to continue.', reason: 'BUDGET_EXCEEDED', session: 'blocked · block', topic: 'client_onboarding', guardian: 'further supervision held · reservation unavailable', outcome: 'Request not sent; no topic violation confirmed', audit: 'budget.denied → session.blocked'
  }
};

let selectedScenario = 'read';
let approvalResolved = false;
const lab = document.querySelector('.decision-lab');
const scenarioButtons = [...document.querySelectorAll('[data-scenario]')];
const approvalActions = document.querySelector('#approval-actions');
const resetButton = document.querySelector('#reset-scenario');
const outputFields = {
  tool: '#tool-preview', effect: '#decision-effect', caption: '#decision-caption',
  message: '#decision-message', reason: '#decision-reason', session: '#decision-session',
  outcome: '#decision-outcome', audit: '#audit-event', topic: '#decision-topic', guardian: '#decision-guardian'
};

function renderDecision(state) {
  lab.dataset.tone = state.tone;
  for (const [key, selector] of Object.entries(outputFields)) {
    document.querySelector(selector).textContent = state[key];
  }
  for (const button of scenarioButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.scenario === selectedScenario));
  }
  approvalActions.hidden = selectedScenario !== 'overwrite' || approvalResolved;
  resetButton.hidden = !approvalResolved;
}

function selectScenario(key) {
  if (!Object.hasOwn(scenarios, key)) return;
  selectedScenario = key;
  approvalResolved = false;
  renderDecision(scenarios[key]);
}

for (const button of scenarioButtons) {
  button.addEventListener('click', () => selectScenario(button.dataset.scenario));
}

document.querySelector('#approve-operation').addEventListener('click', () => {
  if (selectedScenario !== 'overwrite' || approvalResolved) return;
  approvalResolved = true;
  renderDecision({
    ...scenarios.overwrite, tone: 'allow', effect: 'allow', caption: 'Approval for this one operation.',
    message: 'In this example, user approval and a fresh check allow the KYC draft to be overwritten. The grant applies to this one unchanged operation.',
    reason: 'USER_APPROVED_OPERATION', session: 'active · continue',
    outcome: 'One-time approval to write · execution reported separately',
    audit: 'approval.approved → decision.allowed'
  });
  resetButton.focus({preventScroll: true});
});

document.querySelector('#reject-operation').addEventListener('click', () => {
  if (selectedScenario !== 'overwrite' || approvalResolved) return;
  approvalResolved = true;
  renderDecision({
    ...scenarios.overwrite, tone: 'deny', effect: 'deny', caption: 'Decision respected.',
    message: 'The user rejected overwriting the KYC draft. The write is denied and the session is blocked.',
    reason: 'USER_REJECTED_OPERATION', session: 'blocked · block',
    outcome: 'Write blocked', audit: 'approval.rejected → session.blocked'
  });
  resetButton.focus({preventScroll: true});
});
resetButton.addEventListener('click', () => {
  selectScenario(selectedScenario);
  document.querySelector('#approve-operation').focus({preventScroll: true});
});

const juniorDialog = document.querySelector('#junior-dialog');
document.querySelector('#open-junior').addEventListener('click', () => juniorDialog.showModal());
document.querySelector('#close-junior').addEventListener('click', () => juniorDialog.close());
juniorDialog.addEventListener('click', (event) => {
  if (event.target !== juniorDialog) return;
  const bounds = juniorDialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) juniorDialog.close();
});

// Local story navigation only: the conversations are illustrative, not live agent runs.
const storyTabs = [...document.querySelectorAll('[data-story]')];
const storyPanels = [...document.querySelectorAll('.story-panel')];
function activateStory(id, moveFocus = false) {
  for (const tab of storyTabs) {
    const selected = tab.dataset.story === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) tab.focus();
  }
  for (const panel of storyPanels) panel.hidden = panel.id !== `story-${id}`;
}
for (const [index, tab] of storyTabs.entries()) {
  tab.addEventListener('click', () => activateStory(tab.dataset.story));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % storyTabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + storyTabs.length) % storyTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = storyTabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      activateStory(storyTabs[next].dataset.story, true);
    }
  });
}
if (storyTabs.length) activateStory(storyTabs[0].dataset.story);
