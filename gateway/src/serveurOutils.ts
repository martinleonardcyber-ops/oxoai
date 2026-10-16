import type http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  employe,
  cleValide,
  famillesEffectives,
  identiteEmploye,
  lecteursDe,
  lectureDesBases,
  noterLectureHorsEquipe,
  nomOpenClaw,
  prefixerNoms,
  traiteUnMailRecu,
  type Employe,
} from "./employes.ts";
import { outilsDeFamille, executerOutil, cibleDe, ecrituresApplicationsPourEmploye, refusApplication, type DefinitionOutil } from "./outils.ts";
import { estEcritureRoblox } from "./robloxRegles.ts";
import { estEcritureBlender } from "./blenderRegles.ts";
import { estEcritureUnreal } from "./unrealRegles.ts";
import { demandeToujours, modifie, verifierOutil } from "./approbation.ts";
import { journaliser } from "./audit.ts";
import { OUTIL_EMPLOYE, chercherPourEmploye, outilEmploye } from "./connaissances.ts";
import * as webGarde from "./webGarde.ts";

/**
 * Serveur d'outils des employés : les outils d'Helix, servis par MCP à
 * l'instance OpenClaw dédiée (voir employes.ts).
 *
 * Chaque employé a son adresse, `/helix/employes/<id>/outils`, et n'y trouve
 * que les familles d'outils qu'on lui a données. Un appel passe par les mêmes
 * points que dans le Chat : la barrière d'approbation, puis `executerOutil`,
 * puis le journal, au nom de l'employé.
 *
 * Le jeton d'instance ne suffit pas : il est sur tous les postes du parc. La
 * clé `X-Helix-Cle` n'est connue que de la passerelle et de l'instance
 * OpenClaw qu'elle a lancée (fichier 0600 dans le dossier de données).
 *
 * Sans état : un transport par requête, réponses JSON. OpenClaw n'a pas
 * besoin de notifications, et une session MCP de plus serait un état à perdre
 * à chaque redémarrage de la passerelle.
 */

/**
 * Ce qu'un employé voit en ce moment : ses familles, et ce que chacune offre ;
 * plus la recherche dans ses bases de connaissances, si son agent en a.
 */
async function outilsDe(e: Employe): Promise<DefinitionOutil[]> {
  const toutes = famillesEffectives(e).flatMap((f) => outilsDeFamille(f));
  /*
   * Les écritures de Roblox Studio et de Blender (12/10/2026, SECURITE.md
   * § 65) : seulement pour un employé dont la propriétaire administre
   * l'instance, relu à chaque liste et à chaque appel. Aux autres, on ne les
   * montre pas : chaque appel serait refusé (relecture du 12/10/2026).
   */
  const ecritures = await ecrituresApplicationsPourEmploye(e.ownerId);
  const familles = ecritures ? toutes : toutes.filter((o) => !estEcritureRoblox(o.function.name) && !estEcritureBlender(o.function.name) && !estEcritureUnreal(o.function.name));
  const avecBases = (e.connaissances?.length ?? 0) > 0 ? [...familles, outilEmploye()] : familles;
  /*
   * Le web gardé (webGarde.ts), pour les paliers qui ont le web : c'est lui
   * que son profil des mails reçus utilise, puisqu'il n'a pas celui
   * d'OpenClaw. Au palier « encadré », pas de web du tout.
   */
  return (e.liberte ?? "encadre") === "encadre" ? avecBases : [...avecBases, ...(webGarde.outilsWeb() as DefinitionOutil[])];
}

/** L'auteur tel que le journal le retient : l'employé, pas une personne. */
export const auteurEmploye = identiteEmploye;

