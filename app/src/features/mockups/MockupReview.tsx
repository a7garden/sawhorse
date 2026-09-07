import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  Loader2,
  MessageSquare,
  Monitor,
  RefreshCw,
  Smartphone,
  Tablet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { sddApi } from "@/features/workbench/api";
import type { Document } from "@/features/workbench/types";
import type { Mockup } from "./types";
import {
  appendFeedback,
  normalizeFeedback,
  readFeedback,
  type FeedbackKind,
} from "./feedback";
import { sandboxedMockupHtml } from "./preview-html";
import "./mockups.css";

const devices = [
  { id: "desktop", width: 1440, height: 900, icon: Monitor },
  { id: "tablet", width: 768, height: 1024, icon: Tablet },
  { id: "mobile", width: 390, height: 844, icon: Smartphone },
] as const;

export function MockupReview({
  workId,
  onDirtyChange,
  onOpenWork,
}: {
  workId: string;
  onDirtyChange: (dirty: boolean) => void;
  onOpenWork: (workId: string, artifact?: string) => void;
}) {
  const { t } = useTranslation("mockups");
  const formId = useId();
  const [mockup, setMockup] = useState<Mockup | null>(null);
  const [feedback, setFeedback] = useState<Document | null>(null);
  const [screenId, setScreenId] = useState("");
  const [deviceId, setDeviceId] = useState("desktop");
  const [fit, setFit] = useState(true);
  const [width, setWidth] = useState(0);
  const canvas = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<{ screenId: string; source: string } | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [htmlError, setHtmlError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const [previewReload, setPreviewReload] = useState(0);
  const [kind, setKind] = useState<FeedbackKind>("revision");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onDirtyChange(Object.values(drafts).some((text) => text.trim().length > 0));
  }, [drafts, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    void Promise.all([
      sddApi.readMockup(workId),
      sddApi.readDocument(workId, "feedback"),
    ])
      .then(([next, document]) => {
        if (!alive) return;
        setMockup(next);
        setFeedback(document);
        setScreenId((current) =>
          next.screens.some((screen) => screen.id === current)
            ? current
            : (next.screens[0]?.id ?? ""),
        );
      })
      .catch((error) => {
        if (alive) setLoadError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [workId, reload]);
  useEffect(() => {
    if (!screenId) return;
    let alive = true;
    setHtml(null);
    setHtmlError(null);
    void sddApi
      .readMockupHtml(workId, screenId)
      .then((source) => {
        if (alive) setHtml({ screenId, source: sandboxedMockupHtml(source) });
      })
      .catch((error) => {
        if (alive) setHtmlError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [workId, screenId, previewReload]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [mockup]);

  const screen = mockup?.screens.find((item) => item.id === screenId);
  const device = devices.find((item) => item.id === deviceId) ?? devices[0];
  const scale = fit ? Math.min(1, Math.max(1, width - 32) / device.width) : 1;
  const draftKey = `${screenId}:${kind}`;
  const draft = drafts[draftKey] ?? "";
  const comments = useMemo(
    () => readFeedback(feedback?.markdown ?? ""),
    [feedback],
  );
  const screenComments = comments.filter((item) => item.screenId === screenId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!screen || !normalizeFeedback(draft) || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    const submitted = draft;
    const submittedKey = draftKey;
    try {
      // Merge into the latest file, then use the document API's revision check.
      const latest = await sddApi.readDocument(workId, "feedback");
      const markdown = appendFeedback(
        latest.markdown,
        kind,
        screen.id,
        submitted,
      );
      const next = await sddApi.writeDocument(
        workId,
        "feedback",
        markdown,
        latest.revision,
      );
      if (!mounted.current) return;
      setFeedback(next);
      setDrafts((current) =>
        current[submittedKey] === submitted
          ? { ...current, [submittedKey]: "" }
          : current,
      );
      setSaved(true);
    } catch (error) {
      if (mounted.current)
        setSaveError(
          error instanceof Error && error.message === "duplicate-feedback"
            ? t("duplicate")
            : String(error),
        );
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  if (loadError)
    return (
      <div className="mockup-state" role="alert">
        <CircleAlert size={22} />
        <strong>{t("loadFailed")}</strong>
        <p>{loadError}</p>
        <Button size="sm" onClick={() => setReload((value) => value + 1)}>
          {t("retry")}
        </Button>
      </div>
    );
  if (!mockup || !screen)
    return (
      <div className="mockup-state" role="status">
        <Loader2 className="animate-spin" size={22} />
        {t("loading")}
      </div>
    );

  return (
    <div className="mockup-review">
      <header className="mockup-heading">
        <div>
          <span className="mockup-eyebrow">{t("review")}</span>
          <h3>{mockup.title}</h3>
          <p>
            {t("coverage", {
              screens: mockup.screens.length,
              issues: mockup.issues.length,
            })}
          </p>
        </div>
        <div className="mockup-revision">
          <span>Rev {mockup.revision}</span>
          {mockup.parentMockupId && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onOpenWork(mockup.parentMockupId, "mockup")}
            >
              {t("previous")}
              <ArrowUpRight size={13} />
            </Button>
          )}
        </div>
      </header>
      <div className="mockup-screens" role="group" aria-label={t("screens")}>
        {mockup.screens.map((item, index) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={item.id === screenId}
            disabled={saving}
            onClick={() => {
              setScreenId(item.id);
              setSaved(false);
              setSaveError(null);
            }}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {item.label}
            <small>
              {
                mockup.issues.filter((issue) => issue.screenId === item.id)
                  .length
              }
            </small>
            {Object.entries(drafts).some(
              ([key, text]) => key.startsWith(`${item.id}:`) && text.trim(),
            ) && (
              <span className="mockup-draft-dot" aria-label={t("unsaved")} />
            )}
          </button>
        ))}
      </div>
      <section className="mockup-screen" aria-label={screen.label}>
        <div className="mockup-screen-context">
          <strong>{screen.label}</strong>
          <span>{screen.context}</span>
          <div>
            {mockup.issues
              .filter((issue) => issue.screenId === screen.id)
              .map((issue) => (
                <button
                  type="button"
                  key={issue.id}
                  title={issue.title}
                  onClick={() => onOpenWork(issue.id)}
                >
                  {issue.id}
                  <ArrowUpRight size={11} />
                </button>
              ))}
          </div>
        </div>
        <div className="mockup-preview-toolbar">
          <div role="group" aria-label={t("viewport")}>
            {devices.map(({ id, icon: Icon }) => (
              <button
                type="button"
                key={id}
                aria-label={t(`device.${id}`)}
                title={t(`device.${id}`)}
                aria-pressed={id === deviceId}
                onClick={() => setDeviceId(id)}
              >
                <Icon size={15} />
                <span>{t(`device.${id}`)}</span>
              </button>
            ))}
          </div>
          <span className="mockup-dimensions">
            {device.width} × {device.height}
          </span>
          <button
            type="button"
            aria-pressed={fit}
            onClick={() => setFit((value) => !value)}
          >
            {fit ? t("fit", { scale: Math.round(scale * 100) }) : "100%"}
          </button>
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("reloadPreview")}
            title={t("reloadPreview")}
            onClick={() => setPreviewReload((value) => value + 1)}
          >
            <RefreshCw size={13} />
          </Button>
        </div>
        <div className="mockup-canvas" ref={canvas}>
          {htmlError ? (
            <div className="mockup-state" role="alert">
              <CircleAlert size={22} />
              <strong>{t("htmlFailed")}</strong>
              <p>{htmlError}</p>
              <Button
                size="sm"
                onClick={() => setPreviewReload((value) => value + 1)}
              >
                {t("retry")}
              </Button>
            </div>
          ) : html?.screenId === screenId ? (
            <div
              className="mockup-device"
              style={{
                width: device.width * scale,
                height: device.height * scale,
              }}
            >
              <iframe
                key={`${screenId}:${previewReload}`}
                title={t("previewTitle", { screen: screen.label })}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                srcDoc={html.source}
                style={{
                  width: device.width,
                  height: device.height,
                  transform: `scale(${scale})`,
                }}
              />
            </div>
          ) : (
            <div className="mockup-state" role="status">
              <Loader2 className="animate-spin" size={22} />
              {t("loadingPreview")}
            </div>
          )}
        </div>
      </section>
      <div className="mockup-review-bottom">
        <section className="mockup-context" aria-label={t("changes")}>
          <div className="mockup-comparison">
            {(["baseline", "proposal"] as const).map((field) => (
              <div key={field}>
                <h4>{t(field)}</h4>
                {screen[field].length ? (
                  <ul>
                    {screen[field].map((text, index) => (
                      <li key={index}>{text}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{t("notRecorded")}</p>
                )}
              </div>
            ))}
          </div>
          <details>
            <summary>
              {t("acceptance")} <span>{screen.acceptance.length}</span>
            </summary>
            <ul>
              {screen.acceptance.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
            {!screen.acceptance.length && <p>{t("notRecorded")}</p>}
          </details>
          <details>
            <summary>
              {t("evidence")} <span>{screen.evidence.length}</span>
            </summary>
            <ul>
              {screen.evidence.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
            {!screen.evidence.length && <p>{t("notRecorded")}</p>}
          </details>
        </section>
        <section className="mockup-feedback" aria-label={t("feedback")}>
          <h4>
            <MessageSquare size={15} />
            {t("feedback")}
            <span>
              {t("pending", {
                count: screenComments.filter((item) => !item.processed).length,
              })}
            </span>
          </h4>
          <form onSubmit={(event) => void submit(event)}>
            <div
              className="mockup-feedback-kinds"
              role="group"
              aria-label={t("feedbackKind")}
            >
              {(["revision", "proposal"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  disabled={saving}
                  aria-pressed={kind === value}
                  onClick={() => {
                    setKind(value);
                    setSaved(false);
                    setSaveError(null);
                  }}
                >
                  {t(`kind.${value}`)}
                </button>
              ))}
            </div>
            <label htmlFor={formId}>
              {t("commentFor", { screen: screen.label })}
            </label>
            <textarea
              id={formId}
              value={draft}
              disabled={saving}
              maxLength={4000}
              placeholder={t(`placeholder.${kind}`)}
              onChange={(event) => {
                setDrafts((current) => ({
                  ...current,
                  [draftKey]: event.target.value,
                }));
                setSaved(false);
                setSaveError(null);
              }}
            />
            <div className="mockup-feedback-actions">
              <small>{t("feedbackHint")}</small>
              <Button
                type="submit"
                size="sm"
                disabled={saving || !feedback || !normalizeFeedback(draft)}
              >
                {saving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <MessageSquare size={14} />
                )}
                {t("saveFeedback")}
              </Button>
            </div>
            {saveError && (
              <p className="mockup-error" role="alert">
                {saveError}
              </p>
            )}
            {saved && (
              <p className="mockup-success" role="status">
                <Check size={14} />
                {t("saved")}
              </p>
            )}
          </form>
          {screenComments.length ? (
            <ul className="mockup-comments">
              {screenComments.map((comment, index) => (
                <li key={index}>
                  <div>
                    <span>{t(`kind.${comment.kind}`)}</span>
                    <small>
                      {t(comment.processed ? "processed" : "unprocessed")}
                    </small>
                  </div>
                  <p>{comment.text}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mockup-no-comments">{t("noFeedback")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
