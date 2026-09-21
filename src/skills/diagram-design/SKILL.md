---
name: diagram-design
description: Design evidence-backed protocol diagrams for mydevsaid reports. Apply when generating or editing report diagrams, their renderer, or the Pi presentation prompt.
license: MIT
metadata:
  upstream: cathrynlavery/diagram-design
  revision: ce9344c52cb9be811de187bf2a6d58c712c9c9fe
---

# mydevsaid diagram design

Project adaptation of Cathryn Lavery's Diagram Design. This is a bounded report integration, not the complete upstream catalog or its export tooling.

## Report generation contract

Explain one useful relationship or mechanism per diagram for a nontechnical reader. Prefer prose or a table when a graph adds no understanding. Keep at most 9 nodes and 12 edges per diagram, with at most 3 diagrams per report. Split larger subjects by meaning; never silently discard relationships to fit a layout.

Submit only the structured diagram fields in the presentation schema: kind, id, title, description, nodes, edges, limitations. Do not submit HTML, SVG, CSS, coordinates, images, or executable content. The application owns rendering. Preserve the actual topology even when it will use a connection list.

Choose kind by the question the diagram answers. money_flow explains where assets enter, move, and leave; name the asset in each transfer label when known. contract_control explains who can call, change, pause, or upgrade what; label the specific permission. dependencies explains which system calls or relies on another; label the dependency, not a funds transfer. Never infer money movement from a dependency or ownership from a permission. Older reports may omit kind and retain the neutral Protocol relationships heading.

Give each node a distinct meaning and a short, plain-English label. Label every edge with its specific action. Cite captured evidence for every node and edge. Distinguish project_claim, observation, and inference. A website link, common funder, address mention, or matching name does not establish ownership, deployed-code equivalence, independent users, or actual money movement. Retain unresolved questions and limitations beside the figure. Never invent a link to make a graph look complete.

## Attribution

Adapted from https://github.com/cathrynlavery/diagram-design at ce9344c52cb9be811de187bf2a6d58c712c9c9fe. The runtime loads only the semantic contract above this heading. The implementation guidance below is for developers, not instructions for the evidence narrator to draw SVG.

## Implementation profile

The user's existing mydevsaid palette is the approved profile: black canvas, charcoal surfaces, white primary text, neutral gray borders and secondary text. Use the application's sans-serif family for human labels and monospace only for technical identifiers. No external fonts are required. Use a light version when exporting to a light report.

Use flat surfaces, thin borders, radii no larger than 8px, and structural spacing on a 4px grid. No shadows, glows, decorative dots, or unrequested animation. Use emphasis on at most two nodes; emphasis expresses reading priority, never technical legitimacy. Reserve existing risk colors for explicit risk labels.

Connectors must be independently traceable. public/report-map.js owns a shared layered layout for all three semantic types: chains, branches, merges, and links that skip levels. Ports and routing tracks are separate for each edge. Crossings use a background under-stroke to distinguish bridges from junctions. Numbered arrows map to a permanently visible connection list containing full labels and citations. Numbers sit at least 8px off the stroke. Cycles, legacy oversized graphs, and labels that cannot fit retain the complete connection list. Never drop edges to produce a drawing.

## Rendering and review

Use self-contained inline SVG with a viewBox. The first child is a title; a description follows it. Give both unique IDs and reference them with role=img and aria-labelledby. Render untrusted labels with textContent. Include a textual equivalent with all node and relationship citations, and keep limitations visible. Meaning must survive grayscale, printing, reduced motion, and offline HTML export.

Verify labels fit without clipping, connectors avoid nodes and label masks, and narrow screens retain readable text. If independently routed edges would share a collinear segment, retain the full connection list rather than implying a shared junction. Verify any supported graph is complete, correctly directed, and traceable to its evidence. Never change the graph to suit the renderer.

The fixed skill file is loaded directly by src/pi-runner.ts. Keep these instructions aligned with src/report-model.ts and public/report-map.js. General filesystem, shell, extension, and skill discovery remain disabled for the evidence narrator. This is a project adaptation, not installation of upstream's complete toolset.

## Integration acceptance checks

Treat a skill as a workflow to translate into code and verifiable behavior, not a block of prompt text to paste. Record what is adopted, which component enforces it, its unsupported cases, and how it was checked. Load additional upstream references when extending the supported layouts.

Reference lock: existing mydevsaid grayscale palette; upstream Diagram Design for semantic/layout separation and traceable relationships; Refero's Linear changelog reference for compact sans-serif hierarchy and thin borders. Avoid decorative focal nodes that suggest a trust judgment.

Required examples: money-flow chain, control fan-out, dependency diamond with a shared target, skip-level link, cycle fallback, long address labels, missing citations, and legacy graphs. Check every edge's endpoints, orthogonal routing, distinct ports, and clearance from unrelated nodes. Compare desktop, narrow chat, and light HTML export in a browser. Narrow containers show the same numbered connection list without horizontal scrolling; export retains the diagram and list. Unit tests alone do not establish visual quality. A live model run remains a separate integration check.

## License

MIT License

Copyright (c) 2025 Cathryn Lavery

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
