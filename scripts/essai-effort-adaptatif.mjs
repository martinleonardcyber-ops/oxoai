/**
 * Le niveau de réflexion « adaptatif » (gateway/src/effortAdaptatif.ts) :
 * pas de réflexion pour un « bonjour », de la réflexion pour un calcul.
 *
 *   node scripts/essai-effort-adaptatif.mjs
 */
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("..", import.meta.url));
const { choisirEffort } = await import(pathToFileURL(join(RACINE, "gateway", "src", "effortAdaptatif.ts")).href);

let echecs = 0;
const verifier = (attendu, texte, messages) => {
  const obtenu = choisirEffort(messages ?? [{ role: "user", content: texte }]);
  const ok = obtenu === attendu;
  if (!ok) echecs++;
  console.log(`${ok ? "✓" : "✗"} ${attendu.padEnd(6)} ${JSON.stringify(texte).slice(0, 70)}${ok ? "" : `  —  obtenu : ${obtenu}`}`);
};

for (const t of ["salut", "Bonjour !", "bonjour", "merci beaucoup !", "ok", "d'accord, merci", "ça va ?", "Salut, ça va ?", "hello 👋", "top merci", "bonne nuit", "thanks!"]) verifier("aucun", t);
for (const t of [
  "C'est quoi la capitale de l'Australie ?",
  "Traduis « bonne journée » en anglais",
  "Donne-moi un synonyme de rapide",
  "Écris un message d'anniversaire pour ma sœur",
  // Courtes : le modèle y répond juste sans réfléchir (mesuré avec Qwen 3.5 9B).
  "Combien font 17 × 23 ?",
  "Calcule la TVA sur 1 250 €",
  "Pourquoi le ciel est bleu ?",
  "Quelle est la différence entre un CDI et un CDD ?",
  "Rédige un court texte de présentation pour mon entreprise de jardinage à Lyon : nous faisons la taille des haies, la tonte et l'entretien des massifs, pour les particuliers et les copropriétés, avec un ton chaleureux et professionnel.",
]) verifier("aucun", t);
for (const t of [
  "Compare Python et JavaScript pour un débutant",
  "Corrige ce code :\n```js\nconst a = [1,2,3].map(x => x*2\n```",
  "J'ai une erreur TypeError: cannot read properties of undefined, tu peux m'aider ?",
  "Fais-moi un plan pour lancer ma boutique en ligne",
  "Explique étape par étape comment fonctionne un moteur de recherche",
  "Résous l'équation 2x + 5 = 17",
  "Analyze the pros and cons of remote work",
]) verifier("moyen", t);
verifier("moyen", "x".repeat(1300));
verifier("moyen", "J'ai un budget de 2 400 € par mois, un loyer de 850 €, 300 € de courses et un crédit auto de 210 €. Combien puis-je mettre de côté chaque mois si je veux garder 200 € de marge pour les imprévus ?");
verifier("faible", "Voici mes notes de réunion, mets-les au propre. " + "Nous avons parlé du site, du budget et du calendrier de lancement avec toute l'équipe. ".repeat(8));
// Le dernier message de la personne compte, pas l'historique.
verifier("aucun", "merci", [{ role: "user", content: "Calcule 12 × 7" }, { role: "assistant", content: "84" }, { role: "user", content: "merci" }]);
// Parties de message (texte et image).
verifier("faible", "(image seule)", [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:" } }] }]);
verifier("aucun", "(salut + image)", [{ role: "user", content: [{ type: "text", text: "salut" }, { type: "image_url", image_url: { url: "data:" } }] }]);
verifier("faible", "(rien)", []);

console.log(echecs ? `${echecs} échec(s)` : "tout est bon");
process.exit(echecs ? 1 : 0);
