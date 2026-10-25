# OxoAI AI pour VS Code

Le Chat de votre instance OxoAI dans VS Code : vos modèles (locaux d'abord), vos règles, votre journal. L'extension ne parle à aucun autre service.

- **Chat** dans la barre latérale (icône OxoAI), avec « Joindre le fichier ouvert ».
- **Expliquer / Améliorer la sélection** : clic droit sur du code sélectionné.
- **Insérer** : chaque bloc de code d'une réponse porte, au-dessus du code, un bouton qui l'insère à la place de la sélection.
- **Code** (onglet) : OxoAI Code lit, écrit et modifie les fichiers du dossier ouvert. Il faut se connecter une fois avec son compte OxoAI (commande « OxoAI : se connecter ») ; la séance est gardée dans le coffre de VS Code.

## Installer

Le paquet `oxoai-ai-<version>.vsix` est joint à chaque version de OxoAI, sur https://github.com/martinleonardcyber-ops/oxoai/releases/latest. Téléchargez-le, puis dans VS Code : vue Extensions, menu « … » en haut de la vue, « Install from VSIX… », et choisissez le fichier. Pour une version plus récente, refaites la même chose : elle remplace l'ancienne.

## Nouveautés de la 0.2.6

- Une réflexion que le modèle écrit dans sa réponse (entre `<think>` et `</think>`, selon le moteur ou le modèle) est reconnue : la vue dit que le modèle réfléchit, et la réponse s'affiche sans les balises.

## Nouveautés de la 0.2.5

- Pendant que le modèle réfléchit avant de répondre, la vue dit « Le modèle réfléchit (N s)… » au lieu de « … ».
- Le code de votre question garde sa mise en forme (indentation, lignes) dans le fil.
- Le bouton « Insérer » est posé au-dessus du code : il ne recouvre plus la première ligne.

## Réglages

- `oxoai.adresse` : par défaut `http://127.0.0.1:8787`, l'application OxoAI de cet ordinateur. Hors de cet ordinateur, en `https` seulement.
- `oxoai.jeton` : vide, il est lu dans `~/.oxoai/data/instance-token`, et seulement pour le port que l'application a ouvert. Pour une instance d'entreprise, celui que vous donne l'administrateur.

Ces deux réglages sont ceux de la machine : le `.vscode/settings.json` d'un dépôt ne peut pas les changer, et l'extension ne s'active que dans un espace de travail de confiance. La séance est gardée par adresse d'instance.
- `oxoai.modele` : vide, OxoAI choisit (mode Auto).

Licence AGPL-3.0, comme OxoAI.
