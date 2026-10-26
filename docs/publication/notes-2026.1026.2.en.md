## OxoAI 2026.1026.2: setup fix

"Install and start" did nothing when LM Studio was already installed and set to a port other than the default (1234). OxoAI now connects to the port LM Studio actually uses and finds the models already installed.

If OxoAI is installed, the update is offered in the app. Otherwise:

```bash
curl -fsSL https://raw.githubusercontent.com/martinleonardcyber-ops/oxoai/main/scripts/installer-macos.sh | sh
```
