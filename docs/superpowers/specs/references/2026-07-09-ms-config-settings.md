# MS Copilot Studio Agent Flows — Step Config Settings Reference

**Date captured:** 2026-07-09
**Source:** 15 screenshots of Microsoft Copilot Studio "Agent flows" designer (Power Automate-style canvas) + 1 inline follow-up image, provided as parity reference for the Backstory Studio flow builder.
**Scope:** Variables, Controls, Data Operations, and Human-in-the-loop (Human review) step categories.

---

## Shared designer conventions (observed across all screenshots)

These apply to every step card and picker panel and should be treated as the baseline config UX contract:

1. **Inline canvas editing.** Step configuration is edited directly in a card on the canvas (not a separate modal). Each card has: colored category icon + step title header, a "side panel" toggle icon, and a `...` overflow menu at top-right.
2. **Insertion points.** A circled `(+)` button appears between/after every card on the canvas (with a connector arrow) for inserting the next action at that position.
3. **Validation model.** Cards with missing required fields show a red warning banner directly under the header: warning-triangle icon + text `Invalid parameters`. Each invalid field additionally shows red inline helper text below it in the form `'FieldName' is required.` Required fields are marked with a red asterisk `*` after the label; dropdown/combobox fields also show a small red asterisk to the right of the control itself.
4. **Field input types.** Two dominant input styles:
   - Plain text inputs with grey placeholder text (all accept dynamic content/expressions).
   - Combobox/dropdowns with a chevron (used where the value must come from a known set — e.g., variable name, variable type, Boolean value).
5. **Action picker panel.** Choosing a category from "Add an action" opens a panel: breadcrumb header `Add an action > <Category>`, close `X` top-right, then a bold category section header with a **star (favorite) icon** beside it, then a **two-column grid of action tiles** (icon + label). Category icon colors: Variables = purple `{x}`, Data Operation = violet `{/}` (pencil variant for Compose, funnel variant for Parse/CSV/Join), Control = dark grey split-branch glyph, Human review = blue approval/loop glyph.
6. **Advanced parameters pattern.** Optional params are hidden behind an "Advanced parameters" section at the bottom of the card: a dropdown reading `Showing 0 of 1` (count of surfaced vs. available advanced params), plus `Show all` and `Clear all` buttons (`Clear all` is disabled/greyed when nothing is set).
7. **Top toolbar (partially visible).** Undo / redo, `Copilot`, `Version history`, `Flow checker` — designer-level chrome, noted for context.

---

## Screenshot-by-screenshot

### 1. `7.39.59 PM` — Action picker: **Variable category**

- **Surface:** "Add an action > Variable" picker panel.
- **Layout:** Breadcrumb header, close `X`; section header `Variable` with favorite star; two-column tile grid.
- **Tiles (6, all purple `{x}` icon):**
  | Left column | Right column |
  |---|---|
  | Append to array variable | Append to string variable |
  | Decrement variable | Increment variable |
  | Initialize variable | Set variable |
- **Behaviors implied:** clicking a tile inserts that step at the `(+)` insertion point; star lets users favorite the category.

### 2. `7.40.05 PM` — **Append to array variable** config card

- **Banner:** `Invalid parameters`.
- **Fields:**
  | Label | Required | Input type | Placeholder / default | Validation text |
  |---|---|---|---|---|
  | Name | Yes | Dropdown (combobox, chevron; red `*` beside control) | empty | `'Name' is required.` |
  | Value | Yes | Text input (dynamic-content capable) | `Enter a value` | `'Value' is required.` |
- **Behaviors implied:** Name is a **dropdown of previously-initialized variables** (not free text) — the step can only target a variable declared earlier by an Initialize variable step. Value is required for append.

### 3. `7.40.13 PM` — **Decrement variable** config card

- **Banner:** `Invalid parameters`.
- **Fields:**
  | Label | Required | Input type | Placeholder | Validation text |
  |---|---|---|---|---|
  | Name | Yes | Dropdown (variable picker) | empty | `'Name' is required.` |
  | Value | No (no asterisk) | Text input | `Enter a value` | — |
- **Behaviors implied:** Value is the optional decrement amount (defaults to 1 when omitted, per the optional marker).

### 4. `7.40.23 PM` — **Initialize variable** config card

- **Banner:** `Invalid parameters`.
- **Fields:**
  | Label | Required | Input type | Placeholder / default | Validation text |
  |---|---|---|---|---|
  | Name | Yes | Free text input | `Enter variable name` | `'Name' is required.` |
  | Type | Yes | Dropdown (red `*` beside control) | Default: `Boolean` | — |
  | Value | No | Dropdown-style input (chevron) | empty | — |
- **Behaviors implied:** This is the only variable step where Name is **free text** (declaration site). The Value editor is **type-driven**: with Type=Boolean the Value control renders as a dropdown (true/false picker) rather than a plain text box.

