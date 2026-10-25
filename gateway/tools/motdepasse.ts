/**
 * Redéfinir le mot de passe d'un compte OxoAI, depuis le poste.
 *
 * Il n'existe pas de « mot de passe oublié » par courriel : l'instance ne sait
 * pas envoyer de courrier, et n'a personne à qui le demander. La seule autorité
 * disponible est la possession de la machine et de son trousseau. C'est donc
 * l'outil local qui tient lieu de récupération.
 *
 * Depuis le 23/10/2026, l'application en offre trois autres voies, sans
 * terminal (« Mot de passe oublié ? » sur l'écran de connexion) : un
 * administrateur réinitialise le mot de passe d'un collègue, l'application
 * de bureau de la machine de l'instance fait reconnaître la session de
 * l'ordinateur et appelle la même fonction que cet outil
 * (`definirMotDePasse`), ou un code de récupération. Cet outil reste la voie
 * de dernier recours.
 *
 * Le mot de passe n'est jamais passé en argument de ligne de commande : il
 * resterait dans l'historique du terminal et dans la liste des processus, où
 * n'importe quel programme du poste peut le lire. Il est saisi sans écho.
 *
 * Il retire aussi la vérification en deux étapes d'un compte qui a perdu son
 * téléphone et ses codes de secours, et supprime le compte d'une personne qui
 * a quitté l'entreprise ou qui en fait la demande (RGPD, article 17) : même
 * autorité, même raison.
 *
 *   npm run motdepasse
 */

import { createInterface } from "node:readline";
import {
  publicAccounts,
  definirMotDePasse,
  retirerDeuxFacteurs,
  MOT_DE_PASSE_MIN,
} from "../src/accounts.ts";
import { apercuEffacement, effacerCompte } from "../src/effacement.ts";

/**
 * L'instance tourne-t-elle ? Une suppression faite pendant qu'elle tourne
 * serait défaite en partie : la passerelle garde en mémoire la consommation et
 * les séances, et les réécrirait par-dessus.
 */
async function instanceEnMarche(): Promise<boolean> {
  const port = Number(process.env.OXOAI_GATEWAY_PORT ?? 8787);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** La même règle que partout ailleurs dans l'instance. */
const MINIMUM = MOT_DE_PASSE_MIN;

const ENTREE = ["\r", "\n"];
const INTERRUPTION = "\u0003";
const EFFACEMENT = ["\u007f", "\b"];

/** Saisie sans écho : rien ne s'affiche, pas même des étoiles qui trahiraient la longueur. */
function demanderSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const entree = process.stdin;
    if (!entree.isTTY) {
      reject(new Error("Cet outil doit être lancé depuis un terminal."));
      return;
    }
    process.stdout.write(question);

    entree.setRawMode(true);
    entree.resume();
    entree.setEncoding("utf8");

    let saisi = "";
    const surTouche = (touche: string) => {
      if (ENTREE.includes(touche)) {
        entree.setRawMode(false);
        entree.pause();
        entree.off("data", surTouche);
        process.stdout.write("\n");
        resolve(saisi);
        return;
      }
      if (touche === INTERRUPTION) {
        entree.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (EFFACEMENT.includes(touche)) {
        saisi = saisi.slice(0, -1);
        return;
      }
      // Ignore les séquences de touches (flèches, touches de fonction).
      if (touche.charCodeAt(0) < 32) return;
      saisi += touche;
    };

    entree.on("data", surTouche);
  });
}

function demander(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (reponse) => {
      rl.close();
      resolve(reponse.trim());
    }),
  );
}

