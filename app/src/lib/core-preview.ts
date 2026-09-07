import type { NavEntry, PackInfo, PackView, TaskDef, TaskRow } from "./types";

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
        { field: "domain", source: "", label: "분류", type: "badge", width: 110 },
      ],
      groupBy: "domain",
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
      actions: [],
      empty: "",
    },
  },
];

const previewPack = (id: string, name: string, views: PackView[]): PackInfo => ({
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
        throw new Error("제목과 작업 내용을 입력하세요.");
      def.id ||= crypto.randomUUID();
      def.createdAt ||= new Date().toISOString();
      def.updatedAt = new Date().toISOString();
      const rows = readTasks();
      const old = rows.find((r) => r.def.id === def.id);
      saveTasks([
        ...rows.filter((r) => r.def.id !== def.id),
        { def, lastRun: old?.lastRun ?? null },
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
        title: String(args.rel ?? "").split("/").pop()?.replace(/\.md$/, "") ?? "문서",
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
    case "list_schedules":
    case "list_extension_packages":
    case "ingestion_list":
      return [];
    default:
      throw new Error("이 기능은 데스크톱 앱에서 사용할 수 있습니다.");
  }
}
