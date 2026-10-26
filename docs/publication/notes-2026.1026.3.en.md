## OxoAI 2026.1026.3: fast answers, reasoning when it helps

With a local reasoning model (Qwen 3.5, Qwen 3…), OxoAI used to reason about everything: over a minute and a half to answer "hi".

New default reasoning level, **Adaptive**: OxoAI decides per message. No reasoning for greetings, thanks or short questions (answers in one to a few seconds); reasoning for code, bugs, plans, analysis or comparisons, equations, proofs, "step by step" requests and long texts. Measured on an Apple silicon Mac with Qwen 3.5 9B: "hi" went from 1 min 43 s to 1.4 s.

The assistant also stops reminding you at every message that it has no tools; it only says so when you ask for an action that needs them.

If OxoAI is installed, the update is offered in the app. Otherwise:

```bash
curl -fsSL https://raw.githubusercontent.com/martinleonardcyber-ops/oxoai/main/scripts/installer-macos.sh | sh
```