async function principal(): Promise<void> {
  const comptes = await publicAccounts();
  if (comptes.length === 0) {
    console.log("Aucun compte sur cette instance. Ouvrez OxoAI : le premier compte s'y crée.");
    return;
  }

  console.log("\nComptes de cette instance :\n");
  comptes.forEach((c, i) => console.log(`  ${i + 1}. ${c.fullName}  <${c.email}>`));
  console.log("");

  const choix =
    comptes.length === 1 ? "1" : await demander(`Lequel ? (1 à ${comptes.length}) `);

  const compte = comptes[Number(choix) - 1];
  if (!compte) {
    console.error("Choix invalide. Rien n'a été modifié.");
    process.exitCode = 1;
    return;
  }

  console.log(`\nQue faire pour ${compte.email} ?\n`);
  console.log("  1. Définir un nouveau mot de passe");
  if (compte.deuxFacteursActive) {
    console.log("  2. Retirer la vérification en deux étapes (téléphone et codes de secours perdus)");
  }
  console.log("  3. Supprimer ce compte et ses données\n");
  const action = await demander("Votre choix : ");

  if (action === "2" && compte.deuxFacteursActive) {
    const retrait = await retirerDeuxFacteurs(compte.id);
    if (!retrait.ok) {
      console.error(`\nÉchec : ${retrait.raison}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\nVérification en deux étapes retirée pour ${compte.email}.`);
    console.log("Le retrait est inscrit au journal d'audit. Réactivez-la depuis");
    console.log("Paramètres, Sécurité, une fois connecté avec le nouveau téléphone.\n");
    return;
  }

  if (action === "3") {
    if (await instanceEnMarche()) {
      console.error("\nL'application est ouverte : quittez-la d'abord, puis relancez cet outil.");
      console.error("Rien n'a été modifié.");
      process.exitCode = 1;
      return;
    }
    const apercu = await apercuEffacement(compte.id, compte.email);
    console.log("\nSeront supprimés :");
    console.log(`  - ${apercu.conversations} conversation(s), ${apercu.taches} tâche(s), ${apercu.agents} agent(s)`);
    console.log("  - le profil (instructions et mémoire), la consommation, les séances");
    if (apercu.projetsSupprimes.length > 0) {
      console.log(`  - les projets sans autre membre : ${apercu.projetsSupprimes.join(", ")}`);
    }
    for (const c of apercu.projetsConfies) console.log(`  Le projet « ${c.projet} » sera confié à ${c.a}.`);
    console.log("Le journal d'audit est conservé : il est scellé, et sert à établir qui a fait quoi.\n");
    const confirmation = await demander(`Pour confirmer, tapez l'adresse du compte (${compte.email}) : `);
    if (confirmation.trim().toLowerCase() !== compte.email.toLowerCase()) {
      console.error("\nL'adresse ne correspond pas. Rien n'a été supprimé.");
      process.exitCode = 1;
      return;
    }
    await effacerCompte(compte.id, compte.email, "outil local");
    console.log(`\nCompte ${compte.email} supprimé. La suppression est inscrite au journal d'audit.\n`);
    return;
  }

  if (action !== "1") {
    console.error("Choix invalide. Rien n'a été modifié.");
    process.exitCode = 1;
    return;
  }

  console.log(`\nNouveau mot de passe pour ${compte.email}.`);
  console.log("La saisie ne s'affiche pas. Ctrl+C pour abandonner.\n");

  const premier = await demanderSecret("Nouveau mot de passe : ");
  if (premier.length < MINIMUM) {
    console.error(`\nTrop court : ${MINIMUM} caractères au minimum. Rien n'a été modifié.`);
    process.exitCode = 1;
    return;
  }

  const second = await demanderSecret("Confirmez            : ");
  if (premier !== second) {
    console.error("\nLes deux saisies diffèrent. Rien n'a été modifié.");
    process.exitCode = 1;
    return;
  }

  const resultat = await definirMotDePasse(compte.id, premier);
  if (!resultat.ok) {
    console.error(`\nÉchec : ${resultat.raison}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nMot de passe redéfini pour ${compte.email}.`);
  console.log("Le changement est inscrit au journal d'audit.");
  console.log("Quittez OxoAI puis rouvrez-le pour vous connecter.\n");
}

principal().catch((err: unknown) => {
  console.error("\n" + (err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
