# Graph visualizer

A view of your vault's link graph as brain-mcp's search sees it: every note is a dot, every link a line.

```bash
npm run build && npm run reindex   # once, so the index has the link graph and embeddings
npm run graph                      # writes visualizer/graph.json from your config's vault
cd visualizer && python3 -m http.server 4750 --bind 127.0.0.1
# open http://127.0.0.1:4750/
```

- **Graph** (default) is a flat, Obsidian-style view. **3D** shows the same graph in space; its libraries load only when you switch. The page remembers your choice, and `?view=3d` opens 3D directly.
- **Colour follows meaning.** Each note's average embedding is reduced to three numbers: two pick the hue, the third the lightness. Notes about similar things get similar colours. "Project" mode colours a project by its notes' overall meaning.
- **Line thickness is bond strength**, the same number the ranker uses when it follows links (`LinkGraph.strength`): where the link sits, times repeats, times whether it goes both ways, times how rare the target is.
- **Hover a note** to light it up in green. Its strongest neighbours glow most, the next rings less (by bond strength along the path), and unconnected notes fade away. Everything eases in and out.
- **Click a note** for its bonds, strongest first, with the sentence that makes each link. Use the slider to hide weak bonds and the checkbox to hide hub and concept pages.

`export-graph.mjs` reads the index read-only through brain-mcp's own code, so links resolve exactly as search resolves them. Denied paths are always left out, and private notes too unless you pass `--include-private`. `graph.json` holds note titles and linking sentences, so it is git-ignored. To export another install, such as a server elsewhere, run `node scripts/export-graph.mjs <its folder> --config <its config> --out <file>` there and copy the file here.

3D needs the page served over http (as above), because three.js loads as a module. The libraries in `vendor/` are MIT licensed and work offline: [force-graph](https://github.com/vasturiano/force-graph) 1.51.4, [3d-force-graph](https://github.com/vasturiano/3d-force-graph) 1.80.0 and [three.js](https://threejs.org) r183.
