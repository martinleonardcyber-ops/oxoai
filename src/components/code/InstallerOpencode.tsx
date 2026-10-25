import { useEffect, useRef, useState } from "react";
import { Download, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { InfoBox } from "@/components/ui/InfoBox";
import { branding } from "@/config/branding";
import { fetchCodeStatus, installerOpencode, type CodeStatus } from "@/lib/code";
import { t, tf } from "@/lib/i18n";
import { instance } from "@/lib/instance";
import { plateformePoste } from "@/lib/plateforme";

/**
 * L'écran Code sans son moteur : OxoAI pose OpenCode lui-même (demandé par
 * Medhi le 27/09/2026, « tout s'installe seul »). Version épinglée, empreinte
 * vérifiée (gateway/src/opencodePrive.ts).
 *
 * Sans clic depuis le 27/09/2026 (vu par Medhi sur un PC Windows : le bouton
 * restait une étape de plus). La passerelle le pose déjà en arrière-plan au
 * démarrage et après la mise en route du modèle (`opencodeEnFond`) ; si
 * l'écran trouve cette installation en cours, il la suit. Sinon, pour
 * l'administrateur, il la lance d'office à l'ouverture. Le bouton ne sert plus
 * qu'à réessayer après un échec, ou quand l'installation d'office n'a pas lieu :
 * profil de déploiement qui la réserve à l'intégrateur, ou poste rattaché (le
 * logiciel irait sur la machine de l'instance, pas sur celle-ci : on le laisse
 * décider). Un membre ne peut pas installer : on lui dit à qui s'adresser.
 */
export function InstallerOpencode({ status, onPret }: { status: CodeStatus; onPret: () => void }) {
  const [etat, setEtat] = useState(status);
  const [refus, setRefus] = useState<string | null>(null);
  const enCours = Boolean(etat.installation?.enCours);
  const administrateur = etat.administrateur === true;
  const rattache = instance().remote;
  const dOffice = administrateur && etat.installable !== false && etat.installationAuto !== false && !rattache;
  // Une seule tentative d'office par ouverture de l'écran ; ensuite, c'est « Réessayer ».
  const [tente, setTente] = useState(false);
  // Par une référence : un rappel neuf à chaque rendu relançait la minuterie.
  const pret = useRef(onPret);
  pret.current = onPret;

  // Pendant l'installation, l'état est relu toutes les deux secondes.
  useEffect(() => {
    if (!enCours) return;
    const minuterie = setInterval(() => {
      void fetchCodeStatus()
        .then((s) => {
          setEtat(s);
          if (s.available) pret.current();
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(minuterie);
  }, [enCours]);

  const lancer = async (ouverture: boolean) => {
    setRefus(null);
    const message = await installerOpencode(ouverture).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    if (message) {
      setRefus(message);
      return;
    }
    setEtat((e) => ({ ...e, installation: { enCours: true, pourcent: 0, erreur: null } }));
  };

  // À l'ouverture : rien d'en cours, l'administrateur est là, on lance.
  useEffect(() => {
    if (!dOffice || tente || enCours) return;
    setTente(true);
    void lancer(true);
  }, [dOffice, tente, enCours]);

  const erreur = refus ?? (enCours ? null : etat.installation?.erreur ?? null);
  const commande = plateformePoste() === "win32" ? t("npm install -g opencode-ai") : t("curl -fsSL https://opencode.ai/install | bash");
  // Avant le premier rendu de l'effet : la progression, pas un bouton qui disparaîtrait aussitôt.
  const demarrage = dOffice && !tente;

  let corps;
  if (etat.installable === false) {
    corps = <p className="text-sm text-muted-foreground">{etat.raisonNonInstallable}</p>;
  } else if (enCours || demarrage) {
    const pourcent = enCours ? etat.installation?.pourcent ?? 0 : 0;
    corps = (
      <div className="w-full">
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          {tf("Installation d'OpenCode... {0} %", pourcent)}
        </p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pourcent}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {tf("{0} l'installe lui-même : OpenCode (licence MIT), version épinglée, empreinte vérifiée, environ 60 Mo, pour ce compte seulement.", branding.name)}
        </p>
      </div>
    );
  } else if (!administrateur) {
    corps = (
      <p className="text-sm text-muted-foreground">
        {t("L'administrateur de l'instance doit installer OpenCode, le moteur de l'écran Code : ce compte ne peut pas le faire.")}
      </p>
    );
  } else {
    corps = (
      <>
        {!erreur && (
          <p className="text-sm text-muted-foreground">
            {tf("{0} l'installe lui-même : OpenCode (licence MIT), version épinglée, empreinte vérifiée, environ 60 Mo, pour ce compte seulement.", branding.name)}
          </p>
        )}
        <Button icon={erreur ? RotateCcw : Download} onClick={() => void lancer(false)}>
          {erreur ? t("Réessayer") : t("Installer OpenCode")}
        </Button>
      </>
    );
  }

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      {corps}
      {erreur && administrateur && !enCours && (
        <InfoBox tone="warning" className="w-full text-start" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {erreur}
        </InfoBox>
      )}
      {administrateur && !rattache && (
        <p className="text-xs text-muted-foreground">
          {t("Ou à la main, dans un terminal :")}{" "}<code className="rounded bg-muted px-1.5 py-0.5 text-foreground">{commande}</code>
        </p>
      )}
    </div>
  );
}

export default InstallerOpencode;
