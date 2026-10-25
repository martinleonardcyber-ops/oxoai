import { t } from "./langue.ts";
import type { Niveau } from "./approbation.ts";

/**
 * Codex dans l'écran Code : ce qui se décide sans lancer aucun programme.
 *
 * Décidé par Medhi le 27/09/2026 (PROJET.md § 3.14) : l'écran Code peut
 * travailler avec le programme `codex` officiel d'OpenAI, installé et connecté
 * par la personne elle-même, pour elle seule. Trois décisions tiennent ici,
 * à part de `codex.ts` qui lance les processus, pour que la batterie de
 * sécurité les vérifie une à une sans rien démarrer :
 *
 *  1. **qui** peut s'en servir (`refusCodex`) : le propriétaire du poste, sur
 *     une installation de bureau, et personne d'autre ;
 *  2. **quel bac à sable** Codex reçoit (`bacASable`), jamais plus large que le
 *     niveau d'approbation de OxoAI ;
 *  3. **comment son flux se lit** (`traduireCodex`) : les lignes JSON de
 *     `codex exec --json` deviennent les évènements de l'écran Code.
 */

/* ------------------------------------------------------------------ */
/* Qui                                                                 */
/* ------------------------------------------------------------------ */

/** Ce que la passerelle sait de la requête, vérifié par elle (index.ts). */
export interface ContexteCodex {
  /** La passerelle a été lancée par l'application de bureau (`OXOAI_BUREAU`, electron/main.cjs). */
  bureau: boolean;
  /** Instance ouverte aux collègues (`share`, ou écoute sur le réseau). */
  partagee: boolean;
  /** La requête arrive par la boucle locale, depuis la machine elle-même. */
  depuisCePoste: boolean;
  /** Jeton d'instance, de séance ou billet de flux posé dans l'adresse. */
  jetonsDansAdresse: boolean;
  /** Requête faite avec une clé de l'API développeur (clesApi.ts). */
  parCleApi: boolean;
  /** Le compte administre l'instance (roles.ts : sur un poste autonome, celui qui l'a mise en route). */
  administrateur: boolean;
}

export type CodeRefusCodex = "cle" | "adresse" | "bureau" | "partagee" | "distant" | "membre";

/**
 * Pourquoi Codex est refusé, ou `null` s'il est permis.
 *
 * La connexion de `codex` appartient au compte système qui fait tourner la
 * passerelle : s'en servir engage l'abonnement ChatGPT de cette personne, et
 * les conditions d'OpenAI interdisent de le mettre à la disposition d'autrui.
 * Chaque barrière ferme une façon précise d'y arriver quand même :
 *
 *  - une clé de l'API développeur (§ 3.13) : elle n'ouvre déjà que `/v1/*`,
 *    on le redit ici pour qu'un élargissement futur ne l'oublie pas ;
 *  - des jetons dans l'adresse : l'écran les pose en en-têtes ; un lien ou un
 *    script lancé sur la machine (le bash de l'agent de code, un employé
 *    OpenClaw) qui passerait par `?session=` est écarté, comme pour l'import
 *    depuis les logiciels du poste (revue du 25/09/2026) ;
 *  - hors installation de bureau : une passerelle lancée à la main sur un
 *    serveur n'est pas « le poste de quelqu'un » ;
 *  - instance partagée : l'abonnement serait celui du serveur, servi à tous ;
 *  - requête venue du réseau : un poste rattaché parle à une instance
 *    distante, dont le `codex` n'est pas celui de la personne ;
 *  - un membre : seul l'administrateur de l'instance locale en est le
 *    propriétaire.
 *
 * Un employé OpenClaw ou une tâche programmée n'ont pas de séance et ne
 * passent par aucune de ces routes : Codex n'est pas un outil qu'on leur
 * donne (il n'apparaît ni dans outilsCode.ts ni dans les outils du Chat).
 */
