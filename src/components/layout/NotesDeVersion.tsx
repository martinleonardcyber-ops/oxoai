import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { TexteRiche } from "@/components/ui/TexteRiche";
import { useFormats } from "@/lib/formats";
import { langue, t, tf } from "@/lib/i18n";
import { lienSur, pontNouveautes, type ResultatNouveautes } from "@/lib/nouveautes";

/**
 * Les nouveautés d'une version, et des versions sautées depuis `depuis`, les
 * plus récentes d'abord (23/10/2026). Le texte est du Markdown réduit, rendu
 * par TexteRiche (aucun HTML interprété ; liens https seulement, ouverts dans
 * le navigateur du système). Rien de lisible : un lien vers la page des
 * publications quand il y en a une, sinon rien.
 *
 * `resultat` : déjà lu par le parent (fenêtre d'après la mise à jour, qui ne
 * s'ouvre que s'il y a des notes) ; sinon, lu ici.
 */
export function NotesDeVersion({
  depuis,
  jusqua,
  resultat: donne,
}: {
  depuis?: string | null;
  jusqua: string;
  resultat?: ResultatNouveautes | null;
}) {
  const api = pontNouveautes();
  const { date } = useFormats();
  const [lu, setLu] = useState<ResultatNouveautes | null>(donne ?? null);

  useEffect(() => {
    if (donne) {
      setLu(donne);
      return;
    }
    if (!api) return;
    let vivant = true;
    setLu(null);
    void api
      .nouveautes({ depuis: depuis ?? null, jusqua, langue: langue() })
      .then((r) => vivant && setLu(r))
      .catch(() => vivant && setLu({ ok: false, lien: null }));
    return () => {
      vivant = false;
    };
  }, [api, depuis, jusqua, donne]);

  if (!api) return null;
  if (!lu) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={13} className="animate-spin" />
        {t("Lecture des nouveautés…")}
      </p>
    );
  }

  const toutes = lienSur(lu.lien);
  if (!lu.ok || lu.versions.length === 0) {
    return toutes ? (
      <a
        href={toutes}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ExternalLink size={13} strokeWidth={1.75} />{" "}{t("Voir les notes de version sur la page des publications")}
      </a>
    ) : null;
  }

  // Pas de traduction automatique : l'anglais est dit comme tel (décision du 23/10/2026).
  const enAnglais = langue() !== "en" && lu.versions.some((v) => v.langue === "en");

  return (
    <div className="space-y-4">
      {enAnglais && <p className="text-xs text-muted-foreground">{t("Notes de version en anglais.")}</p>}
      {lu.versions.map((v) => (
        <section key={v.version} className="space-y-1.5">
          <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-foreground">
            {tf("Version {0}", v.version)}
            {v.date && <span className="text-xs font-normal text-muted-foreground">{date(v.date)}</span>}
          </h3>
          {v.texte ? (
            // La langue du texte, pas celle de l'écran : un texte anglais dans une interface arabe s'aligne à gauche.
            <div lang={v.langue}>
              <TexteRiche texte={v.texte} liens className="text-sm text-muted-foreground" />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("Aucune nouveauté décrite pour cette version.")}</p>
          )}
        </section>
      ))}
      {lu.autres > 0 && toutes && (
        <a
          href={toutes}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink size={13} strokeWidth={1.75} />{" "}{tf("Et {0} version(s) plus ancienne(s) : toutes les notes de version", lu.autres)}
        </a>
      )}
    </div>
  );
}

export default NotesDeVersion;
