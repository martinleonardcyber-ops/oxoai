## OxoAI 2026.1026.0 : première version

Ton espace de travail IA, sur ta propre machine : chat, agents, code, bases de connaissances et entraînement, avec des modèles qui tournent en local. Gratuit, open source (AGPL-3.0), sans compte en ligne et sans télémétrie.

OxoAI est une version modifiée de [HelixAI](https://github.com/medhiclb/HelixAI), de Medhi Clabaut (Helix Agence). Cette première version reprend HelixAI 2026.1024.3 avec le nom, l'icône et les couleurs d'OxoAI, des données séparées d'une éventuelle installation de HelixAI, et des mises à jour qui viennent de ce dépôt. Le détail est dans [COPYRIGHT.md](https://github.com/martinleonardcyber-ops/oxoai/blob/main/COPYRIGHT.md).

### Installer (Mac à puce Apple)

**En une commande** (conseillé) : l'image disque est vérifiée contre `SHA256SUMS.txt`, puis OxoAI est copié dans Applications, sans l'avertissement de macOS.

```bash
curl -fsSL https://raw.githubusercontent.com/martinleonardcyber-ops/oxoai/main/scripts/installer-macos.sh | sh
```

**Ou à la main** : télécharge `OxoAI-2026.1026.0-arm64.dmg`, ouvre-le et glisse OxoAI dans Applications. L'application n'est pas signée par Apple : au premier lancement, va dans *Réglages Système › Confidentialité et sécurité* et clique sur **Ouvrir quand même**.

### Premier lancement

- Choisis **Poste autonome**, puis crée ton compte : il reste sur ta machine.
- OxoAI installe le moteur de LM Studio et le modèle ouvert le mieux noté qui tient dans ta mémoire (16 Go conseillés). C'est le seul téléchargement important : plusieurs gigaoctets, une seule fois.
- macOS peut demander l'accès d'OxoAI à sa clé du trousseau (« OxoAI Safe Storage ») : choisis **Toujours autoriser**.

### À savoir

- Cette version est pour les Mac à puce Apple (M1 et suivants). Les versions Windows, Linux et Mac Intel viendront ensuite.
- Les mises à jour suivantes seront proposées dans l'application.
- Un souci ? Ouvre un ticket dans les [Issues](https://github.com/martinleonardcyber-ops/oxoai/issues).
