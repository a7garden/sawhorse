import type {
  AgentsView,
  ConfigPatch,
  ConfigView,
  DashboardCfg,
  Diagnostics,
  Job,
  NavEntry,
  PackInfo,
  PackView,
  RequirementStatus,
  TaskDef,
  TaskRow,
  TodoSections,
} from "./types";
import { jobRequestKey } from "./jobs";
import i18n from "@/i18n";


function previewJournalRows() {
  return [0, 1, 2, 4, 5, 7, 10].map((offset, index) => {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return {
      path: `/preview/일지/${key}.md`, rel: `일지/${key}.md`, title: key,
      mtimeMs: date.getTime(), fields: {
        date: key,
        mood: index % 2 === 0 ? "집중" : "차분함",
        tags: index % 2 === 0 ? ["sawhorse", "디자인"] : ["회고", "개발"],
        summary: ["기록을 읽기 좋은 하루의 흐름으로", "작은 개선을 차곡차곡", "작업대에서 다음 할 일 찾기"][index % 3],
      },
    };
  });
}

const PREVIEW_VAULT_VIEWS: Array<{
  packId: string;
  packName: string;
  view: PackView;
}> = [
  {
    packId: "journal",
    packName: "일지",
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
    packId: "concepts",
    packName: "개념",
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
    packId: "todos",
    packName: "할 일",
    view: {
      id: "todos",
      label: "할 일",
      icon: "square-check-big",
      type: "native",
      component: "todos",
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
    "journal",
    "일지",
    PREVIEW_VAULT_VIEWS.filter((item) => item.packId === "journal").map(
      (item) => item.view,
    ),
  ),
  previewPack(
    "concepts",
    "개념",
    PREVIEW_VAULT_VIEWS.filter((item) => item.packId === "concepts").map(
      (item) => item.view,
    ),
  ),
  previewPack(
    "todos",
    "할 일",
    PREVIEW_VAULT_VIEWS.filter((item) => item.packId === "todos").map(
      (item) => item.view,
    ),
  ),
  previewPack("project-docs", "프로젝트 문서화", []),
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
const PREVIEW_DISABLED_PACKS_KEY = "sawhorse.preview-disabled-packs";
function previewDisabledPacks(): Set<string> {
  return new Set(
    JSON.parse(localStorage.getItem(PREVIEW_DISABLED_PACKS_KEY) ?? "[]") as string[],
  );
}
function enabledPreviewPacks(): PackInfo[] {
  const disabled = previewDisabledPacks();
  return previewPacks.map((pack) => ({ ...pack, enabled: !disabled.has(pack.id) }));
}
// 설정 화면 미리보기 — 브라우저에서 설정 다섯 탭이 실제로 그려지게 하는 최소 데이터.
// 데스크톱 명령을 흉내만 내며 어떤 파일도 만지지 않는다.
const CONFIG_KEY = "sawhorse.preview-config";
const previewConfigBase: ConfigView = {
  exists: true,
  vaultPath: "/Users/won/Documents/vault",
  defaultProject: "Sawhorse",
  projects: [
    {
      name: "Sawhorse",
      path: "/Volumes/MERCURY/PROJECTS/sawhorse",
      workBranch: "main",
      portableBase: "",
      idPrefix: "SH",
      verify: "npm run build",
    },
    {
      name: "Herdr",
      path: "/Volumes/MERCURY/PROJECTS/herdr",
      workBranch: "main",
      portableBase: "",
      idPrefix: "HD",
      verify: "cargo check",
    },
  ],
  coreProjects: {},
  dashboard: {
    schedules: {
      morning: { enabled: true, time: "08:00" },
      lunch: { enabled: false, time: "12:30" },
      evening: { enabled: true, time: "19:00" },
    },
    excelOutputDir: "",
    claudeBin: "claude",
    permissionMode: "acceptEdits",
    launchAtLogin: false,
    herdr: {
      mode: "auto",
      bin: "herdr",
      session: "",
      workspaceLabel: "sawhorse",
      cleanup: "closeAlways",
      maxParallel: 3,
      startTimeoutSec: 60,
      jobTimeoutMin: 120,
      notify: true,
      childModelPolicy: "auto",
    },
    customAgents: [],
    collaboration: {
      localIntegrationApproval: "required",
      verificationMode: "command",
      failurePolicy: "pause",
      integrationStrategy: "worktree",
      remoteWriteApproval: "required",
    },
  },
};
const readConfig = (): ConfigView => {
  const stored = localStorage.getItem(CONFIG_KEY);
  return stored
    ? (JSON.parse(stored) as ConfigView)
    : structuredClone(previewConfigBase);
};
const saveConfig = (view: ConfigView) =>
  localStorage.setItem(CONFIG_KEY, JSON.stringify(view));
const previewDiagnostics: Diagnostics = {
  configExists: true,
  vaultPathOk: true,
  claudeOk: true,
  claudeVersion: "2.1.7 (Claude Code)",
  herdr: {
    mode: "auto",
    binOk: false,
    serverOk: false,
    effectiveRunner: "headless",
    reason: "herdr 실행 파일을 찾지 못했습니다",
  },
  projects: [
    { name: "Sawhorse", pathOk: true, gitOk: true, branchOk: true },
    { name: "Herdr", pathOk: false, gitOk: false, branchOk: null },
  ],
};
const previewRequirements: RequirementStatus[] = [
  {
    id: "obsidian",
    name: "Obsidian",
    need: "recommended",
    why: "작업공간 노트를 사람이 읽고 고치는 앱입니다. 없어도 앱 안에서 문서를 편집할 수 있습니다.",
    detected: true,
    path: "/Applications/Obsidian.app",
    outdated: false,
    minMajor: 0,
    installUrl: "https://obsidian.md/download",
    installHint: "",
  },
  {
    id: "herdr",
    name: "herdr",
    need: "recommended",
    why: "잡을 보이는 터미널 세션에서 실행",
    detected: false,
    path: "",
    outdated: false,
    minMajor: 0,
    installUrl: "https://github.com/a7garden/herdr",
    installHint: "cargo install herdr",
  },
];
// 동봉 확장 패키지. 체험 화면이 실제 앱과 같은 설치 목록을 보게 한다.
const previewExtensionPackages = [
  {
    manifest: {
      manifestVersion: 2,
      id: "ui-mockup",
      publisher: "sawhorse",
      name: "Issue-driven UI Mockup",
      version: "1.1.0",
      engineApi: "^1.0",
      dependencies: [],
      provides: ["generator:ui-mockup", "artifact:mockup"],
      contributions: {
        workflows: ["workflows/mockup-review.json"],
        schemas: [],
        templates: [],
        views: ["views/candidates.json", "views/artifacts.json"],
        actions: ["actions/generate.json", "actions/process-feedback.json"],
        skills: ["skills/mockup-generator"],
        analyzers: [],
        exporters: [],
      },
      permissions: ["vault:read", "vault:write", "adapter:ui-mockup"],
      fileDigests: {},
    },
    digest: "preview-ui-mockup",
    path: "builtin",
    source: "builtin",
    commit: null,
    installedAt: "",
  },
  {
    manifest: {
      manifestVersion: 2,
      id: "xlsx-export",
      publisher: "sawhorse",
      name: "XLSX Export",
      version: "1.0.0",
      engineApi: "^1.0",
      dependencies: [],
      provides: ["exporter:xlsx"],
      contributions: {
        workflows: [],
        schemas: [],
        templates: [],
        views: ["views/reports.json"],
        actions: ["actions/export.json"],
        skills: ["skills/xlsx-export"],
        analyzers: [],
        exporters: [],
      },
      permissions: ["vault:read", "vault:write", "adapter:xlsx-export"],
      fileDigests: {},
    },
    digest: "preview-xlsx-export",
    path: "builtin",
    source: "builtin",
    commit: null,
    installedAt: "",
  },
];

const previewExtensionWorkflows = [
  {
    packageId: "ui-mockup",
    packageName: "Issue-driven UI Mockup",
    packageVersion: "1.1.0",
    source: "builtin",
    workflows: [
      {
        id: "mockup-review",
        label: "목업 검토",
        version: "1.1.0",
        description:
          "거친 이슈를 화면별 제안으로 구체화하고, 목업 피드백과 개정본을 승인까지 추적합니다.",
        nodes: 3,
      },
    ],
  },
];

const previewAgents: AgentsView = {
  agents: [
    {
      id: "claude",
      name: "claude",
      detected: true,
      version: "2.1.7",
      path: "/opt/homebrew/bin/claude",
      home: "/Users/won/.claude",
      installable: true,
      runsJobs: true,
      installUrl: "https://docs.anthropic.com/en/docs/claude-code",
      installHint: "npm install -g @anthropic-ai/claude-code",
      custom: false,
      note: "",
    },
    {
      id: "codex",
      name: "codex",
      detected: true,
      version: "0.42.0",
      path: "/opt/homebrew/bin/codex",
      home: "/Users/won/.codex",
      installable: false,
      runsJobs: true,
      installUrl: "",
      installHint: "",
      custom: false,
      note: "",
    },
    {
      id: "gemini",
      name: "gemini",
      detected: false,
      path: "",
      home: "",
      installable: true,
      runsJobs: false,
      installUrl: "https://github.com/google-gemini/gemini-cli",
      installHint: "npm install -g @google/gemini-cli",
      custom: false,
      note: "",
    },
  ],
  defaultAgent: "claude",
};
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
    case "read_note": {
      const row = previewJournalRows().find((item) => item.path === args.path);
      if (!row) return { path: args.path, title: "정본", markdown: "# 정본\n\n프로젝트의 기준이 되는 문서를 한곳에 모읍니다." };
      return { path: row.path, title: row.title, markdown: `## ${row.fields.summary}

오늘은 작업의 속도보다, 지나온 과정을 다시 읽기 쉽게 만드는 데 집중했다. 흩어진 기록을 모으니 다음에 해야 할 일이 조금 더 선명해졌다.

## 오늘 한 일

- [x] 작업대의 진행 상황과 남은 항목 확인
- [x] 일지에서 자주 읽는 내용을 정리
- [ ] 새 화면을 작은 창에서도 확인하기

## 생각과 발견

기록은 길이보다 다시 꺼내 읽을 수 있는 모양이 중요하다. 날짜와 맥락을 함께 보여주면 짧은 메모도 하루의 흐름으로 이어진다.

> 작은 개선을 하나씩 쌓아두자. 오늘의 기록이 내일의 출발점이 된다.

## 내일 이어갈 일

- 실제 일지를 읽으며 글의 간격과 정보 순서를 살펴보기
- 이번 주 작업을 돌아보고 다음 우선순위 정하기
` };
    }
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
            rows: previewJournalRows(),
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
      // 깃허브 탭 체험용 staged 이슈 하나. sources 인스턴스와 같은 저장소 id.
      return {
        inbound: [
          {
            id: "preview-ic-1",
            linkId: "",
            sourceInstance: "github-1001",
            externalId: "2001",
            payload: JSON.stringify({
              account: "preview-user",
              repositoryId: "1001",
              repository: "preview-user/workspace",
              number: 12,
              title: "미리보기 이슈",
              body: "프리뷰에서 만든 가져오기 후보 이슈다.",
              state: "open",
              url: "https://github.com/preview-user/workspace/issues/12",
              updatedAt: "2026-09-07T00:00:00Z",
            }),
            targetPath: "",
            createdAt: "2026-09-07T00:00:00Z",
          },
        ],
      };
    case "inbound_accept_import":
      return {
        notePath: `/preview/work/${String(args.projectId ?? "p")}/work.md`,
      };
    case "inbound_accept_update":
      return { notePath: "/preview/work/work.md" };
    case "remote_operations_list":
      return { operations: [] };
    case "list_packs":
      return { packs: enabledPreviewPacks(), broken: [] };
    case "list_nav":
      {
        const disabled = previewDisabledPacks();
        const nav = previewNav.filter((entry) => !disabled.has(entry.packId));
        return i18n.language.startsWith("en")
        ? nav.map((entry) => ({
            ...entry,
            packName: ({ journal: "Journal", concepts: "Concepts", todos: "Todos" } as Record<string, string>)[entry.packId] ?? entry.packName,
            label: ({ logs: "Journal", concepts: "Concepts", todos: "Todos" } as Record<string, string>)[entry.viewId] ?? entry.label,
          }))
        : nav;
      }
    case "set_pack_enabled": {
      const disabled = previewDisabledPacks();
      const id = String(args.id ?? "");
      if (args.on) disabled.delete(id);
      else disabled.add(id);
      localStorage.setItem(PREVIEW_DISABLED_PACKS_KEY, JSON.stringify([...disabled]));
      return readConfig();
    }
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
    case "get_config":
      return readConfig();
    case "save_config": {
      const patch = (args.patch ?? {}) as ConfigPatch;
      const cur = readConfig();
      const dashboard: DashboardCfg = {
        ...cur.dashboard,
        ...(patch.claudeBin != null ? { claudeBin: patch.claudeBin } : {}),
        ...(patch.permissionMode != null
          ? { permissionMode: patch.permissionMode }
          : {}),
        ...(patch.launchAtLogin != null
          ? { launchAtLogin: patch.launchAtLogin }
          : {}),
        ...(patch.schedules ? { schedules: patch.schedules } : {}),
        ...(patch.excelOutputDir != null
          ? { excelOutputDir: patch.excelOutputDir }
          : {}),
        ...(patch.herdr
          ? { herdr: { ...cur.dashboard.herdr, ...patch.herdr } }
          : {}),
        ...(patch.customAgents ? { customAgents: patch.customAgents } : {}),
        collaboration: {
          ...cur.dashboard.collaboration,
          ...(patch.dashboard?.collaboration ?? {}),
        },
      };
      const next: ConfigView = {
        ...cur,
        vaultPath: patch.vaultPath ?? cur.vaultPath,
        defaultProject: patch.defaultProject ?? cur.defaultProject,
        projects: patch.projects ?? cur.projects,
        coreProjects: patch.coreProjects ?? cur.coreProjects,
        dashboard,
      };
      saveConfig(next);
      return next;
    }
    case "set_default_agent":
      return readConfig();
    case "set_launch_at_login":
    case "herdr_probe":
      return undefined;
    case "diagnostics":
      return structuredClone(previewDiagnostics);
    case "check_requirements":
      return structuredClone(previewRequirements);
    case "list_agents":
      return structuredClone(previewAgents);
    case "list_missed":
    case "list_schedules":
    case "ingestion_list":
      return [];
    case "vault_attention":
      return {
        pendingSchemaMoves: 0,
        schemaConflicts: 0,
        schemaId: "",
        schemaRevision: 0,
        pendingLegacyIssues: 0,
      };
    case "extension_package_list":
      return structuredClone(previewExtensionPackages);
    case "extension_package_workflows":
      return structuredClone(previewExtensionWorkflows);
    case "extension_package_lock":
      return { formatVersion: 1, projects: {} };
    default:
      throw new Error("이 기능은 데스크톱 앱에서 사용할 수 있습니다.");
  }
}
