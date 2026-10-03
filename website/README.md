# Blackwall — the project website

A static presentation website in English: a description of the solution, an interactive decision simulation, three KYC/M&A/HR conversations with process diagrams and topic supervision of sessions, an architecture diagram, an audit mockup, a 24-hour schedule, readiness criteria and a scaling plan.

## Running it

Open `dist/index.html` in a browser, or run from the repository directory:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory website/dist
```

Then go to <http://127.0.0.1:4173>. The site needs no package installation or build process; it also works offline after opening the HTML file. The GitHub link requires the internet.

## Files

- `dist/index.html` — the complete content and the semantic layout of the page.
- `dist/styles.css` — styling and the desktop, tablet and phone layouts.
- `dist/app.js` — the decision scenarios, the conversation tabs, approval/rejection, the mobile menu and Blackwall Junior.
- `dist/assets/` — both covers of the project.
- `dist/docs/` — a copy of the concept and the PDF brief, available from the page.
- `.openai/hosting.json` — the publishing configuration for Sites (the site is publicly accessible).

The source of the content is `../docs/blackwall-koncepcja-i-plan-dema.md`. After changing the document, update the description on the page and its copy in `dist/docs/`. The covers come from `../docs/assets/`.

## Scope of the demonstration

The simulation runs only in the browser: it does not execute tools, send data to a model or connect to a Blackwall backend. The approval to overwrite, its rejection and the reset are example interface states. The audit view contains data marked as demonstration data. The schedule and the architecture describe the MVP plan; the working implementation is in `../blackwall/`, and this page does not reflect its state.

The content is readable without JavaScript; the interactions require it. The site supports the keyboard, shows a visible focus, provides decision messages for screen readers and respects the preference for reduced motion.

The agent prefers the controlled file and HTTP tools, and every approval of the shell requires Jev's assessment. The scenarios show KYC onboarding within the client's scope and a one-time write, an attempted unauthorized publication of an M&A analysis, and the closure of a session after a prohibited HR request. The interactive simulation also shows control of a response without a tool and a budget refusal. The diagrams are built in HTML/CSS and need no external renderer. The concept document covers 32 groups of tests of the designed backend, including supervision of sensitive session topics; these are not test results of this static site. The design of the topic module is in `dist/docs/blackwall-koncepcja-i-plan-dema.md`, in section 6a. The site describes detection, labels, one additional supervisor per session and the reviewing/terminated states. The simulation runs neither embeddings nor a supervising model.
