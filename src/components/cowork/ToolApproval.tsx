import { FileCog, Globe, Mail, Send, ShieldCheck, Terminal } from "lucide-react";
import { CarteApprobation } from "@/components/cowork/CarteApprobation";
import { useApprobation } from "@/hooks/useApprobation";
import { langue, t, tf } from "@/lib/i18n";
import { libelleOutil } from "@/lib/libellesOutils";

/**
 * Ce que l'agent veut faire, dans la langue de l'écran.
 *
 * Le résumé est rédigé en français par l'instance (`resumerOutil`,
 * approbation.ts) : affiché tel quel, la carte d'accord, la phrase qu'il faut
 * comprendre avant de cliquer, arrivait en français dans une interface anglaise
 * ou chinoise. Hors français, on la recompose avec le libellé traduit de l'outil
 * et le chemin visé, qui suffisent à décider.
 */
function phraseDemande(resume: string, outil?: string, cible?: string | null, employe?: string | null, destination?: string): string {
  if (langue() === "fr" || !outil) return `${employe ?? "L'agent"} veut ${resume}.`;
  // Un déplacement se juge à ses deux bouts (seconde tournée du 28/09/2026) : sans la destination, la carte anglaise ou chinoise ne disait pas où partait le fichier.
  return `${employe ? `${employe} · ` : ""}${libelleOutil(outil)}${cible ? ` · ${cible}` : ""}${destination ? ` → ${destination}` : ""}`;
}

/**
 * Demande d'accord avant qu'un outil agisse sur vos fichiers.
 *
 * La demande dit ce que l'agent veut faire, pas le nom de la fonction qu'il a
 * appelée : personne n'approuve « fichiers__write_file » en connaissance de
 * cause. Un refus n'interrompt pas la conversation, l'agent en est informé et
 * poursuit avec ce qu'il peut faire sans.
 */