### 5. `7.40.28 PM` — **Initialize variable — Type dropdown open**

- Same card as #4 with the Type dropdown expanded.
- **Options (in order, Boolean highlighted as current selection):**
  1. `Boolean`
  2. `Integer`
  3. `Float`
  4. `String`
  5. `Object`
  6. `Array`
- **Behaviors implied:** exactly six variable types; selection presumably re-renders the Value editor per type.

### 6. `7.40.38 PM` — **Append to string variable** config card

- **Banner:** `Invalid parameters`.
- **Fields:** identical shape to Append to array variable:
  | Label | Required | Input type | Placeholder | Validation text |
  |---|---|---|---|---|
  | Name | Yes | Dropdown (variable picker) | empty | `'Name' is required.` |
  | Value | Yes | Text input | `Enter a value` | `'Value' is required.` |

### 7. `7.40.47 PM` — **Increment variable** config card

- **Banner:** `Invalid parameters`.
- **Fields:** mirror of Decrement variable:
  | Label | Required | Input type | Placeholder | Validation text |
  |---|---|---|---|---|
  | Name | Yes | Dropdown (variable picker) | empty | `'Name' is required.` |
  | Value | No | Text input | `Enter a value` | — |
- Toolbar visible: undo/redo, Copilot, Version history, Flow (checker).

### 8. `7.40.54 PM` — **Set variable** config card

- **Banner:** `Invalid parameters`.
- **Fields (as rendered pre-selection):**
  | Label | Required | Input type | Placeholder | Validation text |
  |---|---|---|---|---|
  | Name | Yes | Dropdown (variable picker) | empty | `'Name' is required.` |
- **Behaviors implied:** only the Name dropdown is shown before a variable is chosen — the **Value field appears conditionally** once a target variable (and hence its type) is selected. Conditional field rendering based on prior field state.

### 9. `7.41.09 PM` — Action picker: **Control category**

- **Surface:** "Add an action > Control" picker panel; section header `Control` + favorite star.
- **Tiles (6, dark branch icon):**
  | Left column | Right column |
  |---|---|
  | Condition | Apply to each |
  | Do until | Scope |
  | Switch | Terminate |
- **Behaviors implied:** the full control-flow vocabulary is: binary branch (Condition), multi-way branch (Switch), for-each loop (Apply to each), condition-bottom loop (Do until), grouping/container (Scope), and early exit with status (Terminate). Only the catalog is shown in this capture set; individual control configs were not captured.

### 10. `7.41.39 PM` — Action picker: **Data Operation category**

- **Surface:** "Add an action > Data Operation" picker panel; section header `Data Operation` + favorite star.
- **Tiles (7, violet `{/}` icon):**
  | Left column | Right column |
  |---|---|
  | Compose | Create CSV table |
  | Create HTML table | Filter array |
  | Join | Parse JSON |
  | Select | |

### 11. `7.41.46 PM` — **Parse JSON** config card

- **Banner:** `Invalid parameters`.
- **Fields:**
  | Label | Required | Input type | Placeholder | Validation text |
  |---|---|---|---|---|
  | Content | Yes | Text input | `Content to create schema from` | `'Content' is required.` |
  | Schema | Yes | Large multi-line code editor / textarea (scrollable) | empty | `'Schema' is required.` |
- **Extra control:** blue link-style button below the Schema editor: `Use sample payload to generate schema` — opens a flow to paste example JSON and auto-generate the JSON schema.
- **Behaviors implied:** schema authoring assistance is first-class; the schema drives downstream typed outputs.

### 12. `7.41.53 PM` — **Create CSV table** config card

- **Banner:** `Invalid parameters`.
- **Fields:**
  | Label | Required | Input type | Placeholder | Validation text |
  |---|---|---|---|---|
  | From | Yes | Text input (expects array) | `Array to create table from` | `'From' is required.` |
- **Advanced parameters section** (below a divider):
  - Dropdown reading `Showing 0 of 1` (1 advanced param available — the columns mode, hidden by default).
  - `Show all` button (surfaces all advanced params).
  - `Clear all` button (greyed/disabled when none set).
- **Behaviors implied:** progressive disclosure — required inputs up front, optional config behind Show all. (Create HTML table, not captured in card form, is the same shape.)

### 13. `7.42.05 PM` — **Join** config card

- **Banner:** `Invalid parameters`.
- **Fields:**
  | Label | Required | Input type | Placeholder | Validation text |
  |---|---|---|---|---|
  | From | Yes | Text input (expects array) | `Array to join` | `'From' is required.` |
  | Join with | Yes | Text input (separator string) | `Join with separator` | `'Join with' is required.` |

### 14. `7.42.18 PM` — **Compose** config card

