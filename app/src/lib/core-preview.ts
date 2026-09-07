import type {
  Job,
  NavEntry,
  PackInfo,
  PackView,
  TaskDef,
  TaskRow,
  TodoSections,
} from "./types";
import { jobRequestKey } from "./jobs";

const PREVIEW_VAULT_VIEWS: Array<{
  packId: string;
  packName: string;
  view: PackView;
}> = [
  {
    packId: "starter",
    packName: "기본 작업",
    view: {
      id: "logs",
      label: "일지",
      icon: "calendar-days",
      type: "notes",
      component: "",
      columns: [
        { field: "", source: "title", label: "날짜", type: "text", width: 120 },
        { field: "", source: "mtime", label: "수정", type: "date", width: 110 },
      ],
      groupBy: "",
      selection: "none",
      actions: [],
      empty: "아직 일지가 없습니다.",
    },
  },
  {
    packId: "si",
    packName: "SI",
    view: {
      id: "concepts",
      label: "개념",
      icon: "book-marked",
      type: "notes",
      component: "",
      columns: [
        { field: "", source: "title", label: "개념", type: "text", width: 0 },
        {
          field: "domain",
          source: "",
          label: "분류",
          type: "badge",
          width: 110,
        },
      ],
      groupBy: "domain",
      selection: "none",
      actions: [],
      empty: "개념 문서가 아직 없습니다.",
    },
  },
  {
    packId: "si",
    packName: "SI",
    view: {
      id: "vault",
      label: "점검",
      icon: "folder-search",
      type: "native",
      component: "vault",
      columns: [],
      groupBy: "",
      selection: "none",
      actions: [],
      empty: "",
    },
  },
];

const previewPack = (
  id: string,
  name: string,
  views: PackView[],
): PackInfo => ({
  id,
  name,
  version: "1.0.0",
  description: `${name} 미리보기 팩`,
  author: "sawhorse",
  icon: "package",
  skills: [],
  workspace: { folders: [], files: [] },
  settings: [],
  actions: [],
  views,
  dir: "",
  source: "builtin",
  enabled: true,
  availableSkills: [],
  settingsValues: {},
});

const previewPacks: PackInfo[] = [
  previewPack(
    "starter",
    "기본 작업",
    PREVIEW_VAULT_VIEWS.filter((item) => item.packId === "starter").map(
      (item) => item.view,
    ),
  ),
  previewPack(
    "si",
    "SI",
    PREVIEW_VAULT_VIEWS.filter((item) => item.packId === "si").map(
      (item) => item.view,
    ),
  ),
];

