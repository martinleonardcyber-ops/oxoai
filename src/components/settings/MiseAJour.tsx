import { useEffect, useState } from "react";
import { RefreshCw, Download, RotateCw, ExternalLink, TriangleAlert, Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ModaleNouveautes } from "@/components/layout/FenetreNouveautes";
import { pontNouveautes } from "@/lib/nouveautes";
import { InfoBox } from "@/components/ui/InfoBox";
import { branding } from "@/config/branding";
import { useFormats } from "@/lib/formats";
import { t, tf } from "@/lib/i18n";

/**
 * Version installée et mise à jour de l'application de bureau.
 *
 * L'état vient du processus principal (`electron/miseAJour.cjs`) : l'écran ne
 * dit « à jour » qu'après une vérification réussie, avec son heure. Il dit
 * aussi lequel des deux régimes s'applique, automatique si l'application est
 * signée, manuel sinon, et pourquoi.
 */

interface EtatMiseAJour {
  phase:
    | "inactif"
    | "non-configuree"
    | "verification"
    | "a-jour"
    | "disponible"
    | "telechargement"
    | "prete"
    | "erreur";
  versionInstallee: string;
  versionDisponible: string | null;
  pourcent: number | null;
  signee: boolean;
  automatique: boolean;
  derniereVerification: string | null;
  message: string | null;
  lienPaquet: string | null;
  /** Système du poste (absent d'une application plus ancienne). */
  plateforme?: string;
  /** D'où vient l'annonce : `agence`, `instance` ou `github`. */
  source?: string | null;
  /** Installation d'un clic possible ; sinon, le paquet se télécharge. */
  unClic?: boolean;
}

interface PontMiseAJour {
  etat: () => Promise<EtatMiseAJour>;
  verifier: () => Promise<EtatMiseAJour>;
  installer: () => Promise<boolean>;
  ouvrirPaquet: () => Promise<boolean>;
  surChangement: (rappel: (etat: EtatMiseAJour) => void) => () => void;
}

const pont = (): PontMiseAJour | undefined =>
  typeof window !== "undefined"
    ? (window as unknown as { helix?: { miseAJour?: PontMiseAJour } }).helix?.miseAJour
    : undefined;

