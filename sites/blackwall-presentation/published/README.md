# Blackwall — interactive presentation

The public Blackwall project website on Sites, in plain English. Its first read explains the checkpoint with a simple picture, three interactive examples and three recorded results. The complete session browser, sequence diagram, policy explorer, test evidence and detailed limits open on demand. Eight demo recordings and a nine-slide downloadable deck remain available.

## Preview

```sh
python3 -m http.server 8790 --bind 127.0.0.1 --directory dist
```

Open `http://127.0.0.1:8790/`. This static site requires no package installation or build step. Replay data is fetched as JSON over HTTP, so opening an HTML file directly is insufficient. Google Fonts have system fallbacks.

## Source files

- `dist/index.html` and identical `dist/presentation.html`: English content and semantics.
- `dist/presentation.css`: shared layout, animation, responsive views and reduced motion.
- `dist/jury.css`: the simplified first read, visual rule shortcuts and accessible disclosure layout.
- `dist/jury-guide.js`: deep links, recorded-result shortcuts, policy presets and closing-panel playback controls.
- `dist/presentation.js`: filters, replay, recording selection and presentation mode.
- `dist/policy-explorer.js`: field catalogue, filters, interactive JSON and evidence media.
- `dist/process-diagram.js` and `dist/assets/process-flow.json`: ten participants, eight paths, 48 steps and 114 sequence messages, with source references and policy links.
- `dist/assets/session-contexts.json`: verbatim original prompts, provenance, separate replay proposals and event explanations. English translations are explicitly separated from original Polish prompts. Temporary workspace paths are represented as `<WORKSPACE>`.
- `dist/assets/policy-guide.json`: 119 explanations covering all 116 PolicySchema leaves, aliases and additional publication fields. Each entry describes its type, example, effect, limits and runtime editability.
- `dist/assets/policy.schema.json` and `policy-publication.schema.json`: schemas generated from the application's exported Zod definitions; additional semantic validation remains in the runtime.
- `dist/assets/evidence.json`: selected recorded audit events and their provenance. Sequence numbers have gaps because intermediate events were omitted.
- `dist/assets/videos/` and `posters/`: web copies of original recordings, with unchanged durations; H.264, 1280×720, 25 fps, no audio.
- `dist/assets/screens/`: original dashboard screenshots.
- `dist/assets/blackwall-demo.pptx`: nine English slides with original screenshots explicitly labeled as Polish UI.
- `.openai/hosting.json`: retained Site identity and static directory.

The original recordings and screenshots remain in Polish and are labeled accordingly. English explanatory copy does not alter the underlying recorded evidence. `app.js` and `styles.css` are historical assets; the current HTML does not load them.

## Interaction and evidence scope

Replay runs only in the browser. It does not connect to Blackwall, run tools, collect user data or invoke OpenAI/Jev. Intermediate states are reconstructed from selected audit events; final states come from completed sessions. Animation compresses playback time while retaining actual timestamps.

KYC and HR include explicit topic assignment from `user_config`. A separate KYC case demonstrates detection without an initial assignment. The M&A POST replay is a harness proposal rather than an autonomous Pi tool call. Test approvals and administrator decisions are simulated and explicitly labeled; authenticated administrator API actions are identified separately. The uncertain verdict is preserved without another model call.

Historical application evidence shown on this site: 143 unit tests, 33 real integration/API tests and 12 Pi E2E tests; 14 demo scenarios with 68 checks, plus six continuation checks. The site describes the recorded corpus, rather than implying that these are current repository test totals. The small synthetic corpus does not establish production reliability. Missing OS sandboxing, a central control plane and complete financial costing remain visible limitations.

## Jury-first reading path

The default page keeps technical panels closed. The hero separates Allow (the tool may run), Ask (wait for approval) and Stop (the tool stays off). Flow examples are illustrations and never run tools. The publication-denial example starts from a request to summarize a deal: the extra external POST was not requested.

Three proof cards open the final recorded event for the approval, cross-client file denial and HR topic violation cases. Three policy cards open the exact `read_roots`, `require_approval_roots` and topic `forbidden` fields. Direct links to the audit, sequence and policy sections open the appropriate panel. Closing a panel stops its playback. The full technical material and unchanged evidence stay available without crowding the first read.

## Presentation mode

Presentation mode adds chapter navigation. Left/right arrows and PageUp/PageDown move between sections; Escape exits. Form and video controls retain their own keyboard behavior. Motion can be disabled; the operating system's reduced-motion preference is respected.

## Policy and session guide

Each session presents the original prompt and its source, the agent or harness action, Blackwall's intervention and the responsible features. Events have specific explanations. Feature chips link to relevant policy fields. The guide supports hover, focus, click, touch and arrow keys. Recordings remain under user control. Fields without direct video evidence clearly state that their explanation is based on source code.

Three publication examples have interactive JSON keys and satisfy PolicyPublicationSchema. This is documentation rather than an administrator form: it neither saves configuration nor performs operations.

## Sequence diagram

Participants occupy columns with vertical lifelines. Messages run from top to bottom. Requests use solid arrows, responses use dashed arrows and self-calls use loops. Guards identify optional messages. The diagram separates model traffic through the gateway from tool evaluation through Core. Participant details explain inputs, outputs, conditions, policy fields and source references. Message activation selects its parent step; playback and keyboard navigation step through the path. Scrolling remains inside the diagram, with sticky participant headers.

The eight routes cover a safe model response, an allowed tool, user approval, a hard denial, a topic violation, an uncertain verdict, configuration publication and Jev denial. Embeddings propose topic candidates, the Guardian supervises content and Jev evaluates proposed operations. Trusted topic assignments come from user configuration when sessions are created.

The diagram distinguishes an allow decision, consumption of a one-use execution grant, local execution start and result reporting. It describes the actual boundaries: no OS sandbox, observe behavior, Pi approval conditions and publication waiting for in-flight HTTP requests without stopping an already running local executor. Decision examples assume enforce mode.

## Publication

Updates retain the existing public Site audience and URL. The Sites workflow helper prepares and pushes source and static assets. Repository credentials and API secrets are never included in the site. The authenticated live session browser belongs to the application dashboard; the public presentation displays recorded evidence.