const previewNav: NavEntry[] = PREVIEW_VAULT_VIEWS.map(
  ({ packId, packName, view }) => ({
    packId,
    packName,
    viewId: view.id,
    label: view.label,
    icon: view.icon,
    type: view.type,
    component: view.component,
    group: "vault",
  }),
);
// Explicit browser preview only. No commands here launch agents or touch desktop files.
export async function corePreview(
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const readTasks = (): TaskRow[] =>
    JSON.parse(localStorage.getItem("sawhorse.preview-tasks") ?? "[]");
  const saveTasks = (rows: TaskRow[]) =>
    localStorage.setItem("sawhorse.preview-tasks", JSON.stringify(rows));
  const readJobs = (): Job[] =>
    JSON.parse(localStorage.getItem("sawhorse.preview-jobs") ?? "[]");
  const saveJobs = (rows: Job[]) =>
    localStorage.setItem("sawhorse.preview-jobs", JSON.stringify(rows));
  const readTodos = (): TodoSections => {
    const stored = localStorage.getItem("sawhorse.preview-todos");
    if (stored) return JSON.parse(stored) as TodoSections;
    const now = new Date();
    return {
      date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      today: [
        { index: 0, text: "작업대 위젯 훑어보기", checked: false },
        { index: 1, text: "오늘 실행 결과 확인", checked: false },
      ],
      tomorrow: [],
      fileExists: true,
    };
  };
  const saveTodos = (view: TodoSections) =>
    localStorage.setItem("sawhorse.preview-todos", JSON.stringify(view));
  // 호스트가 붙이는 중복 판정 키를 브라우저 체험에서도 같은 규칙으로 만든다.
  const previewTaskKey = (id: string): string => {
    if (id === "core.promote") return jobRequestKey({ kind: "promote" });
    const [packId, actionId] = id.split(".", 2);
    return actionId
      ? jobRequestKey({ kind: "action", packId, actionId })
      : jobRequestKey({ kind: "task", taskId: id });
  };
  const builtinTask = (id: string, title: string, prompt: string): TaskRow => ({
    def: {
      id,
      title,
      prompt,
      schedule: null,
      enabled: true,
      builtin: true,
      skill: null,
      project: null,
      source: { kind: id.startsWith("core.") ? "core" : "pack" },
      createdAt: "",
      updatedAt: "",
    },
    lastRun: null,
    jobKey: previewTaskKey(id),
  });
  switch (command) {
    case "list_tasks":
      return {
        builtin: [
          builtinTask(
            "si.milestone",
            "마일스톤 계획",
            "납기·릴리스·검수 목표를 정리하고 이슈를 묶습니다.",
          ),
          builtinTask(
            "core.promote",
            "인박스 승격 검토",
            "미승격 항목을 검토해 이슈로 승격합니다.",
          ),
        ],
        tasks: readTasks(),
        pending: [],
        rejected: [],
      };
    case "save_task": {
      const def = structuredClone(args.def) as TaskDef;
      if (!def.title.trim() || !def.prompt.trim())
        throw new Error("제목과 실행 내용을 입력하세요.");
      def.id ||= crypto.randomUUID();
      def.createdAt ||= new Date().toISOString();
      def.updatedAt = new Date().toISOString();
      const rows = readTasks();
      const old = rows.find((r) => r.def.id === def.id);
      saveTasks([
        ...rows.filter((r) => r.def.id !== def.id),
        { def, lastRun: old?.lastRun ?? null, jobKey: previewTaskKey(def.id) },
      ]);
      return def;
    }
    case "delete_task":
      saveTasks(readTasks().filter((r) => r.def.id !== args.id));
      return;
    case "set_task_enabled":
      saveTasks(
        readTasks().map((r) =>
          r.def.id === args.id
            ? { ...r, def: { ...r.def, enabled: Boolean(args.enabled) } }
            : r,
        ),
      );
      return;
    case "set_connector_enabled":
      if (args.id === "github" && args.enabled)
        localStorage.setItem("sawhorse.preview-github-installed", "true");
      localStorage.setItem(
        `sawhorse.preview-extension-${args.id}`,
        String(args.enabled),
      );
      return;
    case "extensions_list":
      return {
        bundles: (["feeds", "github"] as const)
          .filter(
            (id) =>
              id === "feeds" ||
              localStorage.getItem("sawhorse.preview-github-installed") ===
                "true" ||
              localStorage.getItem("sawhorse.preview-extension-github") ===
                "true",
          )
          .map((id) => ({
            enabled:
              (localStorage.getItem(`sawhorse.preview-extension-${id}`) ??
                (id === "feeds" ? "true" : "false")) === "true",
            manifest: {
              id,
              name: id === "feeds" ? "읽을거리" : "GitHub 이슈 연동",
              version: "0.1.0",
              components: [
                {
                  id: id === "feeds" ? "rss" : "issues",
                  type: "connector",
                  adapter: id === "feeds" ? "builtin:rss" : "builtin:github",
                  requests: {
                    repository: [],
                    issues: [],
                    network: [],
                    secrets: [],
                  },
                },
              ],
            },
            source: id === "feeds" ? "builtin" : "user",
            dir: "",
          })),
      };
    case "github_account":
      return JSON.parse(
        localStorage.getItem("sawhorse.preview-github-account") ?? "null",
      );
    case "github_oauth_start":
      return {
        flowId: "preview-oauth-flow",
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        expiresIn: 900,
        interval: 1,
      };
    case "github_oauth_poll": {
      const user = { login: "preview-user", name: "예제 계정" };
      localStorage.setItem(
        "sawhorse.preview-github-account",
        JSON.stringify(user),
      );
      return { status: "complete", account: user };
    }
    case "github_oauth_cancel":
    case "open_external":
      return;
    case "github_disconnect":
      localStorage.removeItem("sawhorse.preview-github-account");
      return;
    case "github_repositories":
      return {
        repositories: [
          {
            id: "1001",
            name: "workspace",
            fullName: "preview-user/workspace",
            description: "팀 작업공간",
            private: true,
            archived: false,
            language: "TypeScript",
            updatedAt: "2026-09-06T12:00:00Z",
          },
          {
            id: "1002",
            name: "docs",
            fullName: "preview-user/docs",
            description: "프로젝트 문서",
            private: false,
            archived: false,
            language: null,
            updatedAt: "2026-09-05T12:00:00Z",
          },
        ],
        hasMore: false,
      };
    case "sources_upsert_instance": {
      const rows = JSON.parse(
        localStorage.getItem("sawhorse.preview-sources") ?? "[]",
      ) as Array<{ instanceId: string }>;
      localStorage.setItem(
        "sawhorse.preview-sources",
        JSON.stringify([
          ...rows.filter((r) => r.instanceId !== args.instanceId),
          { instanceId: args.instanceId, config: args.config },
        ]),
      );
      return { ok: true, instanceId: args.instanceId };
    }
    case "sources_list_instances":
      return {
        instances: JSON.parse(
          localStorage.getItem("sawhorse.preview-sources") ?? "[]",
        ),
        deadLetters: [],
      };
    case "list_issues":
    case "list_improvements":
      return JSON.parse(
        localStorage.getItem("sawhorse.preview-issues") ?? "[]",
      );
    case "list_vault_tree":
      return [
        { rel: "일지", dir: true },
        { rel: "일지/2026-09-07.md", dir: false },
        { rel: "개념", dir: true },
        { rel: "개념/정본.md", dir: false },
        { rel: "문서", dir: true },
        { rel: "문서/프로젝트 개요.md", dir: false },
      ];
    case "read_vault_note":
      return {
        title:
          String(args.rel ?? "")
            .split("/")
            .pop()
            ?.replace(/\.md$/, "") ?? "문서",
        markdown: "# 미리보기 문서\n\n볼트에 저장된 문서입니다.",
      };
    case "query_pack_view": {
      const viewId = String(args.viewId ?? "");
      return viewId === "logs"
        ? {
            folders: ["일지", "기록"],
            truncated: false,
            rows: [
              {
                path: "/preview/일지/2026-09-07.md",
                rel: "일지/2026-09-07.md",
                title: "2026-09-07",
                mtimeMs: Date.now(),
                fields: {},
              },
            ],
          }
        : {
            folders: ["개념"],
            truncated: false,
            rows: [
              {
                path: "/preview/개념/정본.md",
                rel: "개념/정본.md",
                title: "정본",
                mtimeMs: Date.now(),
                fields: { domain: "지식관리" },
              },
            ],
          };
    }
    case "set_issue_milestone": {
      const rows = JSON.parse(
        localStorage.getItem("sawhorse.preview-issues") ?? "[]",
      ) as Array<{ path: string; milestone: string }>;
      const paths = args.paths as string[];
      localStorage.setItem(
        "sawhorse.preview-issues",
        JSON.stringify(
          rows.map((r) =>
            paths.includes(r.path) ? { ...r, milestone: args.milestone } : r,
          ),
        ),
      );
      return;
    }
    case "inbound_list":
      return { inbound: [] };
    case "remote_operations_list":
      return { operations: [] };
    case "list_packs":
      return { packs: previewPacks, broken: [] };
    case "list_nav":
      return previewNav;
    // 작업대 위젯이 쓰는 읽기·쓰기. 브라우저 체험에서도 실행 타임라인과
    // 체크리스트가 실제로 움직여야 위젯의 값어치를 확인할 수 있다.
    case "list_jobs":
      return readJobs();
    case "enqueue_job": {
      const req = (args.req ?? {}) as { kind?: string; ids?: string[] };
      const kind = (req.kind ?? "action") as Job["kind"];
      const job: Job = {
        id: crypto.randomUUID(),
        kind,
        label: `${req.kind === "design" ? "설계" : "실행"} ${(req.ids ?? []).join(", ")}`,
        dedupKey: jobRequestKey({ kind, ids: req.ids }),
        status: "queued",
        createdAtMs: Date.now(),
        runner: "headless",
      };
      saveJobs([job, ...readJobs()].slice(0, 30));
      return job;
    }
    case "run_task_now": {
      const row = readTasks().find((r) => r.def.id === args.id);
      const job: Job = {
        id: crypto.randomUUID(),
        kind: "task",
        label: row?.def.title ?? String(args.id ?? "실행"),
        dedupKey: previewTaskKey(String(args.id ?? "")),
        status: "running",
        createdAtMs: Date.now(),
        startedAtMs: Date.now(),
        runner: "headless",
      };
      saveJobs([job, ...readJobs()].slice(0, 30));
      return job;
    }
    case "cancel_job":
      saveJobs(
        readJobs().map((job) =>
          job.id === args.id
            ? { ...job, status: "cancelled" as const, finishedAtMs: Date.now() }
            : job,
        ),
      );
      return;
    case "list_todos":
      return readTodos();
    case "toggle_todo": {
      const view = readTodos();
      const section = args.section === "tomorrow" ? "tomorrow" : "today";
      view[section] = view[section].map((item) =>
        item.index === args.index
          ? { ...item, checked: Boolean(args.checked) }
          : item,
      );
      saveTodos(view);
      return;
    }
    case "approve_issue":
    case "approve_note": {
      const rows = JSON.parse(
        localStorage.getItem("sawhorse.preview-issues") ?? "[]",
      ) as Array<{ path: string; status: string; approve: boolean }>;
      localStorage.setItem(
        "sawhorse.preview-issues",
        JSON.stringify(
          rows.map((row) =>
            row.path === args.path
              ? { ...row, approve: true, status: "승인" }
              : row,
          ),
        ),
      );
      return;
    }
    case "list_missed":
    case "list_schedules":
    case "list_extension_packages":
    case "ingestion_list":
      return [];
    default:
      throw new Error("이 기능은 데스크톱 앱에서 사용할 수 있습니다.");
  }
}
