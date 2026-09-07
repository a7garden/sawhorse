export interface MockupScreen {
  id: string;
  label: string;
  context: string;
  baseline: string[];
  evidence: string[];
  proposal: string[];
  acceptance: string[];
}

export interface Mockup {
  id: string;
  title: string;
  projectId: string;
  revision: number;
  parentMockupId: string;
  issues: Array<{ id: string; title: string; screenId: string }>;
  screens: MockupScreen[];
}
