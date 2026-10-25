import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Images,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { Memory } from "../types";

type Step = "welcome" | "sources" | "google" | "complete";
type ImportResult = { imported: number; warnings: string[] } | null;

interface OnboardingProps {
  memories: Memory[];
  googleConfigured: boolean;
  googleConnected: boolean;
  pickerId: string;
  busy: string;
  error: string;
  returnedFromGoogle: boolean;
  onConnectGoogle: () => Promise<void>;
  onOpenGooglePicker: () => Promise<void>;
  onImportGoogle: () => Promise<ImportResult>;
  onImportInstagram: (profile: string, ownership: boolean, consent: boolean) => Promise<ImportResult>;
  onChooseFiles: (
    files: FileList | null,
    afterImport: () => void,
  ) => Promise<void>;
  onClearError: () => void;
  onFinish: () => void;
}

function GoogleMark() {
  return (
    <span className="google-photo-mark" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export default function Onboarding({
  memories,
  googleConfigured,
  googleConnected,
  pickerId,
  busy,
  error,
  returnedFromGoogle,
  onConnectGoogle,
  onOpenGooglePicker,
  onImportGoogle,
  onImportInstagram,
  onChooseFiles,
  onClearError,
  onFinish,
}: OnboardingProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>(
    returnedFromGoogle ? "google" : "welcome",
  );
  const [importSummary, setImportSummary] = useState<ImportResult>(null);
  const [instagramProfile, setInstagramProfile] = useState("");
  const [instagramOwnership, setInstagramOwnership] = useState(false);
  const [instagramConsent, setInstagramConsent] = useState(false);
  const [instagramBusy, setInstagramBusy] = useState(false);
  const photos = memories
    .filter((memory) => memory.mediaType === "image")
    .slice(0, 3);

  useEffect(() => {
    if (returnedFromGoogle) setStep("google");
  }, [returnedFromGoogle]);

  useEffect(() => {
    const root = rootRef.current;
    const first = root?.querySelector<HTMLElement>(
      "button:not(:disabled), input:not(:disabled)",
    );
    first?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !root) return;
      const controls = Array.from(
        root.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), [href]",
        ),
      ).filter((element) => element.offsetParent !== null);
      if (!controls.length) return;
      const firstControl = controls[0];
      const lastControl = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === firstControl) {
        event.preventDefault();
        lastControl.focus();
      } else if (!event.shiftKey && document.activeElement === lastControl) {
        event.preventDefault();
        firstControl.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, [step, googleConnected, googleConfigured, pickerId]);

  async function importSelection() {
    const result = await onImportGoogle();
    if (!result) return;
    setImportSummary(result);
    setStep("complete");
  }

  async function importInstagram() {
    setInstagramBusy(true);
    const result = await onImportInstagram(instagramProfile, instagramOwnership, instagramConsent);
    setInstagramBusy(false);
    if (!result) return;
    setImportSummary(result);
    setStep("complete");
  }

  const activeStep = step === "welcome" ? 0 : step === "sources" ? 1 : 2;

  return (
    <div
      ref={rootRef}
      className="onboarding"
      role="dialog"
      aria-modal="true"
      aria-label="Set up your memory library"
    >
      <header className="onboarding-header">
        <div className="onboarding-brand" aria-label="Again">
          <span>✳</span>again<i>.</i>
        </div>
        {step !== "complete" && (
          <div
            className="onboarding-progress"
            aria-label={`Onboarding step ${activeStep + 1} of 3`}
          >
            {[0, 1, 2].map((item) => (
              <span key={item} className={item <= activeStep ? "active" : ""} />
            ))}
          </div>
        )}
        <button className="onboarding-skip" onClick={onFinish}>
          {step === "complete" ? "Enter your library" : "Skip for now"}
        </button>
      </header>

      {error && (
        <div className="onboarding-error" role="alert">
          <span>{error}</span>
          <button onClick={onClearError}>Dismiss</button>
        </div>
      )}

      {step === "welcome" && (
        <main className="onboarding-welcome">
          <section className="onboarding-copy">
            <span className="onboarding-kicker">
              <Sparkles size={14} /> Your memories, gathered
            </span>
            <h1>Begin with the moments you already have.</h1>
            <p>
              Bring in a few photographs now. Again will preserve the originals,
              understand what is visible, and start finding the trips and themes
              that shaped your story.
            </p>
            <div className="onboarding-actions">
              <button
                className="button primary onboarding-primary"
                onClick={() => setStep("sources")}
              >
                Begin <ArrowRight size={17} />
              </button>
              <span>You stay in control of what enters your library.</span>
            </div>
          </section>
          <section
            className="onboarding-photo-stage"
            aria-label="A preview of your memory library"
          >
            <div className="photo-stage-caption">
              A life is easier to return to when its pieces have a place.
            </div>
            <div className="photo-stack">
              {photos.map((memory, index) => (
                <figure
                  key={memory.id}
                  className={`onboarding-photo photo-${index + 1}`}
                >
                  <img src={memory.thumbnailUrl || memory.url} alt="" />
                  <figcaption>{memory.title}</figcaption>
                </figure>
              ))}
            </div>
          </section>
        </main>
      )}

      {step === "sources" && (
        <main className="onboarding-page onboarding-source-page">
          <button
            className="onboarding-back"
            onClick={() => setStep("welcome")}
          >
            <ArrowLeft size={15} /> Back
          </button>
          <section className="onboarding-page-heading">
            <span className="onboarding-kicker">
              <Cloud size={14} /> Choose a starting place
            </span>
            <h1>Where do your memories live?</h1>
            <p>
              Start with one source. You can connect the rest whenever you are
              ready.
            </p>
          </section>
          <section className="onboarding-source-list">
            <button
              className="onboarding-source featured"
              onClick={() => setStep("google")}
            >
              <GoogleMark />
              <span>
                <strong>Google Photos</strong>
                <small>
                  Sign in, then privately choose the photos and videos to bring
                  into Again.
                </small>
              </span>
              <em>Recommended</em>
              <ArrowRight size={19} />
            </button>
            <label className="onboarding-source">
              <span className="source-file-mark">
                <Images size={24} />
              </span>
              <span>
                <strong>This device</strong>
                <small>
                  Choose photographs and videos already saved on this computer
                  or phone.
                </small>
              </span>
              <ArrowDownToLine size={19} />
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
                multiple
                disabled={Boolean(busy)}
                onChange={(event) =>
                  void onChooseFiles(event.target.files, onFinish)
                }
              />
            </label>
            <div className="onboarding-later">
              <span>Instagram</span>
              <small>Bring in accessible posts from your own account with explicit consent.</small>
            </div>
            <div className="onboarding-social-card">
              <label className="field-label">Instagram profile URL<input value={instagramProfile} onChange={(event) => setInstagramProfile(event.target.value)} placeholder="https://www.instagram.com/yourname/" /></label>
              <label className="consent-check"><input type="checkbox" checked={instagramOwnership} onChange={(event) => setInstagramOwnership(event.target.checked)} /><span>I confirm this is my account, or I have permission to import it.</span></label>
              <label className="consent-check"><input type="checkbox" checked={instagramConsent} onChange={(event) => setInstagramConsent(event.target.checked)} /><span>I authorize Again to retrieve and archive the selected public posts.</span></label>
              <button className="button secondary wide" onClick={() => void importInstagram()} disabled={instagramBusy || !instagramProfile.trim() || !instagramOwnership || !instagramConsent}>{instagramBusy ? <LoaderCircle className="spin" size={17} /> : <Images size={17} />} Import Instagram posts</button>
              <small className="onboarding-social-note">Again does not ask for or store your Instagram password. Private accounts may not be accessible; the account owner remains responsible for permission and platform rules.</small>
            </div>
          </section>
        </main>
      )}

      {step === "google" && (
        <main className="onboarding-page google-onboarding-page">
          <button
            className="onboarding-back"
            onClick={() => setStep("sources")}
          >
            <ArrowLeft size={15} /> Sources
          </button>
          <section className="google-oauth-card">
            <GoogleMark />
            <div className="google-status-line">
              <span>
                {googleConnected
                  ? "Connected"
                  : googleConfigured
                    ? "Ready to connect"
                    : "Setup needed"}
              </span>
              {googleConnected && <Check size={14} />}
            </div>
            <h1>
              {googleConnected
                ? "Choose the moments to bring closer."
                : "Connect Google Photos."}
            </h1>
            <p>
              Again can only access photographs and videos you explicitly select
              in Google’s picker. For the broadest first import, select as many
              as you want—Google allows up to 2,000 items per picker session.
              Again cannot browse or search your library without your selection.
            </p>

            <div className="oauth-trust-list">
              <span>
                <LockKeyhole size={17} />
                <strong>Private by selection</strong>
                <small>Nothing is imported until you choose it.</small>
              </span>
              <span>
                <ShieldCheck size={17} />
                <strong>Originals preserved</strong>
                <small>
                  Selected files are copied into your memoir archive.
                </small>
              </span>
            </div>

            {!googleConfigured && (
              <div className="oauth-setup-note">
                <strong>Google OAuth is not configured on this server.</strong>
                <span>
                  Add the Google client ID and secret to <code>.env</code>, then
                  restart Again.
                </span>
              </div>
            )}

            {!googleConnected ? (
              <button
                className="button primary onboarding-primary oauth-action"
                onClick={() => void onConnectGoogle()}
                disabled={Boolean(busy) || !googleConfigured}
              >
                {busy === "google" ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <GoogleMark />
                )}
                Continue with Google
              </button>
            ) : !pickerId ? (
              <button
                className="button primary onboarding-primary oauth-action"
                onClick={() => void onOpenGooglePicker()}
                disabled={Boolean(busy)}
              >
                {busy === "picker" ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <Images size={18} />
                )}
                Choose as many as possible from Google Photos
              </button>
            ) : (
              <div className="picker-return">
                <span>
                  <Check size={16} /> Select as many memories as you want, then
                  return here to import them.
                </span>
                <button
                  className="button primary onboarding-primary oauth-action"
                  onClick={() => void importSelection()}
                  disabled={Boolean(busy)}
                >
                  {busy === "picker-import" ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <ArrowDownToLine size={18} />
                  )}
                  Import my selection
                </button>
                <button
                  className="text-button"
                  onClick={() => void onOpenGooglePicker()}
                  disabled={Boolean(busy)}
                >
                  Open the picker again
                </button>
              </div>
            )}
          </section>
          <p className="google-policy-note">
            Google sign-in is handled by Google. Again never sees or stores your
            password.
          </p>
        </main>
      )}

      {step === "complete" && (
        <main className="onboarding-complete">
          <span className="complete-mark">
            <Check size={28} />
          </span>
          <span className="onboarding-kicker">Your first source is ready</span>
          <h1>
            {importSummary?.imported
              ? `${importSummary.imported} memories are finding their place.`
              : "Your library is ready to begin."}
          </h1>
          <p>
            Search by a place, a year, or a feeling. As you add more, Again will
            begin surfacing larger trips and recurring chapters in your life.
          </p>
          {Boolean(importSummary?.warnings.length) && (
            <div className="import-warning">
              {importSummary!.warnings.join(" ")}
            </div>
          )}
          <button
            className="button primary onboarding-primary"
            onClick={onFinish}
          >
            Enter your library <ArrowRight size={17} />
          </button>
        </main>
      )}
    </div>
  );
}
