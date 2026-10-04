# Niezależny przegląd kodu Blackwalla — 4 października 2026

Zakres: wyłącznie odczytowy przegląd kodu względem `docs/blackwall-koncepcja-i-plan-dema.md` i `docs/audit-2026-10-03.md`. Sprawdzono granice pluginu Pi przed publikacją do UI, renderer `edit`, wykonanie HTTP, rezerwacje budżetu oraz zakres approval/grantów. Nie uruchamiałem dostawców API ani testów płatnych. Nie odczytywałem plików środowiskowych.

## P1 — Pi przywraca renderer `edit`, który czyta plik przed decyzją Blackwalla — naprawione

`plugin/blackwall.ts:160-165` ustawia `renderCall: undefined` i komentuje, że ma to wyłączyć renderer natywny. Pi Interactive robi fallback do wbudowanych rendererów w `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1673-1674`; `withBuiltInRenderers` wybiera renderer wbudowany dla wartości `undefined` (`dist/core/tools/renderers/index.js:35-45`). Renderer `edit` uruchamia `computeEditsDiff` po otrzymaniu kompletnych argumentów (`dist/core/tools/renderers/edit.js:113-134`), a `computeEditsDiff` wykonuje `readFile(path, "utf-8")` (`dist/core/tools/edit-diff.js:390-408`). To dzieje się w ścieżce prezentacji Pi, niezależnie od wykonania wrappera Blackwalla.

**Odtworzenie:** w Pi uruchom sesję z Blackwallem i wywołaj `edit` na istniejącym pliku, dla którego operacja normalnie wymaga approval (np. raport w `output`). Poczekaj na wyświetlenie wywołania `edit`, po czym odrzuć approval. Przed rozstrzygnięciem approval Pi uruchamia diff preview i odczytuje zawartość pliku; odrzucenie blokuje sam zapis, ale nie odczyt wykonany przez renderer. Dla pliku zawierającego syntetyczny sekret renderer może również umieścić tekst z kontekstu diffu w UI, zanim Blackwall skontroluje wynik toola.

To przeczy deklarowanej poprawce audytu, że renderery natywne zostały wyłączone, ponieważ odczytywały cel przed approval. Ustawienie `undefined` nie wyłącza renderera w wersji Pi dołączonej do projektu. Root dodał jawne renderery bez podglądu oraz test `test/unit/plugin-rendering.test.ts`, który przepuszcza rejestrację Blackwalla przez rzeczywisty `withBuiltInRenderers`. Raport `reports/unit-final.json` potwierdza 103/103 testów zaliczonych, w tym ten regresyjny.

## P2 — approval dla ścieżki względnej nie wiąże identyfikatora celu ani cwd — naprawione

Tabela `approvals` przechowuje hash argumentów i hash zawartości zasobu, ale nie zapisuje `cwd` (`src/store/store.ts:50-64`). Endpoint rozstrzygający przyjmuje `cwd` z requestu klienta (`src/server/app.ts:35,124-130`). `resolveApproval` porównuje `resourceHash(req, cwd)` z zapisanym hashem i następnie ponawia decyzję z tym samym `cwd` (`src/engine/core.ts:569-580`). Hash zasobu jest skrótem samych bajtów pliku; nie obejmuje ścieżki (`src/engine/core.ts:613-623`).

**Odtworzenie:** umieść identyczne istniejące pliki `report.md` w dwóch dozwolonych katalogach `output/a` i `output/b`. Zażądaj zatwierdzenia dla `write` z argumentem względnym `path: "report.md"`, podając cwd `output/a`. Rozstrzygnij ten sam approval tokenem sesji i `cwd: output/b`. Zawartość w drugim celu ma taki sam hash, więc sprawdzenie zasobu przechodzi; następna decyzja tworzy świeży grant związany z cwd `output/b`, choć użytkownik zatwierdzał wywołanie z cwd `output/a`. Zaufany plugin zwykle odrzuci potem consume, bo wyśle swój własny cwd, ale API wyda decyzję/grant o innym celu, a zakres approval nie spełnia deklarowanego związania z zasobem.

