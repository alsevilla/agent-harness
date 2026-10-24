# design-system-artifacts

Optional. Use only when tokens, a theme, a design spec or a page override are missing from the accepted UI. Skip it for ordinary component work or when accepted tokens already exist. It adds no role, gate or authority.

## Procedure
1. Inspect existing tokens, components and brand first: CSS variables, theme files, shared components and accepted product identity. Reuse them; accepted identity overrides speculative aesthetics.
2. Establish audience, product tone, platform and constraints from the brief. Let the brief lead the theme; avoid default neon, gradients or ornamental styling.
3. Define only what the work needs:
   - semantic colors: surface, text, border, accent, status (success, warning, danger, info)
   - interaction states: hover, focus, active, disabled, error, loading
   - typography scale, spacing, radii and elevation
   - contrast checks for text and interactive boundaries against their backgrounds
   - dark and light only when the task requires both; otherwise one theme
4. Produce a compact, non-persisted design handoff by default: token names and values, usage rules and acceptance checks, returned in the reply.
5. Write DESIGN.md or a page override only at a path named by the explicit task or accepted plan. It is never a universal file gate.

## Ownership
ui-ux-specialist owns material brand, palette, flow and accessibility choices. frontend-worker implements the accepted tokens and UI. Main owns assignment and sequencing; leaves launch no helpers. Pair with accessible-ui-patterns or frontend-design only as needed, not both by default.

## Boundaries
Original guidance only: no scripts, downloads, datasets, network use, third-party text or assets. It makes no performance or savings claims, and text checks do not establish visual quality.
