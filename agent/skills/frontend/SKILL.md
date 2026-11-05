---
name: frontend
description: Select one frontend capability module and route accepted implementation to frontend-worker; unresolved material design goes to ui-ux-specialist first.
---

# Frontend
Known/approved design -> frontend-worker. Material unresolved design/flow/accessibility
judgment -> ui-ux-specialist before affected writes; unresolved API shape -> api-specialist.
Unknown-cause bugs follow harness DEBUG. Leaf agents read assigned modules, never launch roles.

## Go straight to the module guide
One routing level (after "Is Progressive Disclosure All You Need for Long-Context Agents?", arXiv 2607.17598: one level of on-demand
disclosure helped, a second routing level never did): each row says when and who, then names the guide to read. In that guide, search
its headings and read only the matching section; resolve relative reference and script paths from the module folder. Each module's
index.md holds the same pointer for prompts and roles that name it.

| Need | When and who | Read |
|---|---|---|
| Screen sequence/branches/recovery | Before visual design; ui-ux-specialist hands off the flow, frontend-worker implements it; reuse an accepted flow; expose open product decisions | ux-flow-wireframer/guide.md (the relevant mode) |
| Dashboard/KPI/table/chart information design | Choose critique, concept, redesign, spec or grill from the request; ui-ux-specialist owns open dashboard design | design-dashboards/guide.md (the chosen mode) and references/dashboard-design-principles.md; operational monitoring also uses its Operational Dashboard section |
| Motion/interaction | Only for material motion; build guidance for new behavior, audit guidance for a requested audit; keep reduced motion; follow the project stack | design-motion-principles/guide.md, then only the matching designer/reference file |
| New visual direction | Aesthetic direction materially open; ui-ux-specialist decides, frontend-worker implements; use this OR ui-ux-pro-max unless a separate need justifies both | frontend-design/guide.md (license in LICENSE.txt) OR ui-ux-pro-max/guide.md (its search/workflow section, then the scripts/ helper against data/; return selected matches; SolidJS takes general advice, not React/Next.js code) |
| Optional design tokens/theme/design spec/page override | Only when the accepted UI lacks them | design-system-artifacts/index.md (the procedure itself) |
| Keyboard/focus/ARIA/forms | Prefer native elements; ui-ux-specialist settles interaction judgments; a checklist does not replace selected VERIFY/REVIEW | accessible-ui-patterns/guide.md (sources in SOURCES.md) |
| Existing UI guideline audit | An explicit audit only; inspect the requested files; no edit authority | web-design-guidelines/guide.md (it says how to fetch the current guidelines) |
| Complex TypeScript types | Only for materially complex generics, conditional/mapped/template types or type utilities; frontend-worker implements; check valid and invalid cases | typescript-advanced-types/guide.md |

Modules are reference procedures, not separate auto-invoked skills. Relative resources
belong to their module folder. Read only the matching guide section;
do not load every capability, catalog or design dataset. Reuse accepted design and loaded
guidance. A capability does not add implementation authority or independent review gates.
Main launches actual named roles with global packets; await evidence and report briefly.