- **Banner:** `Invalid parameters`.
- **Fields:**
  | Label | Required | Input type | Placeholder | Validation text |
  |---|---|---|---|---|
  | Inputs | Yes | Text input (accepts any payload: literal, expression, dynamic content) | `Inputs` | `'Inputs' is required.` |
- **Behaviors implied:** single-field step; output is the composed value referenced by later steps.

### 15. `7.42.30 PM` — Action picker: **Human review category**

- **Surface:** "Add an action > Human review" picker panel; section header `Human review` + favorite star.
- **Tiles (2, blue approval icon):**
  | Left column | Right column |
  |---|---|
  | Request information | Run a multistage approval (pre… *(label truncated — "(preview)")* |
- **Behaviors implied:** human-in-the-loop is a first-class action category with exactly two entry points: a single-step information/approval request, and a multi-stage approval pipeline (flagged preview).

### 16. Inline follow-up image — **Request information** config card (Human review)

- **Surface:** configuration card for the `Request information` human-review step (blue icon), same canvas card chrome and `Invalid parameters` validation pattern as all other steps.
- **Fields (as visible):**
  | Label | Required | Input type | Notes |
  |---|---|---|---|
  | Assigned to | Yes | People/email picker input | who the flow pauses on; `'Assigned to' is required.` inline error when empty |
  | Message | Yes | Multi-line text input (dynamic-content capable) | the information request shown to the human reviewer |
- **Behaviors implied:** the flow run suspends at this step until the assigned human responds; the response becomes the step output for downstream branching. Follows the identical required-asterisk + inline `'X' is required.` validation contract.

---

## SYNTHESIS — capability groups for Backstory Studio parity

Ordered within each group by centrality to the config UX.

### (a) Variables

1. **Initialize variable** — the declaration primitive: free-text Name, required Type (`Boolean | Integer | Float | String | Object | Array`), optional type-driven Value editor. Everything else keys off this.
2. **Variable registry → Name dropdowns** — all mutation steps (Set/Increment/Decrement/Append) select the target from a dropdown of already-initialized variables; no free-text names at mutation sites. This implies the builder maintains a typed variable symbol table scoped to the flow.
3. **Set variable** — Name dropdown first; Value editor appears conditionally after selection (type-aware).
4. **Increment / Decrement variable** — Name required; numeric step Value optional (implicit default 1).
5. **Append to array variable / Append to string variable** — Name required + Value required.
6. Six action set total; consistent two-field cards; purple `{x}` visual identity.

### (b) Controls

1. **Condition** (if/else branch) and **Switch** (multi-case branch) — the core branching pair.
2. **Apply to each** (iterate an array) and **Do until** (loop until condition) — the loop pair.
3. **Scope** — block/container grouping of steps (also the unit for error-handling patterns).
4. **Terminate** — explicit early flow exit.
5. Only the catalog surface was captured; per-control config cards (condition rows with operators, switch cases with "add case", loop source pickers, do-until limits) were not in this screenshot set and need a follow-up capture or doc pass before parity work on their editors.

### (c) Data operations

1. **Compose** — minimal one-required-field step (`Inputs`); the workhorse for shaping/echoing values.
2. **Parse JSON** — `Content` + required `Schema` code editor with **"Use sample payload to generate schema"** generator link; the key affordance to replicate (schema-from-example).
3. **Join** — `From` (array) + `Join with` (separator), both required.
4. **Create CSV table / Create HTML table** — `From` (array) required + **Advanced parameters** progressive-disclosure section (`Showing 0 of 1`, `Show all`, `Clear all`) hiding column-mapping config.
5. **Filter array** and **Select** — present in catalog (query/projection over arrays); config cards not captured.

### (d) Human in the loop

1. **Request information** — single-step suspend-and-wait: required `Assigned to` (person) + required `Message`; run pauses until the human responds, response available downstream.
2. **Run a multistage approval (preview)** — multi-stage approval pipeline, flagged preview in the catalog.
3. Dedicated "Human review" category in the action picker (blue identity) — HITL is a top-level category peer to Variables/Control/Data Operation, not buried in a connector list.

### Cross-cutting UX requirements for parity

1. Inline card-on-canvas editing with `(+)` insertion points between steps.
2. `Invalid parameters` card banner + per-field `'X' is required.` inline errors + red asterisks (label and control-adjacent for dropdowns).
3. Placeholder text that teaches the expected shape (`Array to join`, `Content to create schema from`, `Enter variable name`).
4. Advanced-parameters progressive disclosure with shown/available count and Show all / Clear all.
5. Categorized action picker with breadcrumb, favoriting star, and two-column tile grid with per-category icon color coding.
6. Conditional/type-driven field rendering (Set variable's deferred Value; Initialize variable's Boolean Value dropdown).
