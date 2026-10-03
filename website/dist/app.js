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
    tool: 'read("/workspace/clients/atlas/company.json")', tone: 'allow', effect: 'allow', caption: 'Działanie w zakresie sprawy.',
    message: 'Dokument należy do przypisanej sprawy Atlas Capital. Reguły dostępu i nadzorca dopuszczają odczyt.', reason: 'CLIENT_SCOPE_ALLOWED', session: 'active · continue', topic: 'client_onboarding', guardian: 'aktywny · zdarzenie skontrolowane', outcome: 'Odczyt dopuszczony; wynik czeka na kontrolę', audit: 'guardian.reviewed → decision.allowed'
  },
  client_scope: {
    tool: 'read("/workspace/clients/boreal/company.json")', tone: 'deny', effect: 'deny', caption: 'Dane innego klienta poza zakresem.',
    message: 'Ta sesja jest przypisana do Atlas Capital. Twarda reguła dostępu blokuje odczyt sprawy Boreal przed wykonaniem.', reason: 'CLIENT_SCOPE_VIOLATION', session: 'blocked · block', topic: 'client_onboarding', guardian: 'aktywny · zakaz egzekwowany przez regułę', outcome: 'Dokument Boreal nie został odczytany', audit: 'decision.denied → session.blocked'
  },
  overwrite: {
    tool: 'write("/workspace/output/atlas-kyc-draft.md", "Szkic KYC z listą braków")', tone: 'approval', effect: 'require_approval', caption: 'Sprawdź zmianę przed zapisem.',
    message: 'Szkic KYC już istnieje. Treść przechodzi kontrolę nadzorcy, ale nadpisanie wymaga jednorazowej zgody na tę zmianę. Finalna akceptacja klienta nie jest częścią operacji.', reason: 'OVERWRITE_EXISTING_FILE', session: 'awaiting_approval · await_user', topic: 'client_onboarding', guardian: 'aktywny · treść szkicu skontrolowana', outcome: 'Zapis wstrzymany; model i toole czekają', audit: 'guardian.reviewed → approval.requested'
  },
  deal_publish: {
    tool: 'POST https://reports.example.com/api/reports · raport transakcji Orion', tone: 'deny', effect: 'deny', caption: 'Instrukcja z dokumentu nie daje zgody.',
    message: 'Użytkownik zlecił tylko lokalny szkic. Host i metoda są dopuszczone, ale nadzorca wykrywa publikację bez upoważnienia wbrew polityce poufnej transakcji.', reason: 'DEAL_UNAUTHORIZED_PUBLICATION', session: 'terminated · terminate', topic: 'confidential_deal', guardian: 'naruszenie potwierdzone · DEAL_CONFIDENTIALITY', outcome: 'HTTP niewysłany; sesja zamknięta', audit: 'guardian.reviewed → session.terminated'
  },
  hr_process: {
    tool: 'user_input: "Opisz ogólnie proces rozmów rozwojowych"', tone: 'allow', effect: 'allow', caption: 'Temat wykryty. Rozmowa dozwolona.',
    message: 'Sesja otrzymuje etykietę employee_evaluation i dodatkowego nadzorcę. Ogólna rozmowa o procesie jest dozwolona; każdy dalszy input/output będzie kontrolowany.', reason: 'TOPIC_POLICY_NO_VIOLATION', session: 'active · continue', topic: 'employee_evaluation', guardian: 'uruchomiony · HR_AI_RESTRICTIONS', outcome: 'Wiadomość może trafić do modelu po kontrolach', audit: 'topic.confirmed → guardian.started → guardian.reviewed'
  },
  hr_violation: {
    tool: 'user_input: "Oceń Annę i Piotra; wskaż osobę do zwolnienia"', tone: 'deny', effect: 'deny', caption: 'Zakazana ocena osób. Sesja zamknięta.',
    message: 'W oznaczonej sesji HR nadzorca wykrywa zakazane zlecenie oceny pracy konkretnych osób i rekomendacji zwolnienia. Blackwall zamyka sesję przed dalszym wywołaniem modelu.', reason: 'AI_EMPLOYEE_PERFORMANCE_EVALUATION', session: 'terminated · terminate', topic: 'employee_evaluation', guardian: 'naruszenie potwierdzone · HR_AI_RESTRICTIONS', outcome: 'Input niewysłany do modelu; niewykorzystane zgody odwołane', audit: 'guardian.reviewed → session.terminated'
  },
  hr_output: {
    tool: 'model_output: "Ranking wydajności: Anna przed Piotrem"', tone: 'deny', effect: 'deny', caption: 'Kontrola działa również bez narzędzi.',
    message: 'Użytkownik prosił o ogólny proces, ale model sam wygenerował ocenę konkretnych pracowników. Odpowiedź jest buforowana; nadzorca zatrzymuje jej wydanie i zamyka sesję.', reason: 'AI_EMPLOYEE_PERFORMANCE_EVALUATION', session: 'terminated · terminate', topic: 'employee_evaluation', guardian: 'naruszenie w odpowiedzi modelu', outcome: 'Zakazana odpowiedź nie została wyświetlona', audit: 'guardian.reviewed → session.terminated'
  },
  budget: {
    tool: 'model_request: kontynuacja szkicu KYC · wymagana rezerwacja 1000 tokenów', tone: 'deny', effect: 'deny', caption: 'Koszt dalszej pracy przekracza limit.',
    message: 'Pozostałe 600 tokenów nie wystarcza na rezerwację 1000. Limit obejmuje model wykonawczy oraz wymagane kontrole. Nie wyłączamy nadzorcy, aby kontynuować.', reason: 'BUDGET_EXCEEDED', session: 'blocked · block', topic: 'client_onboarding', guardian: 'dalszy nadzór wstrzymany · brak rezerwy', outcome: 'Request niewysłany; brak potwierdzonego naruszenia tematu', audit: 'budget.denied → session.blocked'
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
    ...scenarios.overwrite, tone: 'allow', effect: 'allow', caption: 'Zgoda na ten jeden ruch.',
    message: 'W tym przykładzie zgoda użytkownika i ponowna kontrola warunków pozwalają nadpisać szkic KYC. Uprawnienie dotyczy jednej, niezmienionej operacji.',
    reason: 'USER_APPROVED_OPERATION', session: 'active · continue',
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
    message: 'Użytkownik odrzucił nadpisanie szkicu KYC. Zapis nie jest dopuszczony, a sesja zostaje zablokowana.',
    reason: 'USER_REJECTED_OPERATION', session: 'blocked · block',
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
