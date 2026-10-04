# Runtime dashboard UI QA

Date: 2026-10-04
URL: `http://127.0.0.1:8787/dashboard`

Used the synthetic `demo-admin-token` session against the app's copied historic database. Actions were read-only: loaded the dashboard and policy data; no publication, revocation, session creation, or model request was made.

## Desktop

At the dashboard's full desktop window (about 1512×949 CSS px), the policy overview, profile comparison, user-scope viewer, and policy/feed editors render without a layout error. The editor cards sit side by side, with readable descriptions, JSON controls, Polish labels, and current version/status. DevTools Console showed zero messages (one hidden by the current log-level filter).

## Mobile

At a 390×844 CSS px responsive viewport, policy/feed editor cards stack vertically. Descriptions wrap, JSON areas stay within their cards, and each pair of reload/publish buttons is visible together. Tables now have focusable horizontal-scroll wrappers with the visible hint “Przesuń tabelę w bok, aby zobaczyć wszystkie kolumny.” Focusing a wrapper and pressing Right exposed the profile table's `strict` column and sensitive-topics table's `Przykłady` column. The wrapper and hint are visible in the UI; all columns can be reached by horizontal keyboard scrolling.

The editable policy JSON shown for the selected user exposes policy scope data only; it contains no authentication-token property. The admin credential is represented separately as a masked input.

No client-side console errors were surfaced. No screenshot files were saved.
