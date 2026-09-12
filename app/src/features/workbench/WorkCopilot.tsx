import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Eraser, Loader2, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/pages/common";
import { useApp } from "@/lib/store";
import { sddApi } from "./api";
import type { CopilotTurn, Project, WorkItem } from "./types";

/** Conversations are kept per work item. Held in memory for the session so that closing and reopening
 *  the detail continues the same thread — never written to the vault. Queries are not records. */
const threads = new Map<string, CopilotTurn[]>();

const SAMPLES = ["summary", "next", "risk"] as const;

/**
 * The copilot on the right of the work detail. Uses the open work item's documents, decision log,
 * and project repository as context to ask the agent the user configured and shows the answer.
 * Read-only, so work status and documents never change through this panel.
 */
export function WorkCopilot({ work, project }: { work: WorkItem; project?: Project }) {
  const { t } = useTranslation("workbench");
  const defaultAgent = useApp((state) => state.defaultAgent);
  const [turns, setTurns] = useState<CopilotTurn[]>(() => threads.get(work.id) ?? []);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [engine, setEngine] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setTurns(threads.get(work.id) ?? []);
    setQuestion("");
    setError("");
    setEngine("");
  }, [work.id]);
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight });
  }, [turns, busy]);

  const agent = project?.defaultAgent?.trim() || defaultAgent;
  const model = project?.defaultModel?.trim() || t("copilot.defaultModel");

  const ask = async (text: string) => {
    const asked = text.trim();
    if (!asked || busy) return;
    // Sent questions appear immediately and survive a failed answer — so they need not be retyped.
    const history = turns;
    const next: CopilotTurn[] = [...history, { role: "question", text: asked }];
    threads.set(work.id, next);
    setTurns(next);
    setQuestion("");
    setError("");
    setBusy(true);
    try {
      const result = await sddApi.copilotAsk({ workId: work.id, question: asked, history });
      const answered: CopilotTurn[] = [...next, { role: "answer", text: result.answer }];
      threads.set(work.id, answered);
      setTurns(answered);
      setEngine([result.agent, result.model].filter(Boolean).join(" · "));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(question);
  };

  return (
    <aside className="wb-copilot" aria-label={t("copilot.title")}>
      <header className="wb-copilot-head">
        <h3>
          <Bot size={15} /> {t("copilot.title")}
        </h3>
        {turns.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            title={t("copilot.clear")}
            aria-label={t("copilot.clear")}
            onClick={() => {
              threads.delete(work.id);
              setTurns([]);
              setError("");
            }}
          >
            <Eraser size={14} />
          </Button>
        )}
      </header>
      <div className="wb-copilot-thread" ref={thread} role="log" aria-live="polite">
        {turns.length === 0 && !busy ? (
          <div className="wb-copilot-empty">
            <p>{t("copilot.description")}</p>
            <ul>
              {SAMPLES.map((sample) => (
                <li key={sample}>
                  <button type="button" onClick={() => void ask(t(`copilot.samples.${sample}`))}>
                    {t(`copilot.samples.${sample}`)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          turns.map((turn, index) => (
            <div
              key={`${index}-${turn.role}`}
              className={turn.role === "question" ? "wb-copilot-question" : "wb-copilot-answer"}
            >
              {turn.role === "question" ? <p>{turn.text}</p> : <MarkdownView src={turn.text} />}
            </div>
          ))
        )}
        {busy && (
          <p className="wb-copilot-waiting" role="status">
            <Loader2 className="wb-spin" size={14} /> {t("copilot.waiting", { agent })}
          </p>
        )}
      </div>
      {error && (
        <div className="wb-inline-error" role="alert">
          {error}
        </div>
      )}
      <form className="wb-copilot-form" onSubmit={submit}>
        <textarea
          aria-label={t("copilot.question")}
          placeholder={t("copilot.placeholder")}
          value={question}
          disabled={busy}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void ask(question);
            }
          }}
        />
        <div className="wb-copilot-actions">
          <small title={t("copilot.engineHint")}>{engine || `${agent} · ${model}`}</small>
          <Button size="sm" type="submit" disabled={busy || !question.trim()}>
            {busy ? <Loader2 className="wb-spin" /> : <Send />} {t("copilot.ask")}
          </Button>
        </div>
      </form>
    </aside>
  );
}