export function refusCodex(c: ContexteCodex): { code: CodeRefusCodex; message: string } | null {
  if (c.parCleApi) return { code: "cle", message: t("Une clé d'API ne donne pas accès à Codex : il est réservé au propriétaire du poste, depuis l'application.") };
  if (c.jetonsDansAdresse) return { code: "adresse", message: t("Jetons en en-têtes seulement pour cette route, jamais dans l'adresse.") };
  if (!c.bureau) return { code: "bureau", message: t("Codex n'est proposé que dans l'application de bureau, sur le poste de la personne dont c'est le compte ChatGPT.") };
  if (c.partagee) return { code: "partagee", message: t("Codex est fermé sur une instance ouverte aux collègues : l'abonnement ChatGPT connecté sur cette machine servirait à d'autres, ce que les conditions d'OpenAI interdisent.") };
  if (!c.depuisCePoste) return { code: "distant", message: t("Codex se lance sur le poste de la personne, pas depuis un poste rattaché à une instance distante.") };
  if (!c.administrateur) return { code: "membre", message: t("Codex est réservé au propriétaire de ce poste (la personne qui administre cette instance).") };
  return null;
}

/* ------------------------------------------------------------------ */
/* Bac à sable                                                         */
/* ------------------------------------------------------------------ */

export type BacCodex = "read-only" | "workspace-write";

/**
 * Le bac à sable passé à Codex pour un niveau d'approbation de OxoAI, ou
 * `null` quand aucun n'est assez strict.
 *
 * `codex exec` ne demande jamais rien : il fixe `approval_policy = never`
 * (lu dans codex-rs/exec/src/lib.rs, « Default to never ask for approvals in
 * headless mode », 27/09/2026). Ce qu'il fait lui-même, ses commandes et ses
 * modifications, ne passe donc par aucune carte de OxoAI : seul son bac à
 * sable le borne. D'où une correspondance qui ne prête jamais plus que OxoAI :
 *
 *  - « tout » (l'agent agit seul) : `workspace-write`, écriture dans le
 *    dossier du projet, réseau des commandes coupé ;
 *  - « modifications » (OxoAI demande avant d'écrire) : `read-only`. Codex ne
 *    sachant pas demander, il ne peut pas écrire du tout ;
 *  - « chaque » (OxoAI demande avant chaque action, lecture comprise) : rien.
 *    Codex lit sans demander ; le proposer à ce niveau le trahirait.
 *
 * `danger-full-access` n'est jamais passé, quel que soit le niveau.
 */
export function bacASable(niveau: Niveau): BacCodex | null {
  if (niveau === "tout") return "workspace-write";
  if (niveau === "modifications") return "read-only";
  return null;
}

/**
 * Arguments de réglage communs à une tâche neuve et à une reprise.
 *
 * Par `-c` et non par `--sandbox` : `codex exec resume` refuse `-s/--sandbox`,
 * et une reprise sans réglage retombait sur `workspace-write` même quand la
 * session avait été ouverte en lecture seule ; `-c sandbox_mode=…` est, lui,
 * respecté par les deux (openai/codex, ticket #40149, 22/08/2026, relevé le
 * 27/09/2026). Le réseau des commandes est coupé explicitement plutôt que
 * laissé au défaut.
 */
export function reglagesCodex(bac: BacCodex): string[] {
  return [
    "-c", `sandbox_mode="${bac}"`,
    "-c", `approval_policy="never"`,
    "-c", "sandbox_workspace_write.network_access=false",
  ];
}

/** Identifiant de session de Codex (`thread_id`) : un UUID, rien d'autre ne part en argument. */
export const SESSION_CODEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Arguments de `codex` pour une tâche. La demande part sur l'entrée standard
 * (`-`) : jamais dans la ligne de commande, que tout compte du poste peut lire
 * (`ps`), et sans limite de longueur.
 */
export function argumentsTache(bac: BacCodex, session?: string): string[] {
  const communs = ["exec", "--json", "--skip-git-repo-check"];
  if (session) {
    if (!SESSION_CODEX.test(session)) throw new Error("session Codex invalide");
    return [...communs, "resume", ...reglagesCodex(bac), session, "-"];
  }
  return [...communs, "--sandbox", bac, ...reglagesCodex(bac), "-"];
}

/* ------------------------------------------------------------------ */
/* Ce qui ressemble à un secret                                        */
/* ------------------------------------------------------------------ */

