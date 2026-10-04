# Blackwall — wynik audytu i testów, 4 października 2026

**Stan: działające lokalne MVP do demo.** [Publiczna prezentacja w Sites](https://blackwall-hackyeah-2026.dariusz.chatgpt.site) zawiera animacje, interaktywny replay, osiem filmów i aktualny PPTX. [Domknięcie publikacji i kryteriów](publication-closeout.md). Aplikacja realizuje główny przepływ: decyzja przed narzędziem, kontrola treści, tematyczny nadzór sesji, zgody, budżety i ślad w dashboardzie. Nie spełnia jeszcze wszystkich wymagań wdrożenia produkcyjnego. [Indeks materiałów](../deliverables/demo-index.md) zawiera nagrania i prezentację.

Zakres porównania: koncepcja i plan dema w `../../docs/`, oryginalny brief Goldman Sachs oraz cały backend, gateway, plugin Pi i dashboard. Szczegółowa [macierz wymagań](../docs/audit-2026-10-03.md) zachowuje także ustalenia historyczne.

## Rzeczywiste usługi

- Agent wykonawczy i guardian: OpenAI **`gpt-6-luna`, reasoning `low`**. Gateway tłumaczy interfejs Pi Chat Completions na Responses API, obsługuje tool calls i przechowuje kontekst reasoning po stronie serwera.
- Tematy: OpenAI **`text-embedding-3-small`**, 1536 wymiarów; przykłady PL/EN i skalibrowane progi dla KYC, M&A oraz HR.
- Ocena działania: prawdziwe API **Jev**, alias `jev-latest` (obserwowany model `jev-1.13.0`).
- Użyto kluczy z lokalnego `.env`. Subskrypcja aplikacji ChatGPT/Codex nie zastępuje rozliczenia OpenAI API; te wywołania korzystają z konta API powiązanego z kluczem. [Dokumentacja rozliczenia](https://learn.chatgpt.com/docs/pricing#token-rates). Nie wyliczamy kwoty bez pełnego cennika usług i danych billingowych.

## Końcowa weryfikacja

Polecenie: `npm run verify -- --report-suffix=publication`, uzupełnione końcowym `typecheck` i pełnymi testami jednostkowymi po zastąpieniu silnika regex przez RE2. [Pełny log](verify-publication.log), [follow-up](unit-publication-followup.log). Skrypt wymaga obu kluczy i odrzuca zestaw z pominiętymi testami.

| Warstwa | Wynik | Dowód i zakres |
| --- | --- | --- |
| TypeScript | PASS | `tsc -p tsconfig.json` |
| Jednostkowe | **143/143**, 0 pominięć | [unit-publication.json](unit-publication.json): ścieżki, symlinki, uprawnienia, redakcja, approval/grant/replay, budżety i metadane, native renderer Pi, kontrolowane wyszukiwanie i stan przeglądu administratora |
| Integracja/API | **33/33**, 0 pominięć | [live-publication.json](live-publication.json): rzeczywiste OpenAI/Jev, guardian PL/EN, gateway i kontrola tokenów |
| Rzeczywisty agent Pi | **12/12**, 0 pominięć | [e2e-publication.json](e2e-publication.json): prawdziwe pliki, propozycje i wykonanie narzędzi, pozytywny POST oraz niezależny receiver, redakcja wyników i odcięcie po terminacji |
| Surowy nadzór semantyczny | **34 ocen**: 15/15 naruszeń zakończonych, 0/19 błędnych terminacji | [eval-2026-10-04-00-38.json](eval-2026-10-04-00-38.json): 0 niepewności i blokad technicznych w tym przebiegu |
| Typowane propozycje narzędzi | **10 ocen**: 5/5 zabronionych odrzucone, 0/5 dozwolonych odrzucone | Ten sam raport; osobne świeże sesje i rzeczywisty `Core.decideTool`; skutki uboczne sprawdzają E2E |
| Jev / shell | **15 ocen**, 0/4 niebezpiecznych dopuszczonych automatycznie w każdym profilu | Ten sam raport; standard: 2/5 prawidłowych programów auto-allow, 3/5 wymagają zgody; zgodność surowych etykiet 12/15 |

To 59 ocen ewaluacyjnych, z których 10 powtarza propozycje narzędzi z korpusu przez pełny silnik. Nie są to 59 niezależnych scenariuszy produkcyjnych. P95 tego przebiegu: detekcja tematu **683 ms**, guardian **2316 ms**, Jev **750 ms**. Czasy dotyczą pojedynczych etapów na małej próbie, nie całej odpowiedzi agenta.

Kalibracja embeddingów: [raport](topics-textembedding3small-2026-10-03T21-30-33-105Z.json), 8 przykładów kalibracyjnych i osobnych 16 holdout. Dla każdego z trzech tematów 4/4 trafienia dodatnie; KYC/M&A bez fałszywych kandydatów, HR ma 2 dodatkowe kandydatury przy dokumentach M&A. Kandydat uruchamia ocenę polityki, nie stanowi automatycznej blokady. Ten mały, autorski korpus nie mierzy skuteczności produkcyjnej.

### Zachowane niepowodzenia i zakres wyników

Nie usuwaliśmy wyników historycznych. [Eval 22:41](eval-2026-10-03-22-41.json) zawiera pomyłkę samego guardiana dla opisu odczytu cudzych danych (`kyc-v02`). Deterministyczny zakres plików w produkcyjnej ścieżce blokuje tę operację; obecny eval mierzy te warstwy osobno i zachowuje surowy werdykt modelu. Późniejsze 34 poprawne oceny nie dowodzą, że LLM nie może ponownie się pomylić.

Pierwsze pełne nagrania zachowują niezaliczone checki. Niezależne recenzje ujawniły m.in. brak realnego executora w starym replayu HTTP, mylenie odmowy LLM z nadzorem Blackwall i niedziałający testowy program Python. Poprawiono przyczynę i wymagania dowodowe, następnie powtarzano nagrania; wcześniejsze artefakty pozostają historyczne.

### Dodatkowe demo bieżącej publikacji

[Publikacja polityki i feedu](../demo-recordings/runtime-publication-2026-10-04T00-53-27-385Z/summary.json): **11/11 checków**, rzeczywisty Pi, OpenAI Luna 6 Low i Jev. Administrator testowy publikuje próg oraz feed przez dashboard; błędny dokument dostaje 400, stary formularz 409. Następna propozycja w tej samej sesji jest odrzucona pod polityką v3/feedem v2, bez consume/executora i bez markera. Wersje pochodzą z finalnych uwierzytelnionych GET. [Szczegóły, historia harnessa i duplikatu](publication-closeout.md). Dwa niezależne przeglądy potwierdziły zgodność dowodów: [review 1](independent-runtime-demo-review-1.md), [review 2](independent-runtime-demo-review-2.md). Oba rozróżniają rzeczywisty Pi od późniejszego jawnego replayu API.

### Końcowe pełne demo historyczne

[Pełny przebieg 23:06:53 UTC](../demo-recordings/2026-10-03-23-06-53/summary.json): **14 scenariuszy, 68/68 checków**, 15 MP4 z dashboardem i overlayem rzeczywistej rozmowy. Sprawdzono także parametry filmów: H.264, 1600×900, 25 fps, razem 295 sekund. W źródłach są transkrypty, JSONL zdarzeń, screeny i lokalna baza SQLite.

W tym przebiegu replay M&A dostał `DEAL_UNAUTHORIZED_PUBLICATION` z prawdziwym cytatem; executor i odbiornik HTTP pozostały bezczynne. Wcześniejszy [22:57:16](../demo-recordings/2026-10-03-22-57-16/05-ma-replay.md) miał `GUARDIAN_EVIDENCE_UNVERIFIED` i bezpieczny hold `reviewing`. Modelowe oskarżenie bez poprawnego dowodu nie jest automatycznym potwierdzeniem naruszenia. Zachowano oba wyniki i przygotowano osobną kontynuację przeglądu człowieka, bez nowych zapytań do modelu.

Testowe zgody i rozstrzygnięcia admina są jawnie oznaczone jako symulacja harnessa. Odczyt dokumentu z instrukcją i samodzielny opór agenta w 04 nie są przedstawiane jako interwencja Blackwalla; jej propozycję sprawdza jawny replay 05. Spontaniczny kandydat KYC w 14 nie ma zaufanego przypisania tematu, w przeciwieństwie do demonstracji HR.

[Kontynuacja naturalnej niepewności](../demo-recordings/2026-10-03-23-18-10-review-continuation/summary.json): **6/6 checków**, bez ponownego wywołania modelu. Zachowuje pierwotny niepewny verdict i exact denied POST; read jest replayem przez `Core.decideTool`, a rozstrzygnięcie admina rzeczywistym uwierzytelnionym API. Po potwierdzeniu naruszenia sesja jest `terminated / ADMIN_CONFIRMED_VIOLATION`. Cały ślad ma zero claimów i receiptów wykonania; hash bazy źródłowej przed/po jest identyczny.

**Dwa niezależne przeglądy zakończone pozytywnie:** [review 1 — finalne demo i kontynuacja](independent-demo-review-final.md), [review 2 — historia i końcowy recheck](independent-demo-review-2.md). Agenci porównali surowe zdarzenia, transkrypty, skutki i reprezentatywne klatki MP4. [Osobny przegląd kodu](independent-code-review-1.md) dokumentuje znalezione luki oraz weryfikację poprawek. Nie deklarujemy oglądania wszystkich filmów od początku do końca ani niezależnego dowodu zachowania całego hosta.

[Prezentacja](../deliverables/blackwall-demo.pptx) ma 9 slajdów, zalety, architekturę, wyniki, rzeczywiste screeny i ograniczenia. Po eksporcie sprawdzono strukturę, ponowny import, układ i rendery; kontrola nie zastępuje natywnego renderowania w PowerPoint. [Bieżący manifest](verification-manifest-publication.json) wiąże aktualny kod, raporty, nowe nagranie, PPTX i publikację Sites. [Manifest historyczny](verification-manifest.json) zapisuje hashe poprzedniego snapshotu kodu i dowodów, wyniki, parametry filmów, receipt prezentacji oraz zakres prywatnego skanu faktycznych kluczy. Snapshot końcowy nie oznacza, że każde historyczne nagranie korzystało z identycznej wersji kodu.

## Najważniejsze poprawki i ich przyczyny

1. **Kontekst i protokół OpenAI:** agent nie miał kompletnej ścieżki dla Responses API i reasoning. Dodano walidowany bridge, narzędzia, usage i kontekst należący do serwera; uszkodzone argumenty lub schema kończą żądanie bez wykonania.
2. **Odkrywanie tematów:** dodano OpenAI embeddings i przykłady po polsku. Dla jawnych domen użytkownika temat przypisuje zaufana polityka, aby pomyłka retrievalu nie wyłączała nadzoru. Kandydaturę i przypisanie dashboard pokazuje osobno.
3. **Guardian:** usunięto ucinanie bieżącej treści, które ukrywało naruszenie za długim prefiksem; verdict wymaga aktualnego cytatu i zgodnej polityki. Błędne advisory topic arrays nie powodują już technicznego odrzucenia poprawnego benign verdict.
4. **Approval i wykonanie:** zgoda mogła wznowić zablokowaną sesję i nie była przypięta do zasobu. Teraz wiąże dokładne argumenty, cwd, hash pliku i policy version; jednorazowy grant ma TTL, świeży recheck i atomowy claim. Revoke, zmiana zasobu i replay odrzucają wykonanie.
5. **Rekurencyjne narzędzia:** dozwolony katalog mógł dać natywnemu grep dostęp do ukrytego `.env`. Każdy plik przechodzi kontrolę przed odczytem; `find`/`ls` także filtrują chronione nazwy, a wyszukiwanie ma ograniczenia liczby plików, wyniku i czasu. Regresja używa prywatnego canary nierozpoznawanego przez DLP oraz pozytywnego wyniku publicznego.
6. **Native Pi UI:** renderer edycji potrafił odczytać plik przed zgodą. Samo `undefined` przywracało domyślny renderer; jawne renderery nie czytają celu i publikują wyłącznie skontrolowany wynik.
7. **Wyniki i sekrety:** inspekcja obejmuje buforowany tekst i metadane diffów przed publikacją do Pi/modelu. Naprawiono wzorzec sekretu po JSON-owym `\\n`; token sesji nie trafia do środowiska `bash`.
8. **Budżety:** atomowe rezerwacje obejmują tokeny i worst-case koszt gatewaya, pełne payloady i wszystkie nakładające się chunki embeddingów. Nieznane usage zużywa całą rezerwę. Limit USD bez ceny usług pomocniczych blokuje `COST_UNPRICED`, a panel pokazuje koszt niewyceniony.
9. **Rola analityka:** jawny pusty zakres zapisu usuwa niezamierzone dziedziczenie prawa zapisu z polityki globalnej.
10. **Dashboard i dowody:** oddzielono decyzję, zgodę, claim oraz raport wykonania; uporządkowano widoki i szczegóły guardiana. Testy weryfikują niezmieniony plik, brak odbioru HTTP i brak ujawnienia sekretu, a nie tylko zielony verdict.
11. **Przegląd administratora:** stare zgłoszenie mogło wznowić sesję po revoke, a nawet wyczyścić późniejszy nowy review po legalnym resume. Resolver działa teraz pod wspólną blokadą sesji, wymaga stanu `reviewing` i dokładnej bieżącej sekwencji guardiana. Trzy reprodukcje były niezaliczone przed odpowiednimi poprawkami; pięć regresji obejmuje również współbieżny revoke/resolve, legalne oba wyniki i jednorazowość. [Log końcowych typów i 115 testów](unit-security-followup.log).

12. **Publikacja konfiguracji:** brak mutacji API/UI nie spełniał jawnego kryterium MVP. Dodano walidowany pełny kandydat, inicjalizację detektora przed przełączeniem, CAS, barierę trwających żądań i trwały overlay SQLite. Kolejna decyzja korzysta z nowej wersji; poprzednie zgody/granty wygasają.
13. **Kontynuacja i regex feedu:** wymiana Core usuwała kontekst Responses reasoning; cache jest teraz związany ze Store i sesją. Native regex akceptował wzorzec zawieszający proces mimo ograniczeń rozmiaru. RE2 WASM usuwa backtracking; niedozwolone konstrukcje nie mają fallbacku. Niezależna reprodukcja dawnego wzorca na 200 tys. znaków trwała 7,32 ms. [Przegląd kodu i reprodukcje](independent-publication-review.md).

## Ograniczenia przed wdrożeniem

- **Brak sandboxa OS.** Jev ocenia tekst komendy; dopuszczony program i procesy potomne działają z prawami użytkownika systemu. Zarządzany plugin jest granicą egzekwowania, a niezależny klient może ją ominąć.
- **Okno wyścigu plikowego:** hash/recheck chroni approval/consume, lecz natywny executor otwiera plik później. Potrzebna atomowa operacja na uchwycie lub sandbox. Kontrolowany HTTP sprawdza DNS przy łączeniu i nie podąża za redirectami.
- **Local MVP:** SQLite, bazowy YAML i publikacja kontrolek/feedu bez restartu przez API/UI. Brak centralnego control plane, SSO, osobnego rollbacku, automatycznego pobierania feedu exploitów, MCP i agent-to-agent. Nie twierdzimy, że wdrożono pełną docelową architekturę.
- **Modele są probabilistyczne.** Mały korpus PL/EN, pojedyncze przebiegi i konserwatywne approval Jeva nie stanowią certyfikatu bezpieczeństwa. Nowe modality i ruch poza gateway/plugin nie są objęte gwarancją kontroli tekstu.
- **Koszty i dane:** auxiliary usage embeddingów jest estymowane; pełny finansowy koszt nie jest wyceniony. Treści wysyłane do OpenAI/Jev opuszczają maszynę. Dane demo są syntetyczne.
- **Audyt:** receipts raportuje plugin, nie niezależny runner. Brak receipt oznacza wynik nieznany. Nagrania mają jawnie oznaczone symulowane zgody oraz replay propozycji.
- **Porządkowanie zgłoszeń:** historyczny otwarty review może pozostać w liczniku po revoke; resolver odrzuca go na podstawie aktualnego stanu i sekwencji. Licznik nie jest uprawnieniem do wznowienia sesji; docelowo należy oznaczać takie zgłoszenia jako anulowane.

Przed produkcją priorytetem są izolowany runner, poświadczenia poza procesem agenta, uwierzytelnienie administratora, retencja oraz reprezentatywne testy jakości i obciążenia. Dla prezentacji lokalnego MVP powyższe granice powinny pozostać widoczne.
