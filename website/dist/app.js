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
  shell: {
    tool: 'bash("cat /workspace/public/reports/q3.md")',
    tone: 'approval', effect: 'deny', caption: 'Zmień narzędzie i kontynuuj.',
    message: 'Cały cel tej operacji realizuje read. Polecenie bash nie zostało wykonane. Zaproponuj odczyt tego samego dozwolonego pliku przez read.',
    reason: 'PREFERRED_TOOL_REQUIRED', session: 'continue',
    outcome: 'Brak startu shella · nowa próba wymaga nowej decyzji', audit: 'decision.denied'
  },
  read: {
    tool: 'read("/workspace/public/reports/q3.md")',
    tone: 'allow', effect: 'allow', caption: 'Możesz działać.',
    message: 'Raport znajduje się w dozwolonym katalogu. Kontrole polityki zakończyły się zgodą.',
    reason: 'ALLOWED_BY_POLICY', session: 'continue',
    outcome: 'Odczyt dopuszczony do wykonania', audit: 'decision.allowed'
  },
  secret: {
    tool: 'read("/workspace/.env")',
    tone: 'deny', effect: 'deny', caption: 'Tutaj przebiega granica.',
    message: 'Odczyt tego pliku jest zabroniony przez politykę ochrony sekretów. Skontaktuj się z administratorem.',
    reason: 'PROTECTED_FILE', session: 'block',
    outcome: 'Odczyt zablokowany · brak opcji obejścia', audit: 'decision.denied'
  },
  overwrite: {
    tool: 'write("/workspace/output/report.md", "Raport demonstracyjny")',
    tone: 'approval', effect: 'require_approval', caption: 'Ten ruch należy do Ciebie.',
    message: 'Raport już istnieje. Nadpisanie go wymaga jednorazowej zgody użytkownika. Agent czeka i nie wykonuje kolejnych kroków.',
    reason: 'OVERWRITE_EXISTING_FILE', session: 'await_user',
    outcome: 'Zapis wstrzymany do decyzji użytkownika', audit: 'approval.requested'
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
  outcome: '#decision-outcome', audit: '#audit-event'
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
    ...scenarios.overwrite, tone: 'allow', effect: 'allow', caption: 'Zgoda na ten jeden ruch.',
    message: 'W tym przykładzie zgoda użytkownika i ponowna kontrola warunków pozwalają nadpisać raport. Uprawnienie dotyczy jednej, niezmienionej operacji.',
    reason: 'USER_APPROVED_OPERATION', session: 'continue',
    outcome: 'Jednorazowa zgoda na zapis · wykonanie raportowane osobno',
    audit: 'approval.approved → decision.allowed'
  });
  resetButton.focus({preventScroll: true});
});

document.querySelector('#reject-operation').addEventListener('click', () => {
  if (selectedScenario !== 'overwrite' || approvalResolved) return;
  approvalResolved = true;
  renderDecision({
    ...scenarios.overwrite, tone: 'deny', effect: 'deny', caption: 'Decyzja uszanowana.',
    message: 'Użytkownik odrzucił nadpisanie raportu. Zapis nie jest dopuszczony, a sesja zostaje zablokowana.',
    reason: 'USER_REJECTED_OPERATION', session: 'block',
    outcome: 'Zapis zablokowany', audit: 'approval.rejected → session.blocked'
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