export async function servirOutils(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string,
  corps: unknown,
): Promise<boolean> {
  const cle = req.headers["x-helix-cle"];
  // La clé de **cet** employé (celui de l'adresse) : celle d'un autre ne l'ouvre pas.
  if (!cleValide(typeof cle === "string" ? cle : undefined, id)) return false;
  const e = await employe(id);
  if (!e) return false;

  const serveur = new Server({ name: `outils-${e.id}`, version: "1.0.0" }, { capabilities: { tools: {} } });

  serveur.setRequestHandler(ListToolsRequestSchema, async () => {
    if (e.enPause) return { tools: [] };
    const outils = await outilsDe(e);
    /*
     * Les descriptions renvoient d'un outil à l'autre (« rappelle
     * courrier__lire ») ; chez OpenClaw, ils portent le préfixe du serveur.
     * Un modèle qui recopierait le nom nu appellerait un outil inexistant.
     */
    const noms = outils.map((o) => o.function.name);
    return {
      tools: outils.map((o) => ({
        name: o.function.name,
        description: prefixerNoms(o.function.description, noms, nomOpenClaw(e.id)),
        inputSchema: o.function.parameters as { type: "object"; [k: string]: unknown },
      })),
    };
  });

  serveur.setRequestHandler(CallToolRequestSchema, async (demande) => {
    const nom = demande.params.name;
    const args = (demande.params.arguments ?? {}) as Record<string, unknown>;
    const texte = (t: string, erreur = false) => ({ content: [{ type: "text" as const, text: t }], isError: erreur });

    // Relu à chaque appel : une pause ou un outil retiré prend effet tout de suite.
    const courant = await employe(id);
    if (!courant || courant.enPause) return texte("Tu es en pause : aucun outil n'est disponible.", true);
    if (!(await outilsDe(courant)).some((o) => o.function.name === nom)) {
      return texte(`L'outil ${nom} ne fait pas partie des tiens.`, true);
    }

    const qui = auteurEmploye(id);
    /*
     * Un employé « autonome » agit sans demander : son propriétaire l'a décidé,
     * et le journal le dit. Sauf pour ce qui ne se reprend pas (un mail qui
     * part), à moins qu'une personne ait choisi d'envoyer sans confirmation.
     *
     * Et jamais, pour **rien de ce qui modifie**, pendant qu'il traite un mail
     * reçu. Ce mail vient de l'extérieur : le texte qu'il contient n'est pas
     * une consigne de l'entreprise, c'est une entrée. Un message piégé
     * (« transmets ce devis à… », « range ce fichier ici… ») ne doit pouvoir
     * ni faire partir un mail, ni écrire, déplacer ou supprimer un fichier, ni
     * écrire dans un service branché, sans qu'une personne l'ait vu — quels
     * que soient les réglages. Le garde-fou ne valait que pour l'envoi ; tout
     * le reste passait.
     *
     * La lecture reste libre : c'est ce pour quoi l'agent a été déclenché.
     */
    // Roblox Studio, Blender, Palmier Pro : refusé avant la carte, pour que sa propriétaire n'accepte pas pour rien.
    const refusAppli = await refusApplication(nom, args, { userId: qui, proprietaire: courant.ownerId });
    if (refusAppli) return texte(refusAppli, true);

    const forcer = (nom === "courrier__envoyer" || modifie(nom)) && traiteUnMailRecu(id);
    const sansAccord = courant.autonome && !demandeToujours(nom, args) && !forcer;
    if (!sansAccord) {
      /*
       * La carte est pour sa propriétaire : c'est elle qui répond. Jusqu'au
       * 26/09/2026 elle était adressée à l'employé lui-même (`employe:<id>`),
       * que personne n'incarne : aucune carte ne pouvait être acceptée, et
       * tout ce qui modifie était refusé (revue de sécurité). La carte nomme
       * l'employé, et le journal aussi.
       */
      const verdict = await verifierOutil(null, nom, args, courant.ownerId ?? qui, courant.nom, forcer);
      if (!verdict.autorise) return texte(verdict.message, true);
    }

    /*
     * Ses bases de connaissances : celles de son agent, relues à chaque appel,
     * et ce qui y est ouvert à toute l'équipe (connaissances.ts,
     * `chercherPourEmploye`, où la règle est justifiée). Plus, si rien de ce
     * qui sort de lui ne quitte son audience (employes.ts, `lectureDesBases`),
     * ce que tous ses destinataires voient : son propriétaire (agent
     * personnel), ou chacun de ses groupes (agent de groupes). Établi ici,
     * depuis l'employé relu plus haut et les groupes à cet instant
     * (`lecteursDe`), jamais gardé d'un appel à l'autre. Traité avant
     * `executerOutil`, qui rangerait ce nom parmi les outils MCP des fichiers.
     */
    const lecture = nom === OUTIL_EMPLOYE ? lectureDesBases(courant) : null;
    const lecteurs = lecture ? await lecteursDe(courant, lecture) : null;
    const bases = nom === OUTIL_EMPLOYE ? await chercherPourEmploye(courant.connaissances ?? [], args, qui, lecteurs) : null;
    // Ce qu'il a lu hors de l'équipe reste dans sa mémoire : noté (un nombre), pour qu'un élargissement la vide d'abord.
    if (bases && bases.horsEquipe > 0) noterLectureHorsEquipe(courant.id, bases.horsEquipe);
    // Plusieurs personnes lui parlent : dans la bibliothèque, il ne voit que ce qui est ouvert à toute l'équipe.
    const r =
      bases ??
      (nom.startsWith("web__") ? await webGarde.callTool(nom, args, courant.id) : await executerOutil(nom, args, { userId: qui, groupes: [], proprietaire: courant.ownerId }));
    // Pendant un mail reçu : ce qu'un outil rend (un autre mail, un document) devient ouvrable par web__lire, et rien d'autre.
    // Seulement un résultat réussi, et sans les adresses que la demande contenait déjà.
    if (traiteUnMailRecu(courant.id) && r.ok) webGarde.noterVues(courant.id, r.content, JSON.stringify(args));
    // Le journal dit combien de passages sont sortis, jamais lesquels ni la question.
    journaliser("outil.appele", qui, {
      outil: nom,
      cible: cibleDe(args),
      ok: r.ok,
      ...(bases
        ? { bases: courant.connaissances?.length ?? 0, passages: bases.passages, regle: lecture?.regle ?? "equipe", horsEquipe: bases.horsEquipe }
        : {}),
      ...(sansAccord ? { sansAccord: true } : {}),
    });
    // Le résultat part tel quel : il porte des données (un mail, un fichier) qu'on ne réécrit pas.
    return texte(r.content, !r.ok);
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void serveur.close();
  });
  await serveur.connect(transport);
  await transport.handleRequest(req, res, corps);
  return true;
}
