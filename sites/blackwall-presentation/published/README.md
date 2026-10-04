# Blackwall — interaktywna prezentacja

Publiczna strona projektu w Sites. Polska prezentacja działającego lokalnego MVP: filmowy hero, animowany schemat decyzji, replay prawdziwych zdarzeń dashboardu, osiem nagrań, wyniki i ograniczenia oraz dziewięcioslajdowa prezentacja PPTX.

## Podgląd

```sh
python3 -m http.server 8790 --bind 127.0.0.1 --directory dist
```

Wejdź na `http://127.0.0.1:8790/`. Strona jest buildless; nie wymaga instalacji pakietów. Replay pobiera JSON przez HTTP, więc otwarcie pliku przez `file://` nie wystarcza. Fonty Google mają systemowy fallback.

## Źródła

- `dist/index.html` i identyczny `dist/presentation.html`: treść i semantyka.
- `dist/presentation.css`: układ, animacje, desktop/mobile, ograniczenie ruchu.
- `dist/presentation.js`: filtry, odtwarzanie, wybór nagrań, tryb pokazu.
- `dist/policy-explorer.js`: mapa pól, filtry, interaktywny JSON i powiązane media.
- `dist/process-diagram.js` i `dist/assets/process-flow.json`: Sequence Diagram dziesięciu uczestników, 114 komunikatów i ośmiu ścieżek; opisy danych, warunków, zdarzeń i źródeł w kodzie.
- `dist/assets/session-contexts.json`: oryginalne prompty ze źródłami, osobne propozycje replayu i objaśnienia interwencji dla każdego zdarzenia. Wygenerowane ścieżki tymczasowego workspace oznaczono jako `<WORKSPACE>`; tłumaczenia są jawnie oddzielone od oryginału.
- `dist/assets/policy-guide.json`: 119 objaśnień obejmujących wszystkie 116 pól PolicySchema, z aliasami i dodatkowymi polami publikacji. Wskazuje typy, przykłady, skutki, granice i możliwość publikacji runtime.
- `dist/assets/policy.schema.json` i `policy-publication.schema.json`: schematy wygenerowane z eksportów Zod aplikacji; kontrole semantyczne pozostają w runtime.
- `dist/assets/evidence.json`: wybrane rzeczywiste zdarzenia audytu i ich pochodzenie. Numery `seq` zawierają przerwy, ponieważ pominięto zdarzenia pośrednie. Dane nie zawierają tokenów ani prywatnych payloadów.
- `dist/assets/videos/` i `posters/`: webowe kopie oryginalnych MP4, bez skracania ich długości, H.264 1280×720/25fps, bez audio.
- `dist/assets/screens/`: czyste screeny dashboardu.
- `dist/assets/blackwall-demo.pptx`: dziewięć zweryfikowanych slajdów.
- `.openai/hosting.json`: zachowana tożsamość Site oraz static directory.

Oryginalne covery i dokumenty koncepcji pozostają w `assets/` i `docs/`. Dotychczasowe `app.js` i `styles.css` są historyczne; nowy dokument ich nie ładuje.

## Zakres interakcji i dowodów

Replay działa wyłącznie w przeglądarce. Nie łączy się z Blackwallem, nie wykonuje narzędzi, nie pobiera danych użytkownika i nie wywołuje OpenAI/Jev. Stan pośredni jest rekonstruowany z typu wybranych zdarzeń; stan końcowy pochodzi z zakończonej sesji. Animacja używa skróconego czasu, zachowując rzeczywiste timestampy.

KYC i HR zawierają jawne przypisanie tematów z `user_config`. Osobny przypadek KYC pokazuje wykrycie bez przypisania. Replay POST M&A jest propozycją harnessa, nie autonomicznym toolem Pi. Zgody użytkownika i administratora w testach są symulowane, a uwierzytelnione API administratora jest oznaczone osobno. Niepewny wynik zachowano bez kolejnego wywołania modelu.

Weryfikacja aplikacji: 143 jednostkowe, 33 integracyjne/API i 12 Pi E2E, zero pominięć; demo 14 scenariuszy/68 checków plus 6 checków kontynuacji. Końcowy pełny follow-up unit/typecheck nastąpił po master verify. Wszystkie wartości opisują mały syntetyczny korpus, nie niezawodność produkcyjną. Brak sandboxa OS, centralnego control plane i pełnej wyceny kosztów pozostaje widoczny na stronie.

## Prezentowanie

„Tryb pokazu” dodaje nawigację rozdziałami. Strzałki lewo/prawo i PageUp/PageDown przechodzą między sekcjami; Escape wychodzi. Kontrolki formularza i wideo zachowują własne klawisze. Animacje można wyłączyć; preferencja systemowa ograniczenia ruchu jest respektowana.

Publikacja zachowuje publiczny dostęp istniejącego Site. Źródło i static assets przygotowuje helper Sites; żadne poświadczenia repozytorium ani API nie należą do tej strony.

## Publikacja konfiguracji

