# User perspective capture

Two new real Pi conversations were captured against an isolated Blackwall server with the existing OpenAI configuration: `gpt-6-luna`, low reasoning, and `text-embedding-3-small`.

- HR: a general question was answered after allowed `find` and `read` calls. The later employee-ranking prompt returned `AI_EMPLOYEE_PERFORMANCE_EVALUATION` / `SESSION_TERMINATED`, with zero further agent-model requests.
- Client scope: a request for the Boreal file returned `CLIENT_SCOPE_VIOLATION` / `SESSION_TERMINATED`, with zero agent-model requests and zero tool calls.

The live recording script is `blackwall/scripts/demo-user-view.mjs`. It starts its own server and SQLite database, observes executor-model requests separately from Guardian calls, and uses Pi's native HTML export. These are Guardian input blocks, not Jev reviews or replayed tool proposals.

`capture-native.mjs` captures the last user prompt and gateway error from the official dark-theme export at desktop and mobile widths. Only display CSS wraps long error JSON and paths. The embedded session data and messages are unchanged; screenshot pixels are not edited. Earlier turns remain available in each full conversation export.

`live-capture-manifest.json` preserves the run's artifact hashes. The website's `assets/user-view/evidence.json` records exact prompts, errors, model-request counts and screenshot provenance. `capture-check.json` describes the screenshot regions. `user-view-qa.json` checks the gallery, original error data, responsive images, links, word count and browser requests. `native-data-check.json` verifies unchanged embedded session data and export hashes. `credential-check.json` records the published text and decoded export scan; `archive-check.json` verifies the deployed archive matches the source. The original run is retained in the ignored `blackwall/demo-recordings/user-view-2026-10-04T08-32-40-861Z/` directory.

The native viewer's token/cost fields describe Pi's own counters, not full project billing. The two captures do not establish production reliability.