Modal pluginu pokazywał argumenty bez rozwiązanego cwd, więc samo `report.md` nie identyfikowało dla zatwierdzającego katalogu. Root dodał kolumnę cwd do approval, odrzucenie `APPROVAL_CWD_MISMATCH` i test z dwoma identycznymi plikami. Modal pokazuje teraz rozwiązaną ścieżkę, working directory i pełne argumenty po redakcji. Raport `reports/unit-final.json` potwierdza testy jednostkowe zaliczone.

## P2 — skan katalogu buforował wszystkie wpisy przed limitem — naprawione

Poprzednia wersja `plugin/file-tools.ts` używała `(await readdir(path)).sort()` przed sprawdzeniem limitu, więc limit odwiedzonych wpisów nie ograniczał alokacji i sortowania całego katalogu. Poprawka przechodzi po `opendir()` strumieniowo, zwiększa licznik przed przetwarzaniem wpisu, sprawdza anulowanie w iteracji i przerywa po osiągnięciu limitu. Wykonałem przegląd statyczny aktualnego helpera i sprawdziłem test `caps discovery and handles cancellation before producing results` w `test/unit/controlled-search.test.ts`; root zgłasza 108/108 testów jednostkowych zaliczonych. Finding zamknięty.

## Pozostałe sprawdzone granice

- Kontrolowany HTTP klient podłącza socket przez własny `lookup`, odrzuca odpowiedzi prywatne, nie śledzi redirectów i ogranicza odpowiedź. Nie znalazłem odrębnej reprodukcji SSRF w tej ścieżce.
- Rezerwacje tokenów są atomowe, a aktualna zmiana dodaje także rezerwację kosztu w USD przed wywołaniem gatewaya; pomocnicze kontrole blokują się przy ustawionym limicie kosztowym i nieznanej cenie. Nie przypisuję temu przeglądowi pozostałego błędu budżetu.
- Wrappery natywnych narzędzi buforują wynik, skanują tekst, `structuredContent` i `details`, a dopiero potem zwracają go Pi. Kontrola nie obejmuje semantycznego OCR bloków obrazowych; dokument koncepcji deklaruje kontrolę tylko dla obsługiwanych danych, a audyt jawnie wymienia obrazy poza zakresem. Należy zachować tę granicę w opisie demo.

## P1 — stare topic review mogło wznowić sesję po revoke — naprawione

Wcześniejszy handler `POST /v1/admin/topic-reviews/:id/resolve` nie serializował się z revoke i pozwalał `no_violation` ustawić sesję `active`, gdy administrator wcześniej cofnął sesję pozostawiając otwarte review. Dodatkowo samo sprawdzenie statusu nie wystarczało: po jawnym resume mogło pojawić się nowsze review, a stare nadal wyglądało na otwarte. Aktualny handler wykonuje operację w `withSessionLock`, wymaga bieżącego statusu `reviewing` oraz `guardian.last_reviewed_seq === review.seq` przed rozstrzygnięciem. `test/unit/topic-review-state.test.ts` obejmuje revoke przed resolution, kolejkę revoke i resolution, starsze review po nowszym evencie oraz jednokrotne rozstrzygnięcie obu rodzajów. W aktualnej implementacji nie widzę już reprodukcji opisanego wznowienia przez nieaktualne review. W finalnym nagraniu nie ma UI admin resolution, więc ta ocena opiera się na handlerze i regresjach, a nie na klatkach demo.

Rzeczywisty finalny przebieg i porównanie klatek z eventami/transcriptem opisuje osobny [niezależny raport demo](independent-demo-review-final.md). Naturalne admin-resolution continuation dla historycznego `uncertain` pozostaje do oceny po nagraniu.
