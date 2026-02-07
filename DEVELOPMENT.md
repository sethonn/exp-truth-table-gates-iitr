# Development: Automating commits

Quick helper to commit and push all workspace changes.

Usage:

- Make sure you have `git` configured and the repository has a remote named `origin`.
- Run the script directly:

```bash
./scripts/auto-commit.sh "Your commit message"
```

Or use the `Makefile` target:

```bash
make commit MSG="Your commit message"
```

The script stages all changes, creates a commit if there are staged changes, and pushes to the current branch.
