---
name: adversarial-tester
description: "Attack a PR or green suite in a fresh agent to break it. Use when asked to 'attack this PR', or on a green test suite before trusting it, especially AI-written code with AI-written tests. Hands the brief in .claude/agents/adversarial-tester.md to a separate agent with its own context, so it does not share the author's blind spots. Works in any harness (Claude Code subagent, Hermes delegate_task). Succeeds only by making green tests fail; reports findings, fixes nothing."
---

# Adversarial tester

A green suite written by the same agent that wrote the code proves little: the same
blind spots wrote both. This skill hands the code to a second agent with a clean
context, whose only job is to make green fail.

## How to run it

1. **Read the brief** in `.claude/agents/adversarial-tester.md` (everything below its
   frontmatter). That file is the single source of truth for what the tester does.
2. **Hand the brief to a fresh agent** with its own context, plus what to attack
   (the changed files or the module name):
   - Claude Code: run the `adversarial-tester` subagent.
   - Hermes: `delegate_task` with the brief as the goal and the repo as the working directory.
   - Any other harness: its subagent / delegate tool. If it has none, start a new session.
   Never run the brief in your own context: you wrote or read the code, so you share its blind spots.
3. **Report its findings unedited**: each failing case, the input that breaks it, and
   whether it changes an amount the system pays anyone. Do not fix anything in this
   step — the fix is the coder's job, in the next round.
