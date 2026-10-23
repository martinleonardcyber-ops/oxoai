import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { NotesDeVersion } from "@/components/layout/NotesDeVersion";
import { langue, t, tf } from "@/lib/i18n";
import { pontNouveautes, type ResultatNouveautes } from "@/lib/nouveautes";

/**
 * « Nouveautés de la version X » (demandé par Medhi le 23/10/2026).
 *
 * Au premier lancement d'une nouvelle version, une fois : les notes de la
 * version installée et de celles qu'on a sautées. Refermée (bouton, croix,
 * Échap, clic à côté), elle ne revient pas pour cette version ; « Ne plus
 * afficher après une mise à jour » la tait pour les suivantes. Elle ne
 * s'ouvre que si des notes ont pu être lues : hors ligne, elle réessaie au
 * lancement suivant ; sur un poste rattaché (qui ne lit pas GitHub), rien.
 * Retrouvable dans Réglages › Préférences › À propos (« Voir les nouveautés »).
 */

export function ModaleNouveautes({
  open,
  onClose,
  version,
  depuis,
  resultat,
  reglage = true,
}: {
  open: boolean;
  onClose: () => void;
  version: string;
  depuis?: string | null;
  resultat?: ResultatNouveautes | null;
  /** Faux pour une version proposée, pas encore installée : ni repère « vu », ni réglage. */
  reglage?: boolean;
}) {
  const api = pontNouveautes();
  const [nePlus, setNePlus] = useState(false);

  useEffect(() => {
    if (!open || !api || !reglage) return;
    void api.lancement().then((l) => setNePlus(l.nePlusAfficher)).catch(() => undefined);
  }, [open, api, reglage]);

  if (!api) return null;
  const fermer = () => {
    if (reglage) void api.nouveautesVues({ nePlusAfficher: nePlus }).catch(() => undefined);
    onClose();
  };

  return (
    <Modal open={open} onClose={fermer} size="lg">
      <div className="space-y-4">
        <h2 className="pe-8 text-lg font-semibold text-foreground">{tf("Nouveautés de la version {0}", version)}</h2>
        <div className="max-h-[55vh] overflow-y-auto pe-1">
          <NotesDeVersion depuis={depuis} jusqua={version} resultat={resultat} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          {reglage ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={nePlus} onChange={setNePlus} label={t("Ne plus afficher après une mise à jour")} />
              {t("Ne plus afficher après une mise à jour")}
            </label>
          ) : (
            <span />
          )}
          <Button onClick={fermer}>{t("Fermer")}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** La fenêtre du premier lancement après une mise à jour, posée une fois dans la mise en page. */
export function FenetreNouveautes() {
  const api = pontNouveautes();
  const [ouverte, setOuverte] = useState<{ version: string; depuis: string | null; resultat: ResultatNouveautes } | null>(null);

  useEffect(() => {
    if (!api) return;
    let vivant = true;
    void (async () => {
      const l = await api.lancement();
      if (!vivant || l.nePlusAfficher || (!l.depuis && !l.inconnue)) return;
      const r = await api.nouveautes({ depuis: l.depuis, jusqua: l.version, langue: langue() });
      if (!vivant) return;
      if (r.ok && r.versions.length > 0) setOuverte({ version: l.version, depuis: l.depuis, resultat: r });
      // Rien à lire là où GitHub n'est pas la source (poste rattaché) : noté comme vu, pour ne pas redemander à chaque lancement.
      else if (!r.ok && !r.lien) void api.nouveautesVues().catch(() => undefined);
    })().catch(() => undefined);
    return () => {
      vivant = false;
    };
  }, [api]);

  if (!ouverte) return null;
  return (
    <ModaleNouveautes
      open
      onClose={() => setOuverte(null)}
      version={ouverte.version}
      depuis={ouverte.depuis}
      resultat={ouverte.resultat}
    />
  );
}

export default FenetreNouveautes;
