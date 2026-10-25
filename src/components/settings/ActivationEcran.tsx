import { useCallback, useEffect, useState } from "react";
import { Monitor, MonitorOff, TriangleAlert, Lock, Box, Loader2, FolderOpen, Trash2, Laptop } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { InfoBox } from "@/components/ui/InfoBox";
import { Card } from "@/components/settings/SettingsShell";
import { branding } from "@/config/branding";
import { definirModeEcran, type Capability } from "@/lib/computer";
import { effacerMachine, lireMachine, type EtatMachine } from "@/lib/machine";
import { lireEtat } from "@/lib/deuxFacteurs";
import { t, tf } from "@/lib/i18n";

type Choix = "sandbox" | "hote";
type Systeme = "linux" | "macos";

/**
 * Où l'agent de Cowork clique et tape, et le choix depuis l'interface.
 *
 * Deux possibilités, dans l'ordre où on les conseille :
 *  - **la machine de l'agent** (`sandbox`) : un ordinateur à part, isolé, que
 *    OxoAI prépare et démarre lui-même (gateway/src/machine.ts). C'était la
 *    décision de départ : une erreur de l'agent y reste enfermée, et la
 *    personne continue de travailler sur le sien. Le diagnostic dit si cet
 *    ordinateur peut la porter, et sinon pourquoi ;
 *    Sur un Mac à puce Apple de 32 Go, elle peut aussi être un Mac virtuel
 *    (machineMacos.ts) : la personne choisit ;
 *  - **cet écran** (`hote`) : la souris et le clavier de la personne.
 *
 * Choisir l'une ou l'autre redemande le mot de passe (et le code, si la double
 * authentification est active). Désactiver ne demande rien. Quand le mode est
 * fixé ailleurs (profil de déploiement, instance partagée), la carte le dit et
 * ne propose rien. Voir gateway/src/reglagesEcran.ts.
 */
