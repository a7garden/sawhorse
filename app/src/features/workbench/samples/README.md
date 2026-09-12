The shared sample bundle contains six built-in workflow examples pinned to their original versions: SDD,
Intent Flow v2, TDD, SDD + TDD, Issues, and Goals. It includes 31 work items,
166 artifact documents, and 18 calendar events. All authored content is English.

Use **Projects → Add sample projects** in the app, or:

```sh
sawhorse --vault /path/to/workspace project samples
```

The importer preserves existing projects and files. IDs use the `sample-` prefix;
date tokens such as `{{day:5}}` resolve relative to the local creation date.
Goals start paused or completed, lifecycle queues are disabled, and repository
paths are empty. Sample evidence is explicitly illustrative.

`data.json` is shared by the desktop importer and browser preview. Classification
codes in the bundle and Markdown use English; the read boundary maps them to the
application's existing classification vocabulary. `workflows.json` holds all canonical built-in revisions for the browser preview,
including the eight latest workflow types and immutable history. Bugfix and
Refactor are available in the catalog without adding sample projects. Desktop
definitions come from the Rust catalog; a Rust test checks that the preview
export matches it.
