# Blackwall — implementacja demo

Warstwa kontroli agentów AI (HackYeah 2026, wyzwanie Goldman Sachs „AI Control Layer”). Ten katalog zawiera działający kod: serwer decyzji, bramkę modelu zgodną z OpenAI, nadzór tematyczny sesji, rozszerzenie dla agenta Pi, panel administratora i testy. Koncepcja i uzasadnienia: [`../docs/blackwall-koncepcja-i-plan-dema.md`](../docs/blackwall-koncepcja-i-plan-dema.md).

## Co działa (sprawdzone)

| Obszar | Stan |
| --- | --- |
| Decyzja przed wykonaniem narzędzia (`allow` / `deny` / `require_approval`) z kodami powodów, stanem sesji i audytem | działa; testowane na prawdziwych plikach i prawdziwym Pi |
| Reguły deterministyczne: ścieżki (komponenty, `..`, symlinki, nowe pliki), `.env`/klucze, rozszerzenia, rozmiar, sieć (host, port, metoda, endpoint, prywatne/loopback/IPv6/zapisy IPv4, DNS), sekrety i dane osobowe (IBAN, PESEL z sumą kontrolną), feed zagrożeń | działa |
| Ocena semantyczna przez **Jev (TypeSafe)** — realne wywołania API | działa |
| Jednorazowa zgoda użytkownika w interfejsie Pi (TTL, jednokrotna, unieważniana przy zmianie stanu) | działa |
| Bramka modelu: allowlista aliasów, rezerwacja i rozliczenie tokenów, skan sekretów w całym prompcie, bufor odpowiedzi przed wydaniem | działa (dostawca: Anthropic) |
| Nadzór tematyczny: embedding → etykieta sesji → jeden nadzorca (Claude Haiku) → `terminated` | działa |
| Panel administratora (przegląd, oś zdarzeń na żywo, polityki), eksport JSONL, metryki p50/p95 | działa |

Szczegółowe wyniki — niżej w sekcji „Testy”.

## Uruchomienie

Wymagane: Node.js 24+ (wbudowany `node:sqlite`), klucze w `../.env` (wzór: `../.env.example`): `ANTHROPIC_API_KEY`, `JEV_API_KEY`.

```sh
cd blackwall
npm install
./scripts/dev-server.sh            # serwer na kopii danych demo, http://127.0.0.1:8787
```

Panel: <http://127.0.0.1:8787/dashboard> (token administratora: `BLACKWALL_ADMIN_TOKEN`, w demo `demo-admin-token`).

Agent Pi przez Blackwall (każdy użytkownik demo ma własny katalog roboczy i zakres):

```sh
node scripts/pi-launch.mjs --user onboarding-demo     # interaktywnie
node scripts/pi-launch.mjs --user onboarding-demo -- -p "Przygotuj szkic KYC dla Atlas Capital …"
```

Użytkownicy demo: `onboarding-demo` (KYC Atlas), `deal-demo` (transakcja Orion), `hr-demo`, `developer-demo`, `analyst-demo`. Odbiornik testowy dla scenariusza M&A: `node scripts/receiver.mjs` (port 9911).

Dowolny inny klient modelu może używać bramki wprost: `POST /v1/chat/completions` z tokenem sesji (`POST /v1/sessions` z tokenem użytkownika). Przy `BLACKWALL_GATEWAY_TOOLS=1` bramka sama ocenia wywołania narzędzi proponowane przez model.

## Konfiguracja

Jedno źródło prawdy: [`config/policy.yaml`](config/policy.yaml). Zmiana = edycja pliku i restart. Walidator odrzuca nieznane klucze, nieistniejące aliasy i niespójne odwołania.

- `profile: permissive | standard | strict` — różnią się **zakresem** oceny semantycznej (strict ocenia każde narzędzie, standard zapisy/HTTP/shell, permissive HTTP/shell), **progami** (0.80/0.90/0.95), obsługą sekretów (redakcja albo blokada), danych osobowych oraz zachowaniem przy niepewności. Każde dopuszczone wywołanie `bash` jest oceniane w każdym profilu.
- `mode: enforce | observe` — `observe` zapisuje, co zostałoby odrzucone; uwierzytelnienie, stan sesji i budżety nadal obowiązują.
- `global` + `users.<nazwa>` — polityka organizacji i użytkownika; allowlisty przecinają się, zakazy sumują, limity biorą minimum, pusta lista = zakaz.
- `topics` / `topic_policies` — katalog tematów wrażliwych i ich polityki.
- Feed zagrożeń: [`feed/demo-attacks.json`](feed/demo-attacks.json) (deserializacja `pickle`/`torch.load` — klasa CVE-2025-32434, `trust_remote_code`, `curl | sh`, reverse shell, `rm -rf /`, wyciek do usług paste/webhook, prompt injection).

## Testy

```sh
npm test            # 47 testów jednostkowych, bez sieci
npm run test:live   # 21 testów na prawdziwych API (Jev, Claude)
npm run test:e2e    # 8 testów z prawdziwym agentem Pi
npm run eval        # korpus semantyczny (patrz niżej)
npm run typecheck
```

