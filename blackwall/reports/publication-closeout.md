# Domknięcie MVP: publikacja polityki i feedu

4 października 2026 UTC. Ten raport opisuje bieżącą poprawkę; wcześniejsze nagrania, raporty i manifest pozostają historyczne.

## Wymóg i przyczyna

Koncepcja `docs/blackwall-koncepcja-i-plan-dema.md` wymaga importu feedu (T14), walidowanej nowej wersji polityki bez zastąpienia jej błędnym kandydatem (T16) oraz zmiany reguły/progu przez API/UI, widocznej w kolejnej decyzji (§13). Dawny panel i GET pokazywały konfigurację odczytaną przy starcie. Sam restart YAML nie spełniał tego kryterium.

Dodano uwierzytelnione edytory API/UI. Publikacja przygotowuje pełnego kandydata i detektor przed przełączeniem. CAS chroni przed starym formularzem; bariera czeka na trwające skończone żądania. SQLite zapisuje historię i aktywne kontrolki bez tokenów. Overlay przywraca się tylko przy zgodnym bazowym YAML. Niewykorzystane zgody i granty są unieważniane; sesje oczekujące blokują się z POLICY_CHANGED, a zakończone nie wracają do pracy. Wcześniej rozpoczętych operacji nie cofamy.

Niezależny przegląd znalazł dwie dalsze przyczyny błędów. Wymiana Core gubiła szyfrowany reasoning Responses API; cache jest teraz związany ze Store i sesją. Ograniczenie długości regexu nie usuwało ReDoS; feed używa RE2 WASM bez fallbacku do natywnego backtrackingu. Nieobsługiwane konstrukcje odrzuca walidacja. [Przegląd i reprodukcje](independent-publication-review.md).

## Weryfikacja

- **143/143 jednostkowych**, **33/33 z rzeczywistymi API**, **12/12 z Pi**, zero pominięć. [Master verify](verify-publication.log); [ostatnie jednostkowe](unit-publication.json); [follow-up](unit-publication-followup.log). Końcowe typy i jednostkowe powtórzono po wprowadzeniu RE2. Nie powtarzano zbędnie całego płatnego korpusu po samych nowych regresjach feedu.
- [Świeża ewaluacja OpenAI/Jev](eval-2026-10-04-00-38.json): 34 oceny guardiana, 10 typowanych propozycji i 15 ocen shella. Guardian 15/15 naruszeń i 0/19 błędnych terminacji; typowane propozycje 5/5 zakazanych odrzucone, 0/5 dozwolonych odrzucone; Jev 0/4 niebezpiecznych auto-allow w każdym profilu. Standard wymaga zgody dla 3/5 prawidłowych programów. P95 etapów: detekcja 683 ms, guardian 2316 ms, Jev 750 ms. Mała próba; 10 propozycji powtarza korpus i nie stanowi niezależnych scenariuszy produkcyjnych.
- Historyczne pełne demo zachowuje **14 scenariuszy/68 checków** oraz osobną kontynuację naturalnej niepewności **6/6** bez resamplingu modelu. [Indeks](../deliverables/demo-index.md).

## Bieżące materiały

[Wybrane rzeczywiste nagranie](../demo-recordings/runtime-publication-2026-10-04T00-53-27-385Z/video/runtime-publication-ui.mp4) przeszło **11/11** sprawdzeń. [Summary](../demo-recordings/runtime-publication-2026-10-04T00-53-27-385Z/summary.json), [receipts](../demo-recordings/runtime-publication-2026-10-04T00-53-27-385Z/source-proof.json) i [surowy audyt](../demo-recordings/runtime-publication-2026-10-04T00-53-27-385Z/events.jsonl) potwierdzają dwie odpowiedzi Luna 6 Low, jedną rzeczywistą ocenę Jeva, wykonany odczyt/program przed zmianą oraz publikację progu i feedu. Finalne uwierzytelnione GET wskazują politykę v3/feed v2. Pi zaproponował odczyt i niezależny program razem: ich wykonanie częściowo się nakładało mimo słowa „then” w promptcie harnessa. Oba zakończyły się przed publikacją; test nie deklaruje sekwencyjnej zależności ani idealnego posłuszeństwa modelu. Jawny replay tej samej sesji otrzymał THREAT_FEED_MATCH; consume/start nie wywołano, marker nie powstał.

Dwa wcześniejsze nieudane podejścia dotyczą harnessa: pusty POST sesji oraz reload nadpisujący edytowany feed starą wersją, poprawnie odrzuconą przez serwer. Po no-paid reprodukcji dodano stan ładowania formularza oraz synchronizację skryptu. [Opóźniony GET: 6/6 sprawdzeń](runtime-editor-reload-qa.json). Dodatkowy udany przebieg 00:54:56 powstał przez podwójnie odebraną instrukcję uruchomienia; zachowano go, lecz do prezentacji wybrano pierwszą udaną próbę 00:53:27. Nie wykonano dalszych zapytań po wykryciu duplikatu.

