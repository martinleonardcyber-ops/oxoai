## OxoAI 2026.1026.3 : des réponses rapides, de la réflexion quand il le faut

Avec un modèle local qui « réfléchit » (Qwen 3.5, Qwen 3…), OxoAI réfléchissait à tout : plus d'une minute et demie pour répondre à « salut ».

**Nouveau réglage de réflexion « Adaptatif », par défaut** : OxoAI décide, message par message, s'il faut réfléchir.

- **Pas de réflexion** pour une salutation, un remerciement ou une question courte : réponse en une à quelques secondes.
- **Réflexion** pour ce qui la mérite : du code, un bug, un plan, une analyse ou une comparaison, une équation, une démonstration, une demande « étape par étape », un long texte.

Mesuré sur un Mac à puce Apple avec Qwen 3.5 9B :

| Message | Avant | Maintenant |
|---|---|---|
| « salut » | 1 min 43 | 1,4 s |
| « Combien font 17 × 23 ? » | plus de 30 s | 3,5 s (réponse juste) |
| « Résous l'équation 3x − 7 = 2x + 5 » | avec réflexion | avec réflexion, résolue étape par étape |

Les autres niveaux (Aucun, Faible, Moyen, Élevé, Max) restent dans le menu de la zone de saisie.

**Aussi** : l'assistant ne rappelle plus à chaque message qu'il n'a pas accès aux outils, seulement quand on lui demande une action qui en a besoin.

### Mettre à jour (Mac à puce Apple)

Si OxoAI est installé, la mise à jour est proposée dans l'application. Sinon, en une commande :

```bash
curl -fsSL https://raw.githubusercontent.com/martinleonardcyber-ops/oxoai/main/scripts/installer-macos.sh | sh
```
