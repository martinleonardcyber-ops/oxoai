import { useRef, useState } from "react";
import { AlertTriangle, Download, FileText, Paperclip, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import {
  BORNES,
  nomDeFichierValide,
  problemeCompetence,
  type Competence,
  type DonneesCompetence,
  type FichierCompetence,
  type VisibiliteCompetence,
} from "@/lib/store/competences";
import { telechargerCompetence } from "@/lib/competencesFichier";
import { t, tf } from "@/lib/i18n";

/**
 * L'éditeur d'une compétence (23/10/2026, sorti de cowork/Competences.tsx).
 *
 * Le même pour créer, modifier, et accepter un import : un fichier importé
 * s'ouvre ici, contenu entier sous les yeux, avec ce qu'il faut savoir
 * (champs ignorés, code joint qui ne sera jamais exécuté), et rien n'est
 * enregistré avant « Ajouter ». Une compétence d'un collègue s'ouvre en
 * lecture : seule son autrice la modifie (authz.ts).
 *
 * Les champs, et pas un de plus (ADR-043) : le nom, quand s'en servir, la
 * manière de faire, qui s'en sert, et au plus cinq fichiers texte.
 */
export interface ValeursEditeur {
  nom: string;
  quand: string;
  instructions: string;
  visibilite: VisibiliteCompetence;
  fichiers: FichierCompetence[];
}

export function EditeurCompetence({
  competence,
  initial,
  avertissements = [],
  lectureSeule = false,
  onFermer,
  onEnregistrer,
  onSupprimer,
}: {
  /** La compétence modifiée, ou null pour une nouvelle (création, import). */
  competence: Competence | null;
  initial?: Partial<ValeursEditeur>;
  /** Ce qu'un import a relevé : montré en tête. */
  avertissements?: string[];
  lectureSeule?: boolean;
  onFermer: () => void;
  onEnregistrer: (valeurs: DonneesCompetence) => void;
  onSupprimer?: () => void;
}) {
  const importee = Boolean(initial) && !competence;
  const [nom, setNom] = useState(competence?.nom ?? initial?.nom ?? "");
  const [quand, setQuand] = useState(competence?.quand ?? initial?.quand ?? "");
  const [instructions, setInstructions] = useState(competence?.instructions ?? initial?.instructions ?? "");
  const [visibilite, setVisibilite] = useState<VisibiliteCompetence>(competence?.visibilite ?? initial?.visibilite ?? "personnel");
  const [fichiers, setFichiers] = useState<FichierCompetence[]>(competence?.fichiers ?? initial?.fichiers ?? []);
  const [erreurFichier, setErreurFichier] = useState<string | null>(null);
  const choix = useRef<HTMLInputElement>(null);

  const probleme = problemeCompetence({ nom, quand, instructions, fichiers });

  const enregistrer = () => {
    if (probleme || lectureSeule) return;
    onEnregistrer({ nom, quand, instructions, visibilite, fichiers });
    onFermer();
  };

  /** Joindre un fichier texte : lu ici, gardé comme texte, jamais exécuté. */
  const joindre = async (liste: FileList | null) => {
    setErreurFichier(null);
    const ajouts: FichierCompetence[] = [];
    for (const f of Array.from(liste ?? [])) {
      if (fichiers.length + ajouts.length >= BORNES.fichiers) {
        setErreurFichier(t("Cinq fichiers joints au plus."));
        break;
      }
      if (f.size > BORNES.fichier * 4) {
        setErreurFichier(tf("« {0} » est trop grand pour un fichier joint.", f.name));
        continue;
      }
      const contenu = await f.text();
      if (contenu.includes("\u0000") || contenu.length > BORNES.fichier) {
        setErreurFichier(tf("« {0} » n'est pas un fichier texte assez court.", f.name));
        continue;
      }
      if (!nomDeFichierValide(f.name)) {
        setErreurFichier(tf("« {0} » a un nom invalide.", f.name));
        continue;
      }
      ajouts.push({ nom: f.name, contenu });
    }
    if (ajouts.length > 0) setFichiers((avant) => [...avant, ...ajouts.filter((a) => !avant.some((b) => b.nom === a.nom))]);
    if (choix.current) choix.current.value = "";
  };

  const titre = lectureSeule
    ? t("Compétence partagée")
    : competence
      ? t("Modifier la compétence")
      : importee
        ? t("Importer une compétence")
        : t("Créer une compétence");

  return (
    <Modal open onClose={onFermer} size="lg">
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">{titre}</h2>
        {importee ? (
          <InfoBox tone="muted" leading={<FileText size={15} strokeWidth={1.75} />}>
            {t("Voici tout ce que contient le fichier. Relisez-le : rien n'est ajouté avant que vous cliquiez sur « Ajouter ». Une compétence n'est que du texte donné à lire à l'assistant ; rien de ce qu'elle contient n'est jamais exécuté.")}
          </InfoBox>
        ) : (
          <InfoBox tone="muted" leading={<Sparkles size={15} strokeWidth={1.75} />}>
            {t("Une compétence est une manière de faire, écrite avec vos mots. Elle ne donne aucun pouvoir nouveau à l'assistant : elle lui dit comment se servir de ceux qu'il a déjà.")}
          </InfoBox>
        )}
        {lectureSeule && (
          <p className="text-sm text-muted-foreground">{t("Écrite par un collègue et partagée à l'organisation : vous pouvez la lire, l'exporter et l'éteindre pour vous, pas la modifier.")}</p>
        )}
        {avertissements.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            {avertissements.map((a) => (
              <li key={a} className="flex gap-1.5">
                <AlertTriangle size={13} strokeWidth={1.75} className="mt-0.5 shrink-0" />
                <span>{a}</span>
              </li>
            ))}
          </ul>
        )}

        <Field label={t("Nom")}>
          <Input
            autoFocus={!lectureSeule}
            readOnly={lectureSeule}
            maxLength={BORNES.nom}
            placeholder={t("Compte rendu de visite client")}
            value={nom}
            onChange={(e) => setNom(e.target.value)}
          />
        </Field>

        <Field
          label={t("Quand s'en servir")}
          hint={t("Une phrase. C'est elle qui sert à reconnaître la situation, et la seule que l'assistant lit quand la place manque. Soyez précis sur la situation, pas sur la méthode.")}
        >
          <Input
            readOnly={lectureSeule}
            maxLength={BORNES.quand}
            placeholder={t("Quand on me demande de rédiger le compte rendu d'un rendez-vous")}
            value={quand}
            onChange={(e) => setQuand(e.target.value)}
          />
        </Field>

        <Field
          label={t("La manière de faire")}
          hint={t("Ce que l'assistant suivra. Écrivez-la comme à un nouveau collègue : les étapes, dans l'ordre, et ce qu'il ne faut surtout pas faire.")}
        >
          <Textarea
            rows={10}
            readOnly={lectureSeule}
            maxLength={BORNES.instructions}
            placeholder={
              t("1. Commencer par la date, le nom du client et les personnes présentes.\n") +
              t("2. Trois parties : ce qui a été dit, ce qui a été décidé, ce qui reste à faire.\n") +
              t("3. Chaque point à faire porte un responsable et une date.\n") +
              t("4. Ne jamais inventer un chiffre : si une donnée manque, écrire « à confirmer ».")
            }
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>

        <Field
          label={t("Fichiers joints")}
          hint={t("Facultatif : un modèle de document, un exemple réussi. Du texte seulement, cinq fichiers au plus ; l'assistant les lit avec la compétence.")}
        >
          <div className="space-y-1.5">
            {fichiers.map((f) => (
              <div key={f.nom} className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm">
                <FileText size={14} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{f.nom}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{tf("{0} caractères", f.contenu.length)}</span>
                {!lectureSeule && (
                  <button
                    type="button"
                    aria-label={tf("Retirer {0}", f.nom)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                    onClick={() => setFichiers((avant) => avant.filter((x) => x !== f))}
                  >
                    <X size={14} strokeWidth={1.75} />
                  </button>
                )}
              </div>
            ))}
            {!lectureSeule && fichiers.length < BORNES.fichiers && (
              <>
                <input ref={choix} type="file" multiple className="hidden" onChange={(e) => void joindre(e.target.files)} />
                <Button variant="secondary" size="sm" icon={Paperclip} onClick={() => choix.current?.click()}>
                  {t("Joindre un fichier")}
                </Button>
              </>
            )}
            {erreurFichier && <p className="text-xs text-destructive">{erreurFichier}</p>}
          </div>
        </Field>

        {!lectureSeule && (
          <Field
            label={t("Qui s'en sert")}
            hint={t("Partagée à l'organisation, elle sert à tous vos collègues, et à vos employés toujours actifs ; vous seul pouvez la modifier. Personnelle, elle ne sert qu'à vous.")}
          >
            <Select
              value={visibilite}
              onChange={(v) => setVisibilite(v as VisibiliteCompetence)}
              options={[
                { value: "personnel", label: t("Moi seul") },
                { value: "organisation", label: t("Toute l'organisation") },
              ]}
            />
          </Field>
        )}

        {probleme && !lectureSeule && (nom || instructions) && <p className="text-xs text-muted-foreground">{probleme}</p>}

        <div className="flex flex-wrap items-center gap-2">
          {!lectureSeule && (
            <Button onClick={enregistrer} disabled={Boolean(probleme)}>
              {competence ? t("Enregistrer") : importee ? t("Ajouter") : t("Créer")}
            </Button>
          )}
          <Button variant="ghost" onClick={onFermer}>
            {lectureSeule ? t("Fermer") : t("Annuler")}
          </Button>
          {competence && (
            <Button variant="ghost" icon={Download} onClick={() => telechargerCompetence(competence)}>
              {t("Exporter")}
            </Button>
          )}
          {competence && onSupprimer && !lectureSeule && (
            <Button
              variant="ghost"
              icon={Trash2}
              className="ms-auto text-destructive hover:text-destructive"
              onClick={() => {
                onSupprimer();
                onFermer();
              }}
            >
              {t("Supprimer")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default EditeurCompetence;