Dwa niezależne przeglądy nagrania nie znalazły materialnej blokady: [review 1](independent-runtime-demo-review-1.md), [review 2](independent-runtime-demo-review-2.md). [Kontrola dashboardu](runtime-dashboard-qa.md) potwierdziła użyteczne edytory i dostęp do wszystkich kolumn na telefonie; szerokie tabele mają focus i wskazówkę przewijania. [PPTX final-v4](../deliverables/blackwall-demo.pptx) ma 9 slajdów i rzeczywisty crop paneli publikacji. [Receipt walidacji](../.presentation-build/validation-final-v4.json): 0 usterek układu, 0 ostrzeżeń, poprawny ponowny import; wszystkie 9 renderów przejrzano. SHA256: `741bc3b7aadf75a0451a039970ac69a336a6ba516cabd88e41db04a754b4af66`. Natomiast natywnego renderowania w PowerPoint nie sprawdzano.

Strona Sites ma osiem rozdziałów, animowane przykłady decyzji, interaktywny replay sześciu rzeczywistych sesji, osiem klipów oraz dokładnie ten PPTX. QA:31/31, widoki1440×1000 i390×844, brak błędów/brakujących zasobów, odzyskanie danych po503. [Publiczna strona Sites](https://blackwall-hackyeah-2026.dariusz.chatgpt.site) została opublikowana: saved version5, deployment `appgdep_6ac1a6f366bc8191bb6a6bf1ce7e3b05`, native status `succeeded`, commit `9465a345d622b228bd704c78898517ec4ae92253`. Dostęp publiczny istniejącego Site zachowano. [Metadane publikacji](../../sites/blackwall-presentation/deployment.json), [QA](../../sites/blackwall-presentation/qa/browser-qa.json), [prywatny skan publicznych plików](../../sites/blackwall-presentation/qa/publication-check.json). Replay na stronie nie wykonuje nowych operacji ani zapytań do modeli.

[Bieżący manifest](verification-manifest-publication.json) wiąże aktualny snapshot kodu, testy, nowe nagranie, dziewięć slajdów, exact Site commit i prywatny skan rzeczywistych poświadczeń. Historia pozostaje w [poprzednim manifeście](verification-manifest.json).

## Granice

Gotowość dotyczy lokalnego MVP do pokazu. Brak sandboxa OS, organizacyjnego control plane/SSO, osobnego rollbacku i automatycznego pobierania feedów. Modele mogą się mylić. Receipt wykonania raportuje zarządzany plugin. Treść trafia do zewnętrznych usług OpenAI/Jev; demo używa danych syntetycznych. [Pełny raport](final-audit.md) opisuje te granice.

## Domknięcie prośby

| Prośba / kryterium | Dowód |
| --- | --- |
| Porównanie aplikacji z docs i przyczynowe poprawki | [Macierz wymagań](../docs/audit-2026-10-03.md), [raport końcowy](final-audit.md), reprodukcje i niezależne recenzje kodu |
| Faktyczne OpenAI + Jev, Luna 6 Low | 33/33 API i 12/12 Pi, aktualna ewaluacja, raw receipts dema; rozliczenie przez API key, nie subskrypcję Codex |
| OpenAI embeddings i wykrywanie tematów | text-embedding-3-small1536D, PL/EN, kalibracja i holdout, osobne spontaniczne KYC demo |
| Kilka sesji i kontrola dashboardu | 14 scenariuszy/68 checków, kontynuacja6/6, dodatkowa publikacja11/11, desktop/mobile QA |
| Poprawki po niezależnej analizie dema | Dwie wcześniejsze recenzje pełnego dema oraz dwie nowe recenzje publikacji; wszystkie materialne ustalenia naprawione lub dokładnie oznaczone w zakresie dowodu |
| Nagrania gotowego lokalnego MVP | 15 pełnych klipów + kontynuacja + nowy klip publikacji; surowe audyty/transkrypty/bazy zachowane |
| Prezentacja do10slajdów, zalety/ograniczenia/screens | Zweryfikowany PPTX final-v4:9slajdów, rzeczywiste screeny, 0 findings/warnings i reimport PASS |
| Strona z animacjami, interaktywnym dashboardem i publikacja Sites | Osiem rozdziałów, animowane przepływy, replay6sesji,8filmów,31/31QA; native deployment succeeded, version5 |

Nie pozostaje niedomknięty element powyższej prośby w deklarowanym zakresie lokalnego MVP. Ograniczenia produkcyjne poniżej są jawne i nie są przedstawiane jako wdrożone funkcje.
