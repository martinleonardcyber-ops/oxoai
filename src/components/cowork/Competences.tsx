import { useState } from "react";
import { Link } from "react-router-dom";
import { Pencil, Plus } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { EditeurCompetence } from "@/components/competences/EditeurCompetence";
import { useCompetences } from "@/hooks/useCompetences";
import type { Competence } from "@/lib/store/competences";
import { t, tf } from "@/lib/i18n";

/**
 * Les compétences, dans le panneau de Cowork : la liste courte, un
 * interrupteur, et la création. Tout le reste (import, export, exemples,
 * fichiers joints) est dans Réglages, « Compétences »
 * (settings/CompetencesReglages.tsx), où on les trouve aussi sans passer par
 * Cowork (23/10/2026).
 *
 * Le bouton « Créer une compétence » existait depuis le début, grisé, avec
 * « Bientôt disponible » en infobulle (ADR-043).
 */
export function Competences() {
  const { competences, creer, modifier, supprimer, allumee, basculer, moi } = useCompetences();
  const [ouverte, setOuverte] = useState<Competence | "nouvelle" | null>(null);

  return (
    <>
      {competences.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("Aucune procédure enregistrée. Écrivez une fois comment vous faites, et l'assistant le refera à chaque demande qui s'y prête.")}
        </p>
      ) : (
        <ul className="space-y-0.5">
          {competences.map((c) => (
            <li
              key={c.id}
              className="group flex items-center gap-2 rounded-md px-1 py-1.5 text-sm"
              title={c.quand || c.instructions.slice(0, 200)}
            >
              <Switch
                checked={allumee(c)}
                onChange={(v) => basculer(c, v)}
                label={tf("Activer la procédure {0}", c.nom)}
              />
              <span className={allumee(c) ? "truncate text-foreground" : "truncate text-muted-foreground"}>{c.nom}</span>
              <button
                type="button"
                aria-label={tf("Modifier {0}", c.nom)}
                className="ms-auto shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => setOuverte(c)}
              >
                <Pencil size={13} strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setOuverte("nouvelle")}
        className="mt-1.5 flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus size={15} strokeWidth={1.75} />
        <span>{t("Créer une compétence")}</span>
      </button>
      <Link to="/parametres/competences" className="mt-1 block px-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
        {t("Importer, exporter, exemples : Réglages, Compétences")}
      </Link>

      {ouverte && (
        <EditeurCompetence
          competence={ouverte === "nouvelle" ? null : ouverte}
          lectureSeule={ouverte !== "nouvelle" && ouverte.ownerId !== moi}
          onFermer={() => setOuverte(null)}
          onEnregistrer={(v) => (ouverte === "nouvelle" ? creer(v) : modifier(ouverte.id, v))}
          onSupprimer={ouverte !== "nouvelle" ? () => supprimer(ouverte.id) : undefined}
        />
      )}
    </>
  );
}

export default Competences;
