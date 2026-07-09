# 03 — claude CLI: use an interactive login shell to read PATH

**Area:** Rust backend (`src-tauri/src/lib.rs`) · **Type:** bug · **Related:** 01, 02

## Problem

Specs 01 and 02 both need to "ask the user's shell" — for the resolved `claude`
path (02) and for the login-shell PATH handed to the spawned child (01). If that
shell is invoked as a **non-interactive** login shell (`$SHELL -lc '…'`), it
comes back empty or wrong under launchd's minimal environment, and both fixes
silently fail: `claude` still isn't found and `node` still isn't on the child's
PATH.

## Root cause

macOS shell-sourcing rules:

- A **login** shell (`-l`) sources `.zprofile` / `.zshenv` (zsh) or `.bash_profile`.
- An **interactive** shell (`-i`) sources `.zshrc` / `.bashrc`.

Toolchain PATH lines (nvm/fnm init, Homebrew `shellenv`, Volta, corporate
toolbox dirs) are **very commonly placed in `.zshrc` / `.bashrc`**, which a
`-lc` (login, non-interactive) shell does **not** source. So under launchd's
minimal env, `$SHELL -lc 'command -v claude'` resolves nothing and
`$SHELL -lc 'printf %s "$PATH"'` returns a PATH missing node.

Proof pattern (scrubbed env):

```
env -i HOME=$HOME /bin/zsh -lc  'command -v claude'   # → empty
env -i HOME=$HOME /bin/zsh -ilc 'command -v claude'   # → /path/to/the/real/claude
```

## The change

Use an **interactive login shell** — `$SHELL -ilc '…'` — everywhere Quill reads
the user's shell to discover `claude` or PATH. Both the binary-resolution step
(spec 02) and the child-PATH login-shell read (spec 01).

Two robustness details, because interactive shells may print rc banners/MOTD to
stdout:

- **Resolving the binary:** take the **last non-empty line** of stdout as the
  path (a banner printed before `command -v` output can't be mistaken for it).
- **Reading PATH:** print it with a **sentinel prefix** and parse the sentinel
  line, e.g. `printf '___QUILL_PATH___%s\n' "$PATH"` then find the line starting
  with `___QUILL_PATH___`. This isolates the PATH from any rc chatter.

## Trade-off (accept it)

Interactive shells are slightly slower and may run rc side effects. That's an
acceptable cost for correct resolution; the sentinel / last-line parsing contains
the banner-noise downside.

## Verify

- With a PATH-setting line in `.zshrc` (not `.zprofile`), confirm the resolver
  finds `claude` and the child PATH contains node — where a `-lc` variant would
  have failed.
- Real-app check (built `.app` from Finder): `@claude` works end-to-end.

## Notes for the porter

- This is a one-flag change (`-lc` → `-ilc`) plus the sentinel/last-line parsing,
  applied at **both** shell-invocation sites. Grep for `-lc` in the Rust backend.
- If the public repo has only one such site today, the same `-ilc` + parsing
  discipline applies there.
