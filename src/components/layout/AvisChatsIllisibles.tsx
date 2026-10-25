import { useEffect, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { GRAND_CHANGE, incidentsGrand, type EtatReleve, type IncidentGrand, type RaisonIllisible } from "@/lib/store/grandStockage";
import { t, tf } from "@/lib/i18n";

/**
 * Bandeau « le fichier des Chats de cet ordinateur n'a pas pu être lu ».
 *
 * Jusqu'au 25/09/2026, ce cas ne se voyait pas : le fichier illisible était
 * mis de côté (`sessions.<date>.illisible.enc`, electron/grandStockage.cjs),
 * rien n'était poussé vers l'instance (sync.ts), et les Chats réapparaissaient
 * une fois l'instance relue, sans que rien ne dise pourquoi la liste avait été
 * vide. Le bandeau dit ce qui s'est passé, que rien n'est perdu et où, ce qui
 * va se passer, et ce que la personne peut faire. Il ne dit que ce qui est
 * constaté : si l'instance n'a pas pu être relue, il le dit, il ne promet pas
 * le retour des Chats.
 *
 * Fermé, il reste fermé tant que la situation ne change pas ; il revient
 * quand elle change (l'instance a rendu les Chats, par exemple).
 */

const CE_QUI_S_EST_PASSE: Record<RaisonIllisible, () => string> = {
  chiffrement: () => t("Le système n'a pas donné accès au trousseau qui le déchiffre (accès refusé, ou trousseau verrouillé)."),
  dechiffrement: () => t("Le trousseau a répondu, mais ce fichier ne se déchiffre pas : la clé a changé, ou le fichier est abîmé."),
  lecture: () => t("Le fichier lui-même n'a pas pu être ouvert (droits du dossier, disque)."),
};

const CE_QUE_VOUS_POUVEZ_FAIRE: Record<RaisonIllisible, () => string> = {
  chiffrement: () =>
    t("Ce que vous pouvez faire : redémarrer l'application et autoriser l'accès au trousseau quand le système le demande (ou le déverrouiller). Si le message revient, contactez votre administrateur."),
  dechiffrement: () =>
    t("Ce que vous pouvez faire : garder la copie et redémarrer l'application une fois. Si le message revient, contactez votre administrateur avant de supprimer quoi que ce soit."),
  lecture: () => t("Ce que vous pouvez faire : redémarrer l'application. Si le message revient, contactez votre administrateur (droits du dossier)."),
};

function ceQuiVaSePasser(etat: EtatReleve, nombre: number | undefined): string {
  switch (etat) {
    case "relue":
      return nombre === undefined
        ? t("L'instance a rendu vos Chats : ils sont de nouveau sur cet ordinateur.")
        : tf("L'instance a rendu vos Chats ({0}) : ils sont de nouveau sur cet ordinateur.", nombre);
    case "absente":
      return t("L'instance n'a aucun Chat enregistré : ils ne peuvent pas revenir d'elle. Tant que ce message est là, les Chats ouverts ici ne lui sont pas envoyés.");
    case "echec":
      return t("L'instance n'a pas pu être relue pour l'instant : vos Chats ne sont pas encore revenus. Cet ordinateur réessaie tout seul ; en attendant, les Chats ouverts ici ne lui sont pas envoyés.");
    case "hors-ligne":
      return t("L'instance n'est pas joignable : vos Chats reviendront d'elle au prochain démarrage où elle répondra. En attendant, les Chats ouverts ici ne lui sont pas envoyés et risquent de ne pas être gardés.");
    case "place":
      return t("L'instance a rendu vos Chats, mais cet ordinateur n'a pas pu les garder : son stockage est plein. Ils restent intacts sur l'instance.");
    default:
      return t("Vos Chats vont revenir depuis l'instance : elle est en cours de relecture.");
  }
}

function rienNEstPerdu(incident: IncidentGrand, relue: boolean): string {
  if (incident.copie) {
    return relue
      ? t("Rien n'a été effacé : une copie du fichier est gardée telle quelle.")
      : t("Rien n'a été effacé : une copie du fichier est gardée telle quelle, et cet ordinateur n'envoie rien à l'instance tant qu'elle ne lui a pas rendu vos Chats.");
  }
  return relue
    ? t("Rien n'a été effacé : le fichier est laissé tel quel, et cet ordinateur n'écrit pas par-dessus.")
    : t("Rien n'a été effacé : le fichier est laissé tel quel, cet ordinateur n'écrit pas par-dessus, et n'envoie rien à l'instance tant qu'elle ne lui a pas rendu vos Chats.");
}

const CLE_FERME = "oxoai:avis-chats-illisibles";

function lireFermes(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(CLE_FERME) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function AvisChatsIllisibles() {
  const [etat, setEtat] = useState(() => incidentsGrand().filter((i) => i.cle === "sessions"));
  const [fermes, setFermes] = useState<string[]>(lireFermes);

  useEffect(() => {
    const maj = () => setEtat(incidentsGrand().filter((i) => i.cle === "sessions"));
    window.addEventListener(GRAND_CHANGE, maj);
    maj();
    return () => window.removeEventListener(GRAND_CHANGE, maj);
  }, []);

  const visibles = etat.filter((i) => !fermes.includes(`${i.cle}:${i.releve.etat}`));
  if (visibles.length === 0) return null;

  const fermer = (cle: string) => {
    const suite = [...fermes, cle];
    setFermes(suite);
    try {
      sessionStorage.setItem(CLE_FERME, JSON.stringify(suite));
    } catch {
      /* stockage indisponible : fermé pour cette fenêtre seulement */
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-4 top-8 z-30 flex justify-center">
      {visibles.map(({ cle, incident, releve }) => {
        const garde = incident.copie ?? incident.fichier;
        const relue = releve.etat === "relue";
        return (
          <div
            key={cle}
            role="status"
            className="pointer-events-auto flex w-full max-w-3xl gap-3 rounded-xl border border-warning/30 bg-card p-4 text-sm text-foreground shadow-lg"
          >
            <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="font-medium">
                {relue ? t("Vos Chats sont revenus depuis l'instance") : t("Le fichier des Chats de cet ordinateur n'a pas pu être lu au démarrage")}
              </p>
              <p className="text-muted-foreground">{CE_QUI_S_EST_PASSE[incident.raison]()}</p>
              <p className="text-muted-foreground">
                {rienNEstPerdu(incident, relue)}
                {garde && (
                  <>
                    {" "}
                    <span className="break-all font-mono text-xs">{garde}</span>
                  </>
                )}
              </p>
              <p className="text-muted-foreground">{ceQuiVaSePasser(releve.etat, releve.nombre)}</p>
              {relue && (
                <p className="text-muted-foreground">
                  {t("Ceux qui n'étaient que sur cet ordinateur, jamais envoyés à l'instance, ne sont que dans le fichier gardé.")}
                </p>
              )}
              <p className="text-muted-foreground">{CE_QUE_VOUS_POUVEZ_FAIRE[incident.raison]()}</p>
            </div>
            <button
              type="button"
              aria-label={t("Fermer")}
              onClick={() => fermer(`${cle}:${releve.etat}`)}
              className="h-fit shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X size={15} strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