export function MiseAJour() {
  const api = pont();
  const { dateHeure } = useFormats();
  const [etat, setEtat] = useState<EtatMiseAJour | null>(null);

  useEffect(() => {
    if (!api) return;
    void api.etat().then(setEtat);
    return api.surChangement(setEtat);
  }, [api]);

  /*
   * « Voir les nouveautés » (23/10/2026) : les notes de la version installée,
   * ou, quand une version est proposée, les siennes et celles qu'on sauterait.
   * Seulement dans l'application de bureau qui sait les lire, et quand GitHub
   * annonce les versions : un poste rattaché ne le contacte pas.
   */
  const pontNotes = pontNouveautes();
  const [notes, setNotes] = useState<{ version: string; depuis: string | null; installee: boolean } | null>(null);
  const installee = etat?.versionInstallee ?? branding.version;

  const version = (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/40 px-4 py-3">
      <div>
        <p className="text-sm font-medium text-foreground">{t("Version installée")}</p>
        <p className="text-xs text-muted-foreground">v{installee}</p>
      </div>
      {pontNotes && etat?.source === "github" && (
        <Button variant="ghost" size="sm" icon={Sparkles} onClick={() => setNotes({ version: installee, depuis: null, installee: true })}>
          {t("Voir les nouveautés")}
        </Button>
      )}
    </div>
  );
  const modaleNotes = notes && (
    <ModaleNouveautes
      open
      onClose={() => setNotes(null)}
      version={notes.version}
      depuis={notes.depuis}
      reglage={notes.installee}
    />
  );

  // Dans un navigateur, il n'y a pas d'application à remplacer.
  if (!api) {
    return (
      <>
        {version}
        <p className="mt-3 text-xs text-muted-foreground">
          {t("La mise à jour concerne l'application de bureau. Dans un navigateur, l'interface suit la version de l'instance.")}
        </p>
      </>
    );
  }

  if (!etat) {
    return (
      <>
        {version}
        {modaleNotes}
      </>
    );
  }

  const verifier = (
    <Button
      variant="secondary"
      size="sm"
      icon={RefreshCw}
      disabled={etat.phase === "verification" || etat.phase === "telechargement"}
      onClick={() => void api.verifier()}
    >
      {t("Vérifier maintenant")}
    </Button>
  );

  let corps: React.ReactNode = null;
  switch (etat.phase) {
    case "inactif":
      corps = <p className="text-xs text-muted-foreground">{etat.message}</p>;
      break;
    case "non-configuree":
      corps = (
        <>
          {etat.plateforme && etat.plateforme !== "darwin" ? (
            <p className="text-xs text-muted-foreground">
              {tf("Sur Windows et Linux, la mise à jour se fait à la main : {0} ne contacte aucun serveur de mise à jour. Pour changer de version, installez le nouveau paquet fourni par votre prestataire, par-dessus celui-ci : vos données restent en place.", branding.name)}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {tf("Aucune adresse de mise à jour n'est inscrite dans cette installation : {0} ne contacte aucun serveur de mise à jour. Pour changer de version, installez le paquet fourni par votre prestataire.", branding.name)}
            </p>
          )}
          {etat.message && (
            <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
              {etat.message}
            </InfoBox>
          )}
        </>
      );
      break;
    case "verification":
      corps = <p className="text-xs text-muted-foreground">{t("Recherche d'une nouvelle version…")}</p>;
      break;
    case "a-jour":
      corps = (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check size={14} strokeWidth={2} className="text-success" />
          {t("Aucune version plus récente")}
          {etat.derniereVerification ? tf(" (vérifié {0})", dateHeure(etat.derniereVerification)) : ""}.
        </p>
      );
      break;
    case "disponible":
      corps = (
        <>
          <p className="text-sm text-foreground">{tf("Version {0} disponible.", etat.versionDisponible ?? "")}</p>
          {pontNotes && etat.source === "github" && etat.versionDisponible && (
            <Button
              variant="ghost"
              size="sm"
              icon={Sparkles}
              onClick={() => setNotes({ version: etat.versionDisponible ?? "", depuis: etat.versionInstallee, installee: false })}
            >
              {tf("Nouveautés de la version {0}", etat.versionDisponible)}
            </Button>
          )}
          {etat.unClic === false ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t("Téléchargez le nouveau paquet, puis installez-le par-dessus celui-ci : vos données restent en place.")}
              </p>
              <Button size="sm" icon={Download} onClick={() => void api.ouvrirPaquet()}>
                {t("Télécharger")}
              </Button>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {etat.plateforme === "win32"
                  ? t("Elle s'installe d'un clic : l'installateur est vérifié par son empreinte et par la signature de l'éditeur, puis il ferme l'application, installe la nouvelle version par-dessus et la rouvre.")
                  : t("Cette installation n'est pas signée : elle ne se met pas à jour seule, mais s'installe d'un clic. L'archive est vérifiée par son empreinte et par la signature de l'éditeur avant de remplacer l'application.")}
              </p>
              <Button size="sm" icon={Download} onClick={() => void api.installer()}>
                {t("Installer maintenant")}
              </Button>
            </>
          )}
        </>
      );
      break;
    case "telechargement":
      corps = (
        <>
          <p className="text-xs text-muted-foreground">
            {t("Téléchargement de la version")}{" "}{etat.versionDisponible}…
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${etat.pourcent ?? 0}%` }}
            />
          </div>
        </>
      );
      break;
    case "prete":
      corps = (
        <>
          <p className="text-sm text-foreground">
            {t("Version")}{" "}{etat.versionDisponible}{" "}{t("téléchargée et vérifiée.")}
          </p>
          <p className="text-xs text-muted-foreground">
            {tf("Elle s'installera à la prochaine fermeture de {0}, ou tout de suite :", branding.name)}
          </p>
          <Button size="sm" icon={RotateCw} onClick={() => void api.installer()}>
            {t("Redémarrer pour installer")}
          </Button>
        </>
      );
      break;
    case "erreur":
      corps = (
        <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
          {etat.message}
        </InfoBox>
      );
      break;
  }

  const configuree = etat.phase !== "non-configuree" && etat.phase !== "inactif";

  return (
    <div className="space-y-3">
      {version}
      {modaleNotes}
      {corps}
      {configuree && (
        <p className="text-xs text-muted-foreground">
          {etat.automatique
            ? t("Mise à jour automatique : l'application est signée, chaque nouvelle version est vérifiée avant d'être installée.")
            : etat.source === "github"
              ? t("Les nouvelles versions sont cherchées dans les versions publiées du projet (GitHub), toutes les six heures. Rien ne s'installe sans votre clic.")
              : t("Mise à jour manuelle : l'application n'est pas encore signée. Elle vérifie qu'une version plus récente existe, et l'installe sur votre clic.")}
        </p>
      )}
      {configuree && etat.phase !== "prete" && verifier}
      {!configuree && branding.urls.releases && (
        <a
          href={branding.urls.releases}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink size={14} strokeWidth={1.75} />{" "}{t("Voir les versions publiées")}
        </a>
      )}
    </div>
  );
}

export default MiseAJour;
