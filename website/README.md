# Blackwall — strona projektu

Statyczna strona prezentacyjna po polsku: opis rozwiązania, interaktywna symulacja decyzji, trzy rozmowy KYC/M&A/HR z diagramami procesu oraz nadzór nad tematami sesji, schemat architektury, makieta audytu, harmonogram 24 godzin, kryteria gotowości i plan skalowania.

## Uruchomienie

Otwórz `dist/index.html` w przeglądarce albo uruchom z katalogu repozytorium:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory website/dist
```

Następnie wejdź na <http://127.0.0.1:4173>. Strona nie wymaga instalacji pakietów ani procesu budowania; działa także offline po otwarciu pliku HTML. Link do GitHuba wymaga internetu.

## Pliki

- `dist/index.html` — kompletna treść i semantyczny układ strony.
- `dist/styles.css` — styl oraz układy desktop, tablet i telefon.
- `dist/app.js` — scenariusze decyzji, zakładki rozmów, zatwierdzenie/odrzucenie, menu mobilne i Blackwall Junior.
- `dist/assets/` — oba covery projektu.
- `dist/docs/` — kopia koncepcji i brief PDF dostępne ze strony.
- `.openai/hosting.json` — konfiguracja publikacji w Sites (strona ma publiczny dostęp).

Źródłem treści jest `../docs/blackwall-koncepcja-i-plan-dema.md`. Po zmianie dokumentu zaktualizuj opis na stronie oraz jego kopię w `dist/docs/`. Covery pochodzą z `../docs/assets/`.

## Zakres demonstracji

Symulacja działa wyłącznie w przeglądarce: nie wykonuje narzędzi, nie wysyła danych do modelu i nie łączy się z backendem Blackwalla. Zgoda na nadpisanie, jej odrzucenie i reset to przykładowe stany interfejsu. Widok audytu zawiera oznaczone dane demonstracyjne. Harmonogram oraz architektura opisują plan MVP.

Treść jest czytelna bez JavaScript; interakcje wymagają jego włączenia. Strona ma obsługę klawiatury, widoczny fokus, komunikaty decyzji dla czytników ekranu i respektuje preferencję ograniczenia animacji.

Agent preferuje kontrolowane narzędzia plikowe i HTTP, a każda zgoda na shell wymaga oceny Jeva. Scenariusze pokazują onboarding KYC w zakresie klienta i jednorazowy zapis, próbę nieuprawnionej publikacji analizy M&A oraz zamknięcie sesji po zakazanym zleceniu HR. Interaktywna symulacja pokazuje także kontrolę odpowiedzi bez toola i odmowę budżetową. Diagramy są zbudowane w HTML/CSS i nie potrzebują zewnętrznego renderera. Dokument koncepcji obejmuje 32 grupy testów projektowanego backendu, w tym nadzór nad wrażliwymi tematami sesji; nie są to wyniki testów tej statycznej strony. Projekt modułu tematycznego jest w `dist/docs/blackwall-koncepcja-i-plan-dema.md`, w sekcji 6a. Strona opisuje detekcję, etykiety, jednego dodatkowego nadzorcę na sesję oraz stany reviewing/terminated. Symulacja nie uruchamia embeddingów ani modelu nadzorującego.
