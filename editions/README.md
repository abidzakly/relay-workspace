# Editions

An edition is a folder here with a `presets.json`. Relay reads it once at start (the first folder by name, if there
are several) and uses it as defaults:

- `global`: any part of the global settings (Settings > General, Connections and so on). These are the defaults until
  the first save in Settings; after that, the saved settings win and the presets are not read again.
- `repo`: pre-fills the "Add repository" form: `reviewers`, `versionBranchPrefix`, `baseBranch`.

A file that does not parse is logged and ignored. The general edition ships no presets.

Example `editions/acme/presets.json`:

```json
{
  "global": {
    "gitlab": { "host": "https://gitlab.acme.example" },
    "features": { "reviews": true }
  },
  "repo": {
    "reviewers": ["lead.reviewer"],
    "versionBranchPrefix": "release/v"
  }
}
```