export function ActivationEcran({
  capability,
  onChange,
}: {
  capability: Capability;
  onChange: () => void;
}) {
  const [choix, setChoix] = useState<Choix | null>(null);
  const [systeme, setSysteme] = useState<Systeme>("linux");
  const [effacement, setEffacement] = useState(false);
  const [motDePasse, setMotDePasse] = useState("");
  const [code, setCode] = useState("");
  const [deuxFacteurs, setDeuxFacteurs] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | undefined>();
  const [machine, setMachine] = useState<EtatMachine | null>(null);

  const relireMachine = useCallback(() => {
    void lireMachine()
      .then(setMachine)
      .catch(() => setMachine(null));
  }, []);

  useEffect(relireMachine, [relireMachine]);

  // Pendant la préparation ou le démarrage de la machine, on suit l'avancement.
  const enPreparation = Boolean(machine?.preparationEnCours) || (capability.mode === "sandbox" && machine !== null && !machine.pret);
  useEffect(() => {
    if (!enPreparation) return;
    const minuterie = window.setInterval(() => {
      relireMachine();
      onChange();
    }, 2000);
    return () => window.clearInterval(minuterie);
  }, [enPreparation, relireMachine, onChange]);

  useEffect(() => {
    if (!choix) return;
    void lireEtat()
      .then((e) => setDeuxFacteurs(e.active))
      .catch(() => setDeuxFacteurs(false));
  }, [choix]);

  const changer = async (mode: Choix | "desactive") => {
    setOccupe(true);
    setErreur(undefined);
    try {
      await definirModeEcran(mode, motDePasse, code.trim(), mode === "sandbox" ? systeme : undefined);
      setChoix(null);
      setMotDePasse("");
      setCode("");
      onChange();
      relireMachine();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    } finally {
      setOccupe(false);
    }
  };

  const effacer = async () => {
    setEffacement(true);
    setErreur(undefined);
    try {
      await effacerMachine();
      relireMachine();
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
    } finally {
      setEffacement(false);
    }
  };

  const choisirMachine = (s: Systeme) => {
    setSysteme(s);
    setChoix("sandbox");
  };

  const erreurBloc = erreur && (
    <InfoBox tone="warning" className="mt-3" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
      {erreur}
    </InfoBox>
  );

  if (!capability.modifiable) {
    return (
      <Card className="mb-4">
        <div className="flex items-start gap-3">
          <Lock size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {capability.mode !== "desactive" ? t("Activé") : t("Désactivé")}
              {t(", réglage verrouillé")}
            </p>
            <p className="text-sm text-muted-foreground">{capability.raisonNonModifiable}</p>
          </div>
        </div>
      </Card>
    );
  }

  /* --- Machine de l'agent choisie ---------------------------------------- */
  if (capability.mode === "sandbox") {
    const progression = machine?.progression;
    return (
      <Card className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <Box size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {machine?.pret
                  ? machine.systeme === "macos"
                    ? t("Machine macOS de l'agent : en marche")
                    : t("Machine de l'agent : en marche")
                  : progression?.etape === "erreur"
                    ? t("Machine de l'agent : n'a pas démarré")
                    : t("Machine de l'agent : démarrage...")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("L'agent travaille sur son propre bureau, isolé du vôtre. Un « Autoriser » vaut pour toute la demande en cours.")}
              </p>
            </div>
          </div>
          <Button variant="secondary" icon={MonitorOff} disabled={occupe} onClick={() => void changer("desactive")}>
            {t("Désactiver")}
          </Button>
        </div>
        {!machine?.pret && progression && progression.etape !== "erreur" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {progression.message}
          </p>
        )}
        {progression?.etape === "erreur" && (
          <InfoBox tone="warning" leading={<TriangleAlert size={15} strokeWidth={1.75} />}>
            {progression.message} {progression.erreur}
          </InfoBox>
        )}
        {machine && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <FolderOpen size={13} strokeWidth={1.75} />
            {tf("Documents rendus par l'agent : {0}", machine.dossierEchange)}
          </p>
        )}
        {erreurBloc}
      </Card>
    );
  }

  /* --- Cet écran choisi --------------------------------------------------- */
  if (capability.mode === "hote") {
    return (
      <Card className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <Monitor size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">{t("Activé sur ce Mac")}</p>
              <p className="text-sm text-muted-foreground">
                {t("L'agent peut voir l'écran et demander à cliquer ou saisir ; chaque action modifiante attend votre accord.")}
              </p>
            </div>
          </div>
          <Button variant="secondary" icon={MonitorOff} disabled={occupe} onClick={() => void changer("desactive")}>
            {t("Désactiver")}
          </Button>
        </div>
        {erreurBloc}
      </Card>
    );
  }

  /* --- Désactivé : les deux possibilités ---------------------------------- */
  const linuxPossible = machine !== null && machine.obstacles.length === 0;
  const macosPossible = Boolean(machine?.macos.possible);
  const machineInstallee = Boolean(machine && (machine.imagePrete || machine.macos.presente));

  if (!choix) {
    return (
      <Card className="mb-4 space-y-4">
        <div className="flex items-start gap-3">
          <MonitorOff size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">{t("Désactivé")}</p>
            <p className="text-sm text-muted-foreground">
              {t("L'agent travaille sur vos fichiers, mais ne voit ni ne pilote aucun écran.")}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <Box size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t("Machine de l'agent (recommandé)")}</p>
                <p className="text-sm text-muted-foreground">
                  {machine ? machine.raison : t("Analyse de cet ordinateur...")}
                </p>
                {machine && machine.obstacles.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {machine.obstacles.map((o) => (
                      <li key={o}>• {o}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {(linuxPossible || !macosPossible) && (
                <Button icon={Box} disabled={!linuxPossible} onClick={() => choisirMachine("linux")}>
                  {macosPossible ? t("Bureau Linux") : t("Choisir")}
                </Button>
              )}
              {macosPossible && (
                <Button variant={linuxPossible ? "secondary" : "primary"} icon={Laptop} onClick={() => choisirMachine("macos")}>
                  {t("Mac virtuel")}
                </Button>
              )}
            </div>
          </div>
          {macosPossible && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("Mac virtuel : Safari et LibreOffice dans un macOS isolé, 8 Go de mémoire, environ 23 Go à télécharger la première fois.")}
            </p>
          )}
          {machineInstallee && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {t("La machine reste sur le disque pour repartir vite. Effacez-la pour rendre sa place ; elle se réinstallera si vous la choisissez de nouveau.")}
              </p>
              <Button variant="ghost" icon={effacement ? Loader2 : Trash2} disabled={effacement} onClick={() => void effacer()}>
                {effacement ? t("Effacement...") : t("Effacer la machine")}
              </Button>
            </div>
          )}
        </div>
        {erreurBloc}

        {capability.modifiable && capability.hotePossible !== false && (
          <div className="rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <Monitor size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{t("Cet écran")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("L'agent pilote votre propre souris et votre clavier, avec votre accord à chaque action. Vous ne pouvez pas travailler pendant ce temps.")}
                  </p>
                </div>
              </div>
              <Button variant="secondary" icon={Monitor} onClick={() => setChoix("hote")}>
                {t("Choisir")}
              </Button>
            </div>
          </div>
        )}
      </Card>
    );
  }

  const points =
    choix === "sandbox" && systeme === "macos"
      ? [
          tf("• {0} installe Lume (le moteur de machines virtuelles de cua, version épinglée et vérifiée), puis télécharge un macOS préparé : environ 23 Go, souvent plus d'une heure.", branding.name),
          t("• Dans la machine : Safari et LibreOffice (installé au premier démarrage, environ 300 Mo). Elle garde 8 Go de mémoire tant qu'elle tourne."),
          tf("• Elle n'est joignable que depuis ce Mac, et s'arrête quand vous désactivez ou fermez {0}.", branding.name),
          t("• L'agent n'accède à aucun de vos fichiers, sauf le dossier d'échange par lequel il vous rend les documents."),
          t("• Si elle ne démarre pas, le message dira où, et le bureau Linux reste possible."),
        ]
      : choix === "sandbox"
      ? [
          tf("• {0} prépare puis démarre un bureau Linux isolé, avec Firefox et LibreOffice. La première fois, il télécharge environ 2 Go.", branding.name),
          tf("• La machine utilise au plus 3 Go de mémoire, et n'est joignable que depuis cet ordinateur. Elle s'arrête quand vous désactivez ou fermez {0}.", branding.name),
          t("• L'agent n'accède à aucun de vos fichiers, sauf le dossier d'échange par lequel il vous rend les documents."),
          t("• Un « Autoriser » vaut pour toute la demande en cours ; le niveau « Demander pour tout » redemande à chaque action."),
          t("• Ces agents se trompent souvent de cible : relisez les documents rendus avant de vous en servir."),
        ]
      : [
          t("• L'agent pourra voir l'écran, et demander à déplacer la souris, cliquer et saisir au clavier."),
          t("• Chaque action qui modifie quelque chose vous sera soumise avant d'être faite."),
          tf("• macOS demandera ensuite deux autorisations pour {0} : Enregistrement de l'écran et Accessibilité.", branding.name),
          t("• Il faut aussi un modèle capable de lire l'écran ; la page le propose s'il manque."),
          t("• Ces agents se trompent souvent de cible : préférez les outils fichiers quand ils suffisent."),
        ];

  return (
    <Card className="mb-4 space-y-4">
      <p className="text-sm font-medium text-foreground">
        {choix === "sandbox"
          ? systeme === "macos"
            ? t("Activer la machine macOS de l'agent")
            : t("Activer la machine de l'agent")
          : t("Activer le contrôle de l'écran de ce Mac")}
      </p>
      <ul className="space-y-1 text-sm text-muted-foreground">
        {points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <Field label={t("Votre mot de passe")}>
        <Input
          type="password"
          value={motDePasse}
          autoFocus
          autoComplete="current-password"
          onChange={(e) => setMotDePasse(e.target.value)}
        />
      </Field>
      {deuxFacteurs && (
        <Field label={t("Code de vérification")} hint={t("Celui de l'application, ou un code de secours.")}>
          <Input
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={32}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
      )}
      {erreurBloc}
      <div className="flex flex-wrap gap-2">
        <Button
          icon={choix === "sandbox" ? (systeme === "macos" ? Laptop : Box) : Monitor}
          disabled={occupe || !motDePasse || (deuxFacteurs && !code.trim())}
          onClick={() => void changer(choix)}
        >
          {occupe ? t("Activation...") : t("Activer")}
        </Button>
        <Button variant="ghost" disabled={occupe} onClick={() => setChoix(null)}>
          {t("Annuler")}
        </Button>
      </div>
    </Card>
  );
}

export default ActivationEcran;