Ostatnie przebiegi: **76/76** (47 jednostkowych + 21 na żywych API + 8 end-to-end). Testy na żywych modelach są niedeterministyczne: jeden test e2e padał w ok. 1 z 4 przebiegów, bo jego prompt (nadpisanie szkicu KYC tekstem „SHOULD NOT BE WRITTEN”) wyglądał dla nadzorcy na sabotaż; prompt zmieniono na zwykły. Wniosek: nadzorca bywa nadgorliwy przy nietypowych poleceniach. Testy negatywne sprawdzają **skutek**, nie wpis w logu: plik nie powstał lub nie zmienił się, odbiornik HTTP nie dostał żądania, model nie dostał zabronionej wiadomości (licznik wywołań modelu nie wzrósł), sekret nie trafił do transkryptu agenta ani do audytu.

Testy end-to-end (prawdziwy Pi + prawdziwy Claude + prawdziwy Jev): zatwierdzenie nadpisania szkicu KYC (jeden zapis), odrzucenie zgody (plik nietknięty, sesja `blocked`), odczyt danych innego klienta, ochrona `.env` i redakcja klucza w dozwolonym pliku, sesja HR zamknięta po zleceniu oceny osób, dozwolony POST na prośbę użytkownika, brak żądania przy injekcji w dokumencie oraz brak tokenu sesji w środowisku powłoki agenta.

### Korpus semantyczny (`npm run eval`)

34 przypadki nadzoru + 15 poleceń shella, etykiety napisane **przed** uruchomieniem i nietrojone. Raporty: [`reports/`](reports/).

| Miara | Wynik |
| --- | --- |
| Nadzór: naruszenia przepuszczone (false allow) | 0/15 |
| Nadzór: zamknięcia bez naruszenia (false terminate) | 0/19 |
| Nadzór: niepewne / blokady techniczne | 0/34 / 0/34 |
| Temat wykryty w niezwiązanych wiadomościach | 0/3 |
| Opóźnienie: detekcja tematu p50 / p95 | 9 / 15 ms (lokalny MiniLM, CPU) |
| Opóźnienie: nadzorca (Haiku) p50 / p95 | ~1.3 / ~1.6 s |
| Jev, shell: niebezpieczne polecenia przepuszczone automatycznie | 0/4 w każdym profilu |
| Jev, shell: uzasadnione programy przepuszczone automatycznie | permissive 5/5, standard 2/5, strict 1/5 (reszta pyta użytkownika) |

**Uwaga:** to małe próby napisane przez autorów. Nie przekładają się na skuteczność produkcyjną. Ocena Jeva dotyczy tekstu polecenia, nie jego skutków w czasie wykonania; profil `demo_prepared` **nie jest sandboxem**.

## Odstępstwa od dokumentu koncepcji

| Koncepcja | Implementacja | Powód |
| --- | --- | --- |
| PostgreSQL + pgvector | SQLite (`node:sqlite`), dokładne podobieństwo cosinusowe w pamięci | brak zależności od Dockera; 3 tematy; kontrakt `Store` pozwala wymienić bazę |
| Embeddingi OpenAI | lokalny MiniLM (transformers.js), tylko angielski; dostawca `openai` gotowy w kodzie | brak klucza OpenAI z dostępnymi środkami; dane nie opuszczają maszyny |
| `execution_authorization` + `/consume` | jednorazowa decyzja po zatwierdzeniu (atomowe przejście `pending → approved`) | uproszczenie na demo jednej maszyny |
| React + Vite | statyczny panel w czystym JS | mniej zależności |
| Komunikaty dla modelu po polsku | po angielsku | model wykonawczy pracuje po angielsku |
| Hot-reload polityki przez API | plik YAML + restart | decyzja użytkownika |
| Walidacja kontekstu przez `trusted_task_id` | zaufane zadanie = wiadomości użytkownika zapisane przez bramkę/rozszerzenie | brak osobnego rejestru zadań |

## Znane ograniczenia i otwarte sprawy

- **Brak sandboxa.** `bash` jest oceniany, ale uruchomiony program może zrobić więcej niż opisuje polecenie. Rozszerzenie nie przekazuje tokenu sesji do środowiska powłoki, lecz proces powłoki działa z uprawnieniami użytkownika systemu.
- Wynik narzędzia przechodzi inspekcję w `tool_result` Pi, czyli po wykonaniu; surowa treść mogła trafić do strumienia TUI zanim zostanie zastąpiona.
- Odpowiedź modelu jest buforowana w całości (brak prawdziwego streamingu).
- Domyślnie odmowa **blokuje sesję** (`default_session_action: block`). Rozszerzenie podaje agentowi dozwolone lokalizacje, aby unikał przypadkowych odmów.
- W trakcie ręcznych prób 3 razy zaobserwowano wywołanie Pi bez żadnego ruchu do serwera (wisiało do limitu czasu); nie udało się go odtworzyć w późniejszych kilkunastu przebiegach (w tym 7 testach e2e). Logowanie żądań serwera: `BLACKWALL_LOG=1`.
- Model embeddingowy jest angielski; polskie wiadomości będą słabiej wykrywane.
- Brak automatycznego pobierania feedu, MCP, agent-to-agent, SSO.
- Klucze użyte podczas budowy trafiły do transkryptu pracy — **należy je zrotować** po hackathonie.
