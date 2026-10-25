import { useCallback, useEffect, useState } from "react";
import { Wrench } from "lucide-react";
import { InfoBox } from "@/components/ui/InfoBox";
import { Button } from "@/components/ui/Button";
import { outils as lireOutils, CONNECTEURS_CHANGE } from "@/lib/connecteurs";
import { t, tf } from "@/lib/i18n";

/**
 * Une ligne sous la zone de saisie : des services sont branchés, mais les
 * outils du Chat sont éteints.
 *
 * Vu le 28/09/2026 (tournée des connecteurs) : l'interrupteur « Outils » est
 * éteint par défaut, et l'écran Connecteurs promet que le service « ajoute ses
 * outils à vos agents, dans le Chat ». Quelqu'un qui branche Stripe puis
 * demande ses paiements n'obtenait rien. Décision de Medhi : le choix reste à
 * la personne (l'interrupteur n'est pas allumé à sa place), mais le Chat le
 * lui dit, avec le bouton qui allume.
 *
 * « Plus tard » masque la ligne pour cette liste de services, sur ce poste
 * seulement ; un service branché ensuite la fait revenir.
 */
const CLE_MASQUEE = "oxoai.inviteOutils.masquee";

function lireMasquee(): string | null {
  try {
    return localStorage.getItem(CLE_MASQUEE);
  } catch {
    return null;
  }
}

export function InviteOutils({
  actif,
  autorise,
  onAllumer,
}: {
  /** Les outils sont-ils déjà allumés pour ce Chat ? */
  actif: boolean;
  /** L'agent choisi a-t-il droit aux outils ? */
  autorise: boolean;
  onAllumer: () => void;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [masquee, setMasquee] = useState<string | null>(lireMasquee);

  const recharger = useCallback(() => {
    void lireOutils().then((groupes) => {
      // Instance muette : rien à dire, plutôt qu'une liste vide prise pour « aucun service ».
      if (!groupes) return;
      setBranches(groupes.filter((g) => g.branche && g.actif).map((g) => g.label));
    });
  }, []);

  useEffect(() => {
    if (actif || !autorise) return;
    recharger();
    window.addEventListener(CONNECTEURS_CHANGE, recharger);
    return () => window.removeEventListener(CONNECTEURS_CHANGE, recharger);
  }, [actif, autorise, recharger]);

  const signature = [...branches].sort().join("|");
  if (actif || !autorise || branches.length === 0 || masquee === signature) return null;

  // « Connecteur branché : … » plutôt que « … est branché » : le nom d'un service n'a pas de genre connu (« Mémoire de travail est branché »).
  const noms =
    branches.length === 1
      ? tf("Connecteur branché : {0}.", branches[0]!)
      : branches.length === 2
        ? tf("Connecteurs branchés : {0} et {1}.", branches[0]!, branches[1]!)
        : branches.length === 3
          ? // Trois : les trois noms, plutôt que « et 1 autres » (relecture du 28/09/2026).
            tf("Connecteurs branchés : {0}, {1} et {2}.", branches[0]!, branches[1]!, branches[2]!)
          : tf("Connecteurs branchés : {0}, {1} et {2} autres.", branches[0]!, branches[1]!, branches.length - 2);

  return (
    <InfoBox tone="muted" className="mt-2" leading={<Wrench size={15} strokeWidth={1.75} />}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1">
          {noms} {t("Les outils de ce Chat sont éteints : il ne peut pas s'en servir.")}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={onAllumer}>
            {t("Allumer les outils")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMasquee(signature);
              try {
                localStorage.setItem(CLE_MASQUEE, signature);
              } catch {
                /* stockage refusé : la ligne reviendra au prochain chargement */
              }
            }}
          >
            {t("Plus tard")}
          </Button>
        </span>
      </div>
    </InfoBox>
  );
}

export default InviteOutils;
