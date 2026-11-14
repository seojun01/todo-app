<!--
Sync Impact Report
- Version change: (unversioned template) → 1.0.0
- Modified principles (placeholder → concrete):
  - [PRINCIPLE_1_NAME] → I. User-Centric Simplicity
  - [PRINCIPLE_2_NAME] → II. Data Integrity & Ownership
  - [PRINCIPLE_3_NAME] → III. Test-First (NON-NEGOTIABLE)
  - [PRINCIPLE_4_NAME] → IV. Accessible & Responsive UI
  - [PRINCIPLE_5_NAME] → V. Minimal Dependencies & YAGNI
- Added sections: Technical Constraints; Development Workflow & Quality Gates
- Removed sections: none
- Deferred TODOs: none (ratification date set to initial adoption, 2026-11-12)
- Note: Remove this report before committing the constitution.
-->

# Todo App Constitution

## Core Principles

### I. User-Centric Simplicity

- Every feature MUST map to a concrete user story with acceptance criteria before work begins.
- Core task actions (create, edit, complete, delete) MUST be reachable in at most two
  interactions from the main view.
- New UI elements or settings MUST justify their existence in the spec; when in doubt, leave
  them out.

Rationale: A todo app succeeds by being faster than pen and paper; every extra step erodes that.

### II. Data Integrity & Ownership

- User actions that change data MUST be persisted before the UI reports success; no silent loss
  of tasks on reload, crash, or offline use.
- Destructive actions (delete, bulk clear) MUST be undoable or require explicit confirmation.
- Users MUST be able to export their data in an open format (e.g., JSON).
- Personal data MUST NOT be sent to third parties without explicit user consent.

Rationale: Users trust the app with their commitments; losing or leaking a task breaks that
trust permanently.

### III. Test-First (NON-NEGOTIABLE)

- Tests MUST be written and observed failing before the implementing code is written
  (Red → Green → Refactor).
- Every user story MUST have at least one automated test that exercises its acceptance criteria.
- Bug fixes MUST include a regression test that fails without the fix.
- The full test suite MUST pass before any change is merged.

Rationale: Tests are the executable form of the spec and the only reliable guard against
regressions.

### IV. Accessible & Responsive UI

- Interfaces MUST meet WCAG 2.1 AA: full keyboard operability, visible focus, sufficient
  contrast, and semantic labels for assistive technology.
- Layouts MUST work from 320px mobile width up to desktop without horizontal scrolling.
- User-perceived interactions (add, toggle, delete) MUST respond within 100 ms under normal
  conditions; initial load SHOULD be interactive within 2 seconds on a mid-range device.

Rationale: A productivity tool must be usable by everyone, on whatever device is at hand.

### V. Minimal Dependencies & YAGNI

- Build only what current specs require; speculative abstractions and features are prohibited.
- Each new runtime dependency MUST be justified in the plan (why it is needed, what it costs,
  why a few lines of own code would not suffice).
- Prefer platform/standard-library capabilities over third-party packages.

Rationale: Small surface area keeps the app fast, secure, and easy to change.

## Technical Constraints

- The concrete technology stack is chosen per feature in `/speckit-plan` and MUST be recorded
  in the plan along with its justification against Principle V.
- Inputs from users MUST be validated and output MUST be escaped to prevent injection (XSS, etc.).
- Secrets and credentials MUST NOT be committed to the repository.
- Data schemas that persist user data MUST be versioned; schema changes MUST include a
  migration path for existing data.

## Development Workflow & Quality Gates

- Work follows the Spec Kit flow: `/speckit-specify` → `/speckit-clarify` (as needed) →
  `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`.
- Every plan MUST include a Constitution Check confirming compliance with each principle;
  any violation MUST be listed with justification in the plan's Complexity Tracking section.
- Changes are merged only when: tests pass, linting/formatting checks pass, and the change has
  been reviewed against this constitution.
- Commits SHOULD be small and focused, with messages describing the intent of the change.

## Governance

- This constitution supersedes all other development practices for this project. Where a spec,
  plan, or task conflicts with it, the constitution prevails.
- Amendments MUST be made via `/speckit-constitution`, documented with a Sync Impact Report, and
  reviewed before adoption. Dependent artifacts (specs, plans, tasks) MUST be re-checked after
  an amendment.
- Versioning follows semantic versioning:
  - MAJOR: removal or backward-incompatible redefinition of a principle or governance rule.
  - MINOR: new principle or section, or materially expanded guidance.
  - PATCH: clarifications, wording, and typo fixes with no semantic change.
- Compliance is reviewed at every plan (Constitution Check gate) and at every code review;
  unjustified complexity is grounds for rejecting a change.

**Version**: 1.0.0 | **Ratified**: 2026-11-12 | **Last Amended**: 2026-11-12
