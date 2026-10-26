# Droits et licence

## OxoAI, version modifiée de HelixAI

OxoAI est une **version modifiée** de [HelixAI](https://github.com/medhiclb/HelixAI),
créée par Medhi Clabaut (Helix Agence) et publiée sous GNU AGPL-3.0. Comme
l'exige l'article 5 de cette licence :

- **Ce qui a changé**, depuis le 25/10/2026 : le nom (OxoAI), l'icône, le logo
  et la couleur d'accent ; l'identifiant de l'application et ses dossiers de
  données, pour ne pas se mélanger avec un HelixAI installé sur la même
  machine ; les mises à jour, qui viennent de ce dépôt et sont signées par sa
  propre clé ; les contacts (les tickets GitHub remplacent les adresses de
  l'agence) ; l'écran d'abonnement, retiré. Le 26/10/2026 : l'interface
  redessinée (palette, police des titres Instrument Serif, dégradé de la
  marque sur les boutons principaux, accueil, chat, barre latérale, réglages)
  et la fenêtre d'installation du .dmg. Le détail est dans l'historique Git
  de ce dépôt.
- **Licence** : OxoAI reste sous GNU AGPL-3.0 ([LICENSE](LICENSE)). Son code
  complet est publié sur https://github.com/martinleonardcyber-ops/oxoai.
- **Droits** : les droits d'auteur sur le code d'origine restent à Medhi
  Clabaut, ci-dessous ; ceux des modifications appartiennent à leurs auteurs.
  « Helix » et « HelixAI » désignent le projet d'origine, auquel OxoAI n'est
  pas affilié.

```
Copyright (C) 2026 martinleonardcyber-ops, pour les modifications d'OxoAI
```

## Le projet d'origine, HelixAI

HelixAI est publié sous **GNU Affero General Public License, version 3**
([LICENSE](LICENSE)).

```
Copyright (C) 2026 Medhi Clabaut, entrepreneur individuel
exerçant sous le nom commercial Helix Agence — SIREN 994 907 145
https://helix-agence.fr

Ce programme est un logiciel libre : vous pouvez le redistribuer et le
modifier selon les termes de la GNU Affero General Public License telle que
publiée par la Free Software Foundation, en version 3 de cette licence.

Ce programme est distribué dans l'espoir qu'il sera utile, mais SANS AUCUNE
GARANTIE, sans même la garantie implicite de QUALITÉ MARCHANDE ou
d'ADÉQUATION À UN USAGE PARTICULIER. Voyez la GNU Affero General Public
License pour plus de détails.

Vous devriez avoir reçu une copie de la GNU Affero General Public License
avec ce programme. Si ce n'est pas le cas, voyez <https://www.gnu.org/licenses/>.
```

> **Qui détient les droits.** Helix Agence est une micro-entreprise, donc une
> entreprise individuelle : elle n'a pas de personnalité juridique distincte de
> son exploitant. Le titulaire des droits d'auteur est la personne nommée
> ci-dessus ; « Helix Agence » est le nom sous lequel elle exerce, et le SIREN
> l'identifie comme professionnel. C'est ce titulaire qui peut faire respecter
> la licence, et lui seul qui peut en vendre une autre.
>
> **Si le projet passe un jour à une société** (SAS, SARL…), remplacez cette
> ligne par sa raison sociale et son SIREN, et faites-lui céder les droits par
> écrit : changer la ligne ne transfère rien.

## Ce que cette licence permet, et ce qu'elle exige

**Permis, à tout le monde, sans rien demander :** lire le code, l'installer,
l'utiliser en entreprise comme chez soi, le modifier, le redistribuer, le
vendre.

**Exigé en retour, et c'est tout l'intérêt :** quiconque distribue HelixAI, ou
**le propose comme service à travers un réseau**, doit fournir à ses
utilisateurs le code source complet de sa version, modifications comprises,
sous cette même licence. C'est la clause qui distingue l'AGPL de la GPL : elle
ferme la porte par laquelle un concurrent pourrait prendre ce logiciel, le
faire tourner sur ses serveurs, le vendre en abonnement, et ne rien rendre.

En clair : **on peut vendre HelixAI, mais pas en le gardant fermé.** Un
concurrent qui voudrait en faire une offre propriétaire devrait publier tout
son travail, y compris ce qu'il a ajouté. C'est ce qui rend l'opération sans
intérêt pour lui, et parfaitement légale pour tous les autres.

## Vendre une licence différente

Le titulaire des droits n'est pas lié par sa propre licence. Détenant les
droits sur l'ensemble du code, il peut en vendre séparément une licence
privée, à une organisation qui veut intégrer HelixAI sans ouvrir son propre
code. C'est le modèle de GitLab, Grafana ou Nextcloud : le logiciel reste
libre pour tous, et une licence commerciale existe pour qui a besoin de
s'affranchir de l'AGPL.

**Condition à tenir pour que cela reste possible :** rester titulaire de
l'ensemble des droits. Une contribution extérieure acceptée sans accord écrit
(un CLA, *Contributor License Agreement*) appartient à son auteur, et vendre
une licence privée sur un code qu'on ne détient pas entièrement devient
impossible. À mettre en place avant la première contribution venue de
l'extérieur.

## Dépendances

Les 444 paquets installés ont été relevés un par un : 368 MIT, 35 ISC, 11
Apache-2.0, 18 BSD, et une poignée d'autres licences permissives (BlueOak, 0BSD,
WTFPL, CC-BY-4.0, Python-2.0). **Aucune** licence copyleft, SSPL, BUSL ou « non
commercial » parmi elles. Toutes sont compatibles avec l'AGPL-3.0 : elles peuvent
être redistribuées à l'intérieur d'un ensemble sous AGPL, chacune gardant sa
propre licence et sa mention de droits.

Ce relevé se refait en une commande, et devrait l'être avant chaque version :

```bash
node -e "const fs=require('fs'),p=require('path');const c={};for(const d of fs.readdirSync('node_modules')){const l=d.startsWith('@')?fs.readdirSync(p.join('node_modules',d)).map(x=>p.join(d,x)):[d];for(const n of l){try{const m=JSON.parse(fs.readFileSync(p.join('node_modules',n,'package.json'),'utf8'));const s=typeof m.license==='string'?m.license:(m.license||{}).type||'(absente)';c[s]=(c[s]||0)+1;if(/AGPL|SSPL|BUSL|CC-BY-NC|Commons-Clause/i.test(s))console.log('À VÉRIFIER',n,s);}catch{}}}console.log(c)"
```

Deux programmes extérieurs que HelixAI lance sans les inclure, et dont les
conditions restent celles de leurs éditeurs : **LM Studio** (propriétaire,
gratuit pour un usage interne, voir PROJET.md § 3.9) et **OpenCode** (MIT).
Les **poids des modèles** ont chacun leur propre licence, indépendante de
celle-ci.