/**
 * Masque ce qui ressemble à une clé ou à un jeton dans un texte rendu par
 * `codex` (état de connexion, message d'erreur). `codex login status` masque
 * déjà une clé d'API ; on ne s'y fie pas.
 */
export function masquer(texte: string): string {
  return texte
    .replace(/\b(sk|rk|sess)-[A-Za-z0-9_\-]{6,}/g, "[masqué]")
    .replace(/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[masqué]")
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, "[masqué]");
}

/* ------------------------------------------------------------------ */
/* Le flux de Codex, dans la langue de l'écran Code                    */
/* ------------------------------------------------------------------ */

/**
 * Évènements rendus à l'écran. Les mêmes noms que `CodeEvent`
 * (src/lib/code.ts), pour que le suivi et les messages de l'écran Code s'y
 * appliquent tels quels ; plus `session` (l'identifiant pour reprendre) et
 * `usage` (la consommation que Codex annonce, décomptée sur l'abonnement).
 */
export type EvenementCodex =
  | { kind: "session"; id: string }
  | { kind: "etape" }
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_start"; callID: string; tool: string; input: Record<string, unknown> }
  | { kind: "tool_end"; callID: string; ok: boolean; preview: string }
  | { kind: "statut"; text: string }
  | { kind: "usage"; entree: number; sortie: number; cache: number; raisonnement: number }
  | { kind: "error"; message: string }
  | { kind: "fin"; note: string }
  | { kind: "done" };

/** Ce qu'il faut retenir d'une ligne à l'autre : les éléments déjà annoncés, les listes de tâches. */
export interface EtatTraduction {
  commences: Set<string>;
  listes: number;
}

export const etatTraduction = (): EtatTraduction => ({ commences: new Set(), listes: 0 });

const APERCU_MAX = 4000;
const texte = (v: unknown): string => (typeof v === "string" ? v : "");
const nombre = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** La fin d'une sortie : c'est là que sont l'erreur et le résultat. */
const fin = (s: string): string => (s.length > APERCU_MAX ? `…${s.slice(-APERCU_MAX)}` : s);

/**
 * Le nom d'outil de l'écran Code pour un changement de fichier de Codex
 * (`add`, `update`, `delete`) : le suivi range ainsi le fichier parmi les
 * écrits ou les modifiés (src/lib/suiviCode.ts, `ACTIONS_FICHIER`).
 */
const outilFichier = (genre: string): string => (genre === "add" ? "write" : genre === "update" ? "edit" : "apply_patch");

/**
 * Traduit une ligne du flux de `codex exec --json`. Schéma relu le 27/09/2026
 * dans codex-rs/exec/src/exec_events.rs et la page « Non-interactive mode » :
 * `thread.started` (`thread_id`), `turn.started`, `item.started`,
 * `item.updated`, `item.completed` (`item` : `id`, `type` et ses champs),
 * `turn.completed` (`usage`), `turn.failed` (`error.message`), `error`
 * (`message`). Une ligne inconnue ne rend rien : une version plus récente de
 * Codex n'arrête pas l'écran.
 */