export function ToolApproval() {
  const { enAttente, niveau, repondre } = useApprobation();
  const demande = enAttente[0];
  if (!demande) return null;

  /*
   * Ce que couvre un « Autoriser » est dit avant le clic, pas après. Sans cela,
   * l'utilisateur croirait n'avoir approuvé qu'une seule écriture alors qu'une
   * tâche longue en enchaîne vingt dans le même dossier.
   */
  const etendue =
    niveau === "chaque"
      ? t("Autoriser vaut aussi pour les actions identiques au même endroit, jusqu'à la fin de cette demande.")
      : t("Autoriser vaut aussi pour les prochaines modifications dans ce dossier, jusqu'à la fin de cette demande.");

  // Un employé travaille aussi quand personne ne lui parle : la carte dit lequel demande.
  const employe = demande.detail?.employe ?? null;

  const envoi = demande.detail?.envoi;
  if (envoi) {
    /*
     * Un mail qui part ne se reprend pas : la carte le montre tel que le
     * serveur le recevra, texte entier, et le bouton dit « Envoyer », pas
     * « Autoriser ». Chaque mail redemande, quel que soit le niveau choisi.
     */
    const ligne = (libelle: string, valeur: string) => (
      <div className="flex gap-2">
        <dt className="w-12 shrink-0 text-muted-foreground">{libelle}</dt>
        <dd className="min-w-0 flex-1 break-words text-foreground">{valeur}</dd>
      </div>
    );
    return (
      <CarteApprobation
        icone={<Mail size={16} strokeWidth={1.75} />}
        titre={employe ? tf("{0}, votre agent, veut envoyer un mail", employe) : t("Un mail est prêt à partir")}
        phrase={envoi.enReponse ? t("Réponse envoyée depuis votre boîte, dans le fil du message d'origine.") : t("Envoyé depuis votre boîte, dès votre accord.")}
        contenu={
          <div className="rounded-xl border border-border bg-muted/40 text-sm">
            <dl className="space-y-1 border-b border-border px-3 py-2.5 text-xs">
              {ligne(t("À"), envoi.a)}
              {envoi.cc && ligne(t("Cc"), envoi.cc)}
              {ligne(t("Objet"), envoi.objet)}
            </dl>
            <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 text-foreground">{envoi.corps}</p>
          </div>
        }
        note={t("Un mail envoyé ne se reprend pas. Relisez avant d'accepter.")}
        accord={t("Envoyer")}
        refus={t("Ne pas envoyer")}
        iconeAccord={Send}
        pied={
          <>
            <ShieldCheck size={12} strokeWidth={1.75} />
            {t("Sans réponse, le mail ne partira pas")}
            {enAttente.length > 1 && tf(" · {0} autre(s) en attente", enAttente.length - 1)}
          </>
        }
        onApprouver={() => void repondre(demande.id, true)}
        onRefuser={() => void repondre(demande.id, false)}
      />
    );
  }

  /*
   * Une commande de l'agent de code (depuis le 26/09/2026, chaque commande
   * demande : gateway/src/permissionsCode.ts). Elle s'exécute avec les droits
   * du compte qui fait tourner l'instance : la carte la montre entière, et un
   * accord ne vaut que pour elle, mot pour mot.
   */
  const commande = demande.detail?.commande;
  const deCode = demande.detail?.surface === "code";
  if (commande !== undefined) {
    return (
      <CarteApprobation
        icone={<Terminal size={16} strokeWidth={1.75} />}
        titre={t("L'agent de code veut lancer une commande")}
        phrase={t("Elle s'exécutera sur la machine de l'instance, avec les droits de son compte, dans le dossier du projet.")}
        contenu={
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/40 px-3 py-2.5 font-mono text-xs text-foreground">
            {commande}
          </pre>
        }
        note={t("Autoriser vaut pour cette commande seulement.")}
        pied={
          <>
            <ShieldCheck size={12} strokeWidth={1.75} />
            {t("Sans réponse, la commande ne sera pas lancée")}
            {enAttente.length > 1 && tf(" · {0} autre(s) en attente", enAttente.length - 1)}
          </>
        }
        onApprouver={() => void repondre(demande.id, true)}
        onRefuser={() => void repondre(demande.id, false)}
      />
    );
  }

  /*
   * Hors fichiers, ce que l'outil recevra (revue du 26/09/2026) : le nom d'un
   * outil de connecteur ne dit pas ce qui part vers le service, ni une tâche
   * programmée ce qu'elle fera seule chaque jour. Et tous les fichiers visés,
   * pas seulement le premier.
   */
  const { arguments: donnees, cibles, tache, unique, destinataire, texteFinal, horsMachine } = demande.detail ?? {};
  /*
   * Palmier Pro (29/09/2026) : ce qui part hors de la machine, dit avant le
   * clic et dans la langue de l'écran (la phrase française de l'instance ne
   * s'affiche qu'en français).
   */
  const dehors =
    horsMachine === "generation"
      ? t("Cette génération part vers les services de Palmier, hors de cette machine, et se paie avec les crédits de votre compte Palmier. Elle ne se reprend pas.")
      : horsMachine === "transcription"
        ? t("Palmier Pro peut envoyer le son à ses services pour le transcrire, hors de cette machine, avec les crédits de votre compte Palmier.")
        : horsMachine === "retour"
          ? t("Ce message part vers l'équipe de Palmier, hors de cette machine.")
          : // Roblox Studio et Blender (12/10/2026) : gateway/src/robloxRegles.ts, blenderRegles.ts.
            horsMachine === "roblox-generation"
            ? t("Cette génération part vers les services de Roblox, hors de cette machine, au nom du compte Roblox ouvert dans Studio.")
            : horsMachine === "roblox-televersement"
              ? t("Cette image part sur les serveurs de Roblox, hors de cette machine, au nom du compte Roblox ouvert dans Studio.")
              : horsMachine === "blender-bibliotheque"
                ? t("Cette demande part vers une bibliothèque en ligne (Poly Haven, Sketchfab ou Poly Pizza), hors de cette machine, si vous l'avez allumée dans le module de Blender.")
                : horsMachine === "blender-generation"
                  ? t("Cette génération part vers le service réglé dans le module de Blender (Hyper3D, Hunyuan3D ou Tripo), hors de cette machine, sur votre compte ou vos crédits chez lui. Elle ne se reprend pas.")
                  : null;
  const contenu =
    donnees || dehors || (cibles && cibles.length > 1) ? (
      <div className="space-y-2">
        {dehors && (
          <p className="flex items-start gap-1.5 break-words text-sm text-foreground">
            <Globe size={14} strokeWidth={1.75} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{dehors}</span>
          </p>
        )}
        {/* Messageries (28/09/2026) : le destinataire résolu, et le texte final d'un modèle WhatsApp, dans la langue de l'écran. */}
        {destinataire && (
          <p className="break-words text-sm text-foreground">{tf("Destinataire : {0}", destinataire)}</p>
        )}
        {texteFinal && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("Texte qui sera envoyé")}</p>
            <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-sm text-foreground">{texteFinal}</p>
          </div>
        )}
        {cibles && cibles.length > 1 && (
          <ul className="max-h-32 overflow-y-auto rounded-xl border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
            {cibles.map((c) => (
              <li key={c} className="truncate" title={c}>
                {c}
              </li>
            ))}
          </ul>
        )}
        {donnees && (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/40 px-3 py-2.5 font-mono text-xs text-foreground">
            {donnees}
          </pre>
        )}
      </div>
    ) : undefined;

  return (
    <CarteApprobation
      icone={<FileCog size={16} strokeWidth={1.75} />}
      titre={
        tache
          ? tf("La tâche programmée « {0} » demande votre accord", tache)
          : employe
            ? tf("{0}, votre agent, demande votre accord", employe)
            : deCode
              ? t("L'agent de code demande votre accord")
              : t("L'agent demande votre accord")
      }
      phrase={phraseDemande(demande.resume, demande.detail?.outil, demande.detail?.url ?? demande.detail?.cible, employe, demande.detail?.destination)}
      contenu={contenu}
      // Un employé n'a pas de « demande » en cours : chaque accord ne vaut que pour une action. Hors fichiers non plus.
      note={employe || unique ? t("Autoriser vaut pour cette action seulement.") : etendue}
      pied={
        <>
          <ShieldCheck size={12} strokeWidth={1.75} />
          {t("Sans réponse, l'action ne sera pas faite")}
          {enAttente.length > 1 && tf(" · {0} autre(s) en attente", enAttente.length - 1)}
        </>
      }
      onApprouver={() => void repondre(demande.id, true)}
      onRefuser={() => void repondre(demande.id, false)}
    />
  );
}

export default ToolApproval;
