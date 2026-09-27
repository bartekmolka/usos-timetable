# USOS – Filtr grup zajęciowych (rozszerzenie do Brave/Chrome)

Rozszerzenie do przeglądarki, które ułatwia czytanie planu zajęć w USOS (widok
„HTML (nowy)”). Samo wykrywa wszystkie przedmioty i dostępne grupy (CWL, CWA,
CWP itd.), a w panelu w prawym górnym rogu strony pozwala wybrać, którą grupę
chcesz widzieć na każdym przedmiocie.

- **Wykłady (W) są zawsze widoczne** – nigdy nie są filtrowane.
- Dla każdego innego typu zajęć (ćwiczenia laboratoryjne CWL, audytoryjne CWA,
  projektowe CWP itd.) wybierasz **jedną grupę na przedmiot** – pozostałe
  grupy znikają z planu.
- Wybory zapisują się automatycznie (`chrome.storage.local`) i zostają po
  odświeżeniu strony.
- Przycisk „Wyczyść filtry” w panelu przywraca widok wszystkich grup.
- Panel można zwinąć przyciskiem „–” w nagłówku.

## Instalacja w Brave

1. Rozpakuj ten folder, jeśli dostałeś go jako `.zip`.
2. Wejdź na `brave://extensions` (Menu → Rozszerzenia → Zarządzaj rozszerzeniami).
3. Włącz **„Tryb programisty”** (Developer mode) – przełącznik w prawym górnym rogu.
4. Kliknij **„Wczytaj rozpakowane”** (Load unpacked) i wskaż ten folder
   (`usos-filter-extension`).
5. Wejdź na stronę planu zajęć w USOS – w prawym górnym rogu strony powinien
   pojawić się panel „Filtr grup zajęciowych”.

Ten sam plik działa tak samo w każdej przeglądarce opartej na Chromium (Chrome,
Edge, Brave, Opera) – wystarczy w niej analogicznie włączyć tryb programisty
i wczytać rozpakowane rozszerzenie.

## Jeśli plan jest na innym adresie USOS

Domyślnie rozszerzenie działa na `https://web.usos.agh.edu.pl/*`. Jeśli
korzystasz z innej instancji USOS, otwórz `manifest.json` i dopisz swój adres
do listy `matches`, np.:

```json
"matches": [
  "https://web.usos.agh.edu.pl/*",
  "https://twoj-usos.przyklad.pl/*"
]
```

Po zmianie manifestu kliknij ikonę odświeżania przy rozszerzeniu na stronie
`brave://extensions`.

## Jak to działa (w skrócie)

Skrypt `content.js` szuka na stronie elementów `<timetable-entry>`, czyta z
nich atrybut `name-id` (identyfikator przedmiotu) oraz tekst w `slot="info"`
(np. „CWL, gr. 7 (316, bud. C2)”), z którego wyciąga typ zajęć i numer grupy.
Na tej podstawie buduje listę przedmiotów z dostępnymi grupami i renderuje
panel wyboru. Wpisy nienależące do wybranej grupy są ukrywane przez dodanie
klasy CSS `usos-filter-hidden` (z `display: none !important`), bez ingerencji
w resztę strony.

## Uwaga

Rozszerzenie obsługuje widok „HTML (nowy)” planu zajęć (dokładnie ten pokazany
w przykładowej strukturze strony). Jeśli USOS zmieni strukturę HTML planu,
może być potrzebna drobna korekta selektorów w `content.js`.