export function traduireCodex(brut: unknown, etat: EtatTraduction): EvenementCodex[] {
  const e = (brut ?? {}) as Record<string, unknown>;
  const type = texte(e.type);

  if (type === "thread.started") {
    const id = texte(e.thread_id);
    return SESSION_CODEX.test(id) ? [{ kind: "session", id }] : [];
  }
  if (type === "turn.started") return [{ kind: "etape" }];
  if (type === "turn.completed") {
    const u = (e.usage ?? {}) as Record<string, unknown>;
    return [
      { kind: "usage", entree: nombre(u.input_tokens), sortie: nombre(u.output_tokens), cache: nombre(u.cached_input_tokens), raisonnement: nombre(u.reasoning_output_tokens) },
      { kind: "done" },
    ];
  }
  if (type === "turn.failed") {
    const message = texte((e.error as Record<string, unknown> | undefined)?.message);
    return [{ kind: "error", message: masquer(message) || t("Codex a échoué sans dire pourquoi.") }];
  }
  if (type === "error") return [{ kind: "error", message: masquer(texte(e.message)) || t("Codex a échoué sans dire pourquoi.") }];

  if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") return [];
  const item = (e.item ?? {}) as Record<string, unknown>;
  const id = texte(item.id) || "element";
  const fini = type === "item.completed";
  const deja = etat.commences.has(id);

  switch (texte(item.type)) {
    case "agent_message":
      return fini && texte(item.text).trim() ? [{ kind: "text", text: texte(item.text) }] : [];
    case "reasoning":
      return fini && texte(item.text).trim() ? [{ kind: "reasoning", text: texte(item.text) }] : [];
    case "command_execution": {
      const sortie: EvenementCodex[] = [];
      if (!deja) {
        etat.commences.add(id);
        sortie.push({ kind: "tool_start", callID: id, tool: "bash", input: { command: texte(item.command) } });
      }
      if (fini) {
        const statut = texte(item.status);
        const ok = statut === "completed" && (item.exit_code === undefined || item.exit_code === null || item.exit_code === 0);
        const apercu = statut === "declined" ? t("Commande refusée par le bac à sable de Codex.") : fin(texte(item.aggregated_output));
        sortie.push({ kind: "tool_end", callID: id, ok, preview: apercu });
      }
      return sortie;
    }
    case "file_change": {
      // Un changement par fichier : c'est ainsi que le suivi les compte.
      const changements = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]).slice(0, 200) : [];
      const sortie: EvenementCodex[] = [];
      changements.forEach((c, i) => {
        const callID = `${id}:${i}`;
        if (!etat.commences.has(callID)) {
          etat.commences.add(callID);
          sortie.push({ kind: "tool_start", callID, tool: outilFichier(texte(c.kind)), input: { filePath: texte(c.path) } });
        }
        if (fini) sortie.push({ kind: "tool_end", callID, ok: texte(item.status) !== "failed", preview: "" });
      });
      return sortie;
    }
    case "mcp_tool_call": {
      const sortie: EvenementCodex[] = [];
      if (!deja) {
        etat.commences.add(id);
        const args = item.arguments && typeof item.arguments === "object" ? (item.arguments as Record<string, unknown>) : {};
        sortie.push({ kind: "tool_start", callID: id, tool: `codex_${texte(item.server)}__${texte(item.tool)}`, input: args });
      }
      if (fini) {
        const erreur = texte((item.error as Record<string, unknown> | undefined)?.message);
        sortie.push({ kind: "tool_end", callID: id, ok: texte(item.status) === "completed", preview: fin(masquer(erreur)) });
      }
      return sortie;
    }
    case "web_search": {
      const sortie: EvenementCodex[] = [];
      if (!deja) {
        etat.commences.add(id);
        sortie.push({ kind: "tool_start", callID: id, tool: "websearch", input: { query: texte(item.query) } });
      }
      if (fini) sortie.push({ kind: "tool_end", callID: id, ok: true, preview: "" });
      return sortie;
    }
    case "todo_list": {
      // Chaque mise à jour de la liste est une trace : le suivi garde la dernière (`todowrite`).
      const lignes = Array.isArray(item.items) ? (item.items as Record<string, unknown>[]) : [];
      const callID = `${id}:liste:${etat.listes++}`;
      const todos = lignes.slice(0, 50).map((l) => ({ content: texte(l.text), status: l.completed === true ? "completed" : "pending" }));
      return [
        { kind: "tool_start", callID, tool: "todowrite", input: { todos } },
        { kind: "tool_end", callID, ok: true, preview: "" },
      ];
    }
    case "collab_tool_call": {
      const sortie: EvenementCodex[] = [];
      if (!deja) {
        etat.commences.add(id);
        const consigne = texte(item.prompt);
        sortie.push({ kind: "tool_start", callID: id, tool: "task", input: { description: consigne.split("\n")[0].slice(0, 80), prompt: consigne } });
      }
      if (fini) sortie.push({ kind: "tool_end", callID: id, ok: texte(item.status) !== "failed", preview: "" });
      return sortie;
    }
    case "error":
      return fini ? [{ kind: "statut", text: masquer(texte(item.message)) }] : [];
    default:
      return [];
  }
}
