# Background agent execution

Workbench harness runs use background execution in `auto` and `headless` modes. Only an explicitly selected `herdr` execution mode creates an interactive agent pane at launch. Existing run records without a `runner` field retain their original herdr ownership.

The harness supports background Claude (`-p`, streamed JSON), Codex (`exec --json`, workspace-write sandbox), and OMP (`-p`). Unsupported drivers persist a failed run with an explanation; they do not silently open terminal panes. Repository scope, trusted extra directories, selected model, parent relationship, and original instructions remain on the durable run record. The configured concurrent harness limit applies to both runners. Legacy jobs that share vault state retain their serial background scheduling.

“View in herdr” opens a live transcript viewer for a background run. Repeated clicks focus the existing viewer. Opening or closing the viewer does not launch, interrupt, or duplicate the agent. Interactive herdr runs retain their existing focus/resume behavior. A background follow-up stays in the background; Claude resumes its recorded conversation, while other supported drivers receive the accumulated instructions in a new CLI turn.

Each background turn has its own stdout/stderr files and appends output to the durable transcript. A zero exit code without a closing report is a failure for structured drivers. Permission denials, process errors, timeout, cancellation, and abandoned runs after restart remain visible. Successful turns enter human review; they do not mark the work complete. Restart recovery reports interrupted execution instead of automatically rerunning potentially partial work.

The dashboard's attention area and execution-list filter show the latest failed, stopped, blocked, or unknown run per work item and role. Closed work is excluded. Details retain errors, output, runner, and retry controls. Retry creates a new run through the current launch gates using the original user instructions, preserving the previous failure for inspection. The execution list also polls for newly created child runs and displays refresh failures.

Validation covers structured completion and permission errors, actual background subprocess output and early exits, cancellation/timeouts, restart recovery, explicit viewer creation without duplicate agents, and the dashboard-to-run-details flow. Browser preview does not execute real agents or open herdr.
