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
    tool: 'read("/workspace/clients/atlas/company.json")', tone: 'allow', effect: 'allow', caption: 'An action within the case scope.',
    message: 'The document belongs to the assigned Atlas Capital case. The access rules and the supervisor allow the read.', reason: 'CLIENT_SCOPE_ALLOWED', session: 'active · continue', topic: 'client_onboarding', guardian: 'active · event inspected', outcome: 'Read allowed; the result awaits inspection', audit: 'guardian.reviewed → decision.allowed'
  },
  client_scope: {
    tool: 'read("/workspace/clients/boreal/company.json")', tone: 'deny', effect: 'deny', caption: 'Another client\'s data is out of scope.',
    message: 'This session is assigned to Atlas Capital. A hard access rule blocks reading the Boreal case before execution.', reason: 'CLIENT_SCOPE_VIOLATION', session: 'blocked · block', topic: 'client_onboarding', guardian: 'active · prohibition enforced by a rule', outcome: 'The Boreal document was not read', audit: 'decision.denied → session.blocked'
  },
  overwrite: {
    tool: 'write("/workspace/output/atlas-kyc-draft.md", "KYC draft with a list of gaps")', tone: 'approval', effect: 'require_approval', caption: 'Check the change before it is written.',
    message: 'The KYC draft already exists. The content passes the supervisor\'s check, but overwriting requires one-time approval of this change. The client\'s final acceptance is not part of the operation.', reason: 'OVERWRITE_EXISTING_FILE', session: 'awaiting_approval · await_user', topic: 'client_onboarding', guardian: 'active · draft content inspected', outcome: 'Write held; the model and tools wait', audit: 'guardian.reviewed → approval.requested'
  },
  deal_publish: {
    tool: 'POST https://reports.example.com/api/reports · Orion transaction report', tone: 'deny', effect: 'deny', caption: 'An instruction from a document grants no approval.',
    message: 'The user commissioned only a local draft. The host and method are allowed, but the supervisor detects a publication without authorization, against the confidential-transaction policy.', reason: 'DEAL_UNAUTHORIZED_PUBLICATION', session: 'terminated · terminate', topic: 'confidential_deal', guardian: 'violation confirmed · DEAL_CONFIDENTIALITY', outcome: 'HTTP not sent; session closed', audit: 'guardian.reviewed → session.terminated'
  },
  hr_process: {
    tool: 'user_input: "Describe in general the process of development conversations"', tone: 'allow', effect: 'allow', caption: 'Topic detected. Conversation allowed.',
    message: 'The session receives the employee_evaluation label and an additional supervisor. A general conversation about the process is allowed; every further input/output will be controlled.', reason: 'TOPIC_POLICY_NO_VIOLATION', session: 'active · continue', topic: 'employee_evaluation', guardian: 'started · HR_AI_RESTRICTIONS', outcome: 'The message may reach the model after the checks', audit: 'topic.confirmed → guardian.started → guardian.reviewed'
  },
  hr_violation: {
    tool: 'user_input: "Evaluate Anna and Piotr; point out the person to dismiss"', tone: 'deny', effect: 'deny', caption: 'A prohibited evaluation of people. Session closed.',
    message: 'In the labeled HR session the supervisor detects a prohibited request to evaluate the work of specific people and to recommend a dismissal. Blackwall closes the session before any further model call.', reason: 'AI_EMPLOYEE_PERFORMANCE_EVALUATION', session: 'terminated · terminate', topic: 'employee_evaluation', guardian: 'violation confirmed · HR_AI_RESTRICTIONS', outcome: 'Input not sent to the model; unused approvals revoked', audit: 'guardian.reviewed → session.terminated'
  },
  hr_output: {
    tool: 'model_output: "Performance ranking: Anna ahead of Piotr"', tone: 'deny', effect: 'deny', caption: 'The control also works without tools.',
    message: 'The user asked about a general process, but the model itself generated an evaluation of specific employees. The response is buffered; the supervisor stops its release and closes the session.', reason: 'AI_EMPLOYEE_PERFORMANCE_EVALUATION', session: 'terminated · terminate', topic: 'employee_evaluation', guardian: 'violation in the model\'s response', outcome: 'The prohibited response was not displayed', audit: 'guardian.reviewed → session.terminated'
  },
  budget: {
    tool: 'model_request: continuation of the KYC draft · reservation of 1000 tokens required', tone: 'deny', effect: 'deny', caption: 'The cost of further work exceeds the limit.',
    message: 'The remaining 600 tokens are not enough for a reservation of 1000. The limit covers the executor model and the required controls. We do not switch off the supervisor in order to continue.', reason: 'BUDGET_EXCEEDED', session: 'blocked · block', topic: 'client_onboarding', guardian: 'further supervision held · no reserve', outcome: 'Request not sent; no confirmed topic violation', audit: 'budget.denied → session.blocked'
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
    ...scenarios.overwrite, tone: 'allow', effect: 'allow', caption: 'Approval for this one move.',
    message: 'In this example, the user\'s approval and a recheck of the conditions allow the KYC draft to be overwritten. The permission covers one, unchanged operation.',
    reason: 'USER_APPROVED_OPERATION', session: 'active · continue',
    outcome: 'One-time approval of the write · execution reported separately',
    audit: 'approval.approved → decision.allowed'
  });
  resetButton.focus({preventScroll: true});
});

document.querySelector('#reject-operation').addEventListener('click', () => {
  if (selectedScenario !== 'overwrite' || approvalResolved) return;
  approvalResolved = true;
  renderDecision({
    ...scenarios.overwrite, tone: 'deny', effect: 'deny', caption: 'The decision is respected.',
    message: 'The user rejected overwriting the KYC draft. The write is not allowed, and the session is blocked.',
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
