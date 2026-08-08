main

# TextBee

- Dashboard
- Path: - ../text_bee_dashoard

- Mobile App
- Path: - ../text_bee

# Sarah Time - Project Instructions

## Project Overview

This project is part of the Sarah Time workspace.

Current Project:

- Dashboard
- Path: - sarah_time_dashboard

Related Project:

- Mobile App
- Path: - ../sarah_time

These two projects represent the same product and MUST remain consistent whenever possible.

---

# Priority Order

Always follow instructions in this order:

1. Your global instructions
2. This project instruction file
3. Task-specific user instructions

If there is any conflict, ask for clarification instead of making assumptions.

---

# Before Starting Any Task

Before writing or modifying code:

1. Understand the user's request.
2. Search the current project first.
3. Determine whether the same feature already exists in the related project.
4. If it exists, inspect its implementation before writing code.
5. Reuse existing architecture, naming, API contracts, validation, and business logic whenever appropriate.
6. Only introduce a different implementation if there is a valid technical reason.

Never skip these steps.

---

# Cross Project Rules

When implementing a feature in Dashboard:

First inspect:

/Users/sayed/Documents/GitHub/sarah_time

When implementing a feature in Mobile App:

First inspect:

- sarah_time_dashboard

Always compare:

- Folder structure
- Naming conventions
- Models
- DTOs
- API endpoints
- Validation
- Business logic
- Error handling
- Permission flow
- State management
- User experience

Do not blindly copy code.

Instead:

- Understand the implementation.
- Adapt it to the current project's architecture.
- Keep behavior consistent across projects.

---

# Feature Synchronization

If the requested feature exists in the other project:

- Study it completely.
- Reuse the same terminology.
- Reuse API contracts.
- Reuse validation rules.
- Reuse response handling.
- Reuse business rules.
- Reuse loading and error behavior where applicable.

Only deviate if:

- Platform requirements differ.
- The user explicitly requests different behavior.
- The existing implementation contains a bug.

Whenever you intentionally deviate, explain why.

---

# Shared Knowledge

Treat both repositories as parts of the same product.

Knowledge learned from one project should be reused in the other whenever applicable.

Never reinvent an existing solution without checking first.

---

# If Something Cannot Be Found

If a related implementation cannot be located:

1. Tell the user what you searched.
2. Mention which project was inspected.
3. Then implement using the current project's architecture.

Never pretend that an implementation exists.

---

# Large Features

For non-trivial tasks:

Before writing code:

- Explain your implementation plan.
- Mention which project(s) you inspected.
- Mention which files you intend to modify.

Then wait if clarification is required.

---

# Consistency Rules

Prefer consistency over creativity.

Avoid introducing:

- New architecture
- New naming style
- New folder structure
- New state management approach
- Duplicate shared logic

unless explicitly requested.

---

# Final Checklist

Before finishing every task verify:

✓ Current project architecture is preserved.

✓ Related project has been inspected (when applicable).

✓ Naming is consistent.

✓ API contract remains consistent.

✓ Validation remains consistent.

✓ No duplicate implementation has been introduced.

✓ User instructions have been followed.
