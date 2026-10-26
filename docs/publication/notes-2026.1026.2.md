## OxoAI 2026.1026.2 : correctif de la mise en route

**« Installer et démarrer » ne faisait rien** quand LM Studio était déjà installé et réglé sur un autre port que celui par défaut (1234). OxoAI voyait que le serveur de LM Studio tournait, mais le cherchait au mauvais endroit, et l'écran restait figé.

OxoAI se branche maintenant sur le port qu'utilise réellement LM Studio, et retrouve les modèles déjà installés.

### Mettre à jour (Mac à puce Apple)

Si OxoAI est installé, la mise à jour est proposée dans l'application.

Sinon, en une commande :

```bash
curl -fsSL https://raw.githubusercontent.com/martinleonardcyber-ops/oxoai/main/scripts/installer-macos.sh | sh
```

Ou télécharge `OxoAI-2026.1026.2-arm64.dmg` et glisse OxoAI dans Applications.
