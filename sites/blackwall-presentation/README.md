# Blackwall Sites presentation

Public site: https://blackwall-hackyeah-2026.dariusz.chatgpt.site/

`published/` is a reproducible snapshot exported from the managed Sites repository at commit `1e92d395c4c72738e14958b652a8061154359681`. It includes the sequence diagram, policy field explorer, recorded session explanations, demo clips and the validated nine-slide presentation. Git metadata and temporary upload archives are excluded.

Preview the snapshot from the project root:

```sh
python3 -m http.server 8790 --directory sites/blackwall-presentation/published/dist
```

`deployment.json` records the published version and URL. `content/` contains the generated schema and explanation sources; `qa/` contains the publication and sequence checks. The managed `source/` checkout remains local and has its own Git history.

Version 8 presents the website and nine-slide downloadable deck in English. Original Polish prompts, recordings and screenshots remain verbatim, with English translations or disclosure labels. `qa/english/` records 455 passing localization, sequence, policy and browser checks. `blackwall/deliverables/blackwall-demo-en.pptx` is the corresponding English deck; the earlier Polish deck is retained.

The live authenticated session browser belongs to the Blackwall application. Its implementation is in `blackwall/dashboard/`, with HTTP/SSE regression checks in `blackwall/test/e2e/dashboard-sessions.qa.mjs`. The presentation contains recorded evidence; run the application to observe new sessions live.
