# pi-prune

## Overview

Prune tool data and thinking blocks from the current Pi session.

## Requirements

This command rewrites the active session file using Pi's internal rewrite primitive. Before replacing content it writes recoverable originals under a `pi-prune-artifacts` directory beside the session file. Ephemeral sessions have no recovery artifact.

## Installation

```sh
pi install npm:@yukikisaku/pi-prune
```

## Usage

Run `/prune`, `/prune tool`, or `/prune thinking`. The default prunes both categories while preserving skill tool content. Before a saved session is rewritten, the removed originals are written to a Markdown artifact and the result message shows its recovery path. Ephemeral sessions are pruned without creating a recovery artifact because they have no session file.

## Configuration

No configuration. Recovery artifacts are always stored in a `pi-prune-artifacts` directory beside the active session file, with one Markdown file created for each prune operation.

## Uninstallation

```sh
pi uninstall npm:@yukikisaku/pi-prune
```

Remove any package-specific configuration described above if you no longer need it.

## Pull requests

This repository includes a policy for automatic AI review and merge of incoming pull requests. It becomes active when the CI and merge workflows are on `main` and the maintainer's GitHub event automation is enabled; a draft setup PR does not activate it.

Once active, AI reviews each non-draft PR and it is merged automatically only when the review has no findings, required CI succeeds, and there are no conflicts or unresolved review threads. New commits require a new review. Changes to the automation itself require manual merge. See [AI review and merge operations](docs/ai-review-operations.md).

## License

MIT © yuki-kisaku. See [LICENSE](LICENSE).