Lokalne MVP publikuje reguły, profile/progi, katalog tematów i feed przez uwierzytelnione API/UI. Walidowany kandydat i detektor powstają przed przełączeniem; CAS chroni przed starą kartą. Publikacja czeka na trwające żądania, unieważnia niewykorzystane zgody/granty i zachowuje kontekst aktywnej rozmowy. Overlay SQLite przywraca się przy tym samym bazowym YAML. RE2 obsługuje wzorce feedu bez native-regex fallbacku. To lokalna administracja, bez organizacyjnego control plane/SSO.

Nowy klip publikacji pochodzi z pierwszego udanego przebiegu `00-53-27-385Z`, 11/11 checków, polityka v3/feed v2. Rzeczywisty Pi kończy odczyt i program przed edycjami; późniejsza odmowa jest jawnym replayem API w tej samej sesji. Wykonania odczytu/programu częściowo się nakładały. PPTX `final-v4`,9 slajdów, zawiera rzeczywiste panele publikacji oraz aktualne wyniki i ograniczenia. QA strony:31/31, desktop/mobile,8 filmów, odzyskanie danych po HTTP503.

## Przewodnik po politykach i sesjach

Każda sesja pokazuje wejściowy prompt, jego źródło, działanie Pi lub harnessa, działanie Blackwalla i funkcje odpowiadające za interwencję. Zdarzenia otrzymują osobne wyjaśnienia. Kliknięcie funkcji przechodzi do powiązanej reguły. Przewodnik działa po najechaniu, kliknięciu, dotknięciu i użyciu klawiatury. Nagrania pozostają pod kontrolą użytkownika; pola bez bezpośredniego klipu mają jawnie oznaczone wyjaśnienie na podstawie kodu.

Trzy przykłady publikacji mają interaktywne klucze i przechodzą rzeczywisty PolicyPublicationSchema. Strona ma dziewięć rozdziałów; pobieralny PPTX zachowuje dziewięć slajdów. Przewodnik jest dokumentacją, nie formularzem administracyjnym: nie zapisuje konfiguracji ani nie wykonuje operacji.

QA tej edycji: 90/90 sprawdzeń przewodnika i kontekstów sesji oraz 31/31 regresji dotychczasowej strony. Zweryfikowano hover, focus, kliknięcie, dotyk, strzałki klawiatury, filtry, interaktywny JSON, wszystkie schematy i odzyskanie po błędach HTTP/mediów. Niezależne audyty potwierdziły pochodzenie sześciu promptów, powiązanie 45 zdarzeń i pokrycie wszystkich 116 liści PolicySchema.

## Sequence Diagram

Sekcja `#proces` przedstawia Sequence Diagram: uczestnicy w kolumnach, pionowe linie życia i komunikaty w kolejności od góry do dołu. Żądania mają strzałki ciągłe, odpowiedzi przerywane, operacje własne mają pętle. Warunki opisują komunikaty opcjonalne. Schemat pokazuje osobno ruch modelu przez gateway i ocenę każdego narzędzia przez Core. Kliknięcie lub najechanie nagłówka uczestnika ujawnia dane wejściowe/wyjściowe, warunki, pola polityki i źródła. Ścieżki można odtwarzać, przechodzić krokami i obsługiwać klawiaturą. Diagram przewija się wewnątrz własnego panelu w obu osiach, z przyklejonymi nagłówkami; aktywny krok jest przewijany do widoku. Kliknięcie wiersza komunikatu wybiera jego krok. Pola polityki otwierają istniejący przewodnik. JSON diagramu jest dostępny do pobrania. Osiem scenariuszy zawiera 48 objaśnionych kroków i 114 komunikatów, zweryfikowane na podstawie 18 plików źródłowych.

Osiem ścieżek obejmuje bezpieczną odpowiedź modelu, dozwolone narzędzie, zgodę użytkownika, twardą odmowę, naruszenie tematu, niepewny werdykt, publikację konfiguracji oraz odmowę Jev. Schemat jest objaśnieniem kodu MVP; nie jest nagraniem konkretnej sesji i nie wywołuje API. Embeddingi zgłaszają kandydatów tematów, Guardian nadzoruje treść, a Jev ocenia proponowaną operację. Zaufane przypisanie tematu pochodzi z konfiguracji użytkownika przy tworzeniu sesji.

Diagram rozróżnia decyzję allow, jednorazowe consume grantu, rozpoczęcie lokalnego wykonania oraz odbiór wyniku. Opisuje rzeczywiste granice: brak sandboxa OS, zachowanie observe, warunki zgody w UI Pi oraz publikację czekającą na żądania HTTP, bez zatrzymywania już uruchomionego lokalnego executora. Przykłady decyzji zakładają tryb enforce.

QA sekwencji: 126/126 sprawdzeń na desktopie i telefonie, 69/69 odnośników do polityk oraz ponowna regresja strony 31/31. Niezależny przegląd potwierdził wszystkie 114 komunikatów, 18 hashy źródeł i 56 odwołań do linii kodu.
